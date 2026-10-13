import type { DomExecutor } from '@ibh/executor';

/** Compact page context block for the system prompt. Rebuilt before every model call. */
export function buildPageContext(dom: DomExecutor): string {
  const snap = dom.snapshot();
  return `url: ${snap.url}
title: ${snap.title}

${snap.tree}`;
}
