// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AnalyzeAdapter } from './adapters/analyze';

describe('AnalyzeAdapter guards', () => {
  const adapter = new AnalyzeAdapter();

  it('rejects empty code', async () => {
    await expect(adapter.run('', {})).rejects.toThrow('non-empty string');
  });

  it('rejects oversized code', async () => {
    const big = 'x'.repeat(20_001);
    await expect(adapter.run(big, {})).rejects.toThrow('exceeds');
  });

  it('rejects non-JSON-serializable data', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(adapter.run('return data;', circular)).rejects.toThrow('JSON-serializable');
  });

  // NOTE: the happy path executes inside a real iframe with script execution
  // (opaque origin + CSP default-src 'none'), which jsdom does not run. The
  // sandbox guarantees are enforced by the browser there, not by this suite.
  // Manual verification: examples/gametorch-demo -> ask ibh to munge data.
});
