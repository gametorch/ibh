import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, OpenRouterError, type ToolDef } from './openrouter';

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];
const TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'api_list', description: 'd', parameters: { type: 'object' } } },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterClient', () => {
  it('posts to the chat-completions endpoint with auth header, model and tools', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OpenRouterClient({ apiKey: 'sk-test', title: 'ibh-test' });
    const res = await client.chat({ model: 'openai/gpt-6-luna', messages: MESSAGES, tools: TOOLS });

    expect(res.message.content).toBe('hello');
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test', 'X-Title': 'ibh-test' });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.messages).toEqual(MESSAGES);
    expect(body.tools).toEqual(TOOLS);
  });

  it('estimates usage when OpenRouter omits it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { role: 'assistant', content: 'abcd' } }] }))
    );
    const res = await new OpenRouterClient({ apiKey: 'k' }).chat({ model: 'm', messages: MESSAGES, tools: TOOLS });
    // prompt estimate: 'hi' -> ceil(2/4) = 1; completion: 'abcd' -> 1
    expect(res.usage.total_tokens).toBe(2);
    expect(res.usage.prompt_tokens).toBe(1);
    expect(res.usage.completion_tokens).toBe(1);
  });

  it('maps auth, credits, rate-limit and server errors to friendly messages', async () => {
    const cases: Array<[number, object, RegExp]> = [
      [401, { error: { message: 'bad key' } }, /invalid OpenRouter API key \(401\): bad key/u],
      [402, {}, /insufficient credits \(402\)/u],
      [429, {}, /rate limited by OpenRouter \(429\)/u],
      [500, {}, /OpenRouter request failed \(500\)/u],
    ];
    for (const [status, payload, match] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload, status)));
      await expect(
        new OpenRouterClient({ apiKey: 'k' }).chat({ model: 'm', messages: MESSAGES, tools: TOOLS })
      ).rejects.toThrow(match);
    }
  });

  it('omits the Authorization header in proxy mode (no key) and sends session cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenRouterClient({ apiKey: undefined, baseUrl: 'https://mysite.com/api/ibh-llm' }).chat({
      model: 'm',
      messages: MESSAGES,
      tools: TOOLS,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mysite.com/api/ibh-llm/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect((init as RequestInit).credentials).toBe('include');
  });

  it('applies integrator-supplied extra headers (e.g. proxy gateway auth)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { role: 'assistant', content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenRouterClient({ apiKey: undefined, baseUrl: 'https://gateway.example', headers: { 'X-Gateway-Token': 't' } }).chat({
      model: 'm',
      messages: MESSAGES,
      tools: TOOLS,
    });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Gateway-Token']).toBe('t');
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws on missing message content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [] })));
    await expect(
      new OpenRouterClient({ apiKey: 'k' }).chat({ model: 'm', messages: MESSAGES, tools: TOOLS })
    ).rejects.toThrow('OpenRouter returned no message content');
  });

  it('wraps network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      new OpenRouterClient({ apiKey: 'k' }).chat({ model: 'm', messages: MESSAGES, tools: TOOLS })
    ).rejects.toThrow('network error talking to OpenRouter: offline');
  });

  it('aborts when the timeout fires', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      })
    );
    const client = new OpenRouterClient({ apiKey: 'k', timeoutMs: 20 });
    await expect(client.chat({ model: 'm', messages: MESSAGES, tools: TOOLS })).rejects.toThrow(
      'model request aborted'
    );
  });

  it('supports tool-call responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'api_list', arguments: '{}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      )
    );
    const res = await new OpenRouterClient({ apiKey: 'k' }).chat({ model: 'm', messages: MESSAGES, tools: TOOLS });
    expect(res.message.tool_calls?.[0]?.function.name).toBe('api_list');
  });

  it('is an Error subclass', () => {
    expect(new OpenRouterError('x')).toBeInstanceOf(Error);
  });
});
