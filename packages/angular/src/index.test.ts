// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IbhChat } from './index';
import type { IbhConfig } from './index';
import { init } from '@gametorch/ibh';
import type { IbhInstance } from '@gametorch/ibh';

vi.mock('@gametorch/ibh', () => ({ init: vi.fn() }));
const initMock = vi.mocked(init);

function makeInstance(): IbhInstance {
  return {
    send: vi.fn(async () => 'ok'),
    open: vi.fn(),
    close: vi.fn(),
    isOpen: vi.fn(() => false),
    setTheme: vi.fn(),
    audit: vi.fn(() => []),
    session: {} as IbhInstance['session'],
    destroy: vi.fn(),
    version: '0-test',
  };
}

const baseConfig: Omit<IbhConfig, never> = {
  manifest: {
    version: 1,
    site: { name: 'TestSite', origin: 'https://example.com' },
    api: [],
    policies: {},
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  },
  auth: { mode: 'cookie' },
  llm: { openRouterKey: 'k' },
  ui: { startOpen: true, showAuditTab: true, theme: 'dark', launcher: { text: 'Go' }, placeholder: 'Type here', style: { '--ibh-accent': '#f00' } },
};

/** Angular directives are plain classes — construct + run lifecycle hooks directly. */
function makeDirective(config = baseConfig): { d: IbhChat; ready: IbhInstance[] } {
  const d = new IbhChat();
  d.manifest = config.manifest;
  d.guide = config.guide;
  d.auth = config.auth;
  d.llm = config.llm;
  d.ui = config.ui;
  d.nav = config.nav;
  d.dom = config.dom;
  const ready: IbhInstance[] = [];
  d.ready.subscribe((inst) => ready.push(inst));
  return { d, ready };
}

beforeEach(() => {
  initMock.mockReset();
  initMock.mockImplementation(() => makeInstance());
});

describe('IbhChat (Angular directive)', () => {
  it('initializes once in ngOnInit with the full config (inputs passthrough)', () => {
    const { d } = makeDirective();
    d.ngOnInit();
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseConfig.manifest);
    expect(cfg.auth).toEqual(baseConfig.auth);
    expect(cfg.llm).toEqual(baseConfig.llm);
    expect(cfg.ui).toEqual(baseConfig.ui);
    expect(cfg.guide).toBeUndefined();
    expect('ready' in (cfg as unknown as Record<string, unknown>)).toBe(false);
  });

  it('emits `ready` with the live instance after a successful init', () => {
    const { d, ready } = makeDirective();
    d.ngOnInit();
    expect(ready).toHaveLength(1);
    expect(initMock).toHaveReturnedWith(ready[0]);
  });

  it('destroys the instance in ngOnDestroy', () => {
    const { d } = makeDirective();
    d.ngOnInit();
    const inst = initMock.mock.results[0]!.value;
    expect(inst.destroy).not.toHaveBeenCalled();
    d.ngOnDestroy();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
    expect(d.instance()).toBeNull();
  });

  it('input changes do NOT re-init (no ngOnChanges; config is read once at mount)', () => {
    const { d } = makeDirective();
    d.ngOnInit();
    expect(initMock).toHaveBeenCalledTimes(1);
    // Angular never re-runs ngOnInit on input changes, and the directive declares
    // no ngOnChanges — so mutating inputs cannot re-init by construction.
    // (Remount via a structural change to apply a new manifest; documented.)
    d.ui = { startOpen: false };
    d.manifest = { ...baseConfig.manifest, site: { name: 'Changed', origin: 'https://example.com' } };
    expect(initMock).toHaveBeenCalledTimes(1);
    // the live instance keeps running with the mount-time config
    const inst = initMock.mock.results[0]!.value;
    d.send('still alive');
    expect(inst.send).toHaveBeenCalledWith('still alive', undefined);
  });

  it('forwards the handle to the live instance', () => {
    const { d } = makeDirective();
    d.ngOnInit();
    const inst = initMock.mock.results[0]!.value;
    const handle = d.handle;
    expect(handle).toBe(d);
    d.send('hello');
    d.open();
    d.close();
    d.setTheme('light');
    expect(inst.send).toHaveBeenCalledWith('hello', undefined);
    expect(inst.open).toHaveBeenCalledTimes(1);
    expect(inst.close).toHaveBeenCalledTimes(1);
    expect(inst.setTheme).toHaveBeenCalledWith('light');
    expect(d.audit()).toEqual([]);
    expect(d.instance()).toBe(inst);
  });

  it('handle methods are safe before init / after destroy (no-ops, not throws)', () => {
    const { d } = makeDirective();
    expect(() => d.send('x')).not.toThrow();
    expect(() => d.open()).not.toThrow();
    expect(d.instance()).toBeNull();
    expect(d.audit()).toEqual([]);
    d.ngOnInit();
    d.ngOnDestroy();
    expect(() => d.send('y')).not.toThrow();
    expect(d.instance()).toBeNull();
    expect(d.audit()).toEqual([]);
  });

  it('proxy mode: keyless llm config passes through untouched', () => {
    const { d } = makeDirective();
    d.llm = { baseUrl: '/api/ibh-llm' };
    d.ngOnInit();
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.llm).toEqual({ baseUrl: '/api/ibh-llm' });
    expect('openRouterKey' in (cfg.llm as unknown as Record<string, unknown>)).toBe(false);
  });

  it('BYO-key mode: user-pasted key passes through untouched', () => {
    const { d } = makeDirective();
    d.llm = { openRouterKey: 'sk-user-own-key' };
    d.ngOnInit();
    expect(initMock.mock.calls[0]![0].llm).toEqual({ openRouterKey: 'sk-user-own-key' });
  });

  it('propagates init failures (e.g. invalid manifest) to the caller', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    const { d } = makeDirective();
    expect(() => d.ngOnInit()).toThrow('ibh: invalid capability manifest');
  });
});
