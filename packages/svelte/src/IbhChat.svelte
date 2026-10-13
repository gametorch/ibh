<script lang="ts">
  import { ibhChat } from './action';
  import type { IbhChatProps, UiTheme } from './types';
  import type { IbhInstance } from '@gametorch/ibh';

  let {
    manifest,
    guide,
    auth,
    llm,
    ui,
    nav,
    dom,
    onReady,
  }: IbhChatProps = $props();

  let current: IbhInstance | null = null;
  function handleReady(inst: IbhInstance): void {
    current = inst;
    onReady?.(inst);
  }

  // Component exports: available on the mount return value / via bind:this.
  export function send(text: string): void {
    current?.send(text);
  }
  export function open(): void {
    current?.open();
  }
  export function close(): void {
    current?.close();
  }
  export function setTheme(theme: UiTheme): void {
    current?.setTheme(theme);
  }
  export function audit() {
    return current?.audit() ?? [];
  }
  export function instance(): IbhInstance | null {
    return current;
  }
</script>

<!-- Renders nothing itself; the panel self-mounts in its own shadow root.
     The action owns the full lifecycle: init on attach, destroy on detach,
     config read once (see action docs). -->
<div use:ibhChat={{ manifest, guide, auth, llm, ui, nav, dom, onReady: handleReady }}></div>
