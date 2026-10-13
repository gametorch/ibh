// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionPersistence } from './persistence';

const KEY = 'ibh:session';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('createSessionPersistence (opt-in localStorage persistence)', () => {
  it('round-trips history, audit and approvals', () => {
    const p = createSessionPersistence(KEY);
    p.save({
      history: [{ role: 'user', content: 'hi' }],
      audit: [{ id: 1, ts: 10, kind: 'llm', decision: 'allow', summary: 's' }],
      approved: ['create'],
    });
    const loaded = p.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.history).toEqual([{ role: 'user', content: 'hi' }]);
    expect(loaded?.audit[0]?.summary).toBe('s');
    expect(loaded?.approved).toEqual(['create']);
  });

  it('returns null when nothing is stored', () => {
    expect(createSessionPersistence(KEY).load()).toBeNull();
  });

  it('ignores corrupt JSON and unknown versions instead of throwing', () => {
    const p = createSessionPersistence(KEY);
    localStorage.setItem(KEY, '{not json');
    expect(p.load()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ v: 2, history: [], audit: [] }));
    expect(p.load()).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ v: 1, history: 'nope', audit: [] }));
    expect(p.load()).toBeNull();
  });

  it('clear removes the stored session', () => {
    const p = createSessionPersistence(KEY);
    p.save({ history: [], audit: [], approved: [] });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    p.clear();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
