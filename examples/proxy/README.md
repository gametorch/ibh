# ibh LLM proxy — never ship a shared key

The browser cannot keep a secret. If **your** OpenRouter key ships to the client,
anyone can read and drain it. ibh therefore supports exactly three modes:

| Mode | Where the key lives | Pure frontend? | Use for |
| --- | --- | --- | --- |
| **BYO user key** | The end user's own key, in their browser only | ✅ yes | demos, internal tools |
| **Backend proxy** (recommended) | Your server | ❌ needs an endpoint | production |
| Shared key in the page | nowhere — ibh refuses to init | — | **never** |

`init()` fails closed if you configure neither a key nor a proxy base URL.

## 1. Run the reference proxy (zero dependencies)

```bash
OPENROUTER_KEY=sk-or-... \
AUTH_VERIFY_URL=http://127.0.0.1:3000/session/verify \
ALLOWED_MODELS="openai/gpt-6-luna,elevenlabs/scribe-v2" \
node examples/proxy/server.js
```

Then point ibh at it — no key in the page:

```js
ibh.init({
  // ...
  llm: { baseUrl: 'http://localhost:4180/api/v1' }, // same-origin in production, e.g. '/api/ibh-llm'
});
```

Same-origin proxies need no extra auth in ibh: the user's existing session cookie
flows with the request, and `verifyRequest()` in the proxy validates it. That one
function is the only thing you must replace with your real session check.

The proxy forwards exactly two paths — `{llm.baseUrl}/chat/completions` and
`{llm.baseUrl}/audio/transcriptions` (for `ui.stt`) — and enforces on **both**:


- **Model allowlist** (`ALLOWED_MODELS`) server-side. The client-side manifest is
  advisory; this is the gate.
- **Per-IP rate limiting** (naive token bucket — swap in whatever your stack has).
- **Request size cap** — 25 MiB for chat, 8 MiB for STT. Chat is generous because
  multimodal messages carry images as base64 data URLs (~1.37× their raw size);
  raise it if your users attach several large images.

It also surfaces OpenRouter's **real per-request cost** so you can meter and
charge your users — see [2g](#2g-metering--charging-your-users--business-logic-proxies-only).

## 2. Other stacks (same shape, ~30 lines each)

**Next.js App Router** — `app/api/ibh-llm/[...path]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth'; // your real session

const ALLOWED_MODELS = new Set(['openai/gpt-6-luna', 'anthropic/claude-haiku-5.5']);

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: { message: 'unauthorized' } }, { status: 401 });
  const path = params.path.join('/');
  if (path !== 'chat/completions' && path !== 'audio/transcriptions') {
    return NextResponse.json({ error: { message: 'not found' } }, { status: 404 });
  }
  if (path === 'chat/completions') {
    const body = await req.json();
    if (body.model && !ALLOWED_MODELS.has(body.model)) {
      return NextResponse.json({ error: { message: 'model not allowed' } }, { status: 403 });
    }
    return new NextResponse(
      JSON.stringify(await fetch(`https://openrouter.ai/api/v1/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.text())),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }
  // audio/transcriptions: forward the raw body
  return new NextResponse(
    await fetch(`https://openrouter.ai/api/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_KEY}`, 'Content-Type': req.headers.get('content-type') ?? 'application/json' },
      body: await req.arrayBuffer(),
    }).then((r) => r.text()),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}
