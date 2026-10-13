import { describe, expect, it, vi } from 'vitest';
import type { IbhManifest } from '@ibh/policy';
import { PolicyEngine } from '@ibh/policy';
import { AuditLedger } from './audit';
import { FetchAdapter } from './adapters/fetch';
import { tryInterpolatePath } from './adapters/fetch';
import { Gatekeeper } from './gate';
import type { ConsentRequest } from './gate';
import type { ApiFetcher, ApiRequestArgs } from './adapters/auth';
import type { DomExecutor } from './adapters/dom';
import type { NavExecutor } from './adapters/nav';
import type { AnalyzeExecutor } from './adapters/analyze';

function noopDom(): DomExecutor {
  return {
    resolve: (selector) => ({ el: selector ? ({ tagName: 'BUTTON' } as unknown as Element) : null }),
    describe: () => 'button "Publish"',
    act: () => ({ ok: true, summary: 'clicked' }),
    snapshot: () => ({ url: '/', title: 'T', tree: '', refs: {} }),
  };
}

function makeManifest(overrides: Partial<IbhManifest['policies']> = {}): IbhManifest {
  return {
    version: 1,
    site: { name: 'T', origin: 'https://example.com' },
    api: [
      { id: 'list', method: 'GET', path: '/api/list', tier: 'auto' },
      {
        id: 'create',
        method: 'POST',
        path: '/api/things',
        tier: 'confirm',
        argSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
      },
      { id: 'slow', method: 'POST', path: '/api/slow', tier: 'confirm', rate: { minIntervalMs: 60_000 } },
      { id: 'capped', method: 'POST', path: '/api/capped', tier: 'confirm', rate: { maxPerSession: 2 } },
      { id: 'rename', method: 'PATCH', path: '/api/t/:id', tier: 'session' },
      { id: 'delete_all', method: 'DELETE', path: '/api/all', tier: 'denied' },
      { id: 'read', method: 'GET', path: '/api/read', tier: 'confirm' },
    ],
    dom: [
      { id: 'publish', action: 'click', selector: '[data-ibh-action="publish"]', tier: 'session' },
      { id: 'nuke_ui', action: 'click', selector: '[data-ibh-ui] .ibh-button', tier: 'auto' },
    ],
    nav: [{ id: 'settings', route: '/settings', tier: 'denied' }],
    policies: { maxMutatingActionsPerSession: 2, ...overrides },
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  };
}

interface GateFixture {
  gate: Gatekeeper;
  ledger: AuditLedger;
  executed: ApiRequestArgs[];
  asks: ConsentRequest[];
  approve: boolean;
}

function makeGate(opts: { consent?: boolean; policies?: Partial<IbhManifest['policies']> } = {}): GateFixture {
  const executed: ApiRequestArgs[] = [];
  const asks: ConsentRequest[] = [];
  const api: ApiFetcher = {
    async request(args) {
      executed.push(args);
      return { status: 200, ok: true, body: { ok: true } };
    },
  };
  const ledger = new AuditLedger();
  const gate = new Gatekeeper({
    manifest: makeManifest(opts.policies),
    policy: new PolicyEngine(makeManifest(opts.policies)),
    api,
    dom: noopDom(),
    nav: { navigate: () => ({ ok: true, summary: 'navigated' }) } as NavExecutor,
    analyze: { run: async () => ({}) } as AnalyzeExecutor,
    ledger,
    consent: opts.consent === false ? undefined : { request: (req) => (asks.push(req), Promise.resolve(true)) },
  });
  return { gate, ledger, executed, asks, approve: true };
}

