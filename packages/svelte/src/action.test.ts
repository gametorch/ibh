import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ibhChat } from './action';
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

const baseParams: IbhChatProps = {
  manifest: {
    version: 1,
    site: { name: 'TestSite', origin: 'https://example.com' },
    api: [],
    policies: {},
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  },
  auth: { mode: 'cookie' },
  llm: { openRouterKey: 'k' },
  ui: { startOpen: true },
};

// the action never touches the node (the panel self-mounts on document.body)
const fakeNode = {} as Element;

beforeEach(() => {
  initMock.mockReset();
  initMock.mockImplementation(() => makeInstance());
});

describe('ibhChat action', () => {
  it('initializes on attach with the full config (onReady stripped from the ibh config)', () => {
    const onReady = vi.fn();
    const action = ibhChat(fakeNode, { ...baseParams, onReady });
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseParams.manifest);
    expect(cfg.auth).toEqual(baseParams.auth);
    expect(cfg.llm).toEqual(baseParams.llm);
    expect(cfg.ui).toEqual(baseParams.ui);
    expect('onReady' in (cfg as unknown as Record<string, unknown>)).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveReturnedWith(onReady.mock.calls[0]![0]);
    action.destroy?.();
  });

  it('update() is a deliberate no-op — config is a contract, not reactive state', () => {
    const action = ibhChat(fakeNode, baseParams);
    action.update?.({ ...baseParams, ui: { startOpen: false } });
    action.update?.({ ...baseParams, llm: { openRouterKey: 'rotated' } });
    expect(initMock).toHaveBeenCalledTimes(1); // no re-init, ever
    action.destroy?.();
  });

  it('destroy() destroys the harness and the handle goes dead', () => {
    const action = ibhChat(fakeNode, baseParams);
    const inst = initMock.mock.results[0]!.value;
    expect(inst.destroy).not.toHaveBeenCalled();
    action.destroy?.();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
    // double-destroy is safe
    expect(() => action.destroy?.()).not.toThrow();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it('works without onReady', () => {
    const action = ibhChat(fakeNode, baseParams);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(() => action.destroy?.()).not.toThrow();
  });

  it('propagates init failures (e.g. invalid manifest)', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    expect(() => ibhChat(fakeNode, baseParams)).toThrow('ibh: invalid capability manifest');
  });
});