```

**Cloudflare Worker:**

```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path !== '/api/v1/chat/completions' && path !== '/api/v1/audio/transcriptions') {
      return new Response('not found', { status: 404 });
    }
    // REPLACEME: verify the user's session (signed cookie, JWT, Access, ...)
    const body = await req.text();
    if (path === '/api/v1/chat/completions' && env.ALLOWED_MODELS) {
      const model = JSON.parse(body || '{}').model;
      if (model && !env.ALLOWED_MODELS.split(',').includes(model)) {
        return Response.json({ error: { message: 'model not allowed' } }, { status: 403 });
      }
    }
    return fetch(`https://openrouter.ai${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
      body,
    });
  },
};
```

## 2b. Cloudflare Workers (full implementation)

On Cloudflare, use a Worker instead of app code or nginx — and unlike nginx, the
Worker **can** parse the request body, so the model allowlist is a real
server-side gate. A complete, deployable, tested implementation with full
documentation (session verification via JWT-HS256 or a remote endpoint, wrangler
setup, WAF rate limiting, CORS guidance) lives at
[`examples/proxy/cloudflare/`](./cloudflare/README.md).

## 2c. Option: nginx-only proxy (no application code)

If your site already runs nginx, you can skip application code entirely —
[`nginx.conf.example`](./nginx.conf.example) is a complete, commented config that
does the path allowlisting, session gating, rate limiting and header injection.

```bash
# 1. secret file (root-owned, 0600, not in the repo)
echo 'set $openrouter_key "sk-or-...";' > /etc/nginx/ibh-secrets.conf
# 2. serve /_ibh_auth from your app: validate the session cookie -> 2xx or 4xx
# 3. include the config, reload nginx
# 4. point ibh at it:
ibh.init({ /* ... */ llm: { baseUrl: '/api/ibh-llm' } });
```

**Model allowlist: skip it on purpose (option "a").** Plain nginx cannot inspect
the JSON request body, so this variant does not filter models. The intended
setup instead:

- **Hardcode exactly one model**: `llm.allowedModels: ["openai/gpt-6-luna"]`,
  `defaultModel: "openai/gpt-6-luna"`. One model = nothing to allowlist.
- **Set an OpenRouter per-key spend cap** — that is the real server-side bound.
- Be honest with yourself about the residual risk: the manifest is client-side
  and advisory, so a sufficiently manipulated agent could still request another
  model through your proxy; the spend cap is what bounds the damage. If that is
  not acceptable for your threat model, use the node/njs/Lua variants that
  inspect the body.

The other caveats, spelled out:

- **Caveat 2 — auth subrequests are hot.** `auth_request /_ibh_auth` fires on
  *every* proxied request, with the caller's cookies. Your verify endpoint must
  reject unauthenticated callers with a non-2xx and must be cheap (session-token
  decode, short-TTL cache — not a fresh DB round-trip per keystroke).
- **Caveat 3 — per-user rate limiting has a phase-ordering catch.** `limit_req`
  (preaccess) runs *before* `auth_request` (access), so a user id returned by the
  auth subrequest is not available to the limit zone yet. Options, in order of
  preference: (1) key the zone on a session-cookie variable (`map $cookie_sid …`
  — crude but per-user-ish), (2) keep the per-IP default shown in the config,
  (3) rate-limit inside your app's verify endpoint (authoritative, but only runs
  after auth). Also cap abuse with OpenRouter's per-key spend limit regardless.
- **Caveat 4 — timeouts.** ibh's model client gives up at 120s; set
  `proxy_read_timeout` above that (the example uses 180s) or long generations
  will be killed mid-stream by nginx, not OpenRouter. `proxy_buffering off` is
  only *required* if you later enable streaming; it is harmless as a default.

## 2d. Option: Apache httpd (no application code)

[`apache.conf.example`](./apache.conf.example) is the Apache equivalent of the
nginx variant — same tradeoff, same recommendation, plus a few Apache-specific
caveats:

```bash
# 1. modules: a2enmod proxy proxy_http ssl headers env  (+ ONE auth option)
# 2. secret via environment (NOT inline): export OPENROUTER_KEY in
#    /etc/apache2/envvars (root-owned; %{OPENROUTER_KEY}e expands at request time)
# 3. include the config, apachectl configtest && systemctl reload apache2
# 4. point ibh at it:
ibh.init({ /* ... */ llm: { baseUrl: '/api/ibh-llm' } });
```

**Model allowlist: option "a", same as nginx.** httpd cannot inspect the JSON
body (ModSecurity could, but that is application-adjacent complexity we
recommend against). Instead: **hardcode exactly one model**
(`llm.allowedModels: [X]`, `defaultModel: X`) and set an **OpenRouter per-key
spend cap** — the real server-side bound. Residual risk is identical to nginx:
a sufficiently manipulated agent could still request another model; the spend
cap bounds the damage.

**Caveat A — auth gating differs from nginx.** httpd has no `auth_request`
equivalent built in. Two supported options (keep exactly one active in the
config):

1. **`mod_auth_openidc`** — native OIDC session validation. If your site is
   OIDC-based this is the cleanest: `AuthType openid-connect; Require
   valid-user`. For an API endpoint set `OIDCUnAuthAction 401` so unauthenticated
   callers get a 401 instead of a redirect to the IdP.
2. **`mod_authnz_fcgi`** — the closest thing to `auth_request`: your app speaks
   the FastCGI **AUTHORIZER** role on a local socket (`AuthBasicProvider
   fcgi://127.0.0.1:9000`); 200 = authenticated, 401/403 = rejected.

⚠️ Do NOT gate with a bare `Require expr` that only checks cookie *presence* —
presence is not authentication.

**Caveat B — rate limiting.** httpd ships **no request-rate limiter**
(`mod_ratelimit` throttles *bandwidth*, not requests). Options: `mod_evasive`
(per-IP heuristics), ModSecurity rules, or — preferred — rate-limit at the edge
(Cloudflare/nginx in front). Also set the OpenRouter per-key spend cap
regardless.

**Caveat C — timeouts.** `ProxyTimeout 180` (the example sets it) must exceed
ibh's 120s model client timeout, or long generations get killed by httpd rather
than OpenRouter.

**Caveat D — header privacy.** The user's session `Cookie` header must never
reach openrouter.ai. The config unsets `Cookie` (and any client-supplied
`Authorization`) *before* setting the proxy's own headers — `early` processing,
so it applies before other modules see it. (The nginx variant strips `Cookie`
too; if you adapted either config, double-check this.)

## 2e. Option: Rust (Rocket)

