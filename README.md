# ibh — the in-browser agent harness

**ibh** is an application-agnostic harness you drop into any website. It gives your
signed-in users a chat panel that can act *on their behalf* — calling your API with
their existing credentials, operating your page's DOM, and navigating your site —
through a capability manifest **you** author and the runtime **enforces**.
Speech-to-text (OpenRouter STT models) is supported out of the box — hold the mic,
talk, and the transcript is sent or filled in. Images are supported too: attach,
paste or drag a screenshot/photo into the panel, or let the agent pull one from
your API or the page itself with its built-in `attach_image` tool. Assistant
replies render as **safe markdown** by default (customizable, or off).

**Already in production:**
- [GAMETORCH](https://gametorch.app) — game-asset studio: the agent creates, generates and publishes sprites
- [Home Makeover Deluxe!](https://homemakeover.app) — 🏠 organize your home makeover w/ yapping 🎤

**Try it live now:** [homemakeover.app/playground](https://homemakeover.app/playground/) —
an interactive ibh playground hosted by Home Makeover Deluxe! No install needed.

```
 your site (any stack, any auth)
 ┌─────────────────────────────────────────────────┐
 │  <script src="ibh/index.global.js">             │
 │  ibh.init({ manifest, guide, auth, llm })       │
 │                                                 │
 │   model ⇄ structured intents ⇄ GATEKEEPER       │
 │                                  │              │
 │            manifest validation ──┤              │
 │            consent tiers ────────┤              │
 │            rate limits/budgets ──┤              │
 │            audit ledger ─────────┘              │
 │                                  │              │
 │        fetch (your session) · DOM actions · nav · sandboxed JS │
 └─────────────────────────────────────────────────┘
```

## More than a chat bot

A chat panel is the primary UX — and ibh ships polished chat components for
React, Vue, Angular, Svelte and Solid, plus a [live demo](#quick-start) you can
try in minutes. But the *component* is optional. At its core, ibh is a **harness**:
a runtime that executes a capability manifest inside the user's browser — API
calls with their session, DOM actions on declared selectors, navigation, and
sandboxed computation — with consent tiers, budgets and a full audit ledger.
Anything the site's own JS could do can be declared as a capability, which opens
use cases beyond chat:

- **Bulk/batch operations** — "archive all drafts older than a month" executed as
  real manifest API calls, each gated and audited
- **Data answers, not data dumps** — reads + the sandboxed analyze step produce
  computed answers (aggregations, formatting) instead of raw JSON
- **Guided flows that do real work** — onboarding checklists, import wizards and
  form prefill where each step is a real, consented capability call
- **Programmatic/headless integrations** — `ui: { enabled: false }` plus
  `instance.send()` / `instance.audit()` to drive the harness from your own UI,
  tests or scripts (fail-closed: without a consent UI, mutating tiers are denied
  unless you supply a `consent` handler — see
  [security model](docs/security-model.md))
- **Accessibility & voice** — STT is built in; the agent navigates and acts for
  users who can't use a mouse

The chat UI is just the reference client for the same runtime.

## Batteries included: 5 framework components + 5 proxy servers

You should rarely have to write glue code. ibh ships tested reference
implementations on both sides — the browser component for the five major
frontend frameworks, and the LLM proxy piece for the five most common hosting
stories — plus a detailed integration guide for everything else.

**Frontend components** (published packages; install one, done — each pulls
`@gametorch/ibh` automatically and mounts a self-contained, shadow-DOM panel):

| Framework | Package | Idiom | Guide |
| --- | --- | --- | --- |
| React 18+ | `@gametorch/ibh-react` | `<IbhChat />` (StrictMode-safe, typed ref) | [examples/react-next](examples/react-next/README.md) |
| Vue 3 | `@gametorch/ibh-vue` | `<IbhChat>` (template-ref handle) | [examples/vue](examples/vue/README.md) |
| Angular 19+ | `@gametorch/ibh-angular` | `<ibh-chat>` standalone directive (no zone.js required) | [examples/angular](examples/angular/README.md) |
| Svelte 5 | `@gametorch/ibh-svelte` | `<IbhChat>` + `use:ibhChat` action | [examples/svelte](examples/svelte/README.md) |
| Solid | `@gametorch/ibh-solid` | `<IbhChat>` + `use:ibhChat` directive | [examples/solid](examples/solid/README.md) |
| anything else | `@gametorch/ibh` | script tag or `init()` — plain JS, no framework needed | [docs/integration-guide](docs/integration-guide.md) |

**LLM proxy reference servers** (so no key ever ships to the browser — pick the
one that matches how you deploy):

| Stack | What ships | Notes |
| --- | --- | --- |
| Node (zero deps) | [`examples/proxy/server.js`](examples/proxy/server.js) | `node server.js`; loopback bind, session-verify via `AUTH_VERIFY_URL`, surfaces OpenRouter's real per-request cost |
| Cloudflare Workers | [`examples/proxy/cloudflare/`](examples/proxy/cloudflare/README.md) | deployable Worker + wrangler config, 8 smoke tests, full docs |
| nginx | [`examples/proxy/nginx.conf.example`](examples/proxy/nginx.conf.example) | config-only; caveats documented |
| Apache httpd | [`examples/proxy/apache.conf.example`](examples/proxy/apache.conf.example) | config-only; caveats documented |
| Rust (Rocket) | [`examples/proxy/rocket/`](examples/proxy/rocket/README.md) | compiled binary, pinned deps, `cargo audit` discipline, surfaces per-request cost |

All proxies: session-gated, model-allowlisted server-side (nginx/Apache: one
hardcoded model + spend cap instead — documented tradeoff), size-capped (25 MiB
for chat so image payloads fit, 8 MiB for STT), and
cookie-safe (session cookies never forwarded upstream). The **node and Rocket**
proxies also read OpenRouter's real per-request cost (`usage.cost`) and surface it
to your business logic — an `ibh.usage {...}` line per request attributed to the
signed-in user, plus `X-Ibh-*` response headers — so you can meter what each user
spends and charge them however you want. That metering belongs in the
business-logic proxy (the browser has no use for cost, and config-only
nginx/Apache can't read response bodies); see
[`examples/proxy/README.md`](examples/proxy/README.md#2g-metering--charging-your-users--business-logic-proxies-only).
Using something else
(Express, Hono, Fastify, Laravel, Rails…)? The contract is ~40 lines —
[`examples/proxy/README.md`](examples/proxy/README.md) documents it, and the
[integration guide](docs/integration-guide.md) walks through the full setup.

Every component also ships **voice input out of the box**: set `ui.stt`, and the
panel gains a mic button — record, transcribe via any OpenRouter STT model
(e.g. `elevenlabs/scribe-v2`), auto-send or fill the input. Same proxy/key modes
as chat, same docs.

> **Integrating?** Start with [`AGENTS.md`](AGENTS.md) (the playbook, written for
> AI coding agents) or the [integration guide](docs/integration-guide.md) (for
> humans). [`llms.txt`](llms.txt) indexes everything for machine consumption.

## The two contracts

- **Manifest (hard):** every API endpoint, DOM action and route the agent may touch,
  each with a consent tier (`auto` / `session` / `confirm` / `denied`), argument
  schemas, rate limits and budgets. Not in the manifest? Not executable — regardless
  of prompts or page content.
- **Site guide (soft):** prose you write that steers the agent's behavior.
  It gates nothing.

## Why this works on any site

- **Auth-agnostic:** ibh never touches credentials. `cookie` mode uses the browser's
  own session; `token` mode asks you for a bearer token at call time; `custom` mode
  gives you full control of request init.
- **Framework-agnostic:** one self-contained IIFE/ESM bundle; UI lives in a shadow
  root; navigation works with plain history or your router via a hook.
- **Works on unannotated pages** via accessibility-style snapshots, and works
  *great* on annotated pages via `data-ibh-*` markers.

## Example: the use case it was built for

A user on [gametorch.app](https://gametorch.app) asks: *"make me 3 fire-themed
sprites and compare their palette sizes"*. ibh reads `/api/sprites`, creates the
sprites (user confirms each create), triggers generation, runs the comparison as a
pure JS function in its network-less sandbox, and answers — every step visible in
the audit log.

## LLM access without leaking keys

The browser can't keep secrets, so ibh supports three modes: **BYO user key**
(pure frontend — the visitor's own key), a **backend proxy** (production — point
`llm.baseUrl` at your endpoint; ibh sends no key, your session authenticates, your
server forwards with the key; a zero-dependency reference proxy ships at
`examples/proxy/`, including a **fully documented, tested Cloudflare Worker**
at `examples/proxy/cloudflare/` and an nginx-only config), or a shared site key —
which ibh **refuses to initialize with**. See
[docs/integration-guide.md](docs/integration-guide.md).

## Repo layout

```
packages/
  policy/     manifest schema, fail-closed validation, tiers, rate limits, budgets
  executor/   the gatekeeper + adapters: fetch, DOM, nav, analyze sandbox; audit ledger
  core/       OpenRouter client, system prompt, page context, gated agent loop
  ui/         shadow-DOM panel: chat, consent cards, voice input, audit view
  ibh/        @gametorch/ibh: umbrella — ibh.init(), single-file bundle
  react/      @gametorch/ibh-react: drop-in component for React apps
  vue/        @gametorch/ibh-vue: drop-in component for Vue 3 apps
  angular/    @gametorch/ibh-angular: drop-in directive for Angular apps
  svelte/     @gametorch/ibh-svelte: component + action for Svelte 5
  solid/      @gametorch/ibh-solid: component + directive for SolidJS
  (policy / executor / core / ui are internal, private, never published)
examples/
  plain-html/       minimal integration on a static page
  gametorch-demo/   the reference integration (mock API + dashboard + editor)
  react-next/       integration guide for React / Next.js via @gametorch/ibh-react
  vue/              integration guide for Vue 3 / Nuxt via @gametorch/ibh-vue
  angular/          integration guide for Angular via @gametorch/ibh-angular
  svelte/           integration guide for Svelte 5 / SvelteKit via @gametorch/ibh-svelte
  solid/            integration guide for SolidJS / SolidStart via @gametorch/ibh-solid
docs/
  manifest-spec.md · integration-guide.md · security-model.md · non-goals.md
AGENTS.md           integration playbook for AI coding agents
llms.txt            machine-readable index of every doc (llms.txt standard)
```

## Quick start

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # ~200 tests: manifest validation, gatekeeper security suite,
                    # agent loop, OpenRouter client, DOM/nav adapters, panel UI
                    # options, and every framework binding (react/vue/angular/
                    # svelte/solid) + the Cloudflare proxy worker
pnpm demo           # gametorch reference demo at http://localhost:4173
```

## Development

- **Always use pnpm.** The repo pins `packageManager` (pnpm@12) and commits
  `pnpm-lock.yaml`; CI-style installs should use `pnpm install --frozen-lockfile`.
- **Supply-chain posture**: `strictDepBuilds` (install fails on any non-allow-listed
  install script — the only allow-listed one is esbuild), `minimumReleaseAge: 3 days`
  (freshly published versions are held back for review), overrides to keep
  transitive deps on patched lines, one external runtime dependency per binding
  package, and `pnpm audit` in CI (currently clean). Keep it that lean.

`pnpm test:e2e` runs **true end-to-end tests**: every reference proxy (node,
Rocket, nginx, Apache) is started as a real process, exercised from a headless
browser through the real UI, and driven against the **real OpenRouter API**
(chat completions, tool calls, speech-to-text). Requires
`E2E_OPENROUTER_KEY`; without a key the positive tests skip and only the
negative (never-reaches-OpenRouter) tests run. See
[examples/proxy/e2e/README.md](examples/proxy/e2e/README.md).

The demo prompts for an OpenRouter key (stored in that browser only) — see
[docs/security-model.md](docs/security-model.md) for why a client-side key is
effectively public and how to handle that responsibly.

## Status

v0.1.0 — first working skeleton: manifest validation, gatekeeper, agent loop,
panel UI, audit log. See [docs/non-goals.md](docs/non-goals.md) for deliberate
limitations (no undo, ever).

MIT — see [LICENSE](LICENSE).
