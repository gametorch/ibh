import { describe, expect, it } from 'vitest';
import type { IbhManifest } from '@ibh/policy';
import { PolicyEngine } from '@ibh/policy';
import { AuditLedger } from './audit';
import { Gatekeeper } from './gate';
import type { ConsentRequest } from './gate';
import type { ApiFetcher, ApiRequestArgs } from './adapters/auth';
import type { DomExecutor, PageSnapshot } from './adapters/dom';
import type { NavExecutor } from './adapters/nav';
import type { AnalyzeExecutor } from './adapters/analyze';

function makeManifest(): IbhManifest {
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
        description: 'Create a thing',
        argSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
        approve: 'Create a thing named "{{body.name}}"?',
      },
      {
        id: 'rename',
        method: 'PATCH',
        path: '/api/things/:id',
        tier: 'session',
      },
    ],
    dom: [
      { id: 'publish', action: 'click', selector: '[data-ibh-action="publish"]', tier: 'session' },
      // no argSchema: the library-level fill cap is the only bound
      { id: 'fill_free', action: 'fill', selector: '#f', tier: 'auto' },
    ],
    nav: [{ id: 'editor', route: '/sprites/:id', tier: 'auto' }],
    policies: { maxMutatingActionsPerSession: 10 },
    llm: { allowedModels: ['m1'], defaultModel: 'm1' },
  };
}

const executed: ApiRequestArgs[] = [];

function makeDeps(consent?: (req: ConsentRequest) => Promise<boolean>) {
  executed.length = 0;
  const api: ApiFetcher = {
    async request(args) {
      executed.push(args);
      return { status: 200, ok: true, body: { hello: 'world' } };
    },
  };
  const dom: DomExecutor = {
    resolve(selector, ref) {
      if (ref === '#r99') return { el: null, error: 'stale' };
      return { el: { tagName: 'BUTTON' } as unknown as Element, error: undefined };
    },
    describe: () => 'button "Publish"',
    act(action, selector) {
      if (selector.includes('missing')) return { ok: false, summary: 'no element matches' };
      return { ok: true, summary: `did ${action}` };
    },
    snapshot(): PageSnapshot {
      return { url: '/x', title: 'T', tree: '- button "A" #r1', refs: { '#r1': 'button "A"' } };
    },
  };
  const nav: NavExecutor = {
    navigate(route) {
      return { ok: true, summary: `navigated to ${route}` };
    },
  };
  const analyzeCalls: Array<{ code: unknown; data: unknown }> = [];
  const analyze: AnalyzeExecutor = {
    async run(code, data) {
      analyzeCalls.push({ code, data });
      return { echoed: data, len: (code as string).length };
    },
  };
  const ledger = new AuditLedger();
  const gate = new Gatekeeper({
    manifest: makeManifest(),
    policy: new PolicyEngine(makeManifest()),
    api,
    dom,
    nav,
    analyze,
    ledger,
    consent: consent ? { request: consent } : undefined,
  });
  return { gate, ledger, analyzeCalls };
}

