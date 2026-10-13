// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { DomAdapter } from './adapters/dom';

function setupPage(): void {
  document.body.innerHTML = `
    <main data-ibh-region="sprites">
      <h2>Editor</h2>
      <input data-ibh-action="sprite-name" placeholder="Sprite name" value="" />
      <select data-ibh-action="palette"><option value="warm">warm</option><option value="cool">cool</option></select>
      <button data-ibh-action="publish">Publish Sprite</button>
      <a href="/elsewhere">Go elsewhere</a>
    </main>
    <div data-ibh-ui>
      <button class="ibh-button">ibh internal</button>
    </div>
    <div data-ibh-ignore>
      <button class="ignored-button">ignored</button>
    </div>
  `;
}

beforeEach(() => {
  setupPage();
});

describe('DomAdapter.resolve', () => {
  it('resolves elements matching a capability selector', () => {
    const dom = new DomAdapter();
    const r = dom.resolve('[data-ibh-action="publish"]');
    expect(r.el?.textContent).toBe('Publish Sprite');
    expect(r.error).toBeUndefined();
  });

  it('rejects targets that do not exist', () => {
    const dom = new DomAdapter();
    const r = dom.resolve('[data-ibh-action="nonexistent"]');
    expect(r.el).toBeNull();
    expect(r.error).toContain('no element matches');
  });

  it('refuses to act on elements inside the ibh UI (data-ibh-ui)', () => {
    const dom = new DomAdapter();
    const r = dom.resolve('.ibh-button');
    expect(r.el).toBeNull();
    expect(r.error).toContain('out of bounds');
  });

  it('refuses to act on ignored subtrees (data-ibh-ignore)', () => {
    const dom = new DomAdapter();
    const r = dom.resolve('.ignored-button');
    expect(r.el).toBeNull();
    expect(r.error).toContain('out of bounds');
  });
});

describe('DomAdapter snapshot refs', () => {
  it('snapshot lists interactive elements with stable refs and excludes ibh UI', () => {
    const dom = new DomAdapter();
    const snap = dom.snapshot();
    expect(snap.title).toBe(document.title);
    expect(snap.tree).toContain('region "sprites"');
    expect(snap.tree).toContain('button "Publish Sprite"');
    expect(snap.tree).toContain('[ibh-action=publish]');
    expect(snap.tree).not.toContain('ibh internal');
    expect(snap.tree).not.toContain('ignored-button');
    expect(Object.keys(snap.refs).length).toBeGreaterThan(0);
  });

  it('a ref from the snapshot resolves to the exact element and must match the selector', () => {
    const dom = new DomAdapter();
    const snap = dom.snapshot();
    const refEntry = Object.entries(snap.refs).find(([, desc]) => desc.includes('"Publish Sprite"'));
    expect(refEntry).toBeDefined();
    const [ref] = refEntry as [string, string];
    const good = dom.resolve('[data-ibh-action="publish"]', ref);
    expect(good.el?.textContent).toBe('Publish Sprite');
    const bad = dom.resolve('[data-ibh-action="sprite-name"]', ref);
    expect(bad.el).toBeNull();
    expect(bad.error).toContain('does not match');
  });

  it('stale refs (element removed from the DOM) are rejected', () => {
    const dom = new DomAdapter();
    const snap = dom.snapshot();
    const entry = Object.entries(snap.refs).find(([, desc]) => desc.includes('"Publish Sprite"'));
    const [ref] = entry as [string, string];
    document.querySelector('[data-ibh-action="publish"]')?.remove();
    const r = dom.resolve('[data-ibh-action="publish"]', ref);
    expect(r.el).toBeNull();
    expect(r.error).toContain('stale');
  });
});

describe('DomAdapter.fill', () => {
  it('sets input values via the native setter and fires input+change', () => {
    const dom = new DomAdapter();
    const input = document.querySelector('[data-ibh-action="sprite-name"]') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    const r = dom.act('fill', '[data-ibh-action="sprite-name"]', undefined, 'Ember Fox');
    expect(r.ok).toBe(true);
    expect(input.value).toBe('Ember Fox');
    expect(events).toEqual(['input', 'change']);
  });

  it('sets select values and fires change', async () => {
    const dom = new DomAdapter();
    let changed = 0;
    const select = document.querySelector('[data-ibh-action="palette"]') as HTMLSelectElement;
    select.addEventListener('change', () => (changed += 1));
    const r = await dom.act('fill', '[data-ibh-action="palette"]', undefined, 'cool');
    expect(r.ok).toBe(true);
    expect(select.value).toBe('cool');
    expect(changed).toBe(1);
  });

  it('refuses to fill non-form elements', async () => {
    const dom = new DomAdapter();
    const r = await dom.act('fill', 'h2', undefined, 'nope');
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('not an input');
  });
});

describe('DomAdapter.click + describe', () => {
  it('clicks buttons through native activation', async () => {
    const dom = new DomAdapter();
    let clicks = 0;
    const btn = document.querySelector('[data-ibh-action="publish"]') as HTMLButtonElement;
    btn.addEventListener('click', () => (clicks += 1));
    const r = await dom.act('click', '[data-ibh-action="publish"]');
    expect(r.ok).toBe(true);
    expect(clicks).toBe(1);
  });

  it('describe renders role + accessible name + marker', () => {
    const dom = new DomAdapter();
    const { el } = dom.resolve('[data-ibh-action="publish"]');
    expect(dom.describe(el as Element)).toContain('button');
    expect(dom.describe(el as Element)).toContain('"Publish Sprite"');
    expect(dom.describe(el as Element)).toContain('data-ibh-action=publish');
  });

  it('highlight draws an overlay outside the snapshot and cleans it up', async () => {
    vi.useFakeTimers();
    try {
      const dom = new DomAdapter();
      const before = document.querySelectorAll('[data-ibh-ignore]').length;
      const r = await dom.act('highlight', '[data-ibh-action="publish"]');
      expect(r.ok).toBe(true);
      expect(document.querySelectorAll('[data-ibh-ignore]').length).toBe(before + 1);
      vi.advanceTimersByTime(2500);
      expect(document.querySelectorAll('[data-ibh-ignore]').length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
