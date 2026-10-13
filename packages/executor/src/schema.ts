import type { JsonSchemaLite } from '@ibh/policy';

export interface LiteValidationResult {
  ok: boolean;
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a value against the lite JSON Schema subset used by capability manifests.
 * Deliberately small: enough to catch agent mistakes, simple enough to audit.
 */
export function validateLite(value: unknown, schema: JsonSchemaLite, path = 'value'): LiteValidationResult {
  const errors: string[] = [];

  const fail = (msg: string) => errors.push(msg);

  if (schema.type === undefined) {
    return { ok: false, errors: [`${path}: schema has no type (internal manifest validation bug)`] };
  }

  if (schema.enum) {
    if (!schema.enum.some((e) => e === value)) {
      fail(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    }
    return { ok: errors.length === 0, errors };
  }

  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        fail(`${path} must be an object`);
        return { ok: false, errors };
      }
      const obj = value as Record<string, unknown>;
      const required = schema.required ?? [];
      for (const key of required) {
        if (!(key in obj)) fail(`${path}.${key} is required`);
      }
      const props = schema.properties ?? {};
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) fail(`${path}.${key} is not an allowed property`);
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) {
          const r = validateLite(obj[key], sub, `${path}.${key}`);
          errors.push(...r.errors);
        }
      }
      return { ok: errors.length === 0, errors };
    }
    case 'array': {
      if (!Array.isArray(value)) {
        fail(`${path} must be an array`);
        return { ok: false, errors };
      }
      if (schema.items) {
        value.forEach((item, i) => {
          const r = validateLite(item, schema.items as JsonSchemaLite, `${path}[${i}]`);
          errors.push(...r.errors);
        });
      }
      return { ok: errors.length === 0, errors };
    }
    case 'string': {
      if (typeof value !== 'string') {
        fail(`${path} must be a string`);
        return { ok: false, errors };
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        fail(`${path} must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        fail(`${path} must be at most ${schema.maxLength} characters`);
      }
      if (schema.pattern !== undefined) {
        try {
          if (!new RegExp(schema.pattern, 'u').test(value)) fail(`${path} does not match the required pattern`);
        } catch {
          fail(`${path} schema pattern is invalid (internal manifest validation bug)`);
        }
      }
      return { ok: errors.length === 0, errors };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`${path} must be a number`);
        return { ok: false, errors };
      }
      if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} must be <= ${schema.maximum}`);
      return { ok: errors.length === 0, errors };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
      return { ok: errors.length === 0, errors };
    }
    case 'null': {
      if (value !== null) fail(`${path} must be null`);
      return { ok: errors.length === 0, errors };
    }
  }
}
