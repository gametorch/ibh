import type {
  ApiCapability,
  DomCapability,
  IbhManifest,
  NavCapability,
  RatePolicy,
  Tier,
} from './manifest';
import { isMutatingApiMethod, isMutatingDomAction } from './manifest';

export type CapabilityKind = 'api' | 'dom' | 'nav' | 'builtin';

export type ResolvedCapability =
  | { kind: 'api'; cap: ApiCapability }
  | { kind: 'dom'; cap: DomCapability }
  | { kind: 'nav'; cap: NavCapability }
  | { kind: 'builtin'; id: string };

export type DecisionStatus = 'allow' | 'session' | 'confirm' | 'deny';

export interface Decision {
  status: DecisionStatus;
  reason: string;
  kind: CapabilityKind;
  capabilityId: string;
  mutating: boolean;
}

/**
 * Hard library ceilings. Manifests may only LOWER these numbers, never raise them.
 * These exist so that even a careless manifest cannot turn ibh into an unbounded agent.
 */
export const LIBRARY_CEILINGS = {
  maxStepsPerTurn: 20,
  maxToolCallsPerTurn: 30,
  maxTokensPerSession: 500_000,
  maxMutatingActionsPerSession: 200,
} as const;

export const BUILTIN_IDS = ['analyze', 'page_snapshot', 'attach_image'] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

const BUILTIN_RATES: Record<BuiltinId, RatePolicy> = {
  analyze: { maxPerSession: 50, minIntervalMs: 200 },
  page_snapshot: { maxPerSession: 100, minIntervalMs: 100 },
  attach_image: { maxPerSession: 40, minIntervalMs: 400 },
};

class RateLimiter {
  private state = new Map<string, { count: number; last: number }>();

  check(key: string, policy: RatePolicy): { ok: boolean; reason?: string } {
    const s = this.state.get(key);
    if (policy.minIntervalMs !== undefined && s && Date.now() - s.last < policy.minIntervalMs) {
      return { ok: false, reason: `rate limit: minimum ${policy.minIntervalMs}ms between calls` };
    }
    if (policy.maxPerSession !== undefined && s && s.count >= policy.maxPerSession) {
      return { ok: false, reason: `rate limit: max ${policy.maxPerSession} calls per session` };
    }
    return { ok: true };
  }

  consume(key: string, _policy: RatePolicy): void {
    const s = this.state.get(key) ?? { count: 0, last: 0 };
    s.count += 1;
    s.last = Date.now();
    this.state.set(key, s);
  }
}

/**
 * The policy engine evaluates every intent against the manifest BEFORE anything executes.
 * It never performs side effects itself; the executor consumes its decisions.
 */
export class PolicyEngine {
  private readonly manifest: IbhManifest;
  private readonly byId = new Map<string, ResolvedCapability>();
  private readonly limiter = new RateLimiter();
  private mutatingCount = 0;
  private tokensSpent = 0;

  constructor(manifest: IbhManifest) {
    this.manifest = manifest;
    for (const cap of manifest.api) this.byId.set(cap.id, { kind: 'api', cap });
    for (const cap of manifest.dom ?? []) this.byId.set(cap.id, { kind: 'dom', cap });
    for (const cap of manifest.nav ?? []) this.byId.set(cap.id, { kind: 'nav', cap });
  }

  getManifest(): IbhManifest {
    return this.manifest;
  }

  lookup(kind: CapabilityKind, id: string): ResolvedCapability | undefined {
    if (kind === 'builtin') {
      return (BUILTIN_IDS as readonly string[]).includes(id) ? { kind: 'builtin', id } : undefined;
    }
    const found = this.byId.get(id);
    if (!found || found.kind !== kind) return undefined;
    return found;
  }

  listCapabilities(): ResolvedCapability[] {
    return [...this.byId.values()];
  }

  ratePolicyFor(kind: CapabilityKind, resolved: ResolvedCapability | undefined): RatePolicy {
    if (kind === 'builtin') {
      return BUILTIN_RATES[(resolved as { kind: 'builtin'; id: string }).id as BuiltinId] ?? { maxPerSession: 20 };
    }
    if (!resolved || resolved.kind === 'builtin') return {};
    return resolved.cap.rate ?? {};
  }

