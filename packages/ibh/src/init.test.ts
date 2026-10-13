// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { init, OPENROUTER_DEFAULT_BASE } from './index';
import type { IbhConfig, IbhManifest } from './index';
import type { ConsentRequest } from '@ibh/executor';

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/** OpenRouter returns one tool call, then a final answer; the site API returns 200. */
function stubChatWithToolCall(toolName: string, args: unknown) {
  let turns = 0;
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      turns += 1;
      if (turns === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
              },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        });
      }
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    }
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeManifest(): IbhManifest {
  return {
    version: 1,
    site: { name: 'TestSite', origin: 'https://example.com' },
    api: [{ id: 'list', method: 'GET', path: '/api/list', tier: 'auto' }],
    policies: {},
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  };
}

function makeConfig(overrides: Partial<IbhConfig> = {}): IbhConfig {
  return {
    manifest: makeManifest(),
    auth: { mode: 'cookie' },
    llm: { openRouterKey: 'sk-test' },
    ui: { enabled: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('init credential validation (fail-closed)', () => {
  it('accepts BYO-key mode (key + default OpenRouter base)', () => {
    const inst = init(makeConfig());
    expect(inst.version).toBeTruthy();
    inst.destroy();
  });

  it('accepts proxy mode (no key, custom baseUrl)', () => {
    const inst = init(
      makeConfig({
        llm: { baseUrl: 'https://example.com/api/ibh-llm' },
      })
    );
    expect(inst.version).toBeTruthy();
    inst.destroy();
  });

  it('accepts proxy mode with extra gateway headers', () => {
    const inst = init(
      makeConfig({
        llm: { baseUrl: 'https://example.com/api/ibh-llm', headers: { 'X-Gateway-Token': 't' } },
      })
    );
    expect(inst.version).toBeTruthy();
    inst.destroy();
  });

  it('refuses keyless configs that still point at OpenRouter directly', () => {
    expect(() => init(makeConfig({ llm: {} }))).toThrow('no LLM credentials configured');
    expect(() => init(makeConfig({ llm: { openRouterKey: undefined, baseUrl: OPENROUTER_DEFAULT_BASE } }))).toThrow(
      'Never ship a shared OpenRouter key'
    );
  });

  it('STT without reachable credentials fails closed even when the LLM runs on a proxy', () => {
    // llm proxy (no key anywhere); stt explicitly points at OpenRouter -> refuse
    expect(() =>
      init(
        makeConfig({
          llm: { baseUrl: 'https://example.com/api/ibh-llm' },
          ui: { enabled: false, stt: { model: 'elevenlabs/scribe-v2', baseUrl: OPENROUTER_DEFAULT_BASE } },
        })
      )
    ).toThrow('no STT credentials are reachable');

    // llm-level proxy covers STT too (same base) -> fine
    const ok = init(
      makeConfig({
        llm: { baseUrl: 'https://example.com/api/ibh-llm' },
        ui: { enabled: false, stt: { model: 'elevenlabs/scribe-v2' } },
      })
    );
    ok.destroy();
  });

  it('invalid LLM credentials are reported first, even when STT is configured', () => {
    expect(() =>
      init(makeConfig({ llm: {}, ui: { enabled: false, stt: { model: 'elevenlabs/scribe-v2' } } }))
    ).toThrow('no LLM credentials configured');
  });

  it('still validates the manifest (fail-closed ordering: manifest first, then credentials)', () => {
    const bad = makeConfig();
    (bad.manifest.api[0] as Partial<typeof bad.manifest.api[0]>) = { id: 'broken' };
    expect(() => init(bad)).toThrow('invalid capability manifest');
  });
});

function confirmManifest(): IbhManifest {
  return {
    version: 1,
    site: { name: 'TestSite', origin: 'https://example.com' },
    api: [
      { id: 'list', method: 'GET', path: '/api/list', tier: 'auto' },
      {
        id: 'create',
        method: 'POST',
        path: '/api/create',
        tier: 'confirm',
        argSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    ],
    policies: { maxMutatingActionsPerSession: 5 },
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  };
}

describe('headless consent (opt-in override)', () => {
  it('denies confirm-tier actions by default in headless mode', async () => {
    stubChatWithToolCall('api_create', { body: { name: 'Ember' } });
    const inst = init(makeConfig({ manifest: confirmManifest() }));
    await inst.send('create a sprite called Ember');
    expect(inst.audit().some((e) => e.decision === 'deny')).toBe(true);
    expect(inst.audit().some((e) => e.kind === 'api' && e.decision === 'confirm')).toBe(false);
    inst.destroy();
  });

  it('executes consented actions when a custom consent handler is supplied', async () => {
    const asks: ConsentRequest[] = [];
    stubChatWithToolCall('api_create', { body: { name: 'Ember' } });
    const inst = init(
      makeConfig({
        manifest: confirmManifest(),
        consent: (req) => {
          asks.push(req);
          return true;
        },
      })
    );
    const out = await inst.send('create a sprite called Ember');
    expect(out).toBe('done');
    expect(asks).toHaveLength(1);
    expect(asks[0]?.capabilityId).toBe('create');
    expect(inst.audit().some((e) => e.kind === 'api' && e.decision === 'confirm')).toBe(true);
    inst.destroy();
  });

  it('a declining consent handler blocks execution', async () => {
    stubChatWithToolCall('api_create', { body: { name: 'Ember' } });
    const inst = init(makeConfig({ manifest: confirmManifest(), consent: () => false }));
    await inst.send('create a sprite called Ember');
    expect(inst.audit().some((e) => e.decision === 'consent-denied')).toBe(true);
    inst.destroy();
  });
});

describe('opt-in persistence', () => {
  it('restores history, audit and approvals on init, and re-saves after a turn', async () => {
    const key = 'ibh:session';
    localStorage.setItem(
      key,
      JSON.stringify({
        v: 1,
        history: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
        audit: [{ id: 3, ts: 1, kind: 'llm', decision: 'allow', summary: 'restored' }],
        approved: ['create'],
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      )
    );

    const inst = init(makeConfig({ manifest: confirmManifest(), persistence: { enabled: true } }));
    expect(inst.session.displayHistory()).toEqual([
      { role: 'user', text: 'earlier question' },
      { role: 'assistant', text: 'earlier answer' },
    ]);
    expect(inst.audit().some((e) => e.summary === 'restored')).toBe(true);

    await inst.send('hi');
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    expect(saved.history.some((m: { content: string }) => m.content === 'hi')).toBe(true);
    expect(saved.audit.length).toBeGreaterThan(1);
    expect(saved.approved).toContain('create');
    inst.destroy();
  });

  it('writes nothing when persistence is off (the default)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      )
    );
    const inst = init(makeConfig({ manifest: confirmManifest() }));
    await inst.send('hi');
    expect(localStorage.getItem('ibh:session')).toBeNull();
    inst.destroy();
  });
});
