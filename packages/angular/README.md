# @gametorch/ibh-angular

Drop-in Angular bindings for [ibh](../../README.md) — the in-browser agent harness.
One standalone directive, zero styling setup: the chat panel self-mounts in its own
shadow root, so it works in any Angular app (standalone or NgModule) without CSS
collisions.

```bash
pnpm add @gametorch/ibh-angular
# ibh itself is installed automatically as a dependency
```

Deliberately minimal: the package is a **template-less standalone directive**, so it
needs only `@angular/core` at runtime — no `@angular/compiler` (your app's own build
compiles your templates), no `platform-browser`, no zone.js requirement (works with
zoneless change detection).

## Usage

```ts
import { Component } from '@angular/core';
import { IbhChat } from '@gametorch/ibh-angular';

@Component({
  selector: 'app-root',
  imports: [IbhChat],
  template: `
    <ibh-chat
      [manifest]="manifest"
      [guide]="guide"
      [auth]="auth"
      [llm]="llm"
      [ui]="ui"
      (ready)="onReady($event)"
    />
  `,
})
export class AppComponent {
  manifest = { /* your capability manifest */ };
  guide = 'How the agent should work on this site.';
  auth = { mode: 'cookie' as const };
  llm = { baseUrl: '/api/ibh-llm' };
  ui = {
    theme: 'system' as const,
    showAuditTab: true,
    stt: { model: 'elevenlabs/scribe-v2' },
  };

  onReady(instance: IbhChat['instance'] extends () => infer R ? R : never): void {
    console.log('ibh ready', instance);
  }
}
```

Or use the attribute form on any element: `<div ibhChat [manifest]="..." ... />`.

## LLM access — pick deliberately (you almost assuredly want the proxy)

**There are exactly two sane modes, and the default for production is the proxy
route unless you explicitly decided otherwise.** A key in the page is readable by
the signed-in user and by anyone who can run JavaScript on your site.

**Mode A — backend proxy (production; what you almost assuredly need):** no key
in the page — your session cookie authenticates the request, and your server
forwards to OpenRouter with the server-side key:

```ts
llm = { baseUrl: '/api/ibh-llm' };
```

Reference servers for every stack: [examples/proxy/](../../examples/proxy/README.md)
(node · Cloudflare Worker · nginx · Apache · Rust/Rocket — the node and Cloudflare
ones are copy-paste deployable). `init()` fails closed if you configure neither a
key nor a proxy.

**Mode B — BYO user key (demos / internal tools):** the visitor pastes *their
own* OpenRouter key, stored in their browser only, billed to their account:

```ts
llm = { openRouterKey: userPastedKey };
```

**Never a shared site key.** ibh refuses to initialize with no key while still
pointing at OpenRouter directly. Full details:
[docs/integration-guide.md](../../docs/integration-guide.md) ·
[docs/security-model.md](../../docs/security-model.md)

## Inputs / outputs

Inputs map 1:1 to `ibh.init()`'s config (see
[docs/integration-guide.md](../../docs/integration-guide.md)): `manifest`,
`guide`, `auth`, `llm`, `ui`, `nav`, `dom`. Output: `ready` (emits the live
`IbhInstance` once, after successful init).

The directive instance itself is the handle — grab it with a template ref:

```html
<ibh-chat #ibh [manifest]="manifest" [auth]="auth" [llm]="llm" />
```

```ts
@ViewChild('ibh') ibh?: IbhChat;
// ibh.send('...'); ibh.setTheme('dark'); ibh.audit();
```

## Behavior notes

- **Config is read once at `ngOnInit`.** The manifest is a contract, not reactive
  state — input changes never re-init (there is no `ngOnChanges` handler);
  remount (via `@if`/structural change or `key`) to apply a new one.
- **`ngOnDestroy` destroys the harness** — history, audit log and session approvals
  die with it.
- **Init failures propagate**: an invalid manifest throws into Angular's
  `ErrorHandler` (fail-closed, by design).
- **Sync your site theme**: hide the panel's picker (`hideThemePicker: true`) and
  call `this.ibh?.setTheme(...)` when your app's theme changes.
- Requires Angular >= 19 (standalone-by-default era). No zone.js requirement.

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

## Security note

The panel and the manifest gate what the *agent* does, client-side. They are not a
security boundary — assume ibh has the same permissions as the signed-in user and
enforce authorization server-side. See
[docs/security-model.md](../../docs/security-model.md).
