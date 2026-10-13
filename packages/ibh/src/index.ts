import type { IbhManifest } from '@ibh/policy';
import { PolicyEngine, validateManifest } from '@ibh/policy';
import type { AgentHooks } from '@ibh/core';
import { AgentSession, OpenRouterClient } from '@ibh/core';
import type { AuditEntry, ConsentRequest, ToolOutcome, AuthAdapter, DomExecutor } from '@ibh/executor';
import { AnalyzeAdapter, AuditLedger, DomAdapter, FetchAdapter, Gatekeeper, NavAdapter } from '@ibh/executor';
import type { IbhUiController, IbhUiHandle, UiTheme } from '@ibh/ui';
import { mountIbhUi } from '@ibh/ui';
import { createSessionPersistence } from './persistence';

export type { IbhManifest, AuthAdapter, AuditEntry, ConsentRequest, ToolOutcome, AgentSession, IbhUiHandle, UiTheme };

export const VERSION = '0.1.0';

export interface IbhConfig {
  /** The hard contract. Validated fail-closed; a bad manifest means ibh refuses to start. */
  manifest: IbhManifest;
  /** The soft contract: prose that steers the agent. Gates nothing. */
  guide?: string | (() => string);
  /** How API calls piggyback on the host's existing session. */
  auth: AuthAdapter;
  /** OpenRouter access. Three modes (see docs/integration-guide.md):
   *  - BYO user key: `openRouterKey` set (the end user's own key; pure frontend).
   *  - Backend proxy (production): omit `openRouterKey` and point `baseUrl` at
   *    YOUR endpoint — requests carry no credentials; your existing session
   *    cookie authenticates them and your server forwards to OpenRouter.
   *  - Shared key in the page: never. init() fails closed if no key is set while
   *    still pointing at OpenRouter directly. */
  llm: {
    openRouterKey?: string;
    baseUrl?: string;
    /** Extra headers (e.g. auth for a custom proxy gateway). */
    headers?: Record<string, string>;
  };
  ui?: {
    enabled?: boolean;
    accent?: string;
    startOpen?: boolean;
    /** Initial theme. Defaults to "system"; the user can switch in the panel header. */
    theme?: 'light' | 'dark' | 'system';
    /** Hide the panel's theme picker (e.g. when the host drives the theme via `setTheme`). */
    hideThemePicker?: boolean;
    /** Show the "clear conversation" (⟲) button in the panel header. Hidden by default. */
    showClearConversation?: boolean;
    /** Show the "Audit" tab in the panel header. Hidden by default. */
    showAuditTab?: boolean;
    /** Launcher button (closed-state circle): text + hover title. */
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
    /** Voice input via OpenRouter speech-to-text. Defaults to the llm key / llm proxy. */
    stt?: {
      model: string;
      /** Override for BYO mode; defaults to llm.openRouterKey. */
      apiKey?: string;
      baseUrl?: string;
      endpoint?: string;
      language?: string;
      autoSend?: boolean;
    };
    /** CSS custom properties / inline styles for the panel host — the stable theming surface. */
    style?: Record<string, string>;
    /** Raw CSS appended to the panel's shadow root — advanced escape hatch. */
    css?: string;
    /** Where the panel + launcher start (viewport coords). Omitted = bottom-right. */
    defaultPosition?: {
      left?: number;
      top?: number;
      right?: number;
      bottom?: number;
    };
  };
  /**
   * Opt-in session persistence. Off by default: conversation history, the audit
   * log and session approvals live in memory and a refresh starts a clean
   * session. When enabled, ibh stores them in localStorage and restores them on
   * the next init. Budgets, rate limits and token spend are NOT persisted.
   */
  persistence?: {
    enabled?: boolean;
    /** localStorage key. Defaults to `ibh:session`. */
    key?: string;
  };
  /**
   * Consent handler used when the panel UI is disabled (headless mode). Headless
   * mode has no consent surface, so by default every capability above `auto` is
   * denied (fail-closed). Supplying this opts in to executing consented actions
   * without the panel — e.g. a native dialog, a host-rendered prompt, or (for
   * trusted automation) unconditional approval. When the panel UI is enabled it
   * handles consent and this is ignored.
   */
  consent?: (req: ConsentRequest) => boolean | Promise<boolean>;
  nav?: {
    /** Hook for hosts whose router is not plain history-based (e.g. Next.js App Router). */
    customNavigate?: (url: string) => void | Promise<void>;
  };
  dom?: {
    snapshotBudgetNodes?: number;
  };
}

export const OPENROUTER_DEFAULT_BASE = 'https://openrouter.ai/api/v1';

