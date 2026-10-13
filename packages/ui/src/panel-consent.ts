import type { ConsentRequest } from '@ibh/core';
import { el } from './el';

interface PendingConsent {
  resolve: (v: boolean) => void;
  card: HTMLElement;
  note: HTMLElement;
}

export interface ConsentFlow {
  requestConsent(req: ConsentRequest): Promise<boolean>;
  /** Used on destroy: every pending card is resolved as denied. */
  denyAllPending(): void;
}

/**
 * Renders consent cards for gated actions. Integrator-authored approval copy
 * (`req.question`) replaces the technical preview. Everything dynamic is
 * inserted with textContent — never innerHTML for untrusted strings.
 */
export function createConsentFlow(deps: {
  chatView: HTMLElement;
  ensureOpen(): void;
  removeEmpty(): void;
  addChip(text: string): void;
  scroll(): void;
}): ConsentFlow {
  const { chatView, ensureOpen, removeEmpty, addChip, scroll } = deps;
  const pending = new Map<ConsentRequest, PendingConsent>();

  const finish = (req: ConsentRequest, approved: boolean) => {
    const entry = pending.get(req);
    if (!entry) return;
    pending.delete(req);
    entry.resolve(approved);
    entry.card.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    entry.note.textContent = approved ? '→ approved' : '→ denied';
    if (approved) {
      addChip(`✓ approved: ${req.capabilityId}`);
    }
  };

  return {
    requestConsent(req: ConsentRequest): Promise<boolean> {
      ensureOpen();
      removeEmpty();

      const card = el('div', 'confirm-card');
      const actions = el('div', 'confirm-actions');
      const deny = el('button');
      deny.textContent = 'Deny';
      const approve = el('button', 'approve');
      approve.textContent = 'Approve';
      actions.append(deny, approve);
      const note = el('div', 'confirm-resolved');

      if (req.question) {
        // Integrator-authored approval copy replaces the technical preview.
        const question = el('div', 'confirm-question');
        question.textContent = req.question;
        card.append(question, actions, note);
      } else {
        const title = el('div', 'confirm-title');
        title.textContent = 'ibh wants to:';
        const summary = el('div', 'confirm-summary');
        summary.textContent = req.actionSummary;
        const details = el('ul', 'confirm-details');
        for (const line of req.detailLines) {
          const li = el('li');
          li.textContent = line;
          details.append(li);
        }
        card.append(title, summary, details, actions, note);
      }
      chatView.append(card);
      scroll();

      return new Promise<boolean>((resolve) => {
        pending.set(req, { resolve, card, note });
        approve.addEventListener('click', () => finish(req, true));
        deny.addEventListener('click', () => finish(req, false));
      });
    },

    denyAllPending(): void {
      for (const [, entry] of pending) entry.resolve(false);
      pending.clear();
    },
  };
}
