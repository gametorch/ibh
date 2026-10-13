# ibh in a Svelte 5 / SvelteKit app

> **LLM access — you almost assuredly want the proxy route.** The snippets
below default to **Mode A (backend proxy)**: `llm={{ baseUrl: '/api/ibh-llm' }}` —
no key in the page, your session cookie authenticates, your server forwards with
the server-side key (reference servers for every stack: [examples/proxy/](../proxy/README.md)).
The alternative is **Mode B (BYO user key)**: the visitor pastes *their own*
OpenRouter key — fine for demos/internal tools, but never ship a shared site key
(`ibh.init()` fails closed on keyless-OpenRouter configs). See
[docs/integration-guide.md](../../docs/integration-guide.md).

ibh ships first-class Svelte bindings: `@gametorch/ibh-svelte`. The reference artifacts — a
`use:ibhChat` action (plain function, idiomatic for self-mounting widgets) and a
thin `<IbhChat />` component — with full lifecycle handling and pass-through of
every `ibh.init` option.

```bash
pnpm add @gametorch/ibh-svelte
```

`src/routes/+page.svelte` (SvelteKit):

```svelte
<script lang="ts">
  import { IbhChat } from '@gametorch/ibh-svelte';
  import { MANIFEST, GUIDE } from '$lib/ibh-config';

  let comp: IbhChat;
</script>

<IbhChat
  bind:this={comp}
  {manifest: MANIFEST}
  guide={GUIDE}
  auth={{ mode: 'cookie' }}
  llm={{ baseUrl: '/api/ibh-llm' }}
  ui={{
    theme: 'system',
    showAuditTab: true,
    stt: { model: 'elevenlabs/scribe-v2' },
  }}
  nav={{ customNavigate: (url) => goto(url) }}
/>
```

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

Notes:

- **SSR**: ibh is browser-only. Gate the component behind a browser check
  (`{#if browser}` with `browser` from `$app/environment`) or render it inside
  `onMount`/client-only routes — SvelteKit prerendering must not execute `init()`.
- **Never** ship a secret-bearing token to the client unless it already is; with
  token auth use `auth: { mode: 'token', getToken: async () => token }`.
- `nav.customNavigate` hooked to `goto` from `$app/navigation` keeps SPA
  navigation in sync.
- Mark regions/controls for the agent with `data-ibh-region` / `data-ibh-action`
  directly in your markup.
- The config (including the manifest) is read once at attach — re-attach (via
  `{#key}`) to apply a different manifest.

Full props/handle documentation: [packages/svelte/README.md](../../packages/svelte/README.md).
