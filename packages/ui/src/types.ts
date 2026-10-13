import type { AuditEntry, ConsentRequest, ToolOutcome } from '@ibh/core';

export type UiTheme = 'light' | 'dark' | 'system';

/** The interface the ibh umbrella provides to the UI layer. Keeps ui decoupled from wiring. */
export interface IbhUiController {
  getSiteName(): string;
  send(text: string): void;
  stop(): void;
  isRunning(): boolean;
  clearConversation(): void;
  onRunningChange(cb: (running: boolean) => void): () => void;
  onStatus(cb: (text: string) => void): () => void;
  onAssistant(cb: (text: string) => void): () => void;
  onToolStart(cb: (info: { capabilityId: string; kind: string }) => void): () => void;
  onToolEnd(cb: (outcome: ToolOutcome) => void): () => void;
  onAudit(cb: (e: AuditEntry) => void): () => void;
  getAudit(): readonly AuditEntry[];
}

export interface IbhUiHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  requestConsent(req: ConsentRequest): Promise<boolean>;
  /** Set the panel theme explicitly ('system' follows the OS preference). */
  setTheme(theme: UiTheme): void;
  destroy(): void;
}

export interface IbhUiOptions {
  accent?: string;
  startOpen?: boolean;
  /** Initial theme. Defaults to "system" (follows the OS preference). The user can switch in the panel header. */
  theme?: UiTheme;
  /** Hide the theme picker button (for hosts that control the theme themselves, e.g. via `setTheme`). */
  hideThemePicker?: boolean;
  /** Show the "clear conversation" (⟲) button in the panel header. Hidden by default. */
  showClearConversation?: boolean;
  /**
   * CSS applied to the panel host element. Custom properties set here inherit into
   * the shadow root — this is the primary, stable theming surface. Example:
   * `{ '--ibh-accent': '#8b6cff', '--ibh-radius-panel': '6px' }`.
   */
  style?: Record<string, string>;
  /**
   * Raw CSS appended to the panel's shadow root. Advanced escape hatch for hosts
   * that need to restyle things the custom properties do not cover.
   */
  css?: string;
  /**
   * Where the panel (and its launcher button) start. Viewport coordinates:
   * give `left`/`top` directly, or anchor from the right/bottom edges.
   * Omitted = default bottom-right corner. User drags/resizes persist and win.
   */
  defaultPosition?: {
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
  };
  /** Show the "Audit" tab next to "Chat" in the panel header. Hidden by default. */
  showAuditTab?: boolean;
  /** Launcher button (the closed-state circle): text + hover title. */
  launcher?: {
    text?: string;
    title?: string;
  };
  /** Composer textarea placeholder text. */
  placeholder?: string;
  /** Empty-chat state: title + hint shown before the first message. */
  emptyState?: {
    title?: string;
    hint?: string;
  };
  /**
   * Voice input via speech-to-text. When set, a mic button appears in the composer:
   * click to record, click again to stop. The recording is transcribed via the
   * OpenRouter audio-input chat-completions shape (using the integrator's key) and
   * either sent automatically or used to fill the input (per the auto-send checkbox,
   * checked by default).
   */
  stt?: {
    /** OpenRouter key for BYO mode. Omit when requests go through the integrator's proxy. */
    apiKey?: string;
    /** OpenRouter STT model slug, e.g. 'elevenlabs/scribe-v2'. */
    model: string;
    /** Defaults to https://openrouter.ai/api/v1 */
    baseUrl?: string;
    /** Full-URL override for the transcription request (default: `${baseUrl}/audio/transcriptions`). */
    endpoint?: string;
    /** Optional language hint (e.g. 'en'), passed to the STT endpoint. */
    language?: string;
    /** Whether the auto-send checkbox starts checked. Default true. */
    autoSend?: boolean;
  };
}
