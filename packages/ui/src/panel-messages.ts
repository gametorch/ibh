import { el } from './el';

/** The chat surface: messages, chips, notices, status line and scroll. */
export interface ChatSurface {
  scroll(): void;
  removeEmpty(): void;
  addMessage(text: string, cls: string, images?: readonly string[]): HTMLElement;
  addChip(text: string): HTMLElement;
  addNotice(text: string): HTMLElement;
  /** Transient status line; managed by the tool flow. */
  showStatus(text: string): void;
  clearStatus(): void;
  setPendingChip(chip: HTMLElement | null): void;
  takePendingChip(): HTMLElement | null;
  clear(): void;
  restoreEmpty(): void;
}

export function createChatSurface(deps: { chatView: HTMLElement; empty: HTMLElement }): ChatSurface {
  const { chatView, empty } = deps;
  let statusLine: HTMLElement | null = null;
  let pendingChip: HTMLElement | null = null;

  const scroll = () => {
    chatView.scrollTop = chatView.scrollHeight;
  };
  const removeEmpty = () => {
    empty.remove();
  };

  return {
    scroll,
    removeEmpty,
    addMessage(text: string, cls: string, images?: readonly string[]): HTMLElement {
    removeEmpty();
    const m = el('div', `msg ${cls}`);
    if (images && images.length > 0) {
      const strip = el('div', 'msg-images');
      for (const url of images) {
        const img = el('img', 'msg-img');
        img.src = url;
        img.alt = 'attached image';
        img.loading = 'lazy';
        strip.append(img);
      }
      m.append(strip);
    }
    if (text.trim().length > 0 || !images || images.length === 0) {
      const t = el('div', 'msg-text');
      t.textContent = text;
      m.append(t);
    }
    chatView.append(m);
    scroll();
    return m;
  },
    addChip(text: string): HTMLElement {
      removeEmpty();
      const c = el('div', 'tool-chip');
      c.textContent = text;
      chatView.append(c);
      scroll();
      return c;
    },
    addNotice(text: string): HTMLElement {
      removeEmpty();
      const n = el('div', 'msg notice');
      n.textContent = text;
      chatView.append(n);
      scroll();
      return n;
    },
    showStatus(text: string): void {
      if (!statusLine) {
        statusLine = el('div', 'status-line');
        chatView.append(statusLine);
      }
      statusLine.textContent = text;
      scroll();
    },
    clearStatus(): void {
      statusLine?.remove();
      statusLine = null;
    },
    setPendingChip(chip: HTMLElement | null): void {
      pendingChip = chip;
    },
    takePendingChip(): HTMLElement | null {
      const c = pendingChip;
      pendingChip = null;
      return c;
    },
    clear(): void {
      chatView.textContent = '';
      statusLine = null;
      pendingChip = null;
    },
    restoreEmpty(): void {
      chatView.append(empty);
    },
  };
}
