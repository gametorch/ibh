# Integrating ibh into your site

ibh is a single, framework-agnostic bundle. It mounts its UI in a shadow root
(no CSS collisions), piggybacks on your existing auth, and can only do what your
capability manifest explicitly allows.

> **It's a harness, not just a chat bot.** The shipped components render a chat
> panel, and chat is the primary UX — but the runtime underneath executes your
> capability manifest in the user's browser: API calls with their session, DOM
> actions on your declared selectors, navigation, sandboxed computation. Any
> flow your own JS could perform can be expressed as capabilities, so beyond
> copilot-style chat the same integration supports bulk operations, computed
> data answers, guided multi-step flows that do real work, accessibility/voice
> agents (STT is built in), and headless/programmatic use
> (`ui.enabled: false` + `instance.send()` — fail-closed: without a consent UI,
> mutating tiers are denied unless you supply a `consent` handler). The
> [demo](../examples/gametorch-demo/) shows the chat experience; the manifest spec
> is the part that defines what ibh *can* do in your product.

## 1. Install / build

```bash
pnpm install && pnpm build
# artifacts: packages/ibh/dist/index.js (ESM) and packages/ibh/dist/index.global.js (IIFE)
```

`dist/index.global.js` is fully self-contained — drop it on a `<script>` tag or
serve it from a CDN. For bundler-based apps, `import { init } from '@gametorch/ibh'`.

## 2. Declare your manifest

See [manifest-spec.md](./manifest-spec.md). Start small: a couple of read
capabilities at `auto`, one or two actions at `confirm`.

## 3. Initialize

```html
<script src="/ibh/index.global.js"></script>
<script>
  window.ibh.init({
    manifest: {
      version: 1,
      site: { name: 'GameTorch', origin: 'https://gametorch.app' },
      api: [
        { id: 'sprites_list', method: 'GET', path: '/api/sprites', tier: 'auto',
          description: 'List the signed-in user\'s sprites.' },
        { id: 'sprites_generate', method: 'POST', path: '/api/sprites/:id/generate',
          tier: 'confirm', description: 'Generate sprite art.' },
      ],
      nav: [{ id: 'editor', route: '/sprites/:id', tier: 'auto' }],
      policies: { maxMutatingActionsPerSession: 20 },
      llm: {
        allowedModels: ['openai/gpt-6-luna'],
        defaultModel: 'openai/gpt-6-luna',
      },
    },
    guide: `Sprites are pixel-art characters. To publish one you must call
sprites_generate first and then click the Publish button. Never edit sprites
the user did not mention.`,
    auth: { mode: 'cookie' },
    llm: { openRouterKey: SERVE_THIS_FROM_YOUR_CONFIG_ENDPOINT },
  });
</script>
```

### Options

| Option          | Meaning                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `manifest`      | Hard contract (validated fail-closed; init throws on any error).                            |
| `guide`         | Soft contract: prose for the agent. String or `() => string`. Truncated at 8k chars.         |
| `auth`          | `{ mode: 'cookie' }`, `{ mode: 'token', getToken: async () => … }` or `{ mode: 'custom', applyAuth }`. |
| `llm`           | `{ openRouterKey?, baseUrl?, headers? }`. Three modes — see "LLM access" below. Production: point `baseUrl` at your backend proxy (no key in the page); pure frontend: BYO *user* key. A shared site key in the page is refused by init. |
| `ui`            | `{ enabled?, accent?, startOpen?, theme?, hideThemePicker?, showClearConversation?, showAuditTab?, stt?, style?, css?, defaultPosition? }`. `enabled: false` = headless (see security note). Theming & placement: see below. |
| `persistence`   | `{ enabled?, key? }`. Off by default — history, audit log and session approvals live in memory and a refresh starts clean. Enable to store them in localStorage (default key `ibh:session`) and resume on the next load. Budgets/rate limits are never persisted. |
| `consent`       | `(req) => boolean \| Promise<boolean>` used only in headless mode (`ui.enabled: false`). Without it, everything above `auto` is denied (fail-closed). Supplying it opts in to executing consented actions without the panel. |
| `nav`           | `{ customNavigate?: (url) => void }` for framework routers (e.g. Next.js App Router).       |
| `dom`           | `{ snapshotBudgetNodes? }` to tighten the snapshot budget.                                   |

### Session persistence

By default a refresh starts a clean session: the conversation, the audit log and
one-time `session`-tier approvals all live in memory. To resume across page loads,
opt in:

