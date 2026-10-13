# @gametorch/ibh-react

Drop-in React bindings for [ibh](../../README.md) — the in-browser agent harness.
One component, zero styling setup: the chat panel self-mounts in its own shadow
root, so it works in any React app (Vite, Next.js, CRA, Remix) without CSS collisions.

```bash
pnpm add @gametorch/ibh-react
# ibh itself is installed automatically as a dependency
```

## Usage

```tsx
import { IbhChat, type IbhChatHandle } from '@gametorch/ibh-react';
import { useRef } from 'react';

const manifest = {
  version: 1,
  site: { name: 'MyApp', origin: 'https://myapp.com' },
  api: [
    { id: 'items_list', method: 'GET', path: '/api/items', tier: 'auto' },
    { id: 'items_create', method: 'POST', path: '/api/items', tier: 'confirm' },
  ],
  policies: { maxMutatingActionsPerSession: 20 },
  llm: { allowedModels: ['openai/gpt-6-luna'], defaultModel: 'openai/gpt-6-luna' },
};

export function Ibh() {
  const ref = useRef<IbhChatHandle>(null);
  return (
    <IbhChat
      ref={ref}
      manifest={manifest}
      guide="Items are {id, name, done}. Creating an item requires the user's name input."
      auth={{ mode: 'cookie' }}
      llm={{ baseUrl: '/api/ibh-llm' }}
      ui={{
        theme: 'system',
        showAuditTab: true,
        stt: { model: 'elevenlabs/scribe-v2' },
      }}
      onReady={(inst) => console.log('ibh ready', inst.version)}
    />
  );
}
```

## LLM access — pick deliberately (you almost assuredly want the proxy)

**There are exactly two sane modes, and the default for production is the proxy
route unless you explicitly decided otherwise.** A key in the page is readable by
the signed-in user and by anyone who can run JavaScript on your site.

**Mode A — backend proxy (production; what you almost assuredly need):** no key
in the page — your session cookie authenticates the request, and your server
forwards to OpenRouter with the server-side key:

```tsx
llm={{ baseUrl: '/api/ibh-llm' }}
```

Reference servers for every stack: [examples/proxy/](../../examples/proxy/README.md)
(node · Cloudflare Worker · nginx · Apache · Rust/Rocket — the node and Cloudflare
ones are copy-paste deployable). `init()` fails closed if you configure neither a
key nor a proxy.

**Mode B — BYO user key (demos / internal tools):** the visitor pastes *their
own* OpenRouter key, stored in their browser only, billed to their account:

```tsx
llm={{ openRouterKey: userPastedKey }}
```

**Never a shared site key.** ibh refuses to initialize with no key while still
pointing at OpenRouter directly. Full details:
[docs/integration-guide.md](../../docs/integration-guide.md) ·
[docs/security-model.md](../../docs/security-model.md)

## Props

`IbhChatProps` is exactly `ibh.init()`'s config (see
[docs/integration-guide.md](../../docs/integration-guide.md)) plus `onReady?`.
Every ui option is available: `theme`, `hideThemePicker`, `showClearConversation`,
`showAuditTab`, `stt`, `style`, `css`, `defaultPosition`, `startOpen`, `accent`.

## Ref handle

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

- **Config is read once at mount.** The manifest is a contract, not reactive state —
  remount (via `key`) to apply a new one.
- **StrictMode-safe**: the double-mount destroys the first instance cleanly; exactly
  one harness survives.
- **Init failures propagate**: an invalid manifest throws into your error boundary
  (fail-closed, by design).
- **Sync your site theme**: hide the panel's picker (`hideThemePicker: true`) and call
  `ref.current?.setTheme(...)` when your app's theme changes.

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

## Security note

The panel and the manifest gate what the *agent* does, client-side. They are not a
security boundary — assume ibh has the same permissions as the signed-in user and
enforce authorization server-side. See
[docs/security-model.md](../../docs/security-model.md).
