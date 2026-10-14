# ibh in a Solid / SolidStart app

> **LLM access — you almost assuredly want the proxy route.** The snippets
below default to **Mode A (backend proxy)**: `llm={{ baseUrl: '/api/ibh-llm' }}` —
no key in the page, your session cookie authenticates, your server forwards with
the server-side key (reference servers for every stack: [examples/proxy/](../proxy/README.md)).
The alternative is **Mode B (BYO user key)**: the visitor pastes *their own*
OpenRouter key — fine for demos/internal tools, but never ship a shared site key
(`ibh.init()` fails closed on keyless-OpenRouter configs). See
[docs/integration-guide.md](../../docs/integration-guide.md).

ibh ships first-class Solid bindings: `@gametorch/ibh-solid`. The reference artifacts — a
`use:ibhChat` directive (plain function, idiomatic for self-mounting widgets) and a
thin `<IbhChat />` component — with full lifecycle handling and pass-through of
every `ibh.init` option.

```bash
pnpm add @gametorch/ibh-solid
```

`src/App.tsx`:

```tsx
import { useNavigate } from '@solidjs/router';
import { IbhChat } from '@gametorch/ibh-solid';
import type { IbhInstance } from '@gametorch/ibh-solid';
import { MANIFEST, GUIDE } from './ibh-config';

export function App() {
  const navigate = useNavigate();
  let ibh: IbhInstance;

  return (
    <>
      <IbhChat
        manifest={MANIFEST}
        guide={GUIDE}
        auth={{ mode: 'cookie' }}
        llm={{ baseUrl: '/api/ibh-llm' }}
        ui={{
          theme: 'system',
          showAuditTab: true,
          stt: { model: 'elevenlabs/scribe-v2' },
        }}
        nav={{ customNavigate: (url) => navigate(new URL(url).pathname) }}
        onReady={(i) => (ibh = i)}
      />
    </>
  );
}
```

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

Assistant replies render as **markdown** by default (safe built-in renderer). Customize or disable with `ui.markdown` — `false` for plain text, or `{ render }` for your own renderer.

Notes:

- **SSR**: ibh is browser-only. SolidStart: render the component inside client-only
  boundaries (`<Show when={isServer === false}>` or `ssr: false` routes) so
  prerendering never executes `init()`.
- **Never** ship a secret-bearing token to the client unless it already is; with
  token auth use `auth: { mode: 'token', getToken: async () => token }`.
- `nav.customNavigate` hooked to the router keeps SPA navigation in sync.
- Mark regions/controls for the agent with `data-ibh-region` / `data-ibh-action`
  directly in your JSX.
- The config (including the manifest) is read once at mount — remount to apply a
  different manifest.

Full props/handle documentation: [packages/solid/README.md](../../packages/solid/README.md).
