import type { DomExecutor } from './dom';

/**
 * Image capture for the `attach_image` builtin: turns an image the agent found
 * (API-returned SVG markup, a same-origin image URL, or an element on the page)
 * into a base64 data URL the model can see with a vision-capable model.
 *
 * Security posture (builtins are always available, like page_snapshot/analyze):
 * - `url` is restricted to the SITE ORIGIN or a `data:` URL — the model can read
 *   what the page/API already exposed, but cannot make the browser fetch an
 *   arbitrary third-party URL.
 * - `selector` / `ref` are resolved through the DOM adapter, so ibh's own UI is
 *   out of bounds.
 * - size is capped so a single call cannot blow up the request body / context.
 */

export type ImageDetail = 'auto' | 'low' | 'high';

export interface CapturedImage {
  /** A `data:` URL (base64) ready for the multimodal chat-completions shape. */
  url: string;
  name?: string;
  mime?: string;
  size?: number;
  detail?: ImageDetail;
}

export interface ImageCaptureSource {
  /** Same-origin or `data:` image URL. */
  url?: string;
  /** CSS selector for an <img>, <svg> or <canvas> on the page. */
  selector?: string;
  /** A page_snapshot ref ("#rN") for such an element. */
  ref?: string;
  /** Raw SVG markup (e.g. art returned by the site's API). */
  svg?: string;
  detail?: ImageDetail;
  label?: string;
}

export interface ImageCaptureResult {
  ok: boolean;
  summary: string;
  image?: CapturedImage;
}

export interface ImageExecutor {
  capture(source: ImageCaptureSource): Promise<ImageCaptureResult>;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_SVG_CHARS = 500_000;
const DEFAULT_RASTER_SIZE = 512;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(new Error('could not read the image data')));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('image load timed out')), 10_000);
    img.addEventListener('load', () => {
      clearTimeout(timer);
      resolve(img);
    });
    img.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('image failed to load'));
    });
    img.src = src;
  });
}

