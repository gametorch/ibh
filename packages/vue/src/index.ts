import { defineComponent, onMounted, onUnmounted } from 'vue';
import type { PropType } from 'vue';
import { init } from '@gametorch/ibh';
import type { AuditEntry, IbhConfig, IbhInstance, UiTheme } from '@gametorch/ibh';

export type { IbhConfig, IbhInstance, IbhManifest, AuditEntry, UiTheme, AuthAdapter } from '@gametorch/ibh';

/** Imperative handle for controlling the ibh instance from outside the component. */
export interface IbhChatHandle {
  send(text: string): void;
  open(): void;
  close(): void;
  setTheme(theme: UiTheme): void;
  audit(): readonly AuditEntry[];
  instance(): IbhInstance | null;
}

export type IbhChatProps = IbhConfig & {
  /** Called once, after ibh initializes successfully. */
  onReady?: (instance: IbhInstance) => void;
};

/**
 * Drop-in ibh agent component for Vue 3. Renders nothing itself — the panel
 * self-mounts in its own shadow root on document.body (framework- and
 * CSS-agnostic).
 *
 * Lifecycle: `ibh.init()` runs in onMounted and `destroy()` in onUnmounted; the
 * full config (including the manifest contract) is read once at mount time.
 * Access the handle via a template ref (the component exposes
 * `send/open/close/setTheme/audit/instance`). If the manifest fails validation,
 * init throws and the error propagates to your app's error handler.
 */
export const IbhChat = defineComponent({
  name: 'IbhChat',
  props: {
    manifest: { type: Object as PropType<IbhConfig['manifest']>, required: true },
    guide: { type: [String, Function] as PropType<IbhConfig['guide']>, default: undefined },
    auth: { type: Object as PropType<IbhConfig['auth']>, required: true },
    llm: { type: Object as PropType<IbhConfig['llm']>, required: true },
    ui: { type: Object as PropType<IbhConfig['ui']>, default: undefined },
    nav: { type: Object as PropType<IbhConfig['nav']>, default: undefined },
    dom: { type: Object as PropType<IbhConfig['dom']>, default: undefined },
    onReady: { type: Function as PropType<IbhChatProps['onReady']>, default: undefined },
  },
  setup(props, { expose }) {
    let instance: IbhInstance | null = null;

    onMounted(() => {
      instance = init({
        manifest: props.manifest,
        guide: props.guide,
        auth: props.auth,
        llm: props.llm,
        ui: props.ui,
        nav: props.nav,
        dom: props.dom,
      });
      props.onReady?.(instance);
    });

    onUnmounted(() => {
      instance?.destroy();
      instance = null;
    });

    const handle: IbhChatHandle = {
      send: (text) => instance?.send(text),
      open: () => instance?.open(),
      close: () => instance?.close(),
      setTheme: (theme) => instance?.setTheme(theme),
      audit: () => instance?.audit() ?? [],
      instance: () => instance,
    };
    expose(handle);

    return () => null;
  },
});

export default IbhChat;
