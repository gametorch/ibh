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

/** A text part of a multimodal message (OpenAI/OpenRouter content-parts shape). */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** An image part. `url` is a `data:` URL (base64) or an `https:` URL. */
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ContentPart = TextContentPart | ImageContentPart;

/** A message's content: plain text, or multimodal content parts. */
export type MessageContent = string | ContentPart[] | null;

/** An image the user attached to a message. */
export interface ImageAttachment {
  /** `data:` URL (base64) or an `https:` URL the model can fetch. */
  url: string;
  /** Optional label (e.g. filename), shown in the panel. */
  name?: string;
  /** Optional MIME type, e.g. `image/png`. */
  mime?: string;
  /** Optional size in bytes. */
  size?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * Build the content for a user message from text + attached images. With no
 * images the content stays a plain string (unchanged behavior); with images it
 * becomes the multimodal parts array OpenRouter expects.
 */
export function buildUserContent(text: string, images: readonly ImageAttachment[] = []): MessageContent {
  if (images.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text.trim().length > 0) parts.push({ type: 'text', text });
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.url } });
  }
  return parts;
}

/** Split message content into displayable text and image URLs (for the panel). */
export function splitContent(content: MessageContent): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  let text = '';
  const images: string[] = [];
  for (const part of content) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'image_url') images.push(part.image_url.url);
  }
  return { text, images };
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
        // Proxy mode (no key): same-origin, so the session cookie authenticates
        // the request -> 'include'. BYO-key mode calls openrouter.ai cross-origin,
        // which answers `Access-Control-Allow-Origin: *`; a credentialed request
        // against a wildcard origin is blocked by the browser, so omit cookies
        // there (the Authorization header carries the key).
        credentials: this.opts.apiKey ? 'omit' : 'include',
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
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        // text is ~4 chars/token; an image is billed by tiles, not bytes —
        // approximate at ~1000 tokens so a data URL doesn't distort the estimate.
        chars += part.type === 'text' ? part.text.length : 4000;
      }
    }
  }
  return Math.ceil(chars / 4);
}
