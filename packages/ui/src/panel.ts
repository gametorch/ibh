import type { AuditEntry, ConsentRequest, ToolOutcome } from '@ibh/core';
import type { IbhUiController, IbhUiHandle, IbhUiOptions, UiTheme } from './types';
import { PANEL_CSS } from './styles';
import { el } from './el';
import { installTheme, makeThemeButton } from './panel-theme';
import { installGeometry } from './panel-geometry';
import { createConsentFlow } from './panel-consent';
import { createChatSurface } from './panel-messages';
import { installStt } from './panel-stt';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function chipText(outcome: ToolOutcome): string {
  if (!outcome.ok) return `${outcome.capabilityId} · ${outcome.error ?? 'failed'}`;
  const r = outcome.result as { summary?: string; status?: number } | undefined;
  if (r?.summary) return `${outcome.capabilityId} · ${r.summary}`;
  if (typeof r?.status === 'number') return `${outcome.capabilityId} · HTTP ${r.status}`;
  return `${outcome.capabilityId} · done`;
}

/** Everything the panel modules need from the mounted shell. */
interface PanelRefs {
  host: HTMLElement;
  shadow: ShadowRoot;
  launcher: HTMLButtonElement;
  panel: HTMLElement;
  header: HTMLElement;
  dot: HTMLElement;
  tabChat: HTMLButtonElement;
  tabAudit: HTMLButtonElement;
  btnTheme: HTMLButtonElement;
  btnClear: HTMLButtonElement;
  btnClose: HTMLButtonElement;
  chatView: HTMLElement;
  auditView: HTMLElement;
  empty: HTMLElement;
  composer: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  micBtn: HTMLButtonElement | null;
  autoSendCheckbox: HTMLInputElement | null;
  resizeGrip: HTMLElement;
}

