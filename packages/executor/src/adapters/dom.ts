import type { DomAction } from '@ibh/policy';

export interface PageSnapshot {
  url: string;
  title: string;
  /** Compact accessibility-style tree with stable element refs ("#rN"). */
  tree: string;
  /** ref -> human-readable descriptor, for the model. */
  refs: Record<string, string>;
}

export interface DomActResult {
  ok: boolean;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface DomExecutor {
  /** Resolve a capability selector (optionally pinned to a snapshot ref). Pure lookup. */
  resolve(selector: string, ref?: string): { el: Element | null; error?: string };
  /** Human-readable description of an element (for consent cards and audit). */
  describe(el: Element): string;
  act(action: DomAction, selector: string, ref?: string, value?: string): DomActResult;
  snapshot(): PageSnapshot;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'LINK', 'META', 'HEAD', 'SVG']);
const INTERACTIVE_SELECTORS =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="textbox"], [role="combobox"], [role="tab"], [contenteditable="true"], [data-ibh-action], [data-ibh-label]';
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4']);

const MAX_NODES = 500;
const MAX_TREE_CHARS = 16_000;
const MAX_NAME_CHARS = 80;

function collapse(s: string): string {
  return s.replaceAll(/\s+/gu, ' ').trim();
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return collapse(aria).slice(0, MAX_NAME_CHARS);
  if (el instanceof HTMLImageElement && el.alt) return collapse(el.alt).slice(0, MAX_NAME_CHARS);
  if (el instanceof HTMLInputElement) {
    return collapse(el.placeholder || el.name || el.type).slice(0, MAX_NAME_CHARS);
  }
  const label = el.getAttribute('data-ibh-label');
  if (label) return collapse(label).slice(0, MAX_NAME_CHARS);
  return collapse(el.textContent ?? '').slice(0, MAX_NAME_CHARS);
}

function inputTypeRole(el: HTMLInputElement): string {
  switch (el.type) {
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'button':
    case 'submit':
      return 'button';
    default:
      return 'textbox';
  }
}

function roleOf(el: Element): string {
  const explicitRole = el.getAttribute('role');
  if (explicitRole) return explicitRole;
  const tag = el.tagName;
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A' && el.hasAttribute('href')) return 'link';
  if (tag === 'INPUT') return inputTypeRole(el as HTMLInputElement);
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  if (HEADING_TAGS.has(tag)) return `heading ${tag.slice(1)}`;
  if (el.hasAttribute('data-ibh-region')) return 'region';
  return tag.toLowerCase();
}

/**
 * DOM adapter: snapshot the page as a compact accessibility-style tree with
 * stable refs, and perform ONLY host-declared actions (click/fill/submit/highlight)
 * on host-declared selectors. It can never touch ibh's own UI.
 */
export class DomAdapter implements DomExecutor {
  private refs = new Map<string, WeakRef<Element>>();
  private refByEl = new WeakMap<Element, string>();
  private nextRef = 1;

  constructor(private readonly opts: { snapshotBudgetNodes?: number } = {}) {}

  private isExcluded(el: Element): boolean {
    return el.closest('[data-ibh-ui]') !== null || el.closest('[data-ibh-ignore]') !== null;
  }

  private getRef(el: Element): string {
    const existing = this.refByEl.get(el);
    if (existing) return existing;
    const ref = `#r${this.nextRef++}`;
    this.refByEl.set(el, ref);
    this.refs.set(ref, new WeakRef(el));
    return ref;
  }

