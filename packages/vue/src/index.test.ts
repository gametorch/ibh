// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { IbhChat } from './index';
import type { IbhChatHandle, IbhChatProps } from './index';
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
  ui: { startOpen: true, showAuditTab: true, theme: 'dark', launcher: { text: 'Go' }, placeholder: 'Type here', style: { '--ibh-accent': '#f00' } },
};

/** Mount IbhChat through a tiny parent so the template ref wires the exposed handle. */
function mountComponent(props: IbhChatProps) {
  const container = document.createElement('div');
  document.body.append(container);
  const child = ref<IbhChatHandle>();
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(IbhChat, { ...props, ref: child });
      },
    })
  );
  app.config.warnHandler = () => {};
  app.mount(container);
  return {
    child,
    app,
    unmount: () => {
      app.unmount();
      container.remove();
    },
  };
}

beforeEach(() => {
  initMock.mockReset();
  initMock.mockImplementation(() => makeInstance());
  document.body.textContent = '';
});

afterEach(() => {
  document.body.textContent = '';
});

describe('IbhChat (Vue)', () => {
  it('initializes once with the full config (manifest, auth, llm, ui passthrough)', () => {
    const m = mountComponent(baseProps);
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseProps.manifest);
    expect(cfg.auth).toEqual(baseProps.auth);
    expect(cfg.llm).toEqual(baseProps.llm);
    expect(cfg.ui).toEqual(baseProps.ui);
    expect('onReady' in (cfg as unknown as Record<string, unknown>)).toBe(false);
    m.unmount();
  });

  it('calls onReady with the live instance', () => {
    const onReady = vi.fn();
    const m = mountComponent({ ...baseProps, onReady });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveReturnedWith(onReady.mock.calls[0]![0]);
    m.unmount();
  });

  it('destroys the instance on unmount', () => {
    const m = mountComponent(baseProps);
    const inst = initMock.mock.results[0]!.value;
    expect(inst.destroy).not.toHaveBeenCalled();
    m.unmount();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it('prop changes do NOT re-init (config is read once at mount)', async () => {
    const ui = ref(baseProps.ui);
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp(
      defineComponent({
        setup() {
          return () => h(IbhChat, { ...baseProps, ui: ui.value });
        },
      })
    );
    app.mount(container);
    ui.value = { startOpen: false };
    await nextTick();
    expect(initMock).toHaveBeenCalledTimes(1);
    app.unmount();
    container.remove();
  });

  it('forwards the exposed handle to the live instance', () => {
    const m = mountComponent(baseProps);
    const inst = initMock.mock.results[0]!.value;
    m.child.value?.send('hello');
    m.child.value?.open();
    m.child.value?.close();
    m.child.value?.setTheme('light');
    expect(inst.send).toHaveBeenCalledWith('hello', undefined);
    expect(inst.open).toHaveBeenCalledTimes(1);
    expect(inst.close).toHaveBeenCalledTimes(1);
    expect(inst.setTheme).toHaveBeenCalledWith('light');
    expect(m.child.value?.audit()).toEqual([]);
    expect(m.child.value?.instance()).toBe(inst);
    m.unmount();
  });

  it('handle methods are safe after unmount (no-ops, not throws)', () => {
    const m = mountComponent(baseProps);
    m.unmount();
    expect(() => m.child.value?.send('x')).not.toThrow();
    expect(() => m.child.value?.open()).not.toThrow();
    expect(m.child.value?.instance() ?? null).toBeNull();
    expect(m.child.value?.audit() ?? []).toEqual([]);
  });

  it('proxy mode: keyless llm config passes through untouched', () => {
    const m = mountComponent({ ...baseProps, llm: { baseUrl: '/api/ibh-llm' } });
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.llm).toEqual({ baseUrl: '/api/ibh-llm' });
    expect('openRouterKey' in (cfg.llm as unknown as Record<string, unknown>)).toBe(false);
    m.unmount();
  });

  it('BYO-key mode: user-pasted key passes through untouched', () => {
    const m = mountComponent({ ...baseProps, llm: { openRouterKey: 'sk-user-own-key' } });
    expect(initMock.mock.calls[0]![0].llm).toEqual({ openRouterKey: 'sk-user-own-key' });
    m.unmount();
  });

  it('propagates init failures (e.g. invalid manifest) to the app error handler', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    const container = document.createElement('div');
    document.body.append(container);
    const app = createApp(defineComponent({ setup: () => () => h(IbhChat, baseProps) }));
    const errors: unknown[] = [];
    app.config.errorHandler = (err) => errors.push(err);
    app.mount(container);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('ibh: invalid capability manifest');
    app.unmount();
    container.remove();
  });

  it('renders nothing into the DOM tree itself (panel self-mounts on body)', () => {
    const m = mountComponent(baseProps);
    expect(document.body.querySelector('div[data-v-app] > *')).toBeNull();
    expect(document.body.querySelectorAll('div[data-v-app] *').length).toBe(0);
    m.unmount();
  });
});
