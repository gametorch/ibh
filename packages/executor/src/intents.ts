import type { CapabilityKind, DecisionStatus } from '@ibh/policy';

/**
 * Intents are the ONLY way the agent can act. The model never touches the network
 * or the DOM directly — it emits structured intents, and the gatekeeper validates,
 * polices, consents, executes and audits them.
 */

export interface ApiIntentArgs {
  /** Values for ":param" segments of the capability's path template. */
  path?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface DomIntentArgs {
  /** Element ref from the last page snapshot (e.g. "#r12"). Must match the capability selector. */
  ref?: string;
  /** Required for `fill`. */
  value?: string;
}

export interface NavIntentArgs {
  /** Values for ":param" segments of the capability's route pattern. */
  params?: Record<string, string>;
}

export type BuiltinName = 'page_snapshot' | 'analyze';

export type Intent =
  | { kind: 'api'; capabilityId: string; args?: ApiIntentArgs }
  | { kind: 'dom'; capabilityId: string; args?: DomIntentArgs }
  | { kind: 'nav'; capabilityId: string; args?: NavIntentArgs }
  | { kind: 'builtin'; name: 'page_snapshot' }
  | { kind: 'builtin'; name: 'analyze'; args: { code: string; data?: unknown } };

export function intentKindToCapabilityKind(intent: Intent): CapabilityKind {
  switch (intent.kind) {
    case 'api':
      return 'api';
    case 'dom':
      return 'dom';
    case 'nav':
      return 'nav';
    case 'builtin':
      return 'builtin';
  }
}

export function capabilityIdOfIntent(intent: Intent): string {
  return intent.kind === 'builtin' ? intent.name : intent.capabilityId;
}

export interface ToolOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  decision: DecisionStatus;
  capabilityId: string;
  kind: CapabilityKind;
}