```js
ibh.init({ /* ... */ persistence: { enabled: true } }); // key defaults to 'ibh:session'
```

ibh then writes history, the audit log and session approvals to localStorage and
restores them on the next `init()`. Budgets, rate limits and token spend are
**not** persisted, so a refresh always resets them. Because localStorage is
readable by any script on the origin, leave this off for sensitive sessions.

### Headless consent

With `ui: { enabled: false }` there is no consent surface, so every capability
above `auto` is denied (fail-closed). For trusted automation you can take over
consent explicitly:

```js
ibh.init({
  /* ... */ ui: { enabled: false },
  consent: async (req) => nativeConfirm(`Allow ${req.capabilityId}?`), // or () => true to auto-approve
});
```

The handler receives the same `ConsentRequest` the panel would show (capability
id, action summary, detail lines). If it unconditionally returns `true`, mutating
actions run with nobody watching — only do that for trusted automation, and keep
capabilities that need a human decision out of the manifest.

## 4. LLM access: keys and proxies

The browser cannot keep a secret. ibh supports three modes, and **refuses to init**
when configured with neither a key nor a proxy (fail-closed):

### Mode A — BYO user key (pure frontend)

```js
ibh.init({ /* ... */ llm: { openRouterKey: theEndUsersOwnKey } });
```

The visitor pastes *their own* OpenRouter key (stored in their browser only,
billed to their account). The site owner stores and pays nothing. Great for demos
and internal tools — see the gametorch demo.

### Mode B — backend proxy (production, recommended)

```js
ibh.init({ /* ... */ llm: { baseUrl: '/api/ibh-llm' } }); // no key in the page
```

Requests go to **your** endpoint with no credentials in ibh (same-origin cookies
flow automatically — `credentials: 'include'` — and authenticate the signed-in
user with your existing session). Your server validates the session, enforces the
model allowlist and rate limits server-side, and forwards to OpenRouter with the
server-side key.