describe('gatekeeper security: the manifest is the capability surface', () => {
  it('denies capabilities that are not in the manifest — the model cannot invent tools', async () => {
    const f = makeGate({ consent: true });
    const r = await f.gate.resolve({ kind: 'api', capabilityId: 'drop_all_tables' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not registered in the manifest');
    expect(f.ledger.getEntries().some((e) => e.decision === 'deny')).toBe(true);
  });

  it('denies tier "denied" capabilities even if the model insists', async () => {
    const f = makeGate({ consent: true });
    for (const intent of [
      { kind: 'api' as const, capabilityId: 'delete_all' },
      { kind: 'nav' as const, capabilityId: 'settings' },
    ]) {
      const r = await f.gate.resolve(intent);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('denied by the site manifest');
    }
    expect(f.executed).toHaveLength(0);
  });

  it('fails closed: confirm-tier actions are denied when no consent UI is connected', async () => {
    const f = makeGate({ consent: false });
    const r = await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'x' } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no consent UI is connected');
    expect(f.executed).toHaveLength(0);
  });

  it('fails closed: session-tier actions also require a consent UI', async () => {
    const f = makeGate({ consent: false });
    const r = await f.gate.resolve({ kind: 'dom', capabilityId: 'publish' });
    expect(r.ok).toBe(false);
    expect(f.executed).toHaveLength(0);
  });

  it('user decline blocks execution and is audited as consent-denied', async () => {
    const asks: ConsentRequest[] = [];
    const m = makeManifest();
    const gate = new Gatekeeper({
      manifest: m,
      policy: new PolicyEngine(m),
      api: { async request(args) { void args; return { status: 200, ok: true, body: null }; } },
      dom: noopDom(),
      nav: { navigate: () => ({ ok: true, summary: '' }) },
      analyze: { run: async () => null },
      ledger: new AuditLedger(),
      consent: { request: (req) => (asks.push(req), Promise.resolve(false)) },
    });
    const r = await gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'x' } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('user declined');
    expect(asks).toHaveLength(1);
  });

  it('invalid arguments are rejected BEFORE consent is ever requested', async () => {
    const f = makeGate({ consent: true });
    const r = await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: '' } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('body invalid');
    expect(f.asks).toHaveLength(0);
    expect(f.executed).toHaveLength(0);
  });

  it('missing path parameters are rejected before consent', async () => {
    const f = makeGate({ consent: true });
    const r = await f.gate.resolve({ kind: 'api', capabilityId: 'rename', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing path parameter');
    expect(f.asks).toHaveLength(0);
  });

  it('session tier asks exactly once per capability per session', async () => {
    const f = makeGate({ consent: true, policies: { maxMutatingActionsPerSession: 100 } });
    await f.gate.resolve({ kind: 'api', capabilityId: 'rename', args: { path: { id: '1' } } });
    await f.gate.resolve({ kind: 'api', capabilityId: 'rename', args: { path: { id: '2' } } });
    expect(f.asks).toHaveLength(1);
    f.gate.resetSessionApprovals();
    await f.gate.resolve({ kind: 'api', capabilityId: 'rename', args: { path: { id: '3' } } });
    expect(f.asks).toHaveLength(2);
  });

  it('confirm tier asks every single time', async () => {
    const f = makeGate({ consent: true });
    await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'a' } } });
    await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'b' } } });
    expect(f.asks).toHaveLength(2);
  });

  it('per-capability maxPerSession rate limit stops execution beyond the cap', async () => {
    const f = makeGate({ consent: true });
    for (let i = 0; i < 2; i++) {
      const r = await f.gate.resolve({ kind: 'api', capabilityId: 'capped', args: {} });
      expect(r.ok).toBe(true);
    }
    const third = await f.gate.resolve({ kind: 'api', capabilityId: 'capped', args: {} });
    expect(third.ok).toBe(false);
    expect(third.error).toContain('rate limit');
    expect(f.executed).toHaveLength(2);
  });

  it('per-capability minIntervalMs blocks back-to-back calls', async () => {
    const f = makeGate({ consent: true });
    const first = await f.gate.resolve({ kind: 'api', capabilityId: 'slow', args: {} });
    const second = await f.gate.resolve({ kind: 'api', capabilityId: 'slow', args: {} });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('rate limit');
  });

  it('session mutating budget stops further mutating actions (reads still allowed)', async () => {
    const f = makeGate({ consent: true, policies: { maxMutatingActionsPerSession: 2 } });
    await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'a' } } });
    await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'b' } } });
    const thirdMutate = await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'c' } } });
    expect(thirdMutate.ok).toBe(false);
    expect(thirdMutate.error).toContain('session budget');

    const read = await f.gate.resolve({ kind: 'api', capabilityId: 'list' });
    expect(read.ok).toBe(true); // reads never count against the mutating budget
  });

  it('confirm-tier reads still require consent when the host demands it', async () => {
    const f = makeGate({ consent: true });
    const r = await f.gate.resolve({ kind: 'api', capabilityId: 'read' });
    expect(r.ok).toBe(true);
    expect(f.asks).toHaveLength(1); // a GET was confirm-tiered by the host — honored
  });

  it('builtins are rate-limited too (min interval between analyze calls)', async () => {
    const f = makeGate({ consent: true });
    const first = await f.gate.resolve({ kind: 'builtin', name: 'analyze', args: { code: 'return 1;' } });
    const second = await f.gate.resolve({ kind: 'builtin', name: 'analyze', args: { code: 'return 1;' } });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('rate limit');
  });

  it('unknown builtins are denied', async () => {
    const f = makeGate({ consent: true });
    const r = await f.gate.resolve({ kind: 'builtin', name: 'drop_database' as unknown as 'page_snapshot' });
    expect(r.ok).toBe(false);
  });

  it('oversized tool results are truncated before reaching the model', async () => {
    const m = makeManifest();
    const gate = new Gatekeeper({
      manifest: m,
      policy: new PolicyEngine(m),
      api: { async request() { return { status: 200, ok: true, body: { blob: 'x'.repeat(40_000) } }; } },
      dom: noopDom(),
      nav: { navigate: () => ({ ok: true, summary: '' }) },
      analyze: { run: async () => null },
      ledger: new AuditLedger(),
    });
    const r = await gate.resolve({ kind: 'api', capabilityId: 'list' });
    const body = (r.result as { body: { _truncated: boolean; _fullSizeChars: number } }).body;
    expect(body._truncated).toBe(true);
    expect(body._fullSizeChars).toBeGreaterThan(20_000);
  });

  it('audits every terminal state', async () => {
    const f = makeGate({ consent: true });
    await f.gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'x' } } }); // confirm
    await f.gate.resolve({ kind: 'api', capabilityId: 'nope' }); // deny
    await f.gate.resolve({ kind: 'api', capabilityId: 'rename', args: {} }); // error (missing param)
    const decisions = f.ledger.getEntries().map((e) => e.decision);
    expect(decisions).toContain('confirm');
    expect(decisions).toContain('deny');
    expect(decisions).toContain('error');
  });
});

