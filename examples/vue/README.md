# ibh in a Vue 3 / Nuxt app

> **LLM access — you almost assuredly want the proxy route.** The snippets
below default to **Mode A (backend proxy)**: `llm={{ baseUrl: '/api/ibh-llm' }}` —
no key in the page, your session cookie authenticates, your server forwards with
the server-side key (reference servers for every stack: [examples/proxy/](../proxy/README.md)).
The alternative is **Mode B (BYO user key)**: the visitor pastes *their own*
OpenRouter key — fine for demos/internal tools, but never ship a shared site key
(`ibh.init()` fails closed on keyless-OpenRouter configs). See
[docs/integration-guide.md](../../docs/integration-guide.md).

ibh ships first-class Vue bindings: `@gametorch/ibh-vue`. It is the reference component — one
element, full lifecycle handling (init on mount, destroy on unmount), typed template
ref, and pass-through of every `ibh.init` option.

```bash
pnpm add @gametorch/ibh-vue
```

`components/Ibh.vue` (Vue 3):

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { IbhChat, type IbhChatHandle } from '@gametorch/ibh-vue';
import { MANIFEST, GUIDE } from './ibh-config';

const router = useRouter();
const ibh = ref<IbhChatHandle>();
</script>

<template>
  <IbhChat
    ref="ibh"
    :manifest="MANIFEST"
    :guide="GUIDE"
    :auth="{ mode: 'cookie' }"
    :llm="{ baseUrl: '/api/ibh-llm' }"
    :nav="{ customNavigate: (url: string) => router.push(url) }"
    :ui="{ theme: 'system', showAuditTab: true, stt: { model: 'elevenlabs/scribe-v2' } }"
  />
</template>
```

Nuxt: render `<Ibh>` from a client plugin / inside a `.client.vue` component
(ibh only runs in the browser). Mark regions/controls for the agent with
`data-ibh-region` / `data-ibh-action` directly in your templates.

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

Notes:

- With Clerk-style token auth, use `auth: { mode: 'token', getToken: ... }`; with
  cookie sessions use `auth: { mode: 'cookie' }`.
- The config (including the manifest) is read once at mount — remount with a new
  `:key` to apply a different manifest.

Full props/handle documentation: [packages/vue/README.md](../../packages/vue/README.md).
