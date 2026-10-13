// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavAdapter } from './adapters/nav';

const ORIGIN = 'https://example.com';

afterEach(() => {
  vi.restoreAllMocks();
  history.pushState(null, '', '/');
});

describe('NavAdapter', () => {
  it('rejects cross-origin navigation in both modes — ibh never leaves the site', () => {
    const nav = new NavAdapter({ siteOrigin: ORIGIN });
    for (const mode of ['spa', 'full'] as const) {
      const r = nav.navigate('https://evil.com/steal', mode);
      expect(r.ok).toBe(false);
      expect(r.summary).toContain('cross-origin');
    }
    const protocol = nav.navigate('javascript:alert(1)', 'spa');
    expect(protocol.ok).toBe(false);
  });

  it('spa mode: pushState + popstate dispatch, path-only navigation', () => {
    const nav = new NavAdapter({ siteOrigin: location.origin });
    const popstate = vi.fn();
    window.addEventListener('popstate', popstate);
    const pushSpy = vi.spyOn(history, 'pushState');
    const r = nav.navigate('/sprites/7', 'spa');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('/sprites/7');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe('/sprites/7');
    expect(popstate).toHaveBeenCalledTimes(1);
    window.removeEventListener('popstate', popstate);
    pushSpy.mockRestore();
  });

  it('full mode resolves the same-origin URL and hands off to a real page load', () => {
    // jsdom's location.assign is not spyable (non-configurable); the semantic we
    // can assert is that full mode is allowed for same-origin and reports itself.
    const nav = new NavAdapter({ siteOrigin: ORIGIN });
    const r = nav.navigate('/sprites/7', 'full');
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('full load');
  });

  it('hosts with framework routers can take over via customNavigate', () => {
    const custom = vi.fn();
    const nav = new NavAdapter({ siteOrigin: ORIGIN, customNavigate: custom });
    const r = nav.navigate('/sprites/7', 'spa');
    expect(r.ok).toBe(true);
    expect(custom).toHaveBeenCalledWith('https://example.com/sprites/7');
  });
});
