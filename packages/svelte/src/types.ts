import type { IbhConfig, IbhInstance, AuditEntry, SendOptions, UiTheme } from '@gametorch/ibh';

export type { IbhConfig, IbhInstance, IbhManifest, AuditEntry, UiTheme, AuthAdapter, SendOptions, ImageAttachment, MarkdownConfig } from '@gametorch/ibh';

/** Imperative handle for controlling the ibh instance. */
export interface IbhChatHandle {
  send(text: string, opts?: SendOptions): void;
  open(): void;
  close(): void;
  setTheme(theme: UiTheme): void;
  audit(): readonly AuditEntry[];
  instance(): IbhInstance | null;
}

/** Config + optional readiness callback (also the action parameter shape). */
export type IbhChatProps = IbhConfig & {
  onReady?: (instance: IbhInstance) => void;
};

export type IbhChatParams = IbhChatProps;
