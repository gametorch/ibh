import type { AuditEntry } from '@ibh/executor';
import type { ChatMessage } from '@ibh/core';

/**
 * Opt-in localStorage persistence. Off by default: history, the audit log and
 * session approvals live in memory and a refresh starts clean. When the host
 * sets `persistence.enabled`, ibh writes them to localStorage and restores them
 * on the next init. Budgets, rate limits and token spend are deliberately NOT
 * persisted (a refresh resets them).
 */
export interface PersistedSession {
  v: 1;
  history: ChatMessage[];
  audit: AuditEntry[];
  approved: string[];
}

export interface SessionState {
  history: readonly ChatMessage[];
  audit: readonly AuditEntry[];
  approved: readonly string[];
}

export interface SessionPersistence {
  load(): PersistedSession | null;
  save(state: SessionState): void;
  clear(): void;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage can throw in sandboxed iframes / disabled cookies
  }
}

export function createSessionPersistence(key: string): SessionPersistence {
  return {
    load(): PersistedSession | null {
      const s = storage();
      if (!s) return null;
      try {
        const raw = s.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedSession>;
        if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.history) || !Array.isArray(parsed.audit)) {
          return null;
        }
        return {
          v: 1,
          history: parsed.history as ChatMessage[],
          audit: parsed.audit as AuditEntry[],
          approved: Array.isArray(parsed.approved) ? parsed.approved : [],
        };
      } catch {
        return null; // corrupt / unreadable state never blocks startup
      }
    },
    save(state: SessionState): void {
      const s = storage();
      if (!s) return;
      try {
        s.setItem(key, JSON.stringify({ v: 1, ...state }));
      } catch {
        /* quota exceeded or private mode — persistence is best-effort */
      }
    },
    clear(): void {
      const s = storage();
      if (!s) return;
      try {
        s.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
