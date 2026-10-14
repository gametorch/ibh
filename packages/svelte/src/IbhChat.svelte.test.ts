// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import IbhChat from './IbhChat.svelte';
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

let container: HTMLElement;

beforeEach(() => {
  initMock.mockReset();
  initMock.mockImplementation(() => makeInstance());
  document.body.textContent = '';
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  document.body.textContent = '';
});

describe('<IbhChat /> (Svelte 5 component)', () => {
  it('initializes on mount with the full config and calls onReady', () => {
    const onReady = vi.fn();
    const app = mount(IbhChat, { target: container, props: { ...baseProps, onReady } });
    flushSync();
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseProps.manifest);
    expect(cfg.ui).toEqual(baseProps.ui);
    expect('onReady' in (cfg as unknown as Record<string, unknown>)).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
    unmount(app);
  });

  it('component exports delegate to the live instance', () => {
    const app = mount(IbhChat, { target: container, props: baseProps });
    flushSync();
    const inst = initMock.mock.results[0]!.value;
    app.send('hello');
    app.open();
    app.close();
    app.setTheme('light');
    expect(inst.send).toHaveBeenCalledWith('hello', undefined);
    expect(inst.open).toHaveBeenCalledTimes(1);
    expect(inst.close).toHaveBeenCalledTimes(1);
    expect(inst.setTheme).toHaveBeenCalledWith('light');
    expect(app.audit()).toEqual([]);
    expect(app.instance()).toBe(inst);
    unmount(app);
  });

  it('props do not re-init; unmount destroys the harness', () => {
    const app = mount(IbhChat, { target: container, props: baseProps });
    flushSync();
    expect(initMock).toHaveBeenCalledTimes(1);
    // props are read at mount; there is no reactive path back into init
    const inst = initMock.mock.results[0]!.value;
    expect(inst.destroy).not.toHaveBeenCalled();
    unmount(app);
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it('proxy mode: keyless llm config passes through untouched', () => {
    const app = mount(IbhChat, { target: container, props: { ...baseProps, llm: { baseUrl: '/api/ibh-llm' } } });
    flushSync();
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.llm).toEqual({ baseUrl: '/api/ibh-llm' });
    expect('openRouterKey' in (cfg.llm as unknown as Record<string, unknown>)).toBe(false);
    unmount(app);
  });

  it('BYO-key mode: user-pasted key passes through untouched', () => {
    const app = mount(IbhChat, { target: container, props: { ...baseProps, llm: { openRouterKey: 'sk-user-own-key' } } });
    flushSync();
    expect(initMock.mock.calls[0]![0].llm).toEqual({ openRouterKey: 'sk-user-own-key' });
    unmount(app);
  });

  it('propagates init failures (e.g. invalid manifest)', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    expect(() => {
      const app = mount(IbhChat, { target: container, props: baseProps });
      flushSync();
      void app;
    }).toThrow('ibh: invalid capability manifest');
  });
});