  resolve(selector: string, ref?: string): { el: Element | null; error?: string } {
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      return { el: null, error: 'selector is empty' };
    }
    if (ref !== undefined) {
      const wr = this.refs.get(ref);
      const el = wr?.deref();
      if (!el || !el.isConnected) return { el: null, error: `ref ${ref} is stale — take a new page_snapshot and use a fresh ref` };
      if (this.isExcluded(el)) return { el: null, error: 'ref points into the ibh UI, which is out of bounds' };
      if (!el.matches(selector)) return { el: null, error: `ref ${ref} does not match the capability selector "${selector}"` };
      return { el };
    }
    const el = document.querySelector(selector);
    if (!el) return { el: null, error: `no element matches "${selector}" on the current page` };
    if (this.isExcluded(el)) return { el: null, error: 'the matched element is inside the ibh UI, which is out of bounds' };
    return { el };
  }

  describe(el: Element): string {
    const role = roleOf(el);
    const name = accessibleName(el);
    const action = el.getAttribute('data-ibh-action');
    const bits = [role, name ? `"${name}"` : ''];
    if (action) bits.push(`[data-ibh-action=${action}]`);
    return bits.filter(Boolean).join(' ');
  }

  snapshot(): PageSnapshot {
    const lines: string[] = [];
    const refs: Record<string, string> = {};
    let nodes = 0;
    let truncated = false;

    const walk = (el: Element, depth: number): void => {
      if (nodes >= (this.opts.snapshotBudgetNodes ?? MAX_NODES)) {
        truncated = true;
        return;
      }
      if (this.isExcluded(el)) return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;

      const interactive = el.matches(INTERACTIVE_SELECTORS);
      const isRegion = el.hasAttribute('data-ibh-region');
      const isHeading = HEADING_TAGS.has(el.tagName);
      if (interactive || isRegion || isHeading) {
        nodes += 1;
        const indent = '  '.repeat(depth);
        const name = accessibleName(el);
        const parts: string[] = [isRegion ? `region "${el.getAttribute('data-ibh-region')}"` : roleOf(el)];
        if (!isRegion && name) parts.push(`"${name}"`);
        const action = el.getAttribute('data-ibh-action');
        if (action) parts.push(`[ibh-action=${action}]`);
        let value = '';
        if (el instanceof HTMLInputElement && el.value) value = collapse(el.value).slice(0, 40);
        if (el instanceof HTMLTextAreaElement && el.value) value = collapse(el.value).slice(0, 40);
        if (el instanceof HTMLSelectElement) value = collapse(el.value).slice(0, 40);
        const ref = this.getRef(el);
        parts.push(ref);
        refs[ref] = `${roleOf(el)} ${name ? `"${name}"` : ''}`.trim();
        let line = `${indent}- ${parts.join(' ')}`;
        if (value) line += ` value="${value}"`;
        lines.push(line);
        if (lines.join('\n').length > MAX_TREE_CHARS) {
          truncated = true;
          return;
        }
      }
      for (const child of el.children) walk(child, interactive || isRegion || isHeading ? depth + 1 : depth);
    };

    const root = document.body;
    if (root) {
      for (const child of root.children) walk(child, 0);
    }

    let tree = lines.join('\n');
    if (truncated) tree += '\n… (page snapshot truncated — narrow your question or ask for a specific region)';
    return { url: `${location.pathname}${location.search}`, title: document.title, tree, refs };
  }

  act(action: DomAction, selector: string, ref?: string, value?: string): DomActResult {
    const { el, error } = this.resolve(selector, ref);
    if (!el) return { ok: false, summary: `${action}: ${error ?? 'element not found'}` };
    const desc = this.describe(el);

    switch (action) {
      case 'highlight': {
        this.highlight(el);
        return { ok: true, summary: `highlighted ${desc}` };
      }
      case 'fill': {
        if (typeof value !== 'string') return { ok: false, summary: 'fill: missing "value" argument' };
        const r = this.fill(el as HTMLElement, value);
        return r.ok ? { ok: true, summary: `filled ${desc} with ${JSON.stringify(value)}` } : r;
      }
      case 'click': {
        this.click(el);
        return { ok: true, summary: `clicked ${desc}`, detail: { selector } };
      }
      case 'submit': {
        const r = this.submit(el);
        return r.ok ? { ok: true, summary: `submitted form containing ${desc}` } : r;
      }
    }
  }

  private fill(el: HTMLElement, value: string): DomActResult {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return { ok: true, summary: 'filled' };
    }
    if (el instanceof HTMLSelectElement) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return { ok: true, summary: 'selected' };
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.blur();
      return { ok: true, summary: 'filled contenteditable' };
    }
    return { ok: false, summary: `fill: element is not an input, textarea, select or contenteditable (${this.describe(el)})` };
  }

  private click(el: Element): void {
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    // Elements with native activation behavior (checkbox toggle, form submit, link nav):
    if (el instanceof HTMLElement && (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'A' || el.tagName === 'SUMMARY')) {
      el.click();
      return;
    }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', common));
    el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', common));
    el.dispatchEvent(new MouseEvent('click', common));
  }

  private submit(el: Element): DomActResult {
    const form = el instanceof HTMLElement ? el.closest('form') : null;
    if (!form) return { ok: false, summary: 'submit: element is not inside a <form>' };
    if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function') {
      form.requestSubmit(el instanceof HTMLElement ? el : undefined);
      return { ok: true, summary: 'submitted' };
    }
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    return { ok: true, summary: 'dispatched submit' };
  }

  private highlight(el: Element): void {
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-ibh-ignore', '');
    Object.assign(box.style, {
      position: 'fixed',
      left: `${r.left - 3}px`,
      top: `${r.top - 3}px`,
      width: `${r.width + 6}px`,
      height: `${r.height + 6}px`,
      border: '3px solid #7c5cff',
      borderRadius: '6px',
      pointerEvents: 'none',
      zIndex: '2147483646',
      boxShadow: '0 0 0 9999px rgba(0,0,0,0.15)',
      transition: 'opacity .4s',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.append(box);
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 450);
    }, 1600);
  }
}
