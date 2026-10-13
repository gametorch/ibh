/**
 * Minimal OpenRouter chat-completions client (non-streaming, tool calling).
 * The integrator supplies their own API key; the manifest's llm policy decides
 * which models may be used.
 */

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

function friendlyStatus(status: number, body: unknown): string {
  const detail =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error?: { message?: string } }).error?.message
      : undefined;
  switch (status) {
    case 401:
      return `invalid OpenRouter API key (401)${detail ? `: ${detail}` : ''}`;
    case 402:
      return `OpenRouter account has insufficient credits (402)${detail ? `: ${detail}` : ''}`;
    case 408:
      return `model request timed out (408)${detail ? `: ${detail}` : ''}`;
    case 429:
      return `rate limited by OpenRouter (429)${detail ? `: ${detail}` : ''}`;
    default:
      return `OpenRouter request failed (${status})${detail ? `: ${detail}` : ''}`;
  }
}

export class OpenRouterClient {
  constructor(
    private readonly opts: {
      /** OpenRouter key for BYO mode. Omit when requests go through the integrator's proxy. */
      apiKey?: string;
      baseUrl?: string;
      title?: string;
      timeoutMs?: number;
      /** Extra headers for the request (e.g. auth for a custom proxy gateway). */
      headers?: Record<string, string>;
    }
  ) {}

  async chat(request: {
    model: string;
    messages: ChatMessage[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }): Promise<{ message: ChatMessage; usage: Usage }> {
    const base = this.opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    if (request.signal) {
      request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Title': this.opts.title ?? 'ibh',
      ...this.opts.headers,
    };
    // BYO mode only: the integrator's proxy authenticates via cookies/its own headers.
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    if (typeof location !== 'undefined' && location.origin.startsWith('http')) {
      headers['HTTP-Referer'] = location.origin;
    }

    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        credentials: 'include',
        headers,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          tools: request.tools.length > 0 ? request.tools : undefined,
        }),
      });
    } catch (e) {
      if (controller.signal.aborted) throw new OpenRouterError('model request aborted', 408);
      throw new OpenRouterError(`network error talking to OpenRouter: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }

    if (!res.ok) {
      throw new OpenRouterError(friendlyStatus(res.status, body), res.status);
    }

    const parsed = body as {
      choices?: Array<{ message?: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = parsed.choices?.[0]?.message;
    if (!message) {
      throw new OpenRouterError('OpenRouter returned no message content');
    }

    const prompt = parsed.usage?.prompt_tokens ?? estimateTokens(request.messages);
    const completion =
      parsed.usage?.completion_tokens ?? estimateTokens([message as unknown as ChatMessage]);
    const usage: Usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: parsed.usage?.total_tokens ?? prompt + completion,
    };
    return { message, usage };
  }
}

function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  return Math.ceil(chars / 4);
}