/** Fail-closed credential validation: a keyless config must NOT still point at OpenRouter. */
function validateCredentials(config: IbhConfig): void {
  const llmBase = config.llm.baseUrl ?? OPENROUTER_DEFAULT_BASE;
  if (!config.llm.openRouterKey && llmBase === OPENROUTER_DEFAULT_BASE) {
    throw new Error(
      "ibh: no LLM credentials configured — set llm.openRouterKey (the end user's own key, pure frontend) " +
        'or point llm.baseUrl at your backend proxy (requests then carry no key; see examples/proxy). ' +
        'Never ship a shared OpenRouter key in the page.'
    );
  }
  const stt = config.ui?.stt;
  if (stt) {
    const sttBase = stt.baseUrl ?? config.llm.baseUrl ?? OPENROUTER_DEFAULT_BASE;
    const sttKey = stt.apiKey ?? config.llm.openRouterKey;
    if (!sttKey && sttBase === OPENROUTER_DEFAULT_BASE) {
      throw new Error(
        'ibh: ui.stt is configured but no STT credentials are reachable — reuse the llm key, or point ' +
          'ui.stt.baseUrl / llm.baseUrl at your backend proxy (see examples/proxy).'
      );
    }
  }
}

export interface IbhInstance {
  /** Send a user message to the agent. Resolves with the final assistant text. */
  send(text: string): Promise<string>;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Set the panel theme ('light' | 'dark' | 'system'). No-op when the UI is disabled. */
  setTheme(theme: UiTheme): void;
  /** Full audit trail of every decision and action this session. */
  audit(): readonly AuditEntry[];
  session: AgentSession;
  destroy(): void;
  readonly version: string;
}

class ControllerBridge implements IbhUiController {
  private listeners = {
    running: new Set<(r: boolean) => void>(),
    status: new Set<(t: string) => void>(),
    assistant: new Set<(t: string) => void>(),
    toolStart: new Set<(i: { capabilityId: string; kind: string }) => void>(),
    toolEnd: new Set<(o: ToolOutcome) => void>(),
    audit: new Set<(e: AuditEntry) => void>(),
  };
  private running = false;

  constructor(
    private readonly siteName: string,
    private readonly ledger: AuditLedger
  ) {}

  hooks(): AgentHooks {
    return {
      onStatus: (t) => this.listeners.status.forEach((cb) => cb(t)),
      onAssistant: (t) => this.listeners.assistant.forEach((cb) => cb(t)),
      onToolStart: (i) => this.listeners.toolStart.forEach((cb) => cb(i)),
      onToolEnd: (o) => this.listeners.toolEnd.forEach((cb) => cb(o)),
    };
  }

  setRunning(r: boolean): void {
    this.running = r;
    this.listeners.running.forEach((cb) => cb(r));
  }

  getSiteName(): string {
    return this.siteName;
  }
  send(text: string): void {
    void this.sendInternal(text);
  }
  private async sendInternal(text: string): Promise<void> {
    if (this.running) return;
    this.setRunning(true);
    try {
      await this.sessionRun(text);
    } finally {
      this.setRunning(false);
    }
  }
  sessionRun: (text: string) => Promise<string> = () => Promise.resolve('');
  stop(): void {
    this.sessionStop();
  }
  sessionStop: () => void = () => {};
  isRunning(): boolean {
    return this.running;
  }
  clearConversation(): void {
    this.sessionClear();
  }
  sessionClear: () => void = () => {};

  onRunningChange(cb: (r: boolean) => void) {
    this.listeners.running.add(cb);
    return () => this.listeners.running.delete(cb);
  }
  onStatus(cb: (t: string) => void) {
    this.listeners.status.add(cb);
    return () => this.listeners.status.delete(cb);
  }
  onAssistant(cb: (t: string) => void) {
    this.listeners.assistant.add(cb);
    return () => this.listeners.assistant.delete(cb);
  }
  onToolStart(cb: (i: { capabilityId: string; kind: string }) => void) {
    this.listeners.toolStart.add(cb);
    return () => this.listeners.toolStart.delete(cb);
  }
  onToolEnd(cb: (o: ToolOutcome) => void) {
    this.listeners.toolEnd.add(cb);
    return () => this.listeners.toolEnd.delete(cb);
  }
  onAudit(cb: (e: AuditEntry) => void) {
    return this.ledger.subscribe(cb);
  }
  getAudit(): readonly AuditEntry[] {
    return this.ledger.getEntries();
  }

  /** Set by init(): returns the displayable conversation history for panel restore. */
  historyProvider: () => Array<{ role: 'user' | 'assistant'; text: string }> = () => [];
  getHistory(): Array<{ role: 'user' | 'assistant'; text: string }> {
    return this.historyProvider();
  }
}

/**
 * Initialize ibh. Fail-closed: throws if the manifest does not validate.
 * There are no library defaults for consent — the manifest must be explicit.
 */
