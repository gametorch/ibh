import { Directive, EventEmitter, Input, Output } from '@angular/core';
import { init } from '@gametorch/ibh';
import type { AuditEntry, IbhConfig, IbhInstance, SendOptions, UiTheme } from '@gametorch/ibh';

export type { IbhConfig, IbhInstance, IbhManifest, AuditEntry, UiTheme, AuthAdapter, SendOptions, ImageAttachment, MarkdownConfig } from '@gametorch/ibh';

/** Imperative handle for controlling the ibh instance from outside the directive. */
export interface IbhChatHandle {
  send(text: string, opts?: SendOptions): void;
  open(): void;
  close(): void;
  setTheme(theme: UiTheme): void;
  audit(): readonly AuditEntry[];
  instance(): IbhInstance | null;
}

/**
 * Drop-in ibh agent directive for Angular (standalone, template-less). The panel
 * self-mounts in its own shadow root on document.body — no CSS setup, no Angular
 * compiler dependency (your app's own templates are compiled by your build).
 *
 * ```html
 * <ibh-chat [manifest]="manifest" [auth]="auth" [llm]="llm" [ui]="ui" (ready)="onReady($event)" />
 * ```
 *
 * Lifecycle: `ibh.init()` runs in ngOnInit and `destroy()` in ngOnDestroy; the full
 * config (including the manifest contract) is read once at mount — input changes do
 * not re-init. If the manifest fails validation, init throws into your
 * ErrorHandler (fail-closed, by design).
 */
@Directive({
  selector: 'ibh-chat, [ibhChat]',
})
export class IbhChat implements IbhChatHandle {
  @Input({ required: true }) manifest!: IbhConfig['manifest'];
  @Input() guide?: IbhConfig['guide'];
  @Input({ required: true }) auth!: IbhConfig['auth'];
  @Input({ required: true }) llm!: IbhConfig['llm'];
  @Input() ui?: IbhConfig['ui'];
  @Input() nav?: IbhConfig['nav'];
  @Input() dom?: IbhConfig['dom'];

  /** Emits the live instance once, right after a successful init. */
  @Output() ready = new EventEmitter<IbhInstance>();

  private instanceHandle: IbhInstance | null = null;

  ngOnInit(): void {
    this.instanceHandle = init({
      manifest: this.manifest,
      guide: this.guide,
      auth: this.auth,
      llm: this.llm,
      ui: this.ui,
      nav: this.nav,
      dom: this.dom,
    });
    this.ready.emit(this.instanceHandle);
  }

  ngOnDestroy(): void {
    this.instanceHandle?.destroy();
    this.instanceHandle = null;
  }

  /** Imperative handle (usable directly on the directive instance via template ref). */
  get handle(): IbhChatHandle {
    return this;
  }

  send(text: string, opts?: SendOptions): void {
    void this.instanceHandle?.send(text, opts);
  }

  open(): void {
    this.instanceHandle?.open();
  }

  close(): void {
    this.instanceHandle?.close();
  }

  setTheme(theme: UiTheme): void {
    this.instanceHandle?.setTheme(theme);
  }

  audit(): readonly AuditEntry[] {
    return this.instanceHandle?.audit() ?? [];
  }

  instance(): IbhInstance | null {
    return this.instanceHandle;
  }
}

export default IbhChat;