A zero-dependency reference proxy ships at [`examples/proxy/server.js`](../examples/proxy/server.js)
(replace its `verifyRequest()` with your session check) along with Next.js and
Cloudflare Worker snippets in [`examples/proxy/README.md`](../examples/proxy/README.md).
For Cloudflare specifically, a **fully documented, deployable, tested Worker**
ships at [`examples/proxy/cloudflare/`](../examples/proxy/cloudflare/README.md) —
and because Workers can read the request body, the model allowlist is enforced
server-side there (unlike the nginx-only variant below).
If your site already runs nginx, [`examples/proxy/nginx.conf.example`](../examples/proxy/nginx.conf.example)
is an nginx-only variant (no application code): it intentionally skips the model
allowlist (plain nginx can't read the body) in favor of **one hardcoded model in
the manifest + an OpenRouter per-key spend cap** — read its caveats (auth
subrequest cost, per-user rate-limit phase ordering, timeouts) in
[`examples/proxy/README.md`](../examples/proxy/README.md).
Apache httpd users get the equivalent at
[`examples/proxy/apache.conf.example`](../examples/proxy/apache.conf.example)
(same tradeoff; auth via `mod_auth_openidc` or the `mod_authnz_fcgi` authorizer,
and an honest rundown of httpd's rate-limiting and timeout caveats).
Teams preferring a compiled binary get a Rust/Rocket server at
[`examples/proxy/rocket/`](../examples/proxy/rocket/README.md) — unlike the
config-only variants it enforces the model allowlist server-side and strips
session cookies by construction.

`ui.stt` inherits the same mode: with a proxy configured, STT routes through it
too (`/audio/transcriptions`); init fails closed if STT would have no reachable
credentials.

### Mode C — shared site key in the page: never

ibh will not initialize with no key while still pointing at OpenRouter directly,
and you should never "solve" that by shipping your own key — it is readable and
drainable by every visitor.

### Models & spend (server-side!)

The manifest's `llm.allowedModels` shapes the *agent*; your proxy should also
enforce it server-side (`ALLOWED_MODELS` in the reference proxy), rate-limit per
user, and cap spend (OpenRouter supports per-key spend limits as a second layer).

**Metering & charging users.** OpenRouter returns the real cost of every request
(`usage.cost`) in the response, so you can track exactly what each user spent and
charge them however you like — pass it through, add a markup, debit credits, or
count it against a plan. Do this in a **business-logic proxy** (the
[node](../examples/proxy/server.js) and [Rocket](../examples/proxy/rocket/)
references read `usage`, attribute it to the verified session user, log an
`ibh.usage {...}` line and set `X-Ibh-*` headers; replace `recordUsage` /
`record_usage` with a write to your billing system). It is not a front-end
concern — the browser has no use for cost — and the config-only proxies
(nginx/Apache) cannot read response bodies, so they can't do it. See
[`examples/proxy/README.md`](../examples/proxy/README.md#2g-metering--charging-your-users--business-logic-proxies-only).

## 5. Annotate your DOM (optional but recommended)

```html
<section data-ibh-region="sprite-editor">
  <input data-ibh-action="sprite-name" placeholder="Sprite name" />
  <button data-ibh-action="generate">Generate</button>
  <button data-ibh-action="publish">Publish</button>
</section>
```

- `data-ibh-region="name"` — labels a section in the page snapshot.
- `data-ibh-action="name"` — marks an interactive element; declare it as a
  `DomCapability` whose selector is `[data-ibh-action="name"]`.
- `data-ibh-label="…"` — override the accessible name used in snapshots.
- `data-ibh-ignore` — keeps a subtree out of snapshots and out of reach.

Unannotated pages still work: ibh snapshots interactive elements (buttons, links,
inputs, headings) with stable refs. Annotations make the agent dramatically more
reliable on dynamic UIs.

## 6. Write the site guide (the soft contract)

A short markdown-ish description of how things work: which capability does what,
what the typical flows are, what to avoid. This steers the agent; it does **not**
constrain it — only the manifest does. Keep it under ~1k words.

## 7. Declarative auto-init

If you cannot run custom JS, set the config before the ibh script loads:

```html
<script>
  window.__IBH_CONFIG__ = { manifest: {...}, guide: '…', llm: { openRouterKey: '…' } };
</script>
<script src="/ibh/index.global.js"></script>
```

Auto-init only supports `auth: { mode: 'cookie' }` (token/custom adapters are
functions, which JSON cannot express). The instance is exposed as `window.ibhInstance`.

## 8. Theming the panel

The panel renders inside a shadow root, so your site CSS can't touch it directly —
instead it exposes a deliberate theming surface:

### Custom properties (stable, recommended)

Pass CSS custom properties via `ui.style`; they are set on the panel host element and
inherit into the shadow root. Pairs naturally with your site's own theme system:

```js
ibh.init({
  // ...
  ui: {
    theme: 'system',          // initial theme: 'system' (default) | 'light' | 'dark'
    hideThemePicker: false,   // hide the header theme button (when YOUR site controls the theme)
    showClearConversation: true, // show the ⟲ "clear conversation" button (hidden by default)
    launcher: { text: 'Ask', title: 'Open the assistant' }, // closed-state circle
    placeholder: 'What can I do for you?',  // composer placeholder
    emptyState: {
      title: 'Welcome to the Home Makeover assistant',  // default: 'Ask ibh about <site>'
      hint: 'Ask me to reorder your catalog…',          // default: 'It reads the site API…'
    },
    style: {
      '--ibh-accent': '#8b6cff',
      '--ibh-radius-panel': '6px',
      '--ibh-radius': '4px',
      '--ibh-radius-s': '3px',
      '--ibh-font': 'ui-sans-serif, system-ui, sans-serif',
    },
    css: `
      :host([data-ibh-theme='dark'])  { --ibh-panel: #15161d; --ibh-border: #262935; }
      :host([data-ibh-theme='light']) { --ibh-panel: #ffffff; --ibh-border: #dfe2ec; }
    `,
  },
});
```

Supported custom properties:

| Property | Default | Controls |
| --- | --- | --- |
| `--ibh-accent` | `#7c5cff` | primary color (bubbles, buttons, highlights) |
| `--ibh-bg` | dark/light palettes | chat area background |
| `--ibh-panel` / `--ibh-panel-2` | palettes | panel + header/composer surfaces |
| `--ibh-border` | palette | all borders |
| `--ibh-text` / `--ibh-muted` | palettes | typography |
| `--ibh-ok` / `--ibh-warn` / `--ibh-danger` | palettes | status colors |
| `--ibh-radius` / `--ibh-radius-s` / `--ibh-radius-panel` | `10/6/14px` | corner radii |
| `--ibh-font` / `--ibh-font-size` | system UI | typography |
| `--ibh-width` / `--ibh-height` | `400/560px` | panel size |
| `--ibh-shadow` | palette | panel drop shadow |
| `--ibh-launcher-bg` / `--ibh-launcher-color` | accent gradient / white | closed-state launcher circle |
| `--ibh-launcher-size` / `--ibh-launcher-radius` | `48px` / `50%` | launcher size + shape |
| `--ibh-launcher-font-size` / `--ibh-launcher-font-weight` / `--ibh-launcher-border` / `--ibh-launcher-shadow` | `15px` / `700` / `none` / accent glow | launcher typography + frame |

### Programmatic theme control

```ts
instance.setTheme('light' | 'dark' | 'system');
```

Drive the panel from your site's own theme picker: hide the panel's picker with
`ui.hideThemePicker: true`, then call `setTheme(...)` when your site's theme changes.
See `examples/gametorch-demo` for a full worked example (site picker → panel sync,
site-matched palette, near-square radii).

### Raw CSS escape hatch

`ui.css` is appended to the panel's shadow root after the base stylesheet, so it can
restyle anything the custom properties don't cover (per-theme via
`:host([data-ibh-theme='…'])` selectors). Internal class names may change between
minor versions — prefer custom properties when they suffice.

### Voice input (speech-to-text)

```js
ui: { stt: { model: 'elevenlabs/scribe-v2', autoSend: true } }
```

When `ui.stt` is set, the composer gains a mic button: click to record, click again
to stop. The recording is posted to OpenRouter's dedicated STT endpoint
(`POST /audio/transcriptions`, `{ model, input_audio: { data, format } }`) using the
integrator's LLM key, and the response's `text` is used as the message. `autoSend:
true` (default) sends the transcript immediately; the user can uncheck the auto-send
toggle to only fill the input. Swap `model` for any STT model in the
[catalog](https://openrouter.ai/models) (e.g. `openai/whisper-large-v3`); `language`
adds a language hint; `endpoint` overrides the request URL. Requires a secure context
(https or localhost) for mic access.

The header's "Audit" tab is likewise opt-in: `ui.showAuditTab: true`.

**Privacy note:** recordings made with the mic are sent to the configured STT
provider (OpenRouter → model vendor) for transcription. Pressing the mic is the
user's consent to that; consider reflecting it in your site's privacy policy.

### Launcher & placeholder

The closed-state launcher circle, the composer placeholder, and the
empty-chat title/hint are fully customizable:

```js
ui: {
  launcher: { text: 'Ask', title: 'Open the assistant' },  // defaults: 'ibh' / 'Open ibh'
  placeholder: 'What can I do for you?',                   // default: 'Ask ibh… (Enter to send)'
  emptyState: {
    title: 'Welcome to the Home Makeover assistant',       // default: 'Ask ibh about <site>'
    hint: 'Ask me to reorder your catalog…',               // default: 'It reads the site API…'
  },
  style: {
    '--ibh-launcher-bg': '#2b2d42',      // or any CSS background (gradient, image…)
    '--ibh-launcher-color': '#ffd166',
    '--ibh-launcher-radius': '12px',     // near-square instead of a circle
    '--ibh-launcher-size': '56px',
    '--ibh-launcher-shadow': '0 4px 20px rgba(0,0,0,0.4)',
  },
}
```

### Drag & resize

Out of the box the panel is draggable (grab its header) and resizable (drag the
bottom-right grip), clamped to the viewport. Geometry persists per origin in
localStorage; double-clicking the header resets position and size to defaults.

### Initial position

```js
ui: { defaultPosition: { left: 1200, top: 16 } }   // or anchor: { right: 24, bottom: 24 }
```

Viewport coordinates for the panel's starting spot; the launcher button follows the
same point. Omitted = bottom-right corner. Persisted user geometry (from dragging)
always wins over `defaultPosition`.

## 9. Framework notes

- **React / Next.js**: mount init inside an effect in a client component; pass
  `nav.customNavigate` that calls `router.push`. See [examples/react-next](../examples/react-next).
- **SPA page changes**: the page snapshot is rebuilt before every model call, so
  client-side route changes are picked up automatically.

## 10. Testing your integration

`examples/gametorch-demo` is the reference integration: a tiny Node server with a
mock API, a dashboard and a sprite editor (visiting auto-signs-you-in as a random
whimsical user — no login flow). Run `pnpm demo` and try:

- "how many sprites do I have?" — read path
- "create a sprite called Ember Fox" — confirm-tier API write
- "publish this sprite" — session-tier DOM click
- "delete everything" — denied by manifest
