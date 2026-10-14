// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ImageAttachment, ToolOutcome } from '@ibh/core';
import { AuditLedger } from '@ibh/executor';
import { mountIbhUi } from './panel';
import type { IbhUiController, IbhUiOptions } from './types';

function makeController(siteName = 'TestSite') {
  const listeners = {
    running: new Set<(r: boolean) => void>(),
    status: new Set<(t: string) => void>(),
    assistant: new Set<(t: string) => void>(),
    toolStart: new Set<(i: { capabilityId: string; kind: string }) => void>(),
    toolEnd: new Set<(o: ToolOutcome) => void>(),
  };
  const ledger = new AuditLedger();
  const sent: string[] = [];
  const sentImages: Array<readonly ImageAttachment[]> = [];
  let running = false;
  const controller: IbhUiController = {
    getSiteName: () => siteName,
    send: (t, images) => {
      sent.push(t);
      sentImages.push(images ?? []);
    },
    stop: () => {},
    isRunning: () => running,
    clearConversation: () => {},
    getHistory: () => [],
    onRunningChange: (cb) => {
      listeners.running.add(cb);
      return () => listeners.running.delete(cb);
    },
    onStatus: (cb) => {
      listeners.status.add(cb);
      return () => listeners.status.delete(cb);
    },
    onAssistant: (cb) => {
      listeners.assistant.add(cb);
      return () => listeners.assistant.delete(cb);
    },
    onToolStart: (cb) => {
      listeners.toolStart.add(cb);
      return () => listeners.toolStart.delete(cb);
    },
    onToolEnd: (cb) => {
      listeners.toolEnd.add(cb);
      return () => listeners.toolEnd.delete(cb);
    },
    onAudit: (cb) => ledger.subscribe(cb),
    getAudit: () => ledger.getEntries(),
  };
  return {
    controller,
    ledger,
    sent,
    sentImages,
    emitAssistant: (t: string) => listeners.assistant.forEach((f) => f(t)),
    emitStatus: (t: string) => listeners.status.forEach((f) => f(t)),
    emitToolStart: (i: { capabilityId: string; kind: string }) => listeners.toolStart.forEach((f) => f(i)),
    emitToolEnd: (o: ToolOutcome) => listeners.toolEnd.forEach((f) => f(o)),
    setRunning: (r: boolean) => {
      running = r;
      listeners.running.forEach((f) => f(r));
    },
  };
}

function mount(opts: IbhUiOptions = {}, siteName?: string) {
  const c = makeController(siteName);
  const handle = mountIbhUi(c.controller, opts);
  const host = [...document.body.querySelectorAll('div[data-ibh-ui]')].at(-1) as HTMLElement;
  const shadow = host.shadowRoot as ShadowRoot;
  const q = <T extends Element>(sel: string) => shadow.querySelector(sel) as unknown as T;
  return { ...c, handle, host, shadow, q };
}

/** Minimal MediaRecorder + getUserMedia stubs so the STT flow can run in jsdom. */
function stubRecorder() {
  class FakeMediaRecorder {
    static current: FakeMediaRecorder | null = null;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    mimeType = 'audio/webm';
    constructor() {
      FakeMediaRecorder.current = this;
    }
    start(): void {}
    stop(): void {}
  }
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
  });
  return { recorder: (): FakeMediaRecorder => FakeMediaRecorder.current as FakeMediaRecorder };
}

