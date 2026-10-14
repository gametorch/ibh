import { describe, expect, it } from 'vitest';
import { renderMarkdown, resolveMarkdownRenderer } from './markdown';

describe('renderMarkdown', () => {
  it('renders headings, bold, italic, code and lists', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *italic* and `code`.\n\n- a\n- b');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders fenced code blocks without interpreting their contents', () => {
    expect(renderMarkdown('```js\nconst x = **1**;\n```')).toBe(
      '<pre><code class="language-js">const x = **1**;</code></pre>'
    );
  });

  it('escapes raw HTML (no XSS)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes HTML inside code spans and blocks', () => {
    expect(renderMarkdown('`<b>x</b>`')).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>');
    expect(renderMarkdown('```\n<script>alert(1)</script>\n```')).toContain('&lt;script&gt;');
  });

  it('allows safe links and rejects javascript: URLs', () => {
    expect(renderMarkdown('[x](https://example.com)')).toContain('<a href="https://example.com"');
    const bad = renderMarkdown('[x](javascript:alert(1))');
    expect(bad).not.toContain('<a ');
    expect(bad).toContain('x');
  });

  it('renders blockquotes, ordered lists and rules', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote>quoted</blockquote>');
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(renderMarkdown('---')).toContain('<hr>');
  });
});

describe('resolveMarkdownRenderer', () => {
  it('defaults to the built-in renderer', () => {
    expect(resolveMarkdownRenderer()).toBe(renderMarkdown);
    expect(resolveMarkdownRenderer(true)).toBe(renderMarkdown);
  });

  it('returns null when disabled', () => {
    expect(resolveMarkdownRenderer(false)).toBeNull();
    expect(resolveMarkdownRenderer({ enabled: false })).toBeNull();
  });

  it('uses a custom renderer', () => {
    const custom = (text: string): string => `CUSTOM:${text}`;
    expect(resolveMarkdownRenderer({ render: custom })).toBe(custom);
  });
});
