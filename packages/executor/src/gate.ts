import type { CapabilityKind, IbhManifest, PolicyEngine, ResolvedCapability } from '@ibh/policy';
import type { AuditDecision, AuditKind, AuditLedger } from './audit';
import type { DomAction } from '@ibh/policy';
import type { DomExecutor } from './adapters/dom';
import type { AnalyzeExecutor } from './adapters/analyze';
import type { ImageExecutor } from './adapters/image';
import type { NavExecutor, NavMode } from './adapters/nav';
import type { ApiFetcher } from './adapters/auth';
import { tryInterpolatePath } from './adapters/fetch';
import { renderApproveQuestion } from './approve';
import { capabilityIdOfIntent, intentKindToCapabilityKind } from './intents';
import type { Intent, ToolOutcome } from './intents';
import { validateLite } from './schema';

export interface ConsentRequest {
  kind: CapabilityKind;
  capabilityId: string;
  /** Single-line description of exactly what will happen. */
  actionSummary: string;
  /** Additional bullets shown to the user (payload preview, target element, etc). */
  detailLines: string[];
  /**
   * Integrator-authored question copy (capability's `approve` spec). When present
   * the UI shows this INSTEAD of the technical summary/details.
   */
  question?: string;
}

export interface ConsentPort {
  request(req: ConsentRequest): Promise<boolean>;
}

export interface GateDeps {
  manifest: IbhManifest;
  policy: PolicyEngine;
  api: ApiFetcher;
  dom: DomExecutor;
  nav: NavExecutor;
  analyze: AnalyzeExecutor;
  /** Image capture for the attach_image builtin. When absent, attach_image is denied. */
  image?: ImageExecutor;
  ledger: AuditLedger;
  /** When absent, every tier that requires consent is denied (fail closed). */
  consent?: ConsentPort;
}

const MAX_RESULT_CHARS = 20_000;
const MAX_BODY_CHARS = 50_000;
/** Library-level cap for DOM fill values (a capability's argSchema can be stricter). */
const MAX_FILL_CHARS = 10_000;

function truncateValue(v: unknown, maxChars = MAX_RESULT_CHARS): unknown {
  let s: string;
  try {
    s = JSON.stringify(v);
    if (s === undefined) s = String(v);
  } catch {
    return String(v);
  }
  if (s.length <= maxChars) return v;
  return {
    _truncated: true,
    _fullSizeChars: s.length,
    _preview: s.slice(0, maxChars),
    _note: `result exceeded ${maxChars} chars — only a preview is returned`,
  };
}

const AUDIT_KIND: Record<CapabilityKind, AuditKind> = {
  api: 'api',
  dom: 'dom',
  nav: 'nav',
  builtin: 'page_snapshot',
};

const BUILTIN_AUDIT_KIND: Record<string, AuditKind> = {
  page_snapshot: 'page_snapshot',
  analyze: 'analyze',
  attach_image: 'image',
};

/**
 * The gatekeeper. Every agent action passes through exactly one method here:
 *
 *   intent -> policy evaluate -> argument validation -> consent (if the tier
 *   requires it) -> rate/budget commit -> execution -> audit
 *
 * The model never gets a reference to fetch, the DOM, or anything else capable of
 * side effects. Denials are returned to the model as structured errors so it can
 * explain them to the user instead of trying to route around policy.
 */
export class Gatekeeper {
  private sessionApproved = new Set<string>();

  constructor(private readonly deps: GateDeps) {}

  getSessionApproved(): string[] {
    return [...this.sessionApproved];
  }

  /** Seed session approvals from a persisted session (opt-in persistence). */
  hydrateApprovals(ids: readonly string[]): void {
    for (const id of ids) this.sessionApproved.add(id);
  }

  resetSessionApprovals(): void {
    this.sessionApproved.clear();
  }