function buildShell(controller: IbhUiController, opts: IbhUiOptions): PanelRefs {
  const host = el('div');
  host.setAttribute('data-ibh-ui', '');
  host.style.position = 'fixed';
  host.style.inset = 'auto';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = el('style');
  style.textContent = PANEL_CSS + (opts.accent ? `\n:host { --ibh-accent: ${opts.accent}; }` : '');
  shadow.append(style);

  // Host-provided custom properties / inline styles (inherited into the shadow root)
  // and an optional raw-CSS escape hatch appended after the base stylesheet.
  if (opts.style) {
    for (const [k, v] of Object.entries(opts.style)) {
      try {
        host.style.setProperty(k, v);
      } catch {
        /* invalid property names are ignored */
      }
    }
  }
  if (opts.css) {
    const extra = el('style');
    extra.textContent = opts.css;
    shadow.append(extra);
  }

  const launcher = el('button', 'launcher');
  launcher.textContent = opts.launcher?.text ?? 'ibh';
  launcher.title = opts.launcher?.title ?? 'Open ibh';

  const panel = el('div', 'panel');
  panel.hidden = true;

  const header = el('div', 'header');
  const dot = el('span', 'dot');
  const brand = el('div', 'brand');
  brand.textContent = 'ibh';
  const siteSmall = el('small');
  siteSmall.textContent = controller.getSiteName();
  brand.append(siteSmall);
  const spacer = el('div', 'spacer');
  const tabChat = el('button', 'tab active');
  tabChat.textContent = 'Chat';
  const tabAudit = el('button', 'tab');
  tabAudit.textContent = 'Audit';
  const btnTheme = makeThemeButton();
  const btnClear = el('button', 'icon-btn');
  btnClear.textContent = '⟲';
  btnClear.title = 'Clear conversation';
  const btnClose = el('button', 'icon-btn');
  btnClose.textContent = '×';
  btnClose.title = 'Close';
  const headerChildren = [dot, brand, spacer, tabChat, tabAudit];
  if (opts.hideThemePicker !== true) headerChildren.push(btnTheme);
  if (opts.showClearConversation === true) headerChildren.push(btnClear);
  headerChildren.push(btnClose);
  header.append(...headerChildren);

  const chatView = el('div', 'view');
  const auditView = el('div', 'view');
  auditView.hidden = true;
  if (opts.showAuditTab !== true) tabAudit.hidden = true;

  const empty = el('div', 'empty');
  const emptyBold = el('div');
  emptyBold.textContent =
    opts.emptyState?.title ?? `Ask ibh about ${controller.getSiteName()}`;
  const hint = el('div', 'hint');
  hint.textContent =
    opts.emptyState?.hint ??
    'It reads the site API, operates the page and navigates for you. Destructive actions always show you exactly what will happen first.';
  empty.append(emptyBold, hint);
  chatView.append(empty);

  const composer = el('div', 'composer');
  const input = el('textarea');
  input.placeholder = opts.placeholder ?? 'Ask ibh… (Enter to send)';
  input.rows = 1;
  const sendBtn = el('button', 'send');
  sendBtn.textContent = '↑';
  sendBtn.title = 'Send';
  composer.append(input, sendBtn);

  // speech-to-text: mic button + auto-send toggle (only when STT is configured)
  let micBtn: HTMLButtonElement | null = null;
  let autoSendCheckbox: HTMLInputElement | null = null;
  const composerExtras: HTMLElement[] = [];
  const stt = opts.stt;
  if (stt) {
    micBtn = el('button', 'mic');
    micBtn.type = 'button';
    micBtn.title = 'Record voice message';
    composer.append(micBtn);

    const bar = el('div', 'composer-bar');
    const label = el('label');
    autoSendCheckbox = el('input');
    autoSendCheckbox.type = 'checkbox';
    autoSendCheckbox.checked = stt.autoSend ?? true;
    label.append(autoSendCheckbox, document.createTextNode('auto-send after recording'));
    bar.append(label);
    composerExtras.push(bar);
  }

  const resizeGrip = el('div', 'resize-grip');
  resizeGrip.setAttribute('data-ibh-ignore', '');

  panel.append(header, chatView, auditView, ...composerExtras, composer, resizeGrip);

  const root = el('div');
  root.append(launcher, panel);
  shadow.append(root);
  document.body.append(host);

  return {
    host, shadow, launcher, panel, header, dot, tabChat, tabAudit,
    btnTheme, btnClear, btnClose, chatView, auditView, empty,
    composer, input, sendBtn, micBtn, autoSendCheckbox, resizeGrip,
  };
}

/**
 * Mounts the ibh panel in a shadow root. Everything dynamic is inserted with
 * textContent (no innerHTML for untrusted strings).
 */
