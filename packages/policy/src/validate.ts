import type {
  ApiCapability,
  ApiMethod,
  DomAction,
  DomCapability,
  IbhManifest,
  JsonSchemaLite,
  NavCapability,
  Policies,
  RatePolicy,
  Tier,
} from './manifest';
import { TIERS, isMutatingApiMethod, isMutatingDomAction } from './manifest';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const API_METHODS: readonly ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const DOM_ACTIONS: readonly DomAction[] = ['click', 'fill', 'submit', 'highlight'];
const ID_PATTERN = /^[_a-zA-Z][-_a-zA-Z0-9]{0,63}$/u;
const PATH_PARAM_PATTERN = /(^|\/):([_a-zA-Z][_a-zA-Z0-9]*)/gu;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Approve copy: integrator-authored string template or function. Trusted — very permissive. */
function checkApprove(approve: unknown, errors: string[], where: string): void {
  if (approve === undefined) return;
  if (typeof approve === 'function') return;
  if (typeof approve === 'string') {
    if (approve.trim().length === 0 || approve.length > 2000) {
      errors.push(`${where}.approve must be a non-empty string (<= 2000 chars) or a function`);
    }
    return;
  }
  errors.push(`${where}.approve must be a string or a function`);
}

// oxlint-disable no-negated-condition -- a validator reads naturally as
// "if invalid -> record error"; positive-form rewrites obscure the failure path.
function checkRate(rate: unknown, errors: string[], where: string): rate is RatePolicy {  if (rate === undefined) return false;
  if (!isPlainObject(rate)) {
    errors.push(`${where}.rate must be an object`);
    return false;
  }
  const { maxPerSession, minIntervalMs } = rate as RatePolicy;
  if (maxPerSession !== undefined && !isPositiveInt(maxPerSession)) {
    errors.push(`${where}.rate.maxPerSession must be a positive integer`);
  }
  if (minIntervalMs !== undefined && !isPositiveInt(minIntervalMs)) {
    errors.push(`${where}.rate.minIntervalMs must be a positive integer`);
  }
  return true;
}

function checkTier(tier: unknown, errors: string[], where: string): tier is Tier {
  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) {
    errors.push(`${where}.tier is required and must be one of: ${TIERS.join(', ')}`);
    return false;
  }
  return true;
}

function checkPathTemplate(path: string, errors: string[], where: string): void {
  if (!path.startsWith('/')) {
    errors.push(`${where}.path must start with "/" and be relative to the site origin`);
    return;
  }
  if (path.includes('*')) {
    errors.push(`${where}.path must not contain wildcards ("*") — API paths are exact templates with ":param" segments only`);
  }
  PATH_PARAM_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_PARAM_PATTERN.exec(path)) !== null) {
    if (m[2] === undefined || m[2].length === 0) {
      errors.push(`${where}.path has an invalid ":param" name`);
    }
  }
  if (/(^|\/):(?![a-zA-Z_])/u.test(path)) {
    errors.push(`${where}.path contains a malformed parameter segment`);
  }
}

function checkRoutePattern(route: string, errors: string[], where: string): void {
  if (!route.startsWith('/')) {
    errors.push(`${where}.route must start with "/"`);
  }
  if (route.includes('*')) {
    errors.push(`${where}.route must not contain wildcards ("*") — nav routes are exact templates with ":param" segments only`);
  }
}

