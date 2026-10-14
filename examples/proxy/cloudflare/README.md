# ibh LLM proxy on Cloudflare Workers

Production-grade LLM access for ibh with **no key in the browser** and **no
server of your own to run** — a ~150-line, zero-dependency Worker on your
Cloudflare zone. Strictly more capable than the nginx variant: Workers can read
the request body, so the model allowlist is a *real* server-side gate.

```
Browser (ibh, llm: { baseUrl: '/api/ibh-llm' })
  → same-origin POST, session cookie flows automatically
    → Cloudflare route: your-site.com/api/ibh-llm/* → this Worker
      → Worker: verify session → allowlist model → rate-limit → forward
        → https://openrouter.ai (Authorization: Bearer $OPENROUTER_KEY)
```

Exactly two paths are forwarded — everything else 404s:

- `POST {llm.baseUrl}/chat/completions` (ibh's model client, 25 MB cap — generous
  so multimodal image payloads fit)
- `POST {llm.baseUrl}/audio/transcriptions` (ibh's `ui.stt` voice input, 8 MB cap)

i.e. with the default `MOUNT_PATH = "/api/ibh-llm"` and ibh configured with
`llm: { baseUrl: '/api/ibh-llm' }`, the Worker receives
`/api/ibh-llm/chat/completions` and forwards to
`https://openrouter.ai/api/v1/chat/completions`. `MOUNT_PATH` is configurable
in `wrangler.toml` if your route differs.

## Quickstart

```bash
# 1. copy this folder into your project (or deploy from a clone of ibh)
cd examples/proxy/cloudflare

# 2. secrets — never in the repo, never in the page
pnpm dlx wrangler secret put OPENROUTER_KEY          # your server-side OpenRouter key
pnpm dlx wrangler secret put AUTH_SECRET             # if AUTH_MODE = "jwt-hs256"

# 3. edit wrangler.toml:
#    - routes: your zone + the /api/ibh-llm/* pattern
#    - ALLOWED_MODELS: your server-side model gate
#    - AUTH_MODE: "jwt-hs256" or "remote" (see below)

# 4. deploy + verify
pnpm dlx wrangler deploy
curl -s -X POST https://your-site.com/api/ibh-llm/chat/completions \
  -H 'content-type: application/json' -d '{"model":"openai/gpt-6-luna"}'   # -> 403 (no session) ✅

# 5. point ibh at it — no key in the page:
ibh.init({ /* ... */ llm: { baseUrl: '/api/ibh-llm' } });
```

## Session verification (AUTH_MODE)

The Worker refuses to forward anything until the caller's session cookie checks
out. Fail-closed: with no `AUTH_MODE` configured it returns 500 and forwards
nothing. Pick one:

### `AUTH_MODE = "jwt-hs256"` — inline, zero network round-trips

Your app issues its session as a signed JWT in a cookie (name via `COOKIE_NAME`,
default `sid`). The Worker verifies the HMAC-SHA256 signature with `AUTH_SECRET`
using WebCrypto and rejects expired tokens (`exp`, seconds since epoch).

```bash
pnpm dlx wrangler secret put AUTH_SECRET   # the SAME secret your app signs with
```

### `AUTH_MODE = "remote"` — delegate to your app

Set `AUTH_VERIFY_URL` (e.g. `https://your-site.com/session/verify`). The Worker
forwards the caller's `Cookie` header to that endpoint on every request:

- `2xx` → authenticated
- anything else → rejected (403)

Keep the endpoint cheap (token decode / short-TTL cache — not a fresh DB query
per request). Use this if your sessions aren't simple HS256 JWTs.

### Fail-closed rules (tested)

- No session cookie → 403
- Bad signature / expired token → 403
- `AUTH_MODE` unset → 500 (misconfiguration, forwards nothing)
- `OPENROUTER_KEY` unset → 500

## Model allowlist (server-side, real)

`ALLOWED_MODELS` (comma-separated) is checked against the parsed request body
for chat completions — impossible in plain nginx, trivial here:

```toml
ALLOWED_MODELS = "openai/gpt-6-luna,anthropic/claude-haiku-5.5"
```

Unset = any model passes. Keep the manifest (`llm.allowedModels`) and this list
**identical**: the manifest shapes the agent's behavior, the Worker enforces it.
If you prefer the one-model approach, set both to a single model — then a
drifted agent call still 403s here instead of silently spending on an
expensive model.

## Rate limiting

Three options, in order of preference:

1. **Cloudflare WAF rate-limiting rule** on the route (dashboard → Security →
   WAF → Rate limiting rules): global, edge-enforced, no code. Match
   `http.request.uri.path starts_with "/api/ibh-llm/"`, threshold e.g. 10
   requests / minute / IP.
2. **Workers Rate Limiting binding** (`[[unsafe.bindings]]` class
   `ratelimit`): programmatic, per-key.
3. The Worker's built-in per-isolate counter (60 req/min/IP): best-effort
   only — isolates churn and counters are per-colo, not global. It exists so a
   misconfigured deployment is still not completely open; do not rely on it.

Always also set an **OpenRouter per-key spend cap** as the final backstop.

## CORS / same-origin

Serve the Worker on a route of your main zone (as in `wrangler.toml`). The
request is then same-origin: cookies flow, no CORS is involved. For a
cross-origin deployment (separate workers.dev domain), set `ALLOWED_ORIGIN` to
your site origin — the Worker rejects mismatched `Origin` headers — and add
CORS response headers yourself if the browser needs them.

## Testing

- **Automated**: `pnpm test examples/proxy/cloudflare` runs 8 smoke tests
  against the Worker module (fail-closed rules, JWT verify, allowlist, remote
  auth, forwarding, size/origin checks).
- **Manual** (`pnpm dlx wrangler dev`, port 8787):

```bash
# rejected: no session
curl -s -X POST http://localhost:8787/api/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"openai/gpt-6-luna"}'

# rejected: model not allowed (with a valid session cookie)
curl -s -X POST http://localhost:8787/api/v1/chat/completions \
  -H 'content-type: application/json' -b 'sid=<your-jwt>' \
  -d '{"model":"openai/o-billion"}'

# forwarded: OpenRouter answers (401 with a fake key proves the pipe)
curl -s -X POST http://localhost:8787/api/v1/chat/completions \
  -H 'content-type: application/json' -b 'sid=<your-jwt>' \
  -d '{"model":"openai/gpt-6-luna","messages":[{"role":"user","content":"hi"}]}'
```

## ibh wiring

```js
ibh.init({
  // ...
  llm: { baseUrl: '/api/ibh-llm' },   // no key in the page
  ui: {
    stt: { model: 'elevenlabs/scribe-v2' }, // inherits the proxy base + forwards /audio/transcriptions
  },
});
```

## Security checklist

- [ ] `OPENROUTER_KEY` is a Worker secret, never committed, never in the page
- [ ] Session verification configured (`AUTH_MODE`) — the Worker refuses to run without it
- [ ] `ALLOWED_MODELS` set and identical to the manifest's `llm.allowedModels`
- [ ] WAF rate-limiting rule on the route + OpenRouter per-key spend cap
- [ ] The route is on your main zone (same-origin, no CORS)
- [ ] Remember: ibh's permissions layer is best-effort client-side — your API
      authorization remains the real boundary (see docs/security-model.md)
