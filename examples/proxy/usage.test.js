import { describe, expect, it, vi } from 'vitest';
import usage from './usage.js';

const { extractUsage, usageHeaders, recordUsage } = usage;

describe('OpenRouter usage accounting', () => {
  it('extracts cost + tokens from a chat completion', () => {
    const record = extractUsage({
      id: 'gen-123',
      model: 'openai/gpt-6-luna',
      usage: {
        prompt_tokens: 194,
        completion_tokens: 2,
        total_tokens: 196,
        cost: 0.95,
        cost_details: { upstream_inference_cost: 0.19 },
        prompt_tokens_details: { cached_tokens: 100 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });
    expect(record).toEqual({
      generationId: 'gen-123',
      model: 'openai/gpt-6-luna',
      cost: 0.95,
      upstreamInferenceCost: 0.19,
      promptTokens: 194,
      completionTokens: 2,
      totalTokens: 196,
      cachedTokens: 100,
      reasoningTokens: 0,
      audioSeconds: null,
    });
  });

  it('extracts the STT usage shape (input/output tokens + seconds)', () => {
    const record = extractUsage(
      {
        text: 'hello',
        usage: { seconds: 9.2, total_tokens: 113, input_tokens: 83, output_tokens: 30, cost: 0.000508 },
      },
      'gen-stt-1'
    );
    expect(record).toEqual({
      generationId: 'gen-stt-1',
      model: null,
      cost: 0.000508,
      upstreamInferenceCost: null,
      promptTokens: 83,
      completionTokens: 30,
      totalTokens: 113,
      cachedTokens: null,
      reasoningTokens: null,
      audioSeconds: 9.2,
    });
  });

  it('prefers the body id over the header when both exist', () => {
    expect(extractUsage({ id: 'from-body', usage: {} }, 'from-header').generationId).toBe('from-body');
  });

  it('returns null when there is no usage object', () => {
    expect(extractUsage({ choices: [] })).toBeNull();
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage('nope')).toBeNull();
  });

  it('maps known fields to X-Ibh-* headers', () => {
    const headers = usageHeaders(
      extractUsage({ id: 'g', usage: { cost: 0.5, total_tokens: 10, seconds: 2.5 } })
    );
    expect(headers).toEqual({
      'x-ibh-cost': '0.5',
      'x-ibh-total-tokens': '10',
      'x-ibh-audio-seconds': '2.5',
      'x-ibh-generation-id': 'g',
    });
  });

  it('omits headers for absent fields and null usage', () => {
    expect(usageHeaders(null)).toEqual({});
    expect(usageHeaders(extractUsage({ usage: { cost: 1 } }))).toEqual({ 'x-ibh-cost': '1' });
  });

  it('logs one structured, machine-readable line per record', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    recordUsage({ user: 'u1', cost: 0.95 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0];
    expect(line.startsWith('ibh.usage ')).toBe(true);
    expect(JSON.parse(line.slice('ibh.usage '.length))).toEqual({ user: 'u1', cost: 0.95 });
    spy.mockRestore();
  });
});
