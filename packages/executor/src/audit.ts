/**
 * The audit ledger records every decision the harness makes — allowed, confirmed,
 * denied, failed. There is deliberately NO undo mechanism; see docs/non-goals.md.
 */

export type AuditKind = 'api' | 'dom' | 'nav' | 'analyze' | 'page_snapshot' | 'llm';

export type AuditDecision = 'allow' | 'session' | 'confirm' | 'deny' | 'consent-denied' | 'error';

export interface AuditEntry {
  id: number;
  ts: number;
  kind: AuditKind;
  decision: AuditDecision;
  /** One-line human-readable summary. */
  summary: string;
  detail?: Record<string, unknown>;
}

const MAX_ENTRIES = 500;

export class AuditLedger {
  private entries: AuditEntry[] = [];
  private nextId = 1;
  private subscribers = new Set<(e: AuditEntry) => void>();

  append(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
    const entry: AuditEntry = { ...e, id: this.nextId++, ts: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch {
        /* subscriber errors must never break the ledger */
      }
    }
    return entry;
  }

  getEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  subscribe(cb: (e: AuditEntry) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}