export function init(config: IbhConfig): IbhInstance {
  const validation = validateManifest(config.manifest);
  if (!validation.ok) {
    throw new Error(`ibh: invalid capability manifest — ${validation.errors.join('; ')}`);
  }
  validateCredentials(config);

  const policy = new PolicyEngine(config.manifest);
  const ledger = new AuditLedger();
  const dom: DomExecutor = new DomAdapter({ snapshotBudgetNodes: config.dom?.snapshotBudgetNodes });

  const fetchAdapter = new FetchAdapter({ siteOrigin: config.manifest.site.origin, auth: config.auth });
  const navAdapter = new NavAdapter({
    siteOrigin: config.manifest.site.origin,
    customNavigate: config.nav?.customNavigate,
  });
  const analyzeAdapter = new AnalyzeAdapter();

  const uiEnabled = config.ui?.enabled !== false;
  const bridge = new ControllerBridge(config.manifest.site.name, ledger);
  const uiRef: { current: IbhUiHandle | null } = { current: null };

  // Consent: the panel is the surface when the UI is on. In headless mode there
  // is none by default (fail-closed), unless the host supplies a handler.
  const consent = uiEnabled
    ? { request: async (req: ConsentRequest) => (await uiRef.current?.requestConsent(req)) === true }
    : config.consent
      ? { request: (req: ConsentRequest) => Promise.resolve(config.consent!(req)) }
      : undefined;

  const gate = new Gatekeeper({
    manifest: config.manifest,
    policy,
    api: fetchAdapter,
    dom,
    nav: navAdapter,
    analyze: analyzeAdapter,
    ledger,
    consent,
  });

  const client = new OpenRouterClient({
    apiKey: config.llm.openRouterKey,
    baseUrl: config.llm.baseUrl,
    headers: config.llm.headers,
    title: 'ibh',
  });

  const session = new AgentSession({
    manifest: config.manifest,
    policy,
    gate,
    client,
    dom,
    ledger,
    guide: config.guide,
    hooks: bridge.hooks(),
  });

  const persistence = config.persistence?.enabled
    ? createSessionPersistence(config.persistence.key ?? 'ibh:session')
    : null;
  const persistNow = () => {
    if (!persistence) return;
    persistence.save({ history: session.history, audit: ledger.getEntries(), approved: gate.getSessionApproved() });
  };
  if (persistence) {
    const saved = persistence.load();
    if (saved) {
      session.restoreHistory(saved.history);
      ledger.hydrate(saved.audit);
      gate.hydrateApprovals(saved.approved);
    }
    ledger.subscribe(() => persistNow());
  }

  bridge.historyProvider = () => session.displayHistory();
  bridge.sessionRun = async (text) => {
    const result = await session.run(text);
    persistNow();
    return result;
  };
  bridge.sessionStop = () => session.stop();
  bridge.sessionClear = () => {
    session.clear();
    persistNow();
  };

  let ui: IbhUiHandle | null = null;
  if (uiEnabled) {
    ui = mountIbhUi(bridge, {
      accent: config.ui?.accent,
      startOpen: config.ui?.startOpen,
      theme: config.ui?.theme,
      hideThemePicker: config.ui?.hideThemePicker,
      showClearConversation: config.ui?.showClearConversation,
      showAuditTab: config.ui?.showAuditTab,
      launcher: config.ui?.launcher,
      placeholder: config.ui?.placeholder,
      emptyState: config.ui?.emptyState,
      style: config.ui?.style,
      css: config.ui?.css,
      defaultPosition: config.ui?.defaultPosition,
      stt: config.ui?.stt ? { ...config.ui.stt, apiKey: config.ui.stt.apiKey ?? config.llm.openRouterKey } : undefined,
    });
    uiRef.current = ui;
  }

  const instance: IbhInstance = {
    send: (text) => session.run(text),
    open: () => ui?.open(),
    close: () => ui?.close(),
    isOpen: () => ui?.isOpen() ?? false,
    setTheme: (t) => ui?.setTheme(t),
    audit: () => ledger.getEntries(),
    session,
    destroy: () => {
      ui?.destroy();
      session.stop();
      session.clear();
    },
    version: VERSION,
  };
  return instance;
}

/**
 * Declarative auto-init: set `window.__IBH_CONFIG__` BEFORE the ibh script loads.
 * Only cookie-based auth is supported in this mode (token/custom auth adapters are
 * functions and cannot be expressed in JSON).
 */
export interface AutoInitConfig {
  manifest: IbhManifest;
  guide?: string;
  llm: { openRouterKey: string; baseUrl?: string };
  ui?: IbhConfig['ui'];
  persistence?: IbhConfig['persistence'];
}

declare global {
  interface Window {
    __IBH_CONFIG__?: AutoInitConfig;
    /** Instance created by declarative auto-init (the `ibh` global itself stays the API object). */
    ibhInstance?: IbhInstance;
  }
}

function autoInit(): void {
  if (typeof window === 'undefined') return;
  const cfg = window.__IBH_CONFIG__;
  if (!cfg || window.ibhInstance) return;
  try {
    window.ibhInstance = init({
      manifest: cfg.manifest,
      guide: cfg.guide,
      llm: cfg.llm,
      ui: cfg.ui,
      persistence: cfg.persistence,
      auth: { mode: 'cookie' },
    });
  } catch (e) {
    console.error('[ibh] auto-init failed:', e instanceof Error ? e.message : e);
  }
}

autoInit();
