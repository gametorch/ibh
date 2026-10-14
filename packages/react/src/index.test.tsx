// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { StrictMode, createRef, Component, type ReactNode } from 'react';
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

beforeEach(() => {
  initMock.mockReset();
  initMock.mockImplementation(() => makeInstance());
});

afterEach(() => {
  cleanup();
});

describe('IbhChat', () => {
  it('initializes once with the full config (manifest, auth, llm, ui passthrough)', () => {
    render(<IbhChat {...baseProps} />);
    expect(initMock).toHaveBeenCalledTimes(1);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.manifest).toEqual(baseProps.manifest);
    expect(cfg.auth).toEqual(baseProps.auth);
    expect(cfg.llm).toEqual(baseProps.llm);
    expect(cfg.ui).toEqual(baseProps.ui);
    // onReady must not leak into the ibh config
    expect('onReady' in (cfg as unknown as Record<string, unknown>)).toBe(false);
  });

  it('calls onReady with the live instance', () => {
    const onReady = vi.fn();
    render(<IbhChat {...baseProps} onReady={onReady} />);
    expect(onReady).toHaveBeenCalledTimes(1);
    const inst = onReady.mock.calls[0]![0];
    expect(initMock).toHaveReturnedWith(inst);
  });

  it('destroys the instance on unmount', () => {
    const { unmount } = render(<IbhChat {...baseProps} />);
    const inst = initMock.mock.results[0]!.value;
    expect(inst.destroy).not.toHaveBeenCalled();
    unmount();
    expect(inst.destroy).toHaveBeenCalledTimes(1);
  });

  it('is StrictMode-safe: destroy runs between the double mount', () => {
    render(
      <StrictMode>
        <IbhChat {...baseProps} />
      </StrictMode>
    );
    expect(initMock).toHaveBeenCalledTimes(2);
    const first = initMock.mock.results[0]!.value;
    const second = initMock.mock.results[1]!.value;
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it('re-renders do NOT re-init (config is read once at mount)', () => {
    const { rerender } = render(<IbhChat {...baseProps} />);
    rerender(<IbhChat {...baseProps} ui={{ startOpen: false }} />);
    rerender(<IbhChat {...baseProps} ui={{ startOpen: false }} />);
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  it('forwards the imperative handle to the live instance', () => {
    const handle = createRef<IbhChatHandle>();
    render(<IbhChat {...baseProps} ref={handle} />);
    const inst = initMock.mock.results[0]!.value;
    handle.current?.send('hello');
    const image = { url: 'data:image/png;base64,AAA' };
    handle.current?.send('with image', { images: [image] });
    handle.current?.open();
    handle.current?.close();
    handle.current?.setTheme('light');
    expect(inst.send).toHaveBeenCalledWith('hello', undefined);
    expect(inst.send).toHaveBeenCalledWith('with image', { images: [image] });
    expect(inst.open).toHaveBeenCalledTimes(1);
    expect(inst.close).toHaveBeenCalledTimes(1);
    expect(inst.setTheme).toHaveBeenCalledWith('light');
    expect(handle.current?.audit()).toEqual([]);
    expect(handle.current?.instance()).toBe(inst);
  });

  it('handle methods are safe before init/after unmount (no-ops, not throws)', () => {
    const handle = createRef<IbhChatHandle>();
    const { unmount } = render(<IbhChat {...baseProps} ref={handle} />);
    unmount();
    expect(() => handle.current?.send('x')).not.toThrow();
    expect(() => handle.current?.open()).not.toThrow();
    expect(handle.current?.instance() ?? null).toBeNull();
    expect(handle.current?.audit() ?? []).toEqual([]);
  });

  it('proxy mode: keyless llm config (baseUrl only) passes through untouched', () => {
    render(<IbhChat {...baseProps} llm={{ baseUrl: '/api/ibh-llm' }} />);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.llm).toEqual({ baseUrl: '/api/ibh-llm' });
    expect('openRouterKey' in (cfg.llm as unknown as Record<string, unknown>)).toBe(false);
  });

  it('BYO-key mode: user-pasted key passes through untouched', () => {
    render(<IbhChat {...baseProps} llm={{ openRouterKey: 'sk-user-own-key' }} />);
    const cfg = initMock.mock.calls[0]![0];
    expect(cfg.llm).toEqual({ openRouterKey: 'sk-user-own-key' });
  });

  class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) {
      return { error };
    }
    render() {
      return this.state.error ? <div>{this.state.error.message}</div> : this.props.children;
    }
  }

  it('propagates init failures (e.g. invalid manifest) to the error boundary', () => {
    initMock.mockImplementation(() => {
      throw new Error('ibh: invalid capability manifest — tier is required');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { getByText } = render(
        <ErrorBoundary>
          <IbhChat {...baseProps} />
        </ErrorBoundary>
      );
      // the boundary catches the throw and renders the message — no unhandled
      // jsdom runtime error noise
      expect(getByText('ibh: invalid capability manifest — tier is required')).toBeDefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('renders nothing into the DOM tree itself (panel self-mounts on body)', () => {
    const { container } = render(<IbhChat {...baseProps} />);
    expect(container.innerHTML).toBe('');
  });
});
