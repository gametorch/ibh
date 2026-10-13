import { describe, expect, it } from 'vitest';
import type { ApiCapability, IbhManifest } from './manifest';
import { validateManifest } from './validate';

function makeManifest(overrides: Partial<IbhManifest> = {}): IbhManifest {
  return {
    version: 1,
    site: { name: 'TestSite', origin: 'https://example.com' },
    api: [
      { id: 'sprites_list', method: 'GET', path: '/api/sprites', tier: 'auto' },
      { id: 'sprites_create', method: 'POST', path: '/api/sprites', tier: 'confirm' },
    ],
    policies: { maxMutatingActionsPerSession: 5 },
    llm: { allowedModels: ['openai/gpt-4o-mini'], defaultModel: 'openai/gpt-4o-mini' },
    ...overrides,
  };
}

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const r = validateManifest(makeManifest());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a manifest with only read capabilities and no mutating budget', () => {
    const r = validateManifest(
      makeManifest({
        api: [{ id: 'sprites_list', method: 'GET', path: '/api/sprites', tier: 'auto' }],
      })
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a missing tier (no library defaults)', () => {
    const m = makeManifest();
    const cap = m.api[1] as Partial<typeof m.api[number]>;
    delete cap.tier;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('tier');
  });

  it('rejects mutating capabilities without a session mutating budget', () => {
    const m = makeManifest();
    delete (m.policies as Record<string, unknown>).maxMutatingActionsPerSession;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('maxMutatingActionsPerSession');
  });

  it('rejects duplicate ids across kinds', () => {
    const m = makeManifest({
      dom: [{ id: 'sprites_create', action: 'click', selector: '[data-ibh-action="x"]', tier: 'auto' }],
    });
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('duplicate');
  });

  it('rejects wildcard paths on api capabilities', () => {
    const m = makeManifest({
      api: [{ id: 'a', method: 'GET', path: '/api/*', tier: 'auto' }],
    });
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects a defaultModel outside allowedModels', () => {
    const m = makeManifest({
      llm: { allowedModels: ['openai/gpt-4o-mini'], defaultModel: 'anthropic/claude-3.5-sonnet' },
    });
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects invalid ids', () => {
    const m = makeManifest({
      api: [{ id: 'bad id with spaces', method: 'GET', path: '/x', tier: 'auto' }],
    });
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects a bad origin', () => {
    const m = makeManifest();
    m.site.origin = 'not a url';
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects denied-tier mutants without budget requirement', () => {
    const m = makeManifest();
    delete (m.policies as Record<string, unknown>).maxMutatingActionsPerSession;
    m.api = m.api.map((c) => (c.id === 'sprites_create' ? { ...c, tier: 'denied' as const } : c));
    expect(validateManifest(m).ok).toBe(true);
  });

  it('accepts approve specs (string templates and functions)', () => {
    const m = makeManifest();
    const createCap = m.api[1] as ApiCapability;
    createCap.approve = 'Create a sprite named "{{body.name}}"?';
    m.dom = [{ id: 'x', action: 'click', selector: '#a', tier: 'session', approve: () => 'ok?' }];
    expect(validateManifest(m).ok).toBe(true);
  });

  it('rejects malformed approve specs', () => {
    const m = makeManifest();
    const createCap = m.api[1] as unknown as Record<string, unknown>;
    createCap.approve = 42;
    expect(validateManifest(m).ok).toBe(false);
    createCap.approve = '   ';
    expect(validateManifest(m).ok).toBe(false);
  });

  it('rejects nav routes containing wildcards', () => {
    const m = makeManifest();
    m.nav = [{ id: 'w', route: '/settings/*', tier: 'auto' }];
    expect(validateManifest(m).ok).toBe(false);
  });

  it('validates argSchema and querySchema (lite subset)', () => {
    const m = makeManifest();
    m.api[1] = {
      ...m.api[1],
      argSchema: { properties: { a: { type: 'string' } } }, // missing top-level type
    } as typeof m.api[number];
    expect(validateManifest(m).ok).toBe(false);

    const m2 = makeManifest();
    m2.api[1] = {
      ...m2.api[1],
      argSchema: { type: 'object', properties: { p: { type: 'string', pattern: '[' } } },
    } as typeof m.api[number];
    expect(validateManifest(m2).ok).toBe(false);
    expect(validateManifest(m2).errors.join(' ')).toContain('pattern');
  });

  it('validates rate fields', () => {
    const m = makeManifest();
    m.api = [{ id: 'r', method: 'GET', path: '/r', tier: 'auto', rate: { minIntervalMs: 0 } }];
    expect(validateManifest(m).ok).toBe(false);
    m.api = [{ id: 'r', method: 'GET', path: '/r', tier: 'auto', rate: { maxPerSession: -1 } }];
    expect(validateManifest(m).ok).toBe(false);
  });
});
