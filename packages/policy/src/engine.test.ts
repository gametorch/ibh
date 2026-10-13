import { describe, expect, it } from 'vitest';
import type { IbhManifest } from './manifest';
import { PolicyEngine } from './engine';

function makeManifest(): IbhManifest {
  return {
    version: 1,
    site: { name: 'T', origin: 'https://example.com' },
    api: [
      { id: 'list', method: 'GET', path: '/api/list', tier: 'auto' },
      {
        id: 'create',
        method: 'POST',
        path: '/api/list',
        tier: 'confirm',
        rate: { maxPerSession: 2, minIntervalMs: 1000 },
      },
      { id: 'nuke', method: 'DELETE', path: '/api/all', tier: 'denied' },
    ],
    dom: [{ id: 'publish', action: 'click', selector: '[data-ibh-action="publish"]', tier: 'session' }],
    nav: [{ id: 'settings', route: '/settings', tier: 'denied' }],
    policies: { maxMutatingActionsPerSession: 2, maxTokensPerSession: 1000 },
    llm: { allowedModels: ['m1'], defaultModel: 'm1' },
  };
}

describe('PolicyEngine', () => {
  it('denies unknown capabilities (fail closed)', () => {
    const e = new PolicyEngine(makeManifest());
    expect(e.evaluate('api', 'nonexistent').status).toBe('deny');
  });

  it('allows auto-tier reads', () => {
    const e = new PolicyEngine(makeManifest());
    const d = e.evaluate('api', 'list');
    expect(d.status).toBe('allow');
    expect(d.mutating).toBe(false);
  });

  it('maps tiers to decision statuses', () => {
    const e = new PolicyEngine(makeManifest());
    expect(e.evaluate('api', 'create').status).toBe('confirm');
    expect(e.evaluate('dom', 'publish').status).toBe('session');
    expect(e.evaluate('api', 'nuke').status).toBe('deny');
    expect(e.evaluate('nav', 'settings').status).toBe('deny');
  });

  it('enforces per-capability rate limits', () => {
    const e = new PolicyEngine(makeManifest());
    e.consumeRate('api', 'create');
    const d = e.evaluate('api', 'create');
    expect(d.status).toBe('deny');
    expect(d.reason).toContain('rate limit');
  });

  it('enforces the session mutating budget', () => {
    const e = new PolicyEngine(makeManifest());
    e.consumeRate('api', 'list'); // read: does not count
    e.recordMutating();
    e.recordMutating();
    const d = e.evaluate('api', 'create');
    expect(d.status).toBe('deny');
    expect(d.reason).toContain('session budget');
  });

  it('enforces the token budget', () => {
    const e = new PolicyEngine(makeManifest());
    e.recordTokens(900);
    expect(e.checkTokenBudget(50).ok).toBe(true);
    e.recordTokens(50);
    expect(e.checkTokenBudget(200).ok).toBe(false);
  });

  it('clamps manifest policy values to library ceilings', () => {
    const m = makeManifest();
    m.policies.maxStepsPerTurn = 9999;
    m.policies.maxTokensPerSession = 999_999_999;
    const e = new PolicyEngine(m);
    expect(e.effectiveLimits().maxStepsPerTurn).toBeLessThan(9999);
    expect(e.effectiveLimits().maxTokensPerSession).toBe(500_000);
  });

  it('evaluates builtins with built-in rate policy', () => {
    const e = new PolicyEngine(makeManifest());
    expect(e.evaluate('builtin', 'analyze').status).toBe('allow');
    expect(e.evaluate('builtin', 'made_up').status).toBe('deny');
  });
});
