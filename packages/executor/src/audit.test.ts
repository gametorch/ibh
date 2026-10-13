import { describe, expect, it } from 'vitest';
import { AuditLedger } from './audit';

describe('AuditLedger', () => {
  it('assigns monotonically increasing ids and timestamps', () => {
    const l = new AuditLedger();
    const a = l.append({ kind: 'api', decision: 'allow', summary: 'GET /a' });
    const b = l.append({ kind: 'dom', decision: 'deny', summary: 'click /b' });
    expect(b.id).toBe(a.id + 1);
    expect(b.ts).toBeGreaterThanOrEqual(a.ts);
    expect(l.getEntries()).toHaveLength(2);
  });

  it('notifies subscribers and supports unsubscribe', () => {
    const l = new AuditLedger();
    const seen: string[] = [];
    const unsub = l.subscribe((e) => seen.push(e.summary));
    l.append({ kind: 'api', decision: 'allow', summary: 'one' });
    unsub();
    l.append({ kind: 'api', decision: 'allow', summary: 'two' });
    expect(seen).toEqual(['one']);
  });

  it('caps the ledger at 500 entries, dropping the oldest', () => {
    const l = new AuditLedger();
    for (let i = 0; i < 600; i++) l.append({ kind: 'llm', decision: 'allow', summary: `e${i}` });
    const entries = l.getEntries();
    expect(entries).toHaveLength(500);
    expect(entries[0]?.summary).toBe('e100');
    expect(entries[499]?.summary).toBe('e599');
  });

  it('subscriber errors never break the ledger', () => {
    const l = new AuditLedger();
    l.subscribe(() => {
      throw new Error('bad subscriber');
    });
    expect(() => l.append({ kind: 'api', decision: 'allow', summary: 'still works' })).not.toThrow();
    expect(l.getEntries()).toHaveLength(1);
  });
});
