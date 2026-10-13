# @gametorch/ibh-vue

Drop-in Vue 3 bindings for [ibh](../../README.md) — the in-browser agent harness.
One component, zero styling setup: the chat panel self-mounts in its own shadow
root, so it works in any Vue app (Vite, Nuxt, plain) without CSS collisions.

```bash
pnpm add @gametorch/ibh-vue
# ibh itself is installed automatically as a dependency
```

Deliberately minimal: the package is a single render-function component — no SFC
compiler, no test-utils, no extra toolchain. `vue` is a peer dependency you already
ship.

## Usage

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { IbhChat, type IbhChatHandle } from '@gametorch/ibh-vue';
import { manifest, guide } from './ibh-config';

const ibh = ref<IbhChatHandle>();
</script>

<template>
  <IbhChat
    ref="ibh"
    :manifest="manifest"
    :guide="guide"
    :auth="{ mode: 'cookie' }"
    :llm="{ baseUrl: '/api/ibh-llm' }"
    :ui="{ theme: 'system', showAuditTab: true, stt: { model: 'elevenlabs/scribe-v2' } }"
    @vue:mounted="() => {}"
  />
</template>
```

Props map 1:1 to `ibh.init()`'s config (see
[docs/integration-guide.md](../../docs/integration-guide.md)): `manifest`,
`guide`, `auth`, `llm`, `ui`, `nav`, `dom`, plus `onReady`.

## LLM access — pick deliberately (you almost assuredly want the proxy)

**There are exactly two sane modes, and the default for production is the proxy
route unless you explicitly decided otherwise.** A key in the page is readable by
the signed-in user and by anyone who can run JavaScript on your site.

**Mode A — backend proxy (production; what you almost assuredly need):** no key
in the page — your session cookie authenticates the request, and your server
forwards to OpenRouter with the server-side key:

```
:llm="{ baseUrl: '/api/ibh-llm' }"
```

Reference servers for every stack: [examples/proxy/](../../examples/proxy/README.md)
(node · Cloudflare Worker · nginx · Apache · Rust/Rocket — the node and Cloudflare
ones are copy-paste deployable). `init()` fails closed if you configure neither a
key nor a proxy.

**Mode B — BYO user key (demos / internal tools):** the visitor pastes *their
own* OpenRouter key, stored in their browser only, billed to their account:

```
:llm="{ openRouterKey: userPastedKey }"
```

**Never a shared site key.** ibh refuses to initialize with no key while still
pointing at OpenRouter directly. Full details:
[docs/integration-guide.md](../../docs/integration-guide.md) ·
[docs/security-model.md](../../docs/security-model.md)

## Template ref handle

```ts
interface IbhChatHandle {
  send(text: string): void;
  open(): void;
  close(): void;
  setTheme(theme: 'light' | 'dark' | 'system'): void;
  audit(): readonly AuditEntry[];
  instance(): IbhInstance | null;
}
```

## Behavior notes

- **Config is read once at mount** (`onMounted`). The manifest is a contract, not
  reactive state — remount (via `:key`) to apply a new one.
- **Unmount destroys the harness** (`onUnmounted`) — history, audit log and session
  approvals die with it.
- **Init failures propagate**: an invalid manifest throws into Vue's
  `app.config.errorHandler` (fail-closed, by design).
- **Sync your site theme**: hide the panel's picker (`hideThemePicker: true`) and
  call `ibh.value?.setTheme(...)` when your app's theme changes.

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

## Security note

The panel and the manifest gate what the *agent* does, client-side. They are not a
security boundary — assume ibh has the same permissions as the signed-in user and
enforce authorization server-side. See
[docs/security-model.md](../../docs/security-model.md).