export function mountIbhUi(controller: IbhUiController, opts: IbhUiOptions = {}): IbhUiHandle {
  const refs = buildShell(controller, opts);
  const { host, launcher, panel, header, dot, tabChat, tabAudit, btnTheme, btnClear, btnClose, chatView, auditView, empty, input, sendBtn, micBtn, autoSendCheckbox } = refs;

  const theme = installTheme({ host, btnTheme, initialTheme: opts.theme });
  const geometry = installGeometry({ panel, header, launcher, defaultPosition: opts.defaultPosition });
  const surface = createChatSurface({ chatView, empty });
  const { addMessage, addChip, scroll, removeEmpty, showStatus, clearStatus, setPendingChip, takePendingChip } = surface;
  const consent = createConsentFlow({
    chatView,
    ensureOpen: () => api.open(),
    removeEmpty,
    addChip,
    scroll,
  });

  let view: 'chat' | 'audit' = 'chat';
  const setView = (v: 'chat' | 'audit') => {
    view = v;
    chatView.hidden = v !== 'chat';
    auditView.hidden = v !== 'audit';
    tabChat.classList.toggle('active', v === 'chat');
    tabAudit.classList.toggle('active', v === 'audit');
  };
  tabChat.addEventListener('click', () => setView('chat'));
  tabAudit.addEventListener('click', () => setView('audit'));

  btnClose.addEventListener('click', () => api.close());
  btnClear.addEventListener('click', () => {
    controller.clearConversation();
    surface.clear();
    surface.restoreEmpty();
  });

  const submit = () => {
    const text = input.value.trim();
    if (text.length === 0) return;
    if (controller.isRunning()) {
      controller.stop();
      return;
    }
    input.value = '';
    input.style.height = 'auto';
    addMessage(text, 'user');
    controller.send(text);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  sendBtn.addEventListener('click', submit);

  if (opts.stt && micBtn && autoSendCheckbox) {
    installStt({ stt: opts.stt, micBtn, autoSendCheckbox, surface, input, controller });
  }

  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && api.isOpen()) api.close();
  };
  document.addEventListener('keydown', onDocKey);

  // wiring ------------------------------------------------------------------
  const unsubs: Array<() => void> = [];

  const setBusy = (busy: boolean) => {
    dot.classList.toggle('busy', busy);
    sendBtn.classList.toggle('stop', busy);
    sendBtn.textContent = busy ? '■' : '↑';
    sendBtn.title = busy ? 'Stop' : 'Send';
    input.disabled = busy;
    if (!busy) clearStatus();
  };

  const onStatusText = (text: string) => showStatus(text);
  const onToolStart = (info: { capabilityId: string; kind: string }) => {
    showStatus(`${info.kind}: ${info.capabilityId}…`);
    setPendingChip(addChip(`… ${info.kind === 'builtin' ? 'ibh' : info.kind} ${info.capabilityId}`));
  };
  const onToolEnd = (outcome: ToolOutcome) => {
    clearStatus();
    const chip = takePendingChip() ?? addChip('');
    chip.textContent = '';
    const st = el('span', `st ${outcome.ok ? outcome.decision : 'error'}`);
    st.textContent = chipText(outcome);
    chip.append(st);
    scroll();
  };

  const renderAuditEntry = (e: AuditEntry) => {
    const row = el('div', 'audit-entry');
    const time = el('span', 'audit-time');
    time.textContent = fmtTime(e.ts);
    const kind = el('span', 'audit-kind');
    kind.textContent = e.kind;
    const decision = el('span', `audit-decision ${e.decision}`);
    decision.textContent = e.decision;
    const summary = el('span');
    summary.textContent = e.summary;
    row.append(time, kind, decision, summary);
    auditView.append(row);
    auditView.scrollTop = auditView.scrollHeight;
  };

  unsubs.push(
    controller.onRunningChange(setBusy),
    controller.onStatus(onStatusText),
    controller.onAssistant((text) => addMessage(text, 'assistant')),
    controller.onToolStart(onToolStart),
    controller.onToolEnd(onToolEnd),
    controller.onAudit(renderAuditEntry),
  );
  for (const e of controller.getAudit()) renderAuditEntry(e);

  // api ---------------------------------------------------------------------
  let open = opts.startOpen === true;
  const applyOpen = () => {
    panel.hidden = !open;
    launcher.hidden = open;
    if (open) {
      input.focus();
      auditView.textContent = '';
  for (const e of controller.getAudit()) renderAuditEntry(e);

  // Restore an opted-in persisted conversation so a refresh resumes the chat.
  for (const m of controller.getHistory()) addMessage(m.text, m.role);

    }
  };
  applyOpen();

  const api: IbhUiHandle = {
    open: () => {
      open = true;
      applyOpen();
    },
    close: () => {
      open = false;
      applyOpen();
    },
    isOpen: () => open,
    requestConsent: (req: ConsentRequest) => consent.requestConsent(req),
    setTheme: (t: UiTheme) => theme.setTheme(t),
    destroy: () => {
      for (const u of unsubs) u();
      theme.dispose();
      geometry.dispose();
      document.removeEventListener('keydown', onDocKey);
      consent.denyAllPending();
      host.remove();
    },
  };

  void view;
  return api;
}
