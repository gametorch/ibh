import { createComponent, onCleanup } from 'solid-js';
import { init } from '@gametorch/ibh';
import type { IbhChatProps } from './types';

/**
 * Drop-in ibh agent component for Solid. Renders nothing itself — the panel
 * self-mounts in its own shadow root on document.body (framework- and
 * CSS-agnostic).
 *
 * ```tsx
 * <IbhChat manifest={manifest} guide={guide} auth={auth} llm={llm} ui={ui} />
 * ```
 *
 * (No JSX transform is needed to consume this package programmatically:
 * `createComponent(IbhChat, props)`.)
 *
 * Lifecycle: `ibh.init()` runs once when the component is created inside a
 * reactive root; `destroy()` runs on cleanup. The full config (including the
 * manifest contract) is read once at creation — input changes do not re-init.
 * Grab the live instance via the `onReady` prop (it carries the full API:
 * send/open/close/setTheme/audit). If the manifest fails validation, init
 * throws (fail-closed, by design).
 */
export function IbhChat(props: IbhChatProps): null {
  const instance = init({
    manifest: props.manifest,
    guide: props.guide,
    auth: props.auth,
    llm: props.llm,
    ui: props.ui,
    nav: props.nav,
    dom: props.dom,
  });
  props.onReady?.(instance);

  onCleanup(() => {
    instance.destroy();
  });

  return null;
}

export { createComponent as createIbhComponent };
