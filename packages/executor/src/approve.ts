import type { ApproveContext, ApproveSpec } from '@ibh/policy';

const PLACEHOLDER = /\{\{\s*([_a-zA-Z][_a-zA-Z0-9.]*)\s*\}\}/gu;

function lookup(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/**
 * Render integrator-authored approval copy.
 * - Function spec: called with the context; integrator owns the string entirely.
 * - String spec: `{{dot.path}}` placeholders resolve against the context
 *   (strings injected raw, numbers/booleans stringified, objects JSON'd, missing -> '').
 * The result is rendered as plain text by the UI (textContent), never as HTML.
 */
export function renderApproveQuestion(spec: ApproveSpec, ctx: ApproveContext): string {
  if (typeof spec === 'function') {
    try {
      return String(spec(ctx) ?? '');
    } catch (e) {
      return `(${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return spec.replace(PLACEHOLDER, (_m, expr: string) => stringify(lookup(ctx, expr)));
}
