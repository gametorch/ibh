import { describe, expect, it } from 'vitest';
import { renderApproveQuestion } from './approve';
import type { ApproveContext } from '@ibh/policy';

const ctx: ApproveContext = {
  kind: 'api',
  capabilityId: 'sprites_create',
  method: 'POST',
  path: '/api/sprites',
  body: { name: 'Sundown Sheriff', tags: ['western', 'sunset'] },
};

describe('renderApproveQuestion', () => {
  it('interpolates string placeholders', () => {
    expect(renderApproveQuestion('Create a sprite named "{{body.name}}"?', ctx)).toBe(
      'Create a sprite named "Sundown Sheriff"?'
    );
  });

  it('stringifies numbers, booleans and objects; missing paths become empty', () => {
    const t = 'm={{method}} p={{path}} tags={{body.tags}} nope=[{{missing.deep}}]';
    expect(renderApproveQuestion(t, ctx)).toBe(
      'm=POST p=/api/sprites tags=["western","sunset"] nope=[]'
    );
  });

  it('supports function specs', () => {
    const fn = (c: ApproveContext) => `${c.method} ${c.path}?`;
    expect(renderApproveQuestion(fn, ctx)).toBe('POST /api/sprites?');
  });

  it('resolves path params via ctx.params (not the interpolated path string)', () => {
    const withParams: ApproveContext = {
      ...ctx,
      path: '/api/sprites/3/generate',
      params: { id: '3' },
    };
    expect(renderApproveQuestion('Generate art for sprite #{{params.id}}?', withParams)).toBe(
      'Generate art for sprite #3?'
    );
    // params.id must not silently resolve through the `path` string
    expect(renderApproveQuestion('Generate art for sprite #{{path.id}}?', withParams)).toBe(
      'Generate art for sprite #?'
    );
  });

  it('recovers from a throwing function spec', () => {
    const fn = () => {
      throw new Error('boom');
    };
    expect(renderApproveQuestion(fn, ctx)).toBe('(boom)');
  });

  it('renders dom contexts', () => {
    const domCtx: ApproveContext = { kind: 'dom', capabilityId: 'editor_name_fill', action: 'fill', value: 'Ember Fox', element: 'textbox "Name"' };
    expect(renderApproveQuestion('Type "{{value}}" into {{element}}?', domCtx)).toBe(
      'Type "Ember Fox" into textbox "Name"?'
    );
  });
});
