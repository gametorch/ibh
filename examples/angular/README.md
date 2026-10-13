# ibh in an Angular app

> **LLM access — you almost assuredly want the proxy route.** The snippets
below default to **Mode A (backend proxy)**: `llm={{ baseUrl: '/api/ibh-llm' }}` —
no key in the page, your session cookie authenticates, your server forwards with
the server-side key (reference servers for every stack: [examples/proxy/](../proxy/README.md)).
The alternative is **Mode B (BYO user key)**: the visitor pastes *their own*
OpenRouter key — fine for demos/internal tools, but never ship a shared site key
(`ibh.init()` fails closed on keyless-OpenRouter configs). See
[docs/integration-guide.md](../../docs/integration-guide.md).

ibh ships first-class Angular bindings: `@gametorch/ibh-angular`. It is the reference
component — one standalone directive, full lifecycle handling (init on
`ngOnInit`, destroy on `ngOnDestroy`), template-ref handle, and pass-through of
every `ibh.init` option.

```bash
pnpm add @gametorch/ibh-angular
```

`app/app.component.ts`:

```ts
import { Component } from '@angular/core';
import { IbhChat } from '@gametorch/ibh-angular';
import { MANIFEST, GUIDE } from './ibh-config';

@Component({
  selector: 'app-root',
  imports: [IbhChat],
  template: `
    <ibh-chat
      #ibh
      [manifest]="MANIFEST"
      [guide]="GUIDE"
      [auth]="auth"
      [llm]="llm"
      [ui]="ui"
      [nav]="nav"
    />
  `,
})
export class AppComponent {
  readonly MANIFEST = MANIFEST;
  readonly GUIDE = GUIDE;
  readonly auth = { mode: 'cookie' as const };
  readonly llm = { baseUrl: '/api/ibh-llm' };
  readonly ui = {
    theme: 'system' as const,
    showAuditTab: true,
    stt: { model: 'elevenlabs/scribe-v2' },
  };
  readonly nav = {
    customNavigate: (url: string) => this.router.navigateByUrl(new URL(url).pathname),
  };
  constructor(private router: Router) {}
}
```

Launcher (closed-state circle), its colors, the composer placeholder, and the empty-chat title/hint are fully customizable — see theming docs (`ui.launcher`, `ui.placeholder`, `ui.emptyState`, `--ibh-launcher-*`).

Notes:

- Angular's own AOT build compiles your templates — `@gametorch/ibh-angular` needs no
  compiler at runtime; the directive is a template-less standalone class.
- **Never** ship a secret-bearing token to the client unless it already is; with
  token auth use `auth: { mode: 'token', getToken: () => this.auth.getToken() }`.
- `nav.customNavigate` hooked to the Angular `Router` keeps SPA navigation in sync.
- Mark regions/controls for the agent with `data-ibh-region` / `data-ibh-action`
  directly in your templates.
- The config (including the manifest) is read once at `ngOnInit` — remount
  (structural change / `@if`) to apply a different manifest.

Full inputs/handle documentation: [packages/angular/README.md](../../packages/angular/README.md).
