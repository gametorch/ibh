// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { init, OPENROUTER_DEFAULT_BASE } from './index';
import type { IbhConfig, IbhManifest } from './index';

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