  async resolve(intent: Intent): Promise<ToolOutcome> {
    const kind = intentKindToCapabilityKind(intent);
    const capabilityId = capabilityIdOfIntent(intent);

    try {
      return await this.resolveInner(intent, kind, capabilityId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.ledger.append({
        kind: intent.kind === 'builtin' ? (BUILTIN_AUDIT_KIND[intent.name] ?? 'page_snapshot') : AUDIT_KIND[kind],
        decision: 'error',
        summary: `${capabilityId}: ${msg}`,
      });
      return { ok: false, error: msg, decision: 'deny', capabilityId, kind };
    }
  }

  private async resolveInner(intent: Intent, kind: CapabilityKind, capabilityId: string): Promise<ToolOutcome> {
    const { policy, ledger } = this.deps;
    const auditKind: AuditKind =
      intent.kind === 'builtin' ? (BUILTIN_AUDIT_KIND[intent.name] ?? 'page_snapshot') : AUDIT_KIND[kind];

    if (intent.kind === 'builtin') {
      const decision = policy.evaluate('builtin', intent.name);
      if (decision.status === 'deny') {
        ledger.append({ kind: auditKind, decision: 'deny', summary: `${intent.name}: ${decision.reason}` });
        return { ok: false, error: decision.reason, decision: 'deny', capabilityId, kind };
      }
      if (intent.name === 'page_snapshot') {
        policy.consumeRate('builtin', intent.name);
        const snap = this.deps.dom.snapshot();
        ledger.append({ kind: 'page_snapshot', decision: 'allow', summary: `page snapshot of ${snap.url}` });
        return { ok: true, result: snap, decision: 'allow', capabilityId, kind };
      }
      if (intent.name === 'attach_image') {
        if (!this.deps.image) {
          const reason = 'image capture is not configured';
          ledger.append({ kind: 'image', decision: 'deny', summary: `attach_image: ${reason}` });
          return { ok: false, error: reason, decision: 'deny', capabilityId, kind };
        }
        policy.consumeRate('builtin', intent.name);
        const r = await this.deps.image.capture(intent.args);
        if (!r.ok) {
          ledger.append({ kind: 'image', decision: 'error', summary: `attach_image: ${r.summary}` });
          return { ok: false, error: r.summary, decision: 'deny', capabilityId, kind };
        }
        ledger.append({ kind: 'image', decision: 'allow', summary: r.summary, detail: { name: r.image?.name } });
        return { ok: true, result: { summary: r.summary, image: r.image }, decision: 'allow', capabilityId, kind };
      }
      // analyze
      policy.consumeRate('builtin', intent.name);
      const result = await this.deps.analyze.run(intent.args.code, intent.args.data);
      ledger.append({ kind: 'analyze', decision: 'allow', summary: `ran sandboxed JS (${intent.args.code.length} chars)` });
      return { ok: true, result: truncateValue(result), decision: 'allow', capabilityId, kind };
    }

    // ---- capability intents -------------------------------------------------
    const decision = policy.evaluate(kind, capabilityId);
    if (decision.status === 'deny') {
      ledger.append({ kind: auditKind, decision: 'deny', summary: `${capabilityId}: ${decision.reason}` });
      return { ok: false, error: decision.reason, decision: 'deny', capabilityId, kind };
    }

    const resolved = policy.lookup(kind, capabilityId);
    if (!resolved || resolved.kind !== kind) {
      return { ok: false, error: 'internal: capability resolution mismatch', decision: 'deny', capabilityId, kind };
    }

    // Validate arguments and build the consent preview BEFORE asking the user,
    // so the preview always matches exactly what will execute.
    const prep = this.prepare(intent, resolved);
    if ('error' in prep) {
      ledger.append({ kind: auditKind, decision: 'error', summary: `${capabilityId}: ${prep.error}` });
      return { ok: false, error: prep.error, decision: 'deny', capabilityId, kind };
    }

    // Consent flow. No consent port => anything above "auto" is denied (fail closed).
    if (decision.status === 'session' || decision.status === 'confirm') {
      const needsApproval = decision.status === 'confirm' || !this.sessionApproved.has(capabilityId);
      if (needsApproval) {
        if (!this.deps.consent) {
          const reason = 'this action requires user confirmation but no consent UI is connected';
          ledger.append({ kind: auditKind, decision: 'deny', summary: `${capabilityId}: ${reason}` });
          return { ok: false, error: reason, decision: 'deny', capabilityId, kind };
        }
        const approved = await this.deps.consent.request({
          kind,
          capabilityId,
          actionSummary: prep.actionSummary,
          detailLines: prep.detailLines,
          question: prep.question,
        });
        if (!approved) {
          ledger.append({
            kind: auditKind,
            decision: 'consent-denied',
            summary: `${capabilityId}: user declined — ${prep.actionSummary}`,
          });
          return { ok: false, error: 'the user declined this action', decision: 'deny', capabilityId, kind };
        }
        if (decision.status === 'session') this.sessionApproved.add(capabilityId);
      }
    }

    policy.consumeRate(kind, capabilityId);

    let outcome: ToolOutcome;
    switch (resolved.kind) {
      case 'api': {
        const cap = resolved.cap;
        const args = intent.kind === 'api' ? (intent.args ?? {}) : {};
        const res = await this.deps.api.request({
          method: cap.method,
          path: prep.path,
          query: args.query,
          body: args.body,
        });
        outcome = {
          ok: true,
          result: { status: res.status, ok: res.ok, body: truncateValue(res.body) },
          decision: decision.status,
          capabilityId,
          kind,
        };
        ledger.append({
          kind: 'api',
          decision: decision.status as AuditDecision,
          summary: `${cap.method} ${prep.path}`,
          detail: { status: res.status, capabilityId },
        });
        break;
      }
      case 'dom': {
        const cap = resolved.cap;
        const args = intent.kind === 'dom' ? (intent.args ?? {}) : {};
        const r = await this.deps.dom.act(cap.action as DomAction, cap.selector, args.ref, args.value);
        if (!r.ok) {
          ledger.append({ kind: 'dom', decision: 'error', summary: `${capabilityId}: ${r.summary}` });
          return { ok: false, error: r.summary, decision: 'deny', capabilityId, kind };
        }
        outcome = { ok: true, result: { summary: r.summary }, decision: decision.status, capabilityId, kind };
        ledger.append({
          kind: 'dom',
          decision: decision.status as AuditDecision,
          summary: `${cap.action}: ${r.summary}`,
          detail: { capabilityId },
        });
        break;
      }
      case 'nav': {
        const cap = resolved.cap;
        const mode: NavMode = cap.mode ?? 'spa';
        const r = this.deps.nav.navigate(prep.path, mode);
        if (!r.ok) {
          ledger.append({ kind: 'nav', decision: 'error', summary: `${capabilityId}: ${r.summary}` });
          return { ok: false, error: r.summary, decision: 'deny', capabilityId, kind };
        }
        outcome = { ok: true, result: { summary: r.summary }, decision: decision.status, capabilityId, kind };
        ledger.append({
          kind: 'nav',
          decision: decision.status as AuditDecision,
          summary: r.summary,
          detail: { capabilityId, mode },
        });
        break;
      }
      default:
        return { ok: false, error: 'internal: unreachable capability kind', decision: 'deny', capabilityId, kind };
    }

    if (decision.mutating) policy.recordMutating();
    return outcome;
  }

  /** Argument validation + consent preview construction. */
  private prepare(
    intent: Intent,
    resolved: ResolvedCapability
  ): { ok: true; path: string; actionSummary: string; detailLines: string[]; question?: string } | { ok: false; error: string } {
    if (resolved.kind === 'api') {
      const cap = resolved.cap;
      const args = intent.kind === 'api' ? (intent.args ?? {}) : {};
      const interp = tryInterpolatePath(cap.path, args.path);
      if (!interp.ok) return { ok: false, error: interp.error };
      if (cap.argSchema) {
        const v = validateLite(args.body ?? null, cap.argSchema, 'body');
        if (!v.ok) return { ok: false, error: `body invalid: ${v.errors.join('; ')}` };
      }
      if (cap.querySchema) {
        const v = validateLite(args.query ?? {}, cap.querySchema, 'query');
        if (!v.ok) return { ok: false, error: `query invalid: ${v.errors.join('; ')}` };
      }
      const bodyJson = args.body === undefined ? '' : JSON.stringify(args.body);
      if (bodyJson.length > MAX_BODY_CHARS) return { ok: false, error: `body exceeds ${MAX_BODY_CHARS} chars` };
      const queryStr = args.query ? `?${new URLSearchParams(Object.entries(args.query).map(([k, v]) => [k, String(v)])).toString()}` : '';
      const detailLines: string[] = [];
      if (cap.description) detailLines.push(cap.description);
      if (bodyJson) detailLines.push(`body: ${bodyJson.slice(0, 500)}${bodyJson.length > 500 ? '…' : ''}`);
      return {
        ok: true,
        path: interp.path,
        actionSummary: `${cap.method} ${interp.path}${queryStr}`,
        detailLines,
        question: cap.approve
          ? renderApproveQuestion(cap.approve, {
              kind: 'api',
              capabilityId: cap.id,
              method: cap.method,
              path: interp.path,
              params: args.path,
              query: args.query,
              body: args.body,
            })
          : undefined,
      };
    }

    if (resolved.kind === 'dom') {
      const cap = resolved.cap;
      const args = intent.kind === 'dom' ? (intent.args ?? {}) : {};
      const { el, error } = this.deps.dom.resolve(cap.selector, args.ref);
      if (!el) return { ok: false, error: error ?? 'element not found' };
      let value = args.value;
      if (cap.action === 'fill') {
        if (typeof value !== 'string') return { ok: false, error: 'fill requires a string "value"' };
        if (value.length > MAX_FILL_CHARS) {
          return { ok: false, error: `fill value exceeds ${MAX_FILL_CHARS} characters` };
        }
        if (cap.argSchema) {
          const v = validateLite(value, cap.argSchema, 'value');
          if (!v.ok) return { ok: false, error: `value invalid: ${v.errors.join('; ')}` };
        }
      } else {
        value = undefined;
      }
      const detailLines: string[] = [`target: ${this.deps.dom.describe(el)}`];
      if (cap.description) detailLines.push(cap.description);
      if (value !== undefined) detailLines.push(`value: ${JSON.stringify(value)}`);
      return {
        ok: true,
        path: cap.selector,
        actionSummary: `${cap.action} → ${this.deps.dom.describe(el)}`,
        detailLines,
        question: cap.approve
          ? renderApproveQuestion(cap.approve, {
              kind: 'dom',
              capabilityId: cap.id,
              action: cap.action,
              value,
              element: this.deps.dom.describe(el),
            })
          : undefined,
      };
    }

    if (resolved.kind === 'nav') {
      const cap = resolved.cap;
      const args = intent.kind === 'nav' ? (intent.args ?? {}) : {};
      const interp = tryInterpolatePath(cap.route, args.params);
      if (!interp.ok) return { ok: false, error: interp.error };
      const detailLines: string[] = [];
      if (cap.description) detailLines.push(cap.description);
      return {
        ok: true,
        path: interp.path,
        actionSummary: `navigate to ${interp.path}`,
        detailLines,
        question: cap.approve
          ? renderApproveQuestion(cap.approve, {
              kind: 'nav',
              capabilityId: cap.id,
              path: interp.path,
              params: args.params,
            })
          : undefined,
      };
    }

    return { ok: false, error: 'internal: unknown capability kind' };
  }
}
