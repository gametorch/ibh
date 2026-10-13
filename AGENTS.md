# AGENTS.md — integrating ibh into a website

Guidance for AI coding agents (and skimming humans) whose job is to add **ibh** —
an in-browser agent harness — to a website. Read this fully before writing code;
it tells you what ibh is, what you must wire up, and what you must never do.

Full docs live in this repo: [docs/integration-guide.md](docs/integration-guide.md) ·
[docs/manifest-spec.md](docs/manifest-spec.md) · [docs/security-model.md](docs/security-model.md) ·
[docs/non-goals.md](docs/non-goals.md).

## What ibh is (30 seconds)

ibh gives a site's **signed-in users** a chat panel that can act *on their
behalf*: calling the site's API with their existing session, operating the page's
DOM, and navigating. It is gated by a **capability manifest** the site authors —
anything not in the manifest is structurally impossible for the agent, no matter
what any prompt or page content says. Every action passes through a runtime
gatekeeper (validation → consent tiers → rate limits → budgets → execution →
audit log).

## How an integration works (the three pieces)

### 1. The UI — you probably want a pre-packaged component

Published under the official GameTorch npm account; each pulls the self-contained
`@gametorch/ibh` core automatically and mounts a shadow-DOM panel (no CSS setup):

| Framework | Install | Use |
| --- | --- | --- |
| React 18+ | `pnpm add @gametorch/ibh-react` | `<IbhChat {...config} />` |
| Vue 3 | `pnpm add @gametorch/ibh-vue` | `<IbhChat :manifest="…" … />` |
| Angular 19+ | `pnpm add @gametorch/ibh-angular` | `<ibh-chat [manifest]="…" … />` |
| Svelte 5 | `pnpm add @gametorch/ibh-svelte` | `<IbhChat {manifest} … />` (+ `use:ibhChat` action) |
| Solid | `pnpm add @gametorch/ibh-solid` | `<IbhChat … />` (+ `use:ibhChat` directive) |
| anything else | `pnpm add @gametorch/ibh` | `<script>` tag + `window.__IBH_CONFIG__`, or `import { init } from '@gametorch/ibh'` |

You **don't have to** use a package — the harness is plain JS and works on any
stack via the script tag. Annotate the DOM you want the agent to use with
`data-ibh-region` / `data-ibh-action` attributes (works unannotated too, just
less reliably).

Voice input is built in: set `ui.stt` and every component gains a mic button —
record, transcribe via any OpenRouter STT model (e.g. `elevenlabs/scribe-v2`),
then auto-send the transcript or fill the input. Consequence for this file's
proxy contract below: when `ui.stt` is configured, your proxy must also expose
`POST {llm.baseUrl}/audio/transcriptions`.

### 2. The capability manifest (required — fail-closed)

A JSON object declaring EVERYTHING the agent may do: `api` endpoints (with HTTP
method, path template, consent `tier`, argument schemas), `dom` actions, `nav`
routes, session `policies`, and the `llm` policy. Hard rules enforced by
validation (`init()` throws otherwise — fix the manifest, never bypass it):

- every capability declares an explicit `tier`: `auto` / `session` / `confirm` /
  `denied` — there are no library defaults
- capability ids are unique across all kinds, no dots
- any executable mutating capability requires `policies.maxMutatingActionsPerSession`
- `llm.allowedModels` is required; `defaultModel` must be in it

Start small: reads at `auto`, one or two important actions at `confirm`.
Full schema: [docs/manifest-spec.md](docs/manifest-spec.md).

### 3. The LLM proxy — you almost certainly need to build these routes

**The browser cannot hold your OpenRouter key.** ibh supports a BYO-user-key
mode (the visitor pastes *their own* key — fine for demos/internal tools), but
production integrations run **proxy routes on the site's backend**, and ibh's
`init()` **fails closed** if you configure neither a key nor a proxy.

ibh POSTs to exactly two endpoints, derived from `llm.baseUrl`:

- `POST {llm.baseUrl}/chat/completions` — OpenRouter-shaped chat body with tools
- `POST {llm.baseUrl}/audio/transcriptions` — only if `ui.stt` is configured

Your routes must:

1. authenticate the caller with the site's **existing session** (same-origin:
   ibh sends `credentials: 'include'` and no `Authorization` header),
2. enforce the **model allowlist server-side** (the manifest's `llm.allowedModels`
   is advisory; this is the real gate),
3. forward to `https://openrouter.ai/api/v1/…` with `Authorization: Bearer $SERVER_KEY`,
4. **strip the user's cookies** from the upstream request,
5. return OpenRouter's status/body unchanged, and reject every other path (404).

**Reference implementations to translate** — we ship examples in pure node
(`examples/proxy/server.js`, zero dependencies) and Rust/Rocket
(`examples/proxy/rocket/`), but you will probably have to **translate those
proxy routes to whatever backend the site actually uses** (Express, Hono,
Fastify, Laravel, Rails, Spring — the contract is ~40 lines; see
[examples/proxy/README.md](examples/proxy/README.md)). Config-only variants:
nginx (`examples/proxy/nginx.conf.example`) and Apache
(`examples/proxy/apache.conf.example`) — with those, the auth gate is
`auth_request`/`mod_authnz_fcgi`/OIDC instead of app routes. A deployable,
tested Cloudflare Worker ships at
[`examples/proxy/cloudflare/`](examples/proxy/cloudflare/README.md).

Server-side you should also set: the model allowlist (identical to the
manifest's), per-user rate limits, and an **OpenRouter per-key spend cap**.
Note: nginx/Apache cannot inspect the request body, so with those the
recommendation is to **hardcode exactly one model** in the manifest and lean on
the spend cap (documented tradeoff in the proxy README).

## Hard rules (do not violate)

- **Never** put a site-controlled OpenRouter key in frontend code, bundled
  constants, or `NEXT_PUBLIC_*`/Vite-public env. BYO-user-key is the only
  key-in-the-page mode, and the key must be the *end user's own*.
- **Never** weaken a manifest entry to make a failing agent call pass. Declare
  the capability correctly or leave it denied.
- **Never** promise undo/rollback — ibh has none by design
  ([docs/non-goals.md](docs/non-goals.md)). There is a full audit log instead.
- ibh's permissions layer is **best-effort client-side** (heavily tested, but
  not a security boundary). Server-side authorization is the real boundary —
  assume ibh has the same permissions as the signed-in user
  ([docs/security-model.md](docs/security-model.md)).

## Verify your integration

1. `init()`/mount throws on invalid manifests or impossible credentials — treat
   that as the checklist failing, not as something to catch-and-ignore.
2. `pnpm demo` in this repo runs a full reference integration (mock API,
   dashboard, editor) you can compare against.
3. `pnpm test` covers the manifest validator, gatekeeper security suite, agent
   loop, UI options and every framework binding.
4. Manual checks: an unauthenticated proxy request must be rejected (401/403);
   a `denied`-tier capability must never execute; every executed action must
   appear in the panel's audit view.
