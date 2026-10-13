// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createComponent, createRoot, onCleanup } from 'solid-js';
import { IbhChat, ibhChat } from './index';
import type { IbhChatProps } from './types';
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

const baseProps: IbhChatProps = {
  manifest: {
    version: 1,
    site: { name: 'TestSite', origin: 'https://example.com' },
    api: [],
    policies: {},
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  },
  auth: { mode: 'cookie' },
  llm: { openRouterKey: 'k' },
  ui: { startOpen: true, showAuditTab: true, theme: 'dark', launcher: { text: 'Go' }, placeholder: 'Type here' },
};

beforeEach(() => {
  initMock.mockReset();
  initMock.mockImplementation(() => makeInstance());
});

afterEach(() => {
  document.body.textContent = '';
});

describe('use:ibhChat directive', () => {
  it('initializes on mount with the full config (onReady stripped from the ibh config)', () => {
    const onReady = vi.fn();
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      ibhChat(document.createElement('div'), () => ({ ...baseProps, onReady }));
    });
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseProps.manifest);
    expect(cfg.auth).toEqual(baseProps.auth);
    expect(cfg.llm).toEqual(baseProps.llm);
    expect(cfg.ui).toEqual(baseProps.ui);
    expect('onReady' in (cfg as unknown as Record<string, unknown>)).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveReturnedWith(onReady.mock.calls[0]![0]);
    dispose();
  });

  it('the accessor is read ONCE at mount (config is a contract, not reactive state)', () => {
    let params: IbhChatProps = baseProps;
    const accessor = vi.fn(() => params);
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      ibhChat(document.createElement('div'), accessor);
    });
    expect(accessor).toHaveBeenCalledTimes(1); // untracked single read
    // later param mutations are never re-read
    params = { ...baseProps, ui: { startOpen: false } };
    dispose();
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('destroy() runs on disposal; double-dispose is safe', () => {
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      ibhChat(document.createElement('div'), () => baseProps);
    });
    const inst = initMock.mock.results[0]!.value;
    expect(inst.destroy).not.toHaveBeenCalled();
    dispose();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
    expect(() => dispose()).not.toThrow();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it('propagates init failures (e.g. invalid manifest)', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    expect(() =>
      createRoot((d) => {
        ibhChat(document.createElement('div'), () => baseProps);
        onCleanup(() => {});
        d();
      })
    ).toThrow('ibh: invalid capability manifest');
  });
});

describe('<IbhChat /> component', () => {
  it('initializes once with the full config and calls onReady', () => {
    const onReady = vi.fn();
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      createComponent(IbhChat, { ...baseProps, onReady });
    });
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseProps.manifest);
    expect(cfg.ui).toEqual(baseProps.ui);
    expect('onReady' in (cfg as unknown as Record<string, unknown>)).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('renders nothing itself (the panel self-mounts on body)', () => {
    let rendered: unknown;
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      rendered = createComponent(IbhChat, baseProps);
    });
    expect(rendered).toBeNull();
    dispose();
  });

  it('destroys on cleanup; props never re-init', () => {
    let props: IbhChatProps = baseProps;
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      createComponent(IbhChat, props);
    });
    const inst = initMock.mock.results[0]!.value;
    props = { ...baseProps, ui: { startOpen: false } };
    dispose();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it('propagates init failures (e.g. invalid manifest)', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    expect(() =>
      createRoot((d) => {
        createComponent(IbhChat, baseProps);
        onCleanup(() => {});
        d();
      })
    ).toThrow('ibh: invalid capability manifest');
  });

  it('proxy mode: keyless llm config passes through untouched', () => {
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      createComponent(IbhChat, { ...baseProps, llm: { baseUrl: '/api/ibh-llm' } });
    });
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.llm).toEqual({ baseUrl: '/api/ibh-llm' });
    expect('openRouterKey' in (cfg.llm as unknown as Record<string, unknown>)).toBe(false);
    dispose();
  });

  it('BYO-key mode: user-pasted key passes through untouched', () => {
    let dispose: () => void = () => {};
    createRoot((d) => {
      dispose = d;
      createComponent(IbhChat, { ...baseProps, llm: { openRouterKey: 'sk-user-own-key' } });
    });
    expect(initMock.mock.calls[0]![0].llm).toEqual({ openRouterKey: 'sk-user-own-key' });
    dispose();
  });
});