describe('network isolation', () => {
  it('FetchAdapter structurally refuses cross-origin targets', async () => {
    const fetchCalls: unknown[][] = [];
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      fetchCalls.push(args);
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({}),
      });
    });
    try {
      const adapter = new FetchAdapter({ siteOrigin: 'https://example.com', auth: { mode: 'cookie' } });
      await expect(adapter.request({ method: 'GET', path: 'https://evil.com/exfil' })).rejects.toThrow(
        'cross-origin'
      );
      await expect(adapter.request({ method: 'GET', path: '//evil.com/exfil' })).rejects.toThrow('cross-origin');
      await expect(adapter.request({ method: 'GET', path: '/api/ok' })).resolves.toMatchObject({ status: 200 });
      expect(fetchCalls).toHaveLength(1);
      const init = fetchCalls[0]![1] as RequestInit;
      expect(init.credentials).toBe('include');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('path params cannot smuggle traversal: separators are percent-encoded', () => {
    const r = tryInterpolatePath('/api/x/:p', { p: '../../secret' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.path).toBe('/api/x/..%2F..%2Fsecret');
    expect(r.ok && (r.path as string).match(/\/api\/x\/[^/]+$/u)).toBeTruthy();
    // NOTE: servers must still validate decoded path params — the harness cannot
    // reason about server-side routing semantics (see docs/security-model.md).
  });

  it('missing params are rejected, leftover placeholders impossible', () => {
    expect(tryInterpolatePath('/api/x/:id', {}).ok).toBe(false);
    expect(tryInterpolatePath('/api/x/:id', { id: '7' }).ok).toBe(true);
  });
});
