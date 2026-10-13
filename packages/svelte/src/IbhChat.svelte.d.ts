import type { Component } from 'svelte';
import type { IbhChatHandle, IbhChatProps } from './types.js';

/**
 * Drop-in ibh agent component for Svelte 5.
 *
 * Props: `manifest`, `guide`, `auth`, `llm`, `ui`, `nav`, `dom` (the full
 * `ibh.init()` config) plus `onReady`. Exports (via `bind:this` or the `mount()`
 * return value): send/open/close/setTheme/audit/instance.
 *
 * The config is read once at mount; unmount destroys the harness.
 */
declare const IbhChat: Component<IbhChatProps, IbhChatHandle>;

export default IbhChat;