  isMutating(resolved: ResolvedCapability): boolean {
    if (resolved.kind === 'api') return isMutatingApiMethod(resolved.cap.method);
    if (resolved.kind === 'dom') return isMutatingDomAction(resolved.cap.action);
    return false; // nav and builtins are never counted as mutating
  }

  /** Evaluate an intent. Pure — call `consumeRate`/`recordMutating` only once execution is approved. */
  evaluate(kind: CapabilityKind, id: string): Decision {
    const base = { kind, capabilityId: id, mutating: false };
    const resolved = this.lookup(kind, id);
    if (!resolved) {
      return { ...base, status: 'deny', reason: `capability "${id}" is not registered in the manifest` };
    }
    const mutating = this.isMutating(resolved);
    const capTier: Tier = resolved.kind === 'builtin' ? 'auto' : resolved.cap.tier;

    if (capTier === 'denied') {
      return { ...base, mutating, status: 'deny', reason: `capability "${id}" is denied by the site manifest` };
    }

    const rate = this.ratePolicyFor(kind, resolved);
    const rateCheck = this.limiter.check(`${kind}:${id}`, rate);
    if (!rateCheck.ok) {
      return { ...base, mutating, status: 'deny', reason: rateCheck.reason ?? 'rate limited' };
    }

    if (mutating) {
      const max = this.effectiveLimits().maxMutatingActionsPerSession;
      if (this.mutatingCount >= max) {
        return {
          ...base,
          mutating,
          status: 'deny',
          reason: `session budget reached: max ${max} mutating actions`,
        };
      }
    }

    const status: DecisionStatus = capTier === 'auto' ? 'allow' : capTier;
    return {
      ...base,
      mutating,
      status,
      reason:
        status === 'allow'
          ? 'allowed by manifest tier'
          : status === 'session'
            ? 'requires one-time user approval for this session'
            : 'requires explicit user confirmation for this action',
    };
  }

  consumeRate(kind: CapabilityKind, id: string): void {
    const resolved = this.lookup(kind, id);
    this.limiter.consume(`${kind}:${id}`, this.ratePolicyFor(kind, resolved));
  }

  recordMutating(): void {
    this.mutatingCount += 1;
  }

  getMutatingCount(): number {
    return this.mutatingCount;
  }

  recordTokens(n: number): void {
    this.tokensSpent += Math.max(0, Math.floor(n));
  }

  getTokensSpent(): number {
    return this.tokensSpent;
  }

  checkTokenBudget(nextCallEstimate = 0): { ok: boolean; reason?: string } {
    const max = this.effectiveLimits().maxTokensPerSession;
    if (this.tokensSpent + nextCallEstimate > max) {
      return { ok: false, reason: `session token budget reached (${this.tokensSpent}/${max})` };
    }
    return { ok: true };
  }

  /** Manifest values, clamped to library ceilings. Manifests may only tighten. */
  effectiveLimits(): EffectiveLimits {
    return effectiveLimits(this.manifest);
  }
}

export interface EffectiveLimits {
  maxStepsPerTurn: number;
  maxToolCallsPerTurn: number;
  maxTokensPerSession: number;
  maxMutatingActionsPerSession: number;
}

/** Manifest values clamped to library ceilings. Pure — usable without a PolicyEngine instance. */
export function effectiveLimits(manifest: IbhManifest): EffectiveLimits {
  const p = manifest.policies;
  return {
    maxStepsPerTurn: Math.min(p.maxStepsPerTurn ?? LIBRARY_CEILINGS.maxStepsPerTurn, LIBRARY_CEILINGS.maxStepsPerTurn),
    maxToolCallsPerTurn: Math.min(
      p.maxToolCallsPerTurn ?? LIBRARY_CEILINGS.maxToolCallsPerTurn,
      LIBRARY_CEILINGS.maxToolCallsPerTurn
    ),
    maxTokensPerSession: Math.min(
      p.maxTokensPerSession ?? LIBRARY_CEILINGS.maxTokensPerSession,
      LIBRARY_CEILINGS.maxTokensPerSession
    ),
    maxMutatingActionsPerSession: Math.min(
      p.maxMutatingActionsPerSession ?? LIBRARY_CEILINGS.maxMutatingActionsPerSession,
      LIBRARY_CEILINGS.maxMutatingActionsPerSession
    ),
  };
}
