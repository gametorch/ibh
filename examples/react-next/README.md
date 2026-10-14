# ibh in a React / Next.js app

> **LLM access — you almost assuredly want the proxy route.** The snippets
below default to **Mode A (backend proxy)**: `llm={{ baseUrl: '/api/ibh-llm' }}` —
no key in the page, your session cookie authenticates, your server forwards with
the server-side key (reference servers for every stack: [examples/proxy/](../proxy/README.md)).
The alternative is **Mode B (BYO user key)**: the visitor pastes *their own*
OpenRouter key — fine for demos/internal tools, but never ship a shared site key
(`ibh.init()` fails closed on keyless-OpenRouter configs). See
[docs/integration-guide.md](../../docs/integration-guide.md).

ibh ships a first-class React binding: `@gametorch/ibh-react`. It is the reference component —
one element, full lifecycle handling (init on mount, destroy on unmount,
StrictMode-safe), typed ref handle, and pass-through of every `ibh.init` option.

```bash
pnpm add @gametorch/ibh-react
```

`app/ibh.tsx`:

```tsx
'use client';

import { useRef } from 'react';
import { IbhChat, type IbhChatHandle } from '@gametorch/ibh-react';
import { MANIFEST, GUIDE } from './ibh-manifest';

export function Ibh() {
  const router = useRouter();
  const ref = useRef<IbhChatHandle>(null);

  return (
    <IbhChat
      ref={ref}
      manifest={MANIFEST}
      guide={GUIDE}
      auth={{ mode: 'cookie' }}
      llm={{ baseUrl: '/api/ibh-llm' }}
      nav={{ customNavigate: (url) => router.push(url) }}
      ui={{
        theme: 'system',
        showAuditTab: true,
        defaultPosition: { right: 20, bottom: 20 },
        stt: { model: 'elevenlabs/scribe-v2' },
      }}
    />
  );
}
```

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

Assistant replies render as **markdown** by default (safe built-in renderer). Customize or disable with `ui.markdown` — `false` for plain text, or `{ render }` for your own renderer.

Notes:

- Render `<Ibh>` once, high in the tree (e.g. the root layout under a client
  boundary). The panel mounts itself in a shadow root — no CSS setup needed.
- **Never** ship a secret-bearing token to the client unless it already is; with
  Clerk or similar use `auth: { mode: 'token', getToken: () => auth.currentUser?.getToken() }`.
- `nav.customNavigate` with `router.push` keeps the Next.js App Router in sync.
- Mark regions/controls for the agent with `data-ibh-region` / `data-ibh-action`
  directly in your JSX.
- The config (including the manifest) is read once at mount — remount with a new
  `key` to apply a different manifest.

Full props/handle documentation: [packages/react/README.md](../../packages/react/README.md).
