import { init } from '@gametorch/ibh';
import type { IbhInstance } from '@gametorch/ibh';
import type { ActionReturn } from 'svelte/action';
import type { IbhChatParams } from './types';

/**
 * Svelte action: `use:ibhChat={config}`.
 *
 * The idiomatic Svelte way to attach a self-mounting imperative widget — a plain
 * function, no component compiler needed. `ibh.init()` runs when the element
 * attaches; `destroy()` runs when it detaches. The config (including the manifest
 * contract) is read ONCE at attach time: `update()` deliberately ignores parameter
 * changes — re-attach the action (e.g. via `{#key}`) to apply a new manifest.
 *
 * Grab the live instance through `onReady` (the instance carries the full API:
 * send/open/close/setTheme/audit):
 *
 * ```svelte
 * <div use:ibhChat={{ ...config, onReady: (instance) => (ibh = instance) }} />
 * ```
 *
 * If the manifest fails validation, init throws (fail-closed, by design).
 */
export function ibhChat(_node: Element, params: IbhChatParams): ActionReturn<IbhChatParams> {
  const { onReady, ...config } = params;
  let instance: IbhInstance | null = init(config);
  onReady?.(instance);

  return {
    update() {
      /* intentional no-op — see docstring */
    },
    destroy() {
      instance?.destroy();
      instance = null;
    },
  };
}
