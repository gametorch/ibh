import { describe, expect, it } from 'vitest';
import { validateLite } from './schema';

describe('validateLite', () => {
  it('validates required object properties', () => {
    const schema = { type: 'object' as const, properties: { a: { type: 'string' as const } }, required: ['a'] };
    expect(validateLite({ a: 'x' }, schema).ok).toBe(true);
    expect(validateLite({}, schema).ok).toBe(false);
    expect(validateLite({ a: 1 }, schema).ok).toBe(false);
  });

  it('rejects additional properties when additionalProperties is false', () => {
    const schema = { type: 'object' as const, properties: { a: { type: 'string' as const } }, additionalProperties: false as const };
    const r = validateLite({ a: 'x', b: 'y' }, schema);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('not an allowed property');
  });

  it('validates enums', () => {
    const schema = { type: 'string' as const, enum: ['red', 'green'] };
    expect(validateLite('red', schema).ok).toBe(true);
    expect(validateLite('blue', schema).ok).toBe(false);
  });

  it('validates string constraints', () => {
    const schema = { type: 'string' as const, minLength: 2, maxLength: 5, pattern: '^[a-z]+$' };
    expect(validateLite('abc', schema).ok).toBe(true);
    expect(validateLite('a', schema).ok).toBe(false);
    expect(validateLite('abcdef', schema).ok).toBe(false);
    expect(validateLite('ABC', schema).ok).toBe(false);
  });

  it('validates numbers', () => {
    const schema = { type: 'number' as const, minimum: 1, maximum: 10 };
    expect(validateLite(5, schema).ok).toBe(true);
    expect(validateLite(0, schema).ok).toBe(false);
    expect(validateLite(11, schema).ok).toBe(false);
  });

  it('validates arrays with item schemas', () => {
    const schema = { type: 'array' as const, items: { type: 'number' as const } };
    expect(validateLite([1, 2], schema).ok).toBe(true);
    expect(validateLite([1, 'x'], schema).ok).toBe(false);
  });

  it('validates nested objects', () => {
    const schema = {
      type: 'object' as const,
      properties: { nested: { type: 'object' as const, properties: { deep: { type: 'boolean' as const } } } },
    };
    expect(validateLite({ nested: { deep: true } }, schema).ok).toBe(true);
    expect(validateLite({ nested: { deep: 'yes' } }, schema).ok).toBe(false);
  });

  it('reports multiple errors', () => {
    const schema = { type: 'object' as const, required: ['a', 'b'] };
    const r = validateLite({}, schema);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
  });
});