describe('Gatekeeper', () => {
  it('denies capabilities not in the manifest', async () => {
    const { gate } = makeDeps();
    const r = await gate.resolve({ kind: 'api', capabilityId: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not registered');
  });

  it('denies tier "denied" capabilities', async () => {
    const m = makeManifest();
    m.api.push({ id: 'nuke', method: 'DELETE', path: '/api/all', tier: 'denied' });
    const gate = new Gatekeeper({
      manifest: m,
      policy: new PolicyEngine(m),
      api: { async request() { return { status: 200, ok: true, body: null }; } },
      dom: {
        resolve: () => ({ el: null }),
        describe: () => '',
        act: () => ({ ok: true, summary: '' }),
        snapshot: () => ({ url: '', title: '', tree: '', refs: {} }),
      },
      nav: { navigate: () => ({ ok: true, summary: '' }) },
      analyze: { async run() { return null; } },
      ledger: new AuditLedger(),
    });
    const r = await gate.resolve({ kind: 'api', capabilityId: 'nuke' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('denied');
  });

  it('denies confirm-tier actions when no consent port exists (fail closed)', async () => {
    const { gate, ledger } = makeDeps();
    const r = await gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'x' } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no consent UI');
    expect(ledger.getEntries().some((e) => e.decision === 'deny')).toBe(true);
  });

  it('executes confirm-tier actions after explicit consent and audits them', async () => {
    const asked: ConsentRequest[] = [];
    const { gate, ledger } = makeDeps(async (req) => {
      asked.push(req);
      return true;
    });
    const r = await gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'x' } } });
    expect(r.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.actionSummary).toBe('POST /api/things');
    expect(asked[0]?.question).toBe('Create a thing named "x"?');
    expect(executed).toHaveLength(1);
    expect(ledger.getEntries().some((e) => e.decision === 'confirm' && e.summary === 'POST /api/things')).toBe(true);
  });

  it('does not execute when the user declines consent', async () => {
    const { gate, ledger } = makeDeps(async () => false);
    const r = await gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: 'x' } } });
    expect(r.ok).toBe(false);
    expect(executed).toHaveLength(0);
    expect(ledger.getEntries().some((e) => e.decision === 'consent-denied')).toBe(true);
  });

  it('library-level fill cap rejects oversized values even without argSchema', async () => {
    const { gate } = makeDeps(async () => true);
    const r = await gate.resolve({
      kind: 'dom',
      capabilityId: 'fill_free',
      args: { value: 'x'.repeat(10_001) },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('fill value exceeds');
  });

  it('session tier asks once, then auto-approves', async () => {
    let asks = 0;
    const { gate } = makeDeps(async () => {
      asks += 1;
      return true;
    });
    const a = await gate.resolve({ kind: 'api', capabilityId: 'rename', args: { path: { id: '7' }, body: { name: 'n' } } });
    const b = await gate.resolve({ kind: 'api', capabilityId: 'rename', args: { path: { id: '7' }, body: { name: 'n2' } } });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(asks).toBe(1);
  });

  it('rejects invalid arguments before consent or execution', async () => {
    let asked = 0;
    const { gate, ledger } = makeDeps(async () => {
      asked += 1;
      return true;
    });
    const r = await gate.resolve({ kind: 'api', capabilityId: 'create', args: { body: { name: '' } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('body invalid');
    expect(asked).toBe(0);
    expect(executed).toHaveLength(0);
    expect(ledger.getEntries().every((e) => e.decision !== 'confirm')).toBe(true);
  });

  it('rejects missing path parameters', async () => {
    const { gate } = makeDeps();
    const r = await gate.resolve({ kind: 'api', capabilityId: 'rename', args: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('path parameter');
  });

  it('nav intent interpolates route params into the concrete path', async () => {
    const { gate } = makeDeps(async () => true);
    const r = await gate.resolve({ kind: 'nav', capabilityId: 'editor', args: { params: { id: '42' } } });
    expect(r.ok).toBe(true);
  });

  it('supports builtins: page_snapshot and analyze', async () => {
    const { gate, analyzeCalls } = makeDeps();
    const snap = await gate.resolve({ kind: 'builtin', name: 'page_snapshot' });
    expect(snap.ok).toBe(true);
    expect((snap.result as PageSnapshot).tree).toContain('button "A"');
    const code = 'return data.x + 1;';
    const an = await gate.resolve({ kind: 'builtin', name: 'analyze', args: { code, data: { x: 41 } } });
    // the gate must route the analyze builtin to the sandbox executor with the
    // model-supplied code/data intact (assert on the CALL, not the fake's output)
    expect(analyzeCalls).toEqual([{ code, data: { x: 41 } }]);
    expect(an.ok).toBe(true);
  });

  it('truncates oversized tool results', async () => {
    const m = makeManifest();
    const gate = new Gatekeeper({
      manifest: m,
      policy: new PolicyEngine(m),
      api: { async request() { return { status: 200, ok: true, body: { blob: 'x'.repeat(30_000) } }; } },
      dom: {
        resolve: () => ({ el: null }),
        describe: () => '',
        act: () => ({ ok: true, summary: '' }),
        snapshot: () => ({ url: '', title: '', tree: '', refs: {} }),
      },
      nav: { navigate: () => ({ ok: true, summary: '' }) },
      analyze: { async run() { return null; } },
      ledger: new AuditLedger(),
    });
    const r = await gate.resolve({ kind: 'api', capabilityId: 'list' });
    expect(r.ok).toBe(true);
    expect((r.result as { body: { _truncated?: boolean } }).body._truncated).toBe(true);
  });
});
