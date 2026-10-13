import { onCleanup, untrack } from 'solid-js';
import { init } from '@gametorch/ibh';
import type { IbhInstance } from '@gametorch/ibh';
import type { IbhChatProps } from './types';

/**
 * Solid directive: `use:ibhChat={params}`.
 *
 * The idiomatic Solid way to attach a self-mounting imperative widget — a plain
 * function, no compiler plugin needed in this package. `ibh.init()` runs when the
 * element mounts; `destroy()` runs on disposal (via onCleanup). The config
 * (including the manifest contract) is read ONCE at mount — the accessor is
 * untracked and never re-read; remount to apply a new manifest.
 *
 * ```tsx
 * let ibh: IbhInstance;
 * <div use:ibhChat={{ ...config, onReady: (i) => (ibh = i) }} />
 * ```
 *
 * If the manifest fails validation, init throws (fail-closed, by design).
 */
export function ibhChat(_el: Element, accessor: () => IbhChatProps): void {
  const { onReady, ...config } = untrack(accessor);
  let instance: IbhInstance | null = init(config);
  onReady?.(instance);

  onCleanup(() => {
    instance?.destroy();
    instance = null;
  });
}
