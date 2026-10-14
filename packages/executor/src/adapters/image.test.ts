// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageAdapter } from './image';
import type { DomExecutor } from './dom';

const ORIGIN = 'https://example.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeDom(overrides: Partial<DomExecutor> = {}): DomExecutor {
  return {
    resolve: () => ({ el: null, error: 'no element matches' }),
    describe: () => 'element',
    act: () => ({ ok: true, summary: '' }),
    snapshot: () => ({ url: '', title: '', tree: '', refs: {} }),
    ...overrides,
  };
}

describe('ImageAdapter (attach_image capture)', () => {
  it('requires exactly one source', async () => {
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom: makeDom() });
    expect((await adapter.capture({})).ok).toBe(false);
    const two = await adapter.capture({ url: 'https://example.com/a.png', svg: '<svg/>' });
    expect(two.ok).toBe(false);
    expect(two.summary).toContain('exactly one');
  });

  it('passes a data: URL through unchanged', async () => {
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom: makeDom() });
    const r = await adapter.capture({ url: 'data:image/png;base64,AAAA', label: 'inline' });
    expect(r.ok).toBe(true);
    expect(r.image?.url).toBe('data:image/png;base64,AAAA');
    expect(r.image?.name).toBe('inline');
  });

  it('fetches a same-origin image and converts it to a data URL', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    })) as unknown as typeof fetch;
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom: makeDom(), fetchImpl });
    const r = await adapter.capture({ url: 'https://example.com/art/sprite.png' });
    expect(r.ok).toBe(true);
    expect(r.image?.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/art/sprite.png', { credentials: 'include' });
    expect(r.image?.name).toBe('sprite.png');
  });

  it('rejects a cross-origin url (no arbitrary third-party fetches)', async () => {
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom: makeDom() });
    const r = await adapter.capture({ url: 'https://evil.example/x.png' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('same-origin');
  });

  it('rejects markup that is not SVG', async () => {
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom: makeDom() });
    const r = await adapter.capture({ svg: 'hello world' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('SVG');
  });

  it('fails gracefully when SVG cannot be rasterized', async () => {
    class FailingImage {
      crossOrigin = '';
      private handlers: Record<string, Array<() => void>> = {};
      addEventListener(type: string, cb: () => void): void {
        (this.handlers[type] ??= []).push(cb);
      }
      get src(): string {
        return '';
      }
      set src(_value: string) {
        queueMicrotask(() => this.handlers.error?.forEach((cb) => cb()));
      }
    }
    vi.stubGlobal('Image', FailingImage);
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom: makeDom() });
    const r = await adapter.capture({ svg: '<svg width="10" height="10"></svg>' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('rasterize');
  });

  it('captures a canvas element as a data URL', async () => {
    const canvas = document.createElement('canvas');
    (canvas as unknown as { toDataURL: () => string }).toDataURL = () => 'data:image/png;base64,CANVAS';
    const dom = makeDom({ resolve: () => ({ el: canvas }) });
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom });
    const r = await adapter.capture({ selector: '#c' });
    expect(r.ok).toBe(true);
    expect(r.image?.url).toBe('data:image/png;base64,CANVAS');
  });

  it('reports when the selected element has no image to capture', async () => {
    const dom = makeDom({ resolve: () => ({ el: document.createElement('div') }) });
    const adapter = new ImageAdapter({ siteOrigin: ORIGIN, dom });
    const r = await adapter.capture({ selector: '#nothing' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('no <img>, <svg> or <canvas>');
  });
});