/** Best-effort intrinsic size for an SVG (width/height attrs, else viewBox, else default). */
function svgSize(markup: string): { width: number; height: number } {
  const width = /<svg[^>]*\swidth=["']?([\d.]+)/iu.exec(markup)?.[1];
  const height = /<svg[^>]*\sheight=["']?([\d.]+)/iu.exec(markup)?.[1];
  if (width && height) return { width: Math.round(Number(width)), height: Math.round(Number(height)) };
  const viewBox = /<svg[^>]*\sviewBox=["']?\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/iu.exec(markup);
  if (viewBox) return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
  return { width: DEFAULT_RASTER_SIZE, height: DEFAULT_RASTER_SIZE };
}

/** Rasterize SVG markup to a PNG data URL (vision models don't accept SVG). */
async function rasterizeSvg(markup: string): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  try {
    const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(objectUrl);
      const { width, height } = svgSize(markup);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

const isSvg = (el: Element): boolean => el.tagName.toLowerCase() === 'svg';

/** MIME type of a `data:` URL (e.g. `data:image/png;base64,...` -> `image/png`). */
function dataUrlMime(url: string): string | undefined {
  return /^data:([^;,]+)/iu.exec(url)?.[1];
}

export class ImageAdapter implements ImageExecutor {
  constructor(
    private readonly opts: {
      siteOrigin: string;
      dom: DomExecutor;
      /** Override for tests. */
      fetchImpl?: typeof fetch;
    }
  ) {}

  async capture(source: ImageCaptureSource): Promise<ImageCaptureResult> {
    const provided = [source.url, source.selector, source.ref, source.svg].filter(
      (v) => typeof v === 'string' && v.length > 0
    );
    if (provided.length !== 1) {
      return { ok: false, summary: 'attach_image needs exactly one of: url, selector, ref, svg' };
    }
    if (source.svg !== undefined) return await this.fromSvg(source);
    if (source.url !== undefined) return await this.fromUrl(source);
    return await this.fromElement(source);
  }

  private done(source: ImageCaptureSource, url: string, name: string, mime?: string, size?: number): ImageCaptureResult {
    return {
      ok: true,
      summary: `attached image "${name}"${size ? ` (~${Math.max(1, Math.round(size / 1024))} KB)` : ''}`,
      image: { url, name, mime, size, detail: source.detail },
    };
  }

  private async fromUrl(source: ImageCaptureSource): Promise<ImageCaptureResult> {
    const raw = source.url as string;
    if (raw.startsWith('data:')) {
      return this.done(source, raw, source.label ?? 'inline image', dataUrlMime(raw));
    }
    let parsed: URL;
    try {
      parsed = new URL(raw, typeof location === 'undefined' ? 'http://localhost/' : location.href);
    } catch {
      return { ok: false, summary: `attach_image: invalid url "${raw}"` };
    }
    if (parsed.origin !== this.opts.siteOrigin) {
      return {
        ok: false,
        summary: `attach_image: url must be same-origin (${this.opts.siteOrigin}) or a data: URL; got ${parsed.origin}`,
      };
    }
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(parsed.href, { credentials: 'include' });
    } catch (e) {
      return { ok: false, summary: `attach_image: fetching the image failed (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!res.ok) return { ok: false, summary: `attach_image: fetching the image failed (HTTP ${res.status})` };
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) {
      return { ok: false, summary: `attach_image: image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB` };
    }
    const url = await blobToDataUrl(blob);
    return this.done(source, url, source.label ?? parsed.pathname.split('/').pop() ?? 'image', blob.type, blob.size);
  }

  private async fromSvg(source: ImageCaptureSource): Promise<ImageCaptureResult> {
    const markup = source.svg as string;
    if (markup.length > MAX_SVG_CHARS) return { ok: false, summary: 'attach_image: svg markup is too large' };
    if (!/<svg[\s>]/iu.test(markup)) return { ok: false, summary: 'attach_image: "svg" does not look like SVG markup' };
    const url = await rasterizeSvg(markup);
    if (!url) return { ok: false, summary: 'attach_image: could not rasterize the SVG (no canvas support in this environment)' };
    return this.done(source, url, source.label ?? 'svg image', 'image/png');
  }

  private async fromElement(source: ImageCaptureSource): Promise<ImageCaptureResult> {
    const selector = source.selector ?? (source.ref ? '*' : '');
    const { el, error } = this.opts.dom.resolve(selector, source.ref);
    if (!el) return { ok: false, summary: `attach_image: ${error ?? 'element not found'}` };
    const target = this.pickImageElement(el);
    if (!target) {
      return { ok: false, summary: `attach_image: ${this.opts.dom.describe(el)} has no <img>, <svg> or <canvas> to capture` };
    }
    return await this.captureElement(source, target);
  }

  /** The element itself if it is an image, else its first image descendant. */
  private pickImageElement(el: Element): Element | null {
    if (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || isSvg(el)) return el;
    return el.querySelector('svg, img, canvas');
  }

  private async captureElement(source: ImageCaptureSource, el: Element): Promise<ImageCaptureResult> {
    const label = source.label ?? this.opts.dom.describe(el);
    if (el instanceof HTMLCanvasElement) {
      try {
        return this.done(source, el.toDataURL('image/png'), label, 'image/png');
      } catch {
        return { ok: false, summary: 'attach_image: could not read the canvas' };
      }
    }
    if (el instanceof HTMLImageElement) {
      const src = el.currentSrc || el.src;
      if (!src) return { ok: false, summary: 'attach_image: the <img> has no src' };
      if (src.startsWith('data:')) return this.done(source, src, label, dataUrlMime(src));
      const origin = (() => {
        try {
          return new URL(src, location.href).origin;
        } catch {
          return null;
        }
      })();
      if (origin === this.opts.siteOrigin) {
        return this.fromUrl({ ...source, url: src, label });
      }
      // cross-origin <img>: rasterize through a canvas (fails if tainted)
      const url = this.rasterizeImageElement(el);
      if (!url) return { ok: false, summary: 'attach_image: could not capture the cross-origin image' };
      return this.done(source, url, label, 'image/png');
    }
    // <svg>
    const markup = new XMLSerializer().serializeToString(el);
    const url = await rasterizeSvg(markup);
    if (!url) return { ok: false, summary: 'attach_image: could not rasterize the SVG element' };
    return this.done(source, url, label, 'image/png');
  }

  private rasterizeImageElement(el: HTMLImageElement): string | null {
    try {
      const width = el.naturalWidth || el.width || DEFAULT_RASTER_SIZE;
      const height = el.naturalHeight || el.height || DEFAULT_RASTER_SIZE;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(el, 0, 0, width, height);
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }
}
