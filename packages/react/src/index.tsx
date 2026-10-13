import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { init } from '@gametorch/ibh';
import type { AuditEntry, IbhConfig, IbhInstance, UiTheme } from '@gametorch/ibh';

export type { IbhConfig, IbhInstance, IbhManifest, AuditEntry, UiTheme, AuthAdapter } from '@gametorch/ibh';

/** Imperative handle for controlling the ibh instance from outside React. */
export interface IbhChatHandle {
  send(text: string): void;
  open(): void;
  close(): void;
  setTheme(theme: UiTheme): void;
  audit(): readonly AuditEntry[];
  instance(): IbhInstance | null;
}

export interface IbhChatProps extends IbhConfig {
  /** Called once, after ibh initializes successfully (not re-called on StrictMode remounts). */
  onReady?: (instance: IbhInstance) => void;
}

/**
 * Drop-in ibh agent component. Renders nothing itself — the panel self-mounts in
 * its own shadow root on document.body (framework- and CSS-agnostic).
 *
 * Lifecycle: `ibh.init()` runs once on mount and `destroy()` on unmount; the full
 * config (including the manifest contract) is read once at mount time. Safe under
 * React StrictMode. If the manifest fails validation, init throws and the error
 * propagates to your error boundary.
 */
export const IbhChat = forwardRef<IbhChatHandle, IbhChatProps>(function IbhChat(props, ref) {
  const instanceRef = useRef<IbhInstance | null>(null);
  const propsRef = useRef(props);

  // keep the latest props in a ref without re-initializing; effects run in
  // declaration order, so this runs BEFORE the init effect on mount.
  useEffect(() => {
    propsRef.current = props;
  });

  useEffect(() => {
    const { onReady, ...config } = propsRef.current;
    const instance = init(config);
    instanceRef.current = instance;
    onReady?.(instance);
    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      send: (text) => instanceRef.current?.send(text),
      open: () => instanceRef.current?.open(),
      close: () => instanceRef.current?.close(),
      setTheme: (theme) => instanceRef.current?.setTheme(theme),
      audit: () => instanceRef.current?.audit() ?? [],
      instance: () => instanceRef.current,
    }),
    []
  );

  return null;
});

export default IbhChat;