For teams that want the proxy as a compiled binary rather than application
code: [`rocket/`](./rocket/) is a complete Rocket server (single crate, exact
pinned dependencies, `cargo audit` discipline). Unlike nginx/Apache it **can**
enforce the model allowlist server-side (`ALLOWED_MODELS`), it **builds fresh
requests** to OpenRouter so session cookies never leak upstream, body size caps
(25 MiB chat / 8 MiB STT) are enforced in-process, and it **refuses to start**
without a session verifier configured (`AUTH_VERIFY_URL`, fail-closed). See its
[README](./rocket/README.md) for setup, env vars, recommendations (one
hardcoded model + spend cap) and caveats (no built-in rate limiting — use
`governor`, nginx in front, or rate-limit inside your verify endpoint).

## 2f. End-to-end tests for every variant

[`e2e/`](./e2e/README.md) starts each reference proxy as a real process and runs
the full route matrix (chat completions, tool calls, speech-to-text with a real
committed speech fixture, allowlist/404 negatives) against the **real OpenRouter
API**, plus a **headless-browser flow** through the real ibh UI and the demo
site. Requires a real key (`E2E_OPENROUTER_KEY`); without one, positive tests
skip and negative tests still run.

## 2g. Metering & charging your users — business-logic proxies only

OpenRouter returns the **real cost** of every request in the response body —
`usage.cost` (USD charged to *your* key) plus
`usage.cost_details.upstream_inference_cost` (what the upstream provider
charged). ibh never needs to see it: cost is a per-user, server-side concern, so
the place to capture it is your **business-logic proxy**. The
[node](./server.js) and [Rocket](./rocket/) references do this for you — and this
is precisely why it *cannot* be done by the config-only variants (nginx/Apache
cannot read response bodies) or by the browser.

Both references:

1. read `usage` from the JSON response (ibh is non-streaming, so it is always
   present and complete),
2. attribute it to the session user returned by your verifier
   (`AUTH_VERIFY_URL`'s JSON `user` field),
3. emit one machine-readable line per request — `ibh.usage {...}` carrying
   `user`, `cost`, token counts, model and generation id — from `recordUsage`
   (node, [`usage.js`](./usage.js)) / `record_usage` (Rocket), and
4. mirror the figures into `X-Ibh-*` response headers.

**To bill**, replace that one function with a write to your database / billing
system and charge however you want — pass `cost` through, add a markup, debit a
credit balance, or count against a plan quota. The hook is deliberately tiny;
every input you need is already in the record:

```
ibh.usage {"user":"u_123","cost":0.000508,"totalTokens":113,"model":"elevenlabs/scribe-v2","generationId":"gen-..."}
```

For example, in the node reference (`usage.js`) that hook is one function:

```js
function recordUsage(record) {
  db.insert('ibh_usage', { ...record, at: new Date() });   // your store
  if (record.cost > 0) bill(record.user, record.cost * 1.2); // your markup
}
```

Response headers (each present only when OpenRouter reports that field):

| Header | Meaning |
| --- | --- |
| `X-Ibh-Cost` | USD charged to your OpenRouter key for this request |
| `X-Ibh-Upstream-Inference-Cost` | USD the upstream provider charged (BYOK) |
| `X-Ibh-Total-Tokens` | total tokens (chat or STT) |
| `X-Ibh-Audio-Seconds` | STT audio duration, in seconds |
| `X-Ibh-Generation-Id` | OpenRouter generation id (for the `/generation` audit endpoint) |
| `X-Ibh-Model` | model that served the request |

These headers are for **your** server and observability (log aggregation, a
gateway in front, tests); ibh itself ignores them, and you can strip them before
the response reaches the browser if you like. Cost is deliberately **not**
surfaced in the ibh front end — the panel has no product reason to know it.

Streaming note: the references read cost from JSON bodies, which is all ibh ever
sends. If you enable streaming for some other client, OpenRouter puts the same
`usage` object in the final SSE chunk — parse it there.

## 3. Pure frontend: BYO user key

```js
ibh.init({ /* ... */ llm: { openRouterKey: userKey } }); // the END USER's key
```

The key belongs to the visitor, lives in their browser only, and bills their own
OpenRouter account. The site owner stores and pays nothing. This is the only
legitimate key-in-the-page mode — and it still must never be a key *you* control.

## Hard rules

1. Never ship a key you control to the browser. ibh refuses to init in that
   configuration (keyless + still pointing at OpenRouter).
2. Enforce the model allowlist **server-side**; the manifest is advisory.
3. Rate-limit and spend-cap at the proxy (OpenRouter also supports per-key spend
   limits — use them as a second layer).
4. The proxy must authenticate with your *existing* session — ibh sends cookies
   (`credentials: 'include'`) and no Authorization header in proxy mode.
5. Meter and charge in your **business-logic proxy**: OpenRouter returns
   `usage.cost` on every response; capture it (node/Rocket references do — see
   [2g](#2g-metering--charging-your-users--business-logic-proxies-only)) to know
   what each user spent and bill them however you want. The browser and the
   config-only proxies cannot do this.