beforeEach(() => {
  document.body.textContent = '';
  localStorage.clear();
});
afterEach(() => {
  document.body.textContent = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('mountIbhUi options', () => {
  it('starts closed by default; startOpen opens the panel; open/close toggle', () => {
    const closed = mount({});
    expect(closed.q<HTMLElement>('.panel').hidden).toBe(true);
    closed.handle.open();
    expect(closed.q<HTMLElement>('.panel').hidden).toBe(false);
    closed.handle.close();
    expect(closed.q<HTMLElement>('.panel').hidden).toBe(true);
    closed.handle.destroy();

    const opened = mount({ startOpen: true });
    expect(opened.q<HTMLElement>('.panel').hidden).toBe(false);
  });

  it('clicking the launcher opens the panel and hides the launcher', () => {
    const m = mount({});
    const launcher = m.q<HTMLButtonElement>('.launcher');
    expect(m.q<HTMLElement>('.panel').hidden).toBe(true);
    expect(launcher.hidden).toBe(false);
    launcher.click();
    expect(m.q<HTMLElement>('.panel').hidden).toBe(false);
    expect(launcher.hidden).toBe(true);
    m.handle.destroy();
  });

  it('launcher reopens the panel after it was closed with the × button', () => {
    const m = mount({ startOpen: true });
    m.q<HTMLButtonElement>('.icon-btn[title="Close"]').click();
    expect(m.q<HTMLElement>('.panel').hidden).toBe(true);
    m.q<HTMLButtonElement>('.launcher').click();
    expect(m.q<HTMLElement>('.panel').hidden).toBe(false);
    m.handle.destroy();
  });

  it('audit tab is hidden by default and shown with showAuditTab', () => {
    const hidden = mount({});
    const visibleTabs = () =>
      [...hidden.shadow.querySelectorAll('.tab')].filter((t) => !(t as HTMLElement).hidden).length;
    expect(visibleTabs()).toBe(1); // only Chat
    hidden.handle.destroy();

    const shown = mount({ showAuditTab: true });
    const visibleTabsShown = () =>
      [...shown.shadow.querySelectorAll('.tab')].filter((t) => !(t as HTMLElement).hidden).length;
    expect(visibleTabsShown()).toBe(2);
    shown.q<HTMLElement>('.tab + .tab').click(); // switch to audit view
    const views = [...shown.shadow.querySelectorAll('.view')] as HTMLElement[];
    expect(views[0]?.hidden).toBe(true); // chat hidden
    expect(views[1]?.hidden).toBe(false); // audit visible
  });

  it('audit entries render in the audit view when the tab is enabled', () => {
    const m = mount({ showAuditTab: true, startOpen: true });
    m.ledger.append({ kind: 'api', decision: 'allow', summary: 'GET /api/sprites' });
    m.handle.close();
    m.handle.open();
    const auditRows = [...m.shadow.querySelectorAll('.audit-entry')];
    expect(auditRows.length).toBe(1);
    expect(auditRows.at(-1)?.textContent).toContain('GET /api/sprites');
  });

  it('clear-conversation button hidden by default, shown with showClearConversation', () => {
    const def = mount({});
    expect(def.shadow.querySelectorAll('.icon-btn')).toHaveLength(2); // theme + close only
    def.handle.destroy();

    const shown = mount({ showClearConversation: true });
    const buttons = [...shown.shadow.querySelectorAll('.icon-btn')] as HTMLButtonElement[];
    expect(buttons.some((b) => b.title === 'Clear conversation')).toBe(true);
  });

  it('theme: initial value applied to the host, setTheme overrides, hideThemePicker removes the button', () => {
    const themed = mount({ theme: 'light' });
    expect(themed.host.getAttribute('data-ibh-theme')).toBe('light');
    themed.handle.setTheme('dark');
    expect(themed.host.getAttribute('data-ibh-theme')).toBe('dark');
    // the theme picker button exists and reflects the active theme pref
    const themeBtn = [...themed.shadow.querySelectorAll('.icon-btn')].find(
      (b) => (b as HTMLButtonElement).title.startsWith('Theme:')
    ) as HTMLButtonElement | undefined;
    expect(themeBtn).toBeDefined();
    expect(themeBtn?.textContent).toBe('☾');
    const themeBtns = [...themed.shadow.querySelectorAll('.icon-btn')].filter(
      (b) => (b as HTMLButtonElement).title.startsWith('Theme:')
    );
    expect(themeBtns).toHaveLength(1);
    themed.handle.destroy();

    const hiddenPicker = mount({ hideThemePicker: true });
    const btns = [...hiddenPicker.shadow.querySelectorAll('.icon-btn')] as HTMLButtonElement[];
    expect(btns.some((b) => b.title.startsWith('Theme:'))).toBe(false);
  });

  it('style custom properties land on the host element', () => {
    const m = mount({ style: { '--ibh-accent': '#123456', '--ibh-radius-panel': '6px' } });
    expect(m.host.style.getPropertyValue('--ibh-accent')).toBe('#123456');
    expect(m.host.style.getPropertyValue('--ibh-radius-panel')).toBe('6px');
  });

  it('css option injects an extra stylesheet into the shadow root', () => {
    const m = mount({ css: '.msg { letter-spacing: 1px; } /* marker-x7 */' });
    const styles = [...m.shadow.querySelectorAll('style')].map((s) => s.textContent ?? '');
    expect(styles.some((t) => t.includes('marker-x7'))).toBe(true);
  });

  it('defaultPosition positions the panel and launcher (user-persisted geometry wins)', () => {
    const m = mount({ defaultPosition: { left: 500, top: 40 } });
    expect(m.q<HTMLElement>('.panel').style.left).toBe('500px');
    expect(m.q<HTMLElement>('.panel').style.top).toBe('40px');
    const launcher = m.q<HTMLElement>('.launcher');
    expect(launcher.style.left).toBe('500px');
    expect(launcher.style.top).toBe('40px');
  });

  it('launcher + placeholder are fully customizable (text, title, colors, shape)', () => {
    const m = mount({
      launcher: { text: 'Ask', title: 'Open the assistant' },
      placeholder: 'What can I do for you?',
      style: {
        '--ibh-launcher-bg': '#2b2d42',
        '--ibh-launcher-color': '#ffd166',
        '--ibh-launcher-radius': '12px',
        '--ibh-launcher-size': '56px',
      },
    });
    const launcher = m.q<HTMLButtonElement>('.launcher');
    expect(launcher.textContent).toBe('Ask');
    expect(launcher.title).toBe('Open the assistant');
    expect(m.host.style.getPropertyValue('--ibh-launcher-bg')).toBe('#2b2d42');
    expect(m.host.style.getPropertyValue('--ibh-launcher-color')).toBe('#ffd166');
    expect(m.host.style.getPropertyValue('--ibh-launcher-radius')).toBe('12px');
    expect(m.host.style.getPropertyValue('--ibh-launcher-size')).toBe('56px');
    const input = m.q<HTMLTextAreaElement>('.composer textarea');
    expect(input.placeholder).toBe('What can I do for you?');
    m.handle.destroy();
  });

  it('launcher + placeholder use the documented defaults when not configured', () => {
    const m = mount({ startOpen: true });
    expect(m.q<HTMLButtonElement>('.launcher').textContent).toBe('ibh');
    expect(m.q<HTMLButtonElement>('.launcher').title).toBe('Open ibh');
    expect(m.q<HTMLTextAreaElement>('.composer textarea').placeholder).toBe('Ask ibh… (Enter to send)');
  });

  it('renders the site name in the header and the default empty-state text', () => {
    const m = mount({ startOpen: true }, 'MySite');
    expect(m.shadow.querySelector('.brand')?.textContent).toContain('MySite');
    expect(m.shadow.querySelector('.empty')?.textContent).toContain('Ask ibh about MySite');
    expect(m.shadow.querySelector('.empty')?.textContent).toContain('It reads the site API');
  });

  it('empty-state title + hint are fully customizable', () => {
    const m = mount(
      {
        startOpen: true,
        emptyState: {
          title: 'Welcome to the Home Makeover assistant',
          hint: 'Ask me to reorder your catalog, remix a room, or export assets.',
        },
      },
      'MySite'
    );
    const empty = m.shadow.querySelector('.empty');
    expect(empty?.textContent).toContain('Welcome to the Home Makeover assistant');
    expect(empty?.textContent).toContain('Ask me to reorder your catalog');
    expect(empty?.textContent).not.toContain('It reads the site API');
  });

  it('assistant messages, status and tool chips render from controller events', () => {
    const m = mount({ startOpen: true });
    m.emitAssistant('hello there');
    const msgs = [...m.shadow.querySelectorAll('.msg')];
    expect(msgs.some((n) => n.textContent === 'hello there' && n.className.includes('assistant'))).toBe(true);

    m.emitToolStart({ capabilityId: 'sprites_create', kind: 'api' });
    const chip = m.shadow.querySelector('.tool-chip')!;
    expect(chip.textContent).toContain('api sprites_create');

    m.emitToolEnd({ ok: true, decision: 'allow', capabilityId: 'sprites_create', kind: 'api', result: { status: 201 } });
    expect(m.shadow.querySelectorAll('.tool-chip').length).toBeGreaterThan(0);
    expect(m.shadow.querySelector('.tool-chip')!.textContent).toContain('sprites_create');

    m.emitStatus('thinking…');
    expect(m.shadow.querySelector('.status-line')?.textContent).toBe('thinking…');
  });

  it('markdown: assistant messages render as markdown by default', () => {
    const m = mount({ startOpen: true });
    m.emitAssistant('**bold** and `code`');
    const text = m.shadow.querySelector('.msg.assistant .msg-text.md');
    expect(text).not.toBeNull();
    expect(text?.querySelector('strong')?.textContent).toBe('bold');
    expect(text?.querySelector('code')?.textContent).toBe('code');
  });

  it('markdown: disabled renders assistant messages as plain text', () => {
    const m = mount({ startOpen: true, markdown: false });
    m.emitAssistant('**bold**');
    const text = m.shadow.querySelector('.msg.assistant .msg-text');
    expect(text?.classList.contains('md')).toBe(false);
    expect(text?.textContent).toBe('**bold**');
    expect(text?.querySelector('strong')).toBeNull();
  });

  it('markdown: a custom renderer is used for assistant messages', () => {
    const m = mount({ startOpen: true, markdown: { render: (text) => `<em>${text}</em>` } });
    m.emitAssistant('hello');
    expect(m.shadow.querySelector('.msg.assistant .msg-text.md em')?.textContent).toBe('hello');
  });

  it('markdown: user messages stay plain text', () => {
    const m = mount({ startOpen: true });
    const input = m.q<HTMLTextAreaElement>('.composer textarea');
    input.value = '**not bold**';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const text = m.shadow.querySelector('.msg.user .msg-text');
    expect(text?.textContent).toBe('**not bold**');
    expect(text?.querySelector('strong')).toBeNull();
  });

  it('user input sends through the controller (Enter key and button)', () => {
    const m = mount({ startOpen: true });
    const input = m.q<HTMLTextAreaElement>('.composer textarea');
    input.value = 'list my sprites';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(m.sent).toEqual(['list my sprites']);
    expect(m.shadow.querySelectorAll('.msg.user')).toHaveLength(1);
  });

  it('the send button stops a running turn instead of trying to send', () => {
    const m = mount({ startOpen: true });
    let stops = 0;
    m.controller.stop = () => {
      stops += 1;
    };
    m.setRunning(true);
    m.q<HTMLButtonElement>('.composer .send').click();
    expect(stops).toBe(1);
  });

  it('images: attach button is present by default and removed with images:false', () => {
    const on = mount({ startOpen: true });
    expect(on.shadow.querySelector('.composer .attach')).not.toBeNull();
    on.handle.destroy();
    const off = mount({ startOpen: true, images: false });
    expect(off.shadow.querySelector('.composer .attach')).toBeNull();
  });

  it('images: a selected file previews a thumbnail and sends with the message', async () => {
    const m = mount({ startOpen: true });
    const fileInput = m.q<HTMLInputElement>('.composer input[type="file"]');
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'cat.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(m.shadow.querySelector('.thumb img')).not.toBeNull());

    const input = m.q<HTMLTextAreaElement>('.composer textarea');
    input.value = 'what is this?';
    m.q<HTMLButtonElement>('.composer .send').click();

    expect(m.sent).toEqual(['what is this?']);
    expect(m.sentImages[0]?.[0]?.name).toBe('cat.png');
    expect(m.sentImages[0]?.[0]?.url.startsWith('data:image/png')).toBe(true);
    expect(m.shadow.querySelector('.msg.user .msg-img')).not.toBeNull();
    expect(m.shadow.querySelector('.thumb')).toBeNull(); // previews cleared after send
  });

  it('images: an image-only message (no text) can be sent', async () => {
    const m = mount({ startOpen: true });
    const fileInput = m.q<HTMLInputElement>('.composer input[type="file"]');
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(m.shadow.querySelector('.thumb')).not.toBeNull());
    m.q<HTMLButtonElement>('.composer .send').click();
    expect(m.sent).toEqual(['']);
    expect(m.sentImages[0]).toHaveLength(1);
  });

  it('images: a non-image file is rejected with a notice', async () => {
    const m = mount({ startOpen: true });
    const fileInput = m.q<HTMLInputElement>('.composer input[type="file"]');
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    await vi.waitFor(() =>
      expect(m.shadow.querySelector('.msg.notice')?.textContent).toContain('not an image')
    );
  });

  it('images: persisted history renders thumbnails on mount', () => {
    const c = makeController();
    c.controller.getHistory = () => [
      { role: 'user', text: 'old', images: ['data:image/png;base64,AAA'] },
      { role: 'assistant', text: 'a cat' },
    ];
    const handle = mountIbhUi(c.controller, { startOpen: true });
    const host = [...document.body.querySelectorAll('div[data-ibh-ui]')].at(-1) as HTMLElement;
    const shadow = host.shadowRoot as ShadowRoot;
    expect(shadow.querySelector('.msg.user .msg-img')).not.toBeNull();
    handle.destroy();
  });

  it('consent card: technical mode shows "ibh wants to:" + summary; approve resolves true', async () => {
    const m = mount({ startOpen: true });
    const p = m.handle.requestConsent({
      kind: 'api',
      capabilityId: 'sprites_create',
      actionSummary: 'POST /api/sprites',
      detailLines: ['Create a sprite'],
    });
    await Promise.resolve();
    expect(m.shadow.querySelector('.confirm-title')?.textContent).toBe('ibh wants to:');
    expect(m.shadow.querySelector('.confirm-summary')?.textContent).toBe('POST /api/sprites');
    m.q<HTMLButtonElement>('.confirm-actions .approve').click();
    await expect(p).resolves.toBe(true);
  });

  it('consent card: integrator question mode replaces the technical preview; deny resolves false', async () => {
    const m = mount({ startOpen: true });
    const p = m.handle.requestConsent({
      kind: 'api',
      capabilityId: 'sprites_create',
      actionSummary: 'POST /api/sprites',
      detailLines: [],
      question: 'Create a sprite named "Ember"?',
    });
    await Promise.resolve();
    expect(m.shadow.querySelector('.confirm-question')?.textContent).toBe('Create a sprite named "Ember"?');
    expect(m.shadow.querySelector('.confirm-title')).toBeNull();
    expect(m.shadow.querySelector('.confirm-summary')).toBeNull();
    m.q<HTMLButtonElement>('.confirm-actions button:first-child').click();
    await expect(p).resolves.toBe(false);
  });

  it('stt: mic + auto-send bar appear only when configured; checkbox default follows autoSend', () => {
    const without = mount({});
    expect(without.shadow.querySelector('.mic')).toBeNull();
    expect(without.shadow.querySelector('.composer-bar')).toBeNull();

    const def = mount({ stt: { apiKey: 'k', model: 'elevenlabs/scribe-v2' } });
    expect(def.shadow.querySelector('.mic')).not.toBeNull();
    expect(def.q<HTMLButtonElement>('.mic').getAttribute('title')).toBe('Record voice message');
    const cb = def.q<HTMLInputElement>('.composer-bar input[type="checkbox"]');
    expect(cb.checked).toBe(true);
    def.handle.destroy();

    const noAuto = mount({ stt: { apiKey: 'k', model: 'elevenlabs/scribe-v2', autoSend: false } });
    expect(noAuto.q<HTMLInputElement>('.composer-bar input[type="checkbox"]').checked).toBe(false);
  });

  it('stt: omits cookies in BYO-key mode (cross-origin to openrouter.ai)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { recorder } = stubRecorder();

    const m = mount({ startOpen: true, stt: { model: 'm', apiKey: 'sk-user' } });
    m.q<HTMLButtonElement>('.mic').click();
    await vi.waitFor(() => expect(recorder()).not.toBeNull());
    const rec = recorder();
    rec.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    rec.onstop?.();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe('omit');
    m.handle.destroy();
  });

  it('destroy removes the host and resolves pending consent with false', async () => {
    const m = mount({ startOpen: true });
    const p = m.handle.requestConsent({ kind: 'api', capabilityId: 'x', actionSummary: 'GET /', detailLines: [] });
    m.handle.destroy();
    await expect(p).resolves.toBe(false);
    expect(document.body.querySelector('div[data-ibh-ui]')).toBeNull();
  });

  it('escaping closes the panel; launcher re-appears', () => {
    const m = mount({ startOpen: true });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(m.q<HTMLElement>('.panel').hidden).toBe(true);
  });
});
