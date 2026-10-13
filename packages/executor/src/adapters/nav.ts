export type NavMode = 'spa' | 'full';

export interface NavResult {
  ok: boolean;
  summary: string;
  error?: string;
}

export interface NavExecutor {
  navigate(route: string, mode: NavMode): NavResult;
}

/**
 * Navigation adapter. Hosts using client-side routers with custom APIs (e.g. the
 * Next.js App Router) should provide `customNavigate`; the default implementation
 * works with plain history-based routers and full page loads.
 */
export class NavAdapter implements NavExecutor {
  constructor(
    private readonly opts: { siteOrigin: string; customNavigate?: (url: string) => void | Promise<void> }
  ) {}

  navigate(route: string, mode: NavMode): NavResult {
    let url: URL;
    try {
      url = new URL(route, this.opts.siteOrigin);
    } catch {
      return { ok: false, summary: `invalid route "${route}"` };
    }
    if (url.origin !== this.opts.siteOrigin) {
      return { ok: false, summary: `blocked: navigation to cross-origin ${url.origin}` };
    }

    const display = `${url.pathname}${url.search}`;
    if (mode === 'full') {
      location.assign(url.toString());
      return { ok: true, summary: `navigating (full load) to ${display}` };
    }

    if (this.opts.customNavigate) {
      void this.opts.customNavigate(url.toString());
      return { ok: true, summary: `navigating (host router) to ${display}` };
    }

    history.pushState(history.state, '', url.toString());
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    return { ok: true, summary: `navigated to ${display}` };
  }
}