function checkLiteSchema(schema: unknown, errors: string[], where: string, depth = 0): void {
  if (depth > 6) {
    errors.push(`${where}: schema nesting exceeds supported depth (6)`);
    return;
  }
  if (schema === undefined || schema === null) return;
  if (!isPlainObject(schema)) {
    errors.push(`${where} must be an object`);
    return;
  }
  const s = schema as JsonSchemaLite;
  if (s.type === undefined) {
    errors.push(`${where}.type is required`);
  }
  if (s.type === 'object') {
    if (s.properties !== undefined) {
      if (isPlainObject(s.properties)) {
        for (const [key, sub] of Object.entries(s.properties)) {
          checkLiteSchema(sub, errors, `${where}.properties.${key}`, depth + 1);
        }
      } else {
        errors.push(`${where}.properties must be an object`);
      }
    }
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string'))) {
      errors.push(`${where}.required must be an array of strings`);
    }
  }
  if (s.type === 'array' && s.items !== undefined) {
    checkLiteSchema(s.items, errors, `${where}.items`, depth + 1);
  }
  if (s.pattern !== undefined && typeof s.pattern === 'string') {
    try {
      void new RegExp(s.pattern, 'u');
    } catch {
      errors.push(`${where}.pattern is not a valid regular expression`);
    }
  }
}

type AnyRecord = Record<string, unknown>;

function checkApiCapabilityBody(cap: Partial<ApiCapability> & AnyRecord, where: string, errors: string[]): void {
  checkTier(cap.tier, errors, where);
  if (typeof cap.method !== 'string' || !API_METHODS.includes(cap.method as ApiMethod)) {
    errors.push(`${where}.method must be one of ${API_METHODS.join(', ')}`);
  }
  if (typeof cap.path === 'string') {
    checkPathTemplate(cap.path, errors, where);
  } else {
    errors.push(`${where}.path must be a string`);
  }
  if (cap.argSchema !== undefined) checkLiteSchema(cap.argSchema, errors, `${where}.argSchema`);
  if (cap.querySchema !== undefined) checkLiteSchema(cap.querySchema, errors, `${where}.querySchema`);
  checkRate(cap.rate, errors, where);
  checkApprove(cap.approve, errors, where);
  if (cap.description !== undefined && typeof cap.description !== 'string') {
    errors.push(`${where}.description must be a string`);
  }
}

