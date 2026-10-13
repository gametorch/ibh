/**
 * The ibh capability manifest — the hard contract between a host site and the harness.
 *
 * Everything the agent can do must be declared here. If it is not in the manifest,
 * the runtime will not execute it. Validation is fail-closed: a manifest that does
 * not explicitly configure consent tiers is rejected, never defaulted.
 */

export type Tier = 'auto' | 'session' | 'confirm' | 'denied';

export const TIERS: readonly Tier[] = ['auto', 'session', 'confirm', 'denied'] as const;

/**
 * Tier semantics (host decides per capability; ibh has no library default):
 * - auto:    execute without asking the user (still rate-limited and budgeted).
 * - session: execute after the user approves this capability once for the session.
 * - confirm: show the user exactly what will happen, every time, before executing.
 * - denied:  never executable. Present in the manifest for documentation/UX only.
 */
export type ConsentTier = 'auto' | 'session' | 'confirm';
export type ExecutableTier = Exclude<Tier, 'denied'>;

export interface RatePolicy {
  /** Maximum executions of this capability per browser session. */
  maxPerSession?: number;
  /** Minimum spacing between executions, in milliseconds. */
  minIntervalMs?: number;
}

/** Minimal, explicitly-supported subset of JSON Schema used for argument validation. */
export interface JsonSchemaLite {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchemaLite>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchemaLite;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What happened / is about to happen, for integrator-authored approval copy. */
export interface ApproveContext {
  kind: 'api' | 'dom' | 'nav';
  capabilityId: string;
  /** api only */
  method?: string;
  /** api/nav: interpolated path or route string (e.g. "/api/sprites/3"). */
  path?: string;
  /** api/nav: the path parameters (e.g. { id: "3" }) — use `{{params.id}}` in templates. */
  params?: Record<string, string>;
  /** api only */
  query?: Record<string, unknown>;
  body?: unknown;
  /** dom only */
  action?: string;
  value?: string;
  /** dom only: human-readable description of the target element. */
  element?: string;
}

/**
 * Custom approval copy for a capability (shown instead of the technical preview).
 * - string: a template; `{{dot.path}}` placeholders resolve against ApproveContext
 *   (e.g. "Create a sprite named {{body.name}}?"). JSON-friendly.
 * - function: full control, programmatic init only (JSON manifests cannot carry functions).
 * Integrator-authored and trusted; rendered as plain text. Optional — without it the
 * default technical preview (method/path/payload) is shown.
 */
export type ApproveSpec = string | ((ctx: ApproveContext) => string);

export interface ApiCapability {
  /** Globally unique across the whole manifest. Chars: [_a-zA-Z0-9-], <= 64. */
  id: string;
  method: ApiMethod;
  /** Path template relative to the site origin, e.g. "/api/sprites/:id". Params use ":name". */
  path: string;
  tier: Tier;
  description?: string;
  /** JSON body schema (lite subset). */
  argSchema?: JsonSchemaLite;
  /** Query parameter schema (lite subset). */
  querySchema?: JsonSchemaLite;
  rate?: RatePolicy;
  /** Custom approval copy (optional). */
  approve?: ApproveSpec;
}

export type DomAction = 'click' | 'fill' | 'submit' | 'highlight';

export interface DomCapability {
  id: string;
  action: DomAction;
  /** CSS selector authored by the (trusted) host. Prefer `data-ibh-action="..."` markers. */
  selector: string;
  tier: Tier;
  description?: string;
  /** For `fill`: schema of the single `value` argument. */
  argSchema?: JsonSchemaLite;
  rate?: RatePolicy;
  /** Custom approval copy (optional). */
  approve?: ApproveSpec;
}

export interface NavCapability {
  id: string;
  /** Route pattern, e.g. "/projects/:id" or "/settings/*". "*" matches one segment. */
  route: string;
  tier: Tier;
  description?: string;
  /** spa = history-based navigation; full = full page load (location.assign). */
  mode?: 'spa' | 'full';
  rate?: RatePolicy;
  /** Custom approval copy (optional). */
  approve?: ApproveSpec;
}

export interface Policies {
  /**
   * Total mutating (non-read) actions allowed per browser session.
   * REQUIRED whenever a mutating capability has a tier other than "denied".
   */
  maxMutatingActionsPerSession?: number;
  /** Agent reasoning/tool steps per user turn. Library ceiling applies. */
  maxStepsPerTurn?: number;
  /** Tool calls per user turn. Library ceiling applies. */
  maxToolCallsPerTurn?: number;
  /** Total LLM tokens (prompt + completion) per browser session. Library ceiling applies. */
  maxTokensPerSession?: number;
}

export interface LlmPolicy {
  /** Models the harness may use. Anything outside this list is refused. */
  allowedModels: string[];
  /** Must be a member of allowedModels. */
  defaultModel: string;
}

export interface IbhManifest {
  version: 1;
  site: {
    name: string;
    origin: string;
  };
  api: ApiCapability[];
  dom?: DomCapability[];
  nav?: NavCapability[];
  policies: Policies;
  llm: LlmPolicy;
}

export function isMutatingApiMethod(method: ApiMethod): boolean {
  return method !== 'GET';
}

export function isMutatingDomAction(action: DomAction): boolean {
  return action !== 'highlight';
}
