# @gametorch/ibh

The umbrella package for **ibh** — an application-agnostic, in-browser agent
harness you drop into any website. The chat panel self-mounts in its own shadow
root and acts on behalf of the signed-in user through an explicit, enforced
capability manifest.

This package is **self-contained** (runtime + UI bundled): framework bindings
live in separate packages, so you only pull the one you need:

- [`@gametorch/ibh-react`](https://www.npmjs.com/package/@gametorch/ibh-react) — React
- [`@gametorch/ibh-vue`](https://www.npmjs.com/package/@gametorch/ibh-vue) — Vue 3
- [`@gametorch/ibh-angular`](https://www.npmjs.com/package/@gametorch/ibh-angular) — Angular
- [`@gametorch/ibh-svelte`](https://www.npmjs.com/package/@gametorch/ibh-svelte) — Svelte 5
- [`@gametorch/ibh-solid`](https://www.npmjs.com/package/@gametorch/ibh-solid) — SolidJS

## Script-tag usage (any site)

```html
<script>
  window.__IBH_CONFIG__ = {
    manifest: { /* your capability manifest — see the docs */ },
    llm: { baseUrl: '/api/ibh-llm' }, // proxy mode: no key in the page
  };
</script>
<script src=".../index.global.js"></script>
<!-- instance exposed as window.ibhInstance -->
```

## Bundler usage

```bash
pnpm add @gametorch/ibh
```

```ts
import { init } from '@gametorch/ibh';

init({
  manifest: { /* ... */ },
  auth: { mode: 'cookie' },
  llm: { baseUrl: '/api/ibh-llm' }, // production: backend proxy (see docs)
});
```

## LLM access — pick deliberately

- **Mode A — backend proxy (production):** `llm: { baseUrl: '/api/ibh-llm' }` —
  no key in the page; your session cookie authenticates; your server forwards to
  OpenRouter with the server-side key. Reference servers for every stack ship in
  the repo (`examples/proxy/`).
- **Mode B — BYO user key (demos):** `llm: { openRouterKey: <the user's own key> }`.
- **Never a shared site key** — `init()` fails closed on keyless configs still
  pointing at OpenRouter.

## Docs

Full documentation (manifest spec, integration guide, security model) lives in
the [ibh repository](https://github.com/gametorch/ibh).
