# @gametorch/ibh-svelte

Drop-in Svelte 5 bindings for [ibh](../../README.md) — the in-browser agent harness.
Two artifacts, both zero styling setup: the chat panel self-mounts in its own shadow
root, so it works in any Svelte / SvelteKit app without CSS collisions.

```bash
pnpm add @gametorch/ibh-svelte
# ibh itself is installed automatically as a dependency
```

Deliberately minimal, in the spirit of Svelte:
- **`use:ibhChat` action** — a plain function (no component compiler needed); the
  idiomatic Svelte way to attach self-mounting imperative widgets.
- **`<IbhChat />` component** — a thin wrapper over the action for `<IbhChat />`
  syntax; shipped as source, compiled by your own toolchain (as Svelte libraries
  conventionally are).

## LLM access — pick deliberately (you almost assuredly want the proxy)

**There are exactly two sane modes, and the default for production is the proxy
route unless you explicitly decided otherwise.** A key in the page is readable by
the signed-in user and by anyone who can run JavaScript on your site.

**Mode A — backend proxy (production; what you almost assuredly need):** no key
in the page — your session cookie authenticates the request, and your server
forwards to OpenRouter with the server-side key:

```svelte
llm={{ baseUrl: '/api/ibh-llm' }}
```

Reference servers for every stack: [examples/proxy/](../../examples/proxy/README.md)
(node · Cloudflare Worker · nginx · Apache · Rust/Rocket — the node and Cloudflare
ones are copy-paste deployable). `init()` fails closed if you configure neither a
key nor a proxy.

**Mode B — BYO user key (demos / internal tools):** the visitor pastes *their
own* OpenRouter key, stored in their browser only, billed to their account:

```svelte
llm={{ openRouterKey: userPastedKey }}
```

**Never a shared site key.** ibh refuses to initialize with no key while still
pointing at OpenRouter directly. Full details:
[docs/integration-guide.md](../../docs/integration-guide.md) ·
[docs/security-model.md](../../docs/security-model.md)

## The action

```svelte
<script lang="ts">
  import { ibhChat } from '@gametorch/ibh-svelte';
  import type { IbhInstance } from '@gametorch/ibh-svelte';
  let ibh: IbhInstance | null = $state(null);
</script>

<div use:ibhChat={{ ...manifestAndFriends, onReady: (i) => (ibh = i) }}></div>
```

- `init()` runs on attach; `destroy()` on detach; **config is read once at attach**
  — `update()` is a deliberate no-op (the manifest is a contract, not reactive
  state). Re-attach via `{#key}` to apply a new manifest.
- Init failures throw (fail-closed, by design).

## The component

```svelte
<script lang="ts">
  import { IbhChat } from '@gametorch/ibh-svelte';
  const manifest = { /* your capability manifest */ };
</script>

<IbhChat
  {manifest}
  guide="How the agent should work on this site."
  auth={{ mode: 'cookie' }}
  llm={{ baseUrl: '/api/ibh-llm' }}
  ui={{ theme: 'system', showAuditTab: true, stt: { model: 'elevenlabs/scribe-v2' } }}
  bind:this={comp}
/>

<button onclick={() => comp.setTheme('light')}>light</button>
```

Props map 1:1 to `ibh.init()`'s config (see
[docs/integration-guide.md](../../docs/integration-guide.md)) plus `onReady`.
Component exports (`bind:this` or the `mount()` return value):
`send / open / close / setTheme / audit / instance`.

## Behavior notes

- Unmounting (action detach or component unmount) **destroys the harness** —
  history, audit log and session approvals die with it.
- **Sync your site theme**: hide the panel's picker (`hideThemePicker: true`) and
  call `ibh?.setTheme(...)` when your app's theme changes.

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

## Security note

The panel and the manifest gate what the *agent* does, client-side. They are not a
security boundary — assume ibh has the same permissions as the signed-in user and
enforce authorization server-side. See
[docs/security-model.md](../../docs/security-model.md).
