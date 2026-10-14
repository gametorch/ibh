/**
 * A tiny, dependency-free, XSS-safe markdown renderer for assistant messages.
 *
 * Safety model: the ENTIRE input is HTML-escaped first, then we only ever emit
 * our own tags. Raw HTML from the model can therefore never become markup, and
 * link hrefs are restricted to http(s)/mailto/relative URLs (no `javascript:`).
 * Integrators can replace this entirely via `ui.markdown.render`.
 */

export type MarkdownRenderer = (text: string) => string | Node;

export type MarkdownConfig = boolean | { enabled?: boolean; render?: MarkdownRenderer };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/gu, (c) => ESCAPES[c] ?? c);
}

/** Only allow safe link targets (everything is already HTML-escaped). */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;
  return trimmed;
}

const PLACEHOLDER = '\uE000';

/** Inline formatting. Assumes `text` is already HTML-escaped. */
function inline(text: string): string {
  const codes: string[] = [];
  let out = text.replaceAll(/`([^`]+)`/gu, (_m, code: string) => {
    codes.push(code);
    return `${PLACEHOLDER}${codes.length - 1}${PLACEHOLDER}`;
  });
  out = out.replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_m, label: string, url: string) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  out = out.replaceAll(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
  out = out.replaceAll(/__([^_]+)__/gu, '<strong>$1</strong>');
  out = out.replaceAll(/(^|[^*])\*([^*\s][^*]*)\*/gu, '$1<em>$2</em>');
  out = out.replaceAll(/(^|[^_\w])_([^_\s][^_]*)_/gu, '$1<em>$2</em>');
  out = out.replaceAll(/~~([^~]+)~~/gu, '<del>$1</del>');
  return out.replaceAll(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'gu'), (_m, i: string) => {
    return `<code>${codes[Number(i)] ?? ''}</code>`;
  });
}

const BLOCK_START = /^(#{1,6})\s|^```|^\s*&gt;|^\s*([-*+]|\d+\.)\s/u;

/** Render markdown to a safe HTML string. */
export function renderMarkdown(source: string): string {
  const text = escapeHtml(source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\u0000', ''));
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = /^```(.*)$/u.exec(line);
    if (fence) {
      const lang = (fence[1] ?? '').trim().replaceAll(/[^\w-]/gu, '');
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/u.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // consume the closing fence (or fall off the end)
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${code.join('\n')}</code></pre>`);
      continue;
    }

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*&gt;/u.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*&gt;/u.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*&gt;\s?/u, ''));
        i += 1;
      }
      out.push(`<blockquote>${inline(quote.join('\n')).replaceAll('\n', '<br>')}</blockquote>`);
      continue;
    }

    const item = /^\s*([-*+]|\d+\.)\s+/u.exec(line);
    if (item) {
      const ordered = /\d+\./u.test(item[1] ?? '');
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+\.)\s+(.*)$/u.exec(lines[i] ?? '');
        if (!m || /\d+\./u.test(m[1] ?? '') !== ordered) break;
        items.push(`<li>${inline(m[2] ?? '')}</li>`);
        i += 1;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim().length > 0 && !BLOCK_START.test(lines[i] ?? '')) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    out.push(`<p>${inline(para.join('\n')).replaceAll('\n', '<br>')}</p>`);
  }

  return out.join('\n');
}

/** Turn the `ui.markdown` config into a renderer (or null when disabled). */
export function resolveMarkdownRenderer(config?: MarkdownConfig): MarkdownRenderer | null {
  if (config === false) return null;
  if (config === undefined || config === true) return renderMarkdown;
  if (config.enabled === false) return null;
  return config.render ?? renderMarkdown;
}