/**
 * Validate a manifest. Fail-closed: any error means the harness must refuse to start.
 * There is no library default for consent — every capability declares its own tier.
 */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const m = input as Partial<IbhManifest> & Record<string, unknown>;

  if (m.version !== 1) errors.push('manifest.version must be 1');

  if (!isPlainObject(m.site)) {
    errors.push('manifest.site is required');
  } else {
    const site = m.site as { name?: unknown; origin?: unknown };
    const nameOk = typeof site.name === 'string' && site.name.trim().length > 0;
    if (!nameOk) {
      errors.push('manifest.site.name must be a non-empty string');
    }
    if (typeof site.origin === 'string') {
      try {
        const u = new URL(site.origin);
        const protocolOk = u.protocol === 'https:' || u.protocol === 'http:';
        if (u.origin === 'null' || !protocolOk) {
          errors.push('manifest.site.origin must be an http(s) origin');
        }
      } catch {
        errors.push('manifest.site.origin must be a valid URL origin');
      }
    }
  }

  if (!Array.isArray(m.api)) {
    errors.push('manifest.api must be an array (possibly empty)');
  }

  const seenIds = new Set<string>();
  const idOf = (where: string, raw: unknown): raw is string => {
    if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
      errors.push(`${where}.id must match ${ID_PATTERN.source}`);
      return false;
    }
    if (seenIds.has(raw)) {
      errors.push(`duplicate capability id "${raw}"`);
      return false;
    }
    seenIds.add(raw);
    return true;
  };

  let mutatingExecutable = false;

  if (Array.isArray(m.api)) {
    m.api.forEach((raw: unknown, i: number) => {
      const where = `manifest.api[${i}]`;
      if (!isPlainObject(raw)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const cap = raw as Partial<ApiCapability> & Record<string, unknown>;
      if (idOf(where, cap.id) && typeof cap.id === 'string') {
        checkApiCapabilityBody(cap, where, errors);
        if (cap.tier !== 'denied' && typeof cap.method === 'string' && isMutatingApiMethod(cap.method as ApiMethod)) {
          mutatingExecutable = true;
        }
      }
    });
  }

  const checkDom = (raw: unknown, i: number) => {
    const where = `manifest.dom[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const cap = raw as Partial<DomCapability> & Record<string, unknown>;
    if (idOf(where, cap.id) && typeof cap.id === 'string') {
      checkTier(cap.tier, errors, where);
      if (typeof cap.action !== 'string' || !DOM_ACTIONS.includes(cap.action as DomAction)) {
        errors.push(`${where}.action must be one of ${DOM_ACTIONS.join(', ')}`);
      }
      if (typeof cap.selector !== 'string' || cap.selector.trim().length === 0 || cap.selector.length > 300) {
        errors.push(`${where}.selector must be a non-empty CSS selector (<= 300 chars)`);
      }
      if (typeof cap.action === 'string' && isMutatingDomAction(cap.action as DomAction) && cap.tier !== 'denied') {
        mutatingExecutable = true;
      }
      if (cap.argSchema !== undefined) checkLiteSchema(cap.argSchema, errors, `${where}.argSchema`);
      checkRate(cap.rate, errors, where);
      checkApprove(cap.approve, errors, where);
    }
  };
  if (m.dom !== undefined) {
    if (!Array.isArray(m.dom)) errors.push('manifest.dom must be an array');
    else m.dom.forEach(checkDom);
  }

  const checkNav = (raw: unknown, i: number) => {
    const where = `manifest.nav[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const cap = raw as Partial<NavCapability> & Record<string, unknown>;
    if (idOf(where, cap.id) && typeof cap.id === 'string') {
      checkTier(cap.tier, errors, where);
      if (typeof cap.route !== 'string') {
        errors.push(`${where}.route must be a string`);
      } else {
        checkRoutePattern(cap.route, errors, where);
      }
      if (cap.mode !== undefined && cap.mode !== 'spa' && cap.mode !== 'full') {
        errors.push(`${where}.mode must be "spa" or "full"`);
      }
      checkRate(cap.rate, errors, where);
      checkApprove(cap.approve, errors, where);
    }
  };
  if (m.nav !== undefined) {
    if (!Array.isArray(m.nav)) errors.push('manifest.nav must be an array');
    else m.nav.forEach(checkNav);
  }

  if (!isPlainObject(m.policies)) {
    errors.push('manifest.policies is required');
  } else {
    const p = m.policies as Policies;
    if (mutatingExecutable) {
      if (p.maxMutatingActionsPerSession === undefined) {
        errors.push(
          'manifest.policies.maxMutatingActionsPerSession is required because the manifest contains executable mutating capabilities'
        );
      } else if (!isPositiveInt(p.maxMutatingActionsPerSession)) {
        errors.push('manifest.policies.maxMutatingActionsPerSession must be a positive integer');
      }
    }
    for (const key of ['maxStepsPerTurn', 'maxToolCallsPerTurn', 'maxTokensPerSession'] as const) {
      if (p[key] !== undefined && !isPositiveInt(p[key])) {
        errors.push(`manifest.policies.${key} must be a positive integer`);
      }
    }
  }

  if (!isPlainObject(m.llm)) {
    errors.push('manifest.llm is required');
  } else {
    const llm = m.llm as { allowedModels?: unknown; defaultModel?: unknown };
    if (!Array.isArray(llm.allowedModels) || llm.allowedModels.length === 0 || llm.allowedModels.some((x) => typeof x !== 'string')) {
      errors.push('manifest.llm.allowedModels must be a non-empty array of strings');
    }
    if (typeof llm.defaultModel !== 'string' || llm.defaultModel.length === 0) {
      errors.push('manifest.llm.defaultModel must be a non-empty string');
    } else if (Array.isArray(llm.allowedModels) && !llm.allowedModels.includes(llm.defaultModel)) {
      errors.push('manifest.llm.defaultModel must be a member of allowedModels');
    }
  }

  return { ok: errors.length === 0, errors };
}
