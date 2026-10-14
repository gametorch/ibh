import { describe, expect, it, vi, type Mock } from 'vitest';
import type { IbhManifest } from '@ibh/policy';
import { PolicyEngine } from '@ibh/policy';
import type { DomExecutor, Gatekeeper, ToolOutcome, Intent } from '@ibh/executor';
import { OpenRouterError, type ChatMessage, type ToolCall, type Usage } from './openrouter';
import type { OpenRouterClient } from './openrouter';
import { AgentSession, type AgentHooks } from './loop';

function makeManifest(policyOverrides: Partial<IbhManifest['policies']> = {}): IbhManifest {
  return {
    version: 1,
    site: { name: 'T', origin: 'https://example.com' },
    api: [
      { id: 'list', method: 'GET', path: '/api/list', tier: 'auto' },
      { id: 'rename', method: 'PATCH', path: '/api/t/:id', tier: 'session' },
    ],
    dom: [{ id: 'publish', action: 'click', selector: '#p', tier: 'auto' }],
    nav: [{ id: 'editor', route: '/sprites/:id', tier: 'auto' }],
    policies: {
      maxMutatingActionsPerSession: 5,
      maxStepsPerTurn: 12,
      maxToolCallsPerTurn: 8,
      maxTokensPerSession: 100_000,
      ...policyOverrides,
    },
    llm: { allowedModels: ['m'], defaultModel: 'm' },
  };
}

const toolCall = (name: string, args: unknown): ToolCall => ({
  id: `call_${name}_${Math.random().toString(36).slice(2)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

const usage = (total: number): Usage => ({ prompt_tokens: total, completion_tokens: 0, total_tokens: total });

function fakeGate(outcomes: Record<string, unknown> = {}) {
  const resolved: Intent[] = [];
  return {
    resolved,
    resolve: async (intent: Intent): Promise<ToolOutcome> => {
      resolved.push(intent);
      const key = intent.kind === 'builtin' ? intent.name : `${intent.kind}:${intent.capabilityId}`;
      const result = key in outcomes ? outcomes[key] : { done: true };
      return {
        ok: true,
        result,
        decision: 'allow',
        capabilityId: intent.kind === 'builtin' ? intent.name : intent.capabilityId,
        kind: intent.kind === 'builtin' ? 'builtin' : (intent.kind as 'api'),
      };
    },
  };
}

/** Snapshot whose url changes on every call — lets tests prove the loop
 * rebuilds page context per model call instead of reusing a stale one. */
function makeCountingDom() {
  let snapCount = 0;
  return {
    get count() {
      return snapCount;
    },
    snapshot: () => {
      snapCount += 1;
      return { url: `/x?snap=${snapCount}`, title: 'T', tree: `- button "A" #r1 (snap ${snapCount})`, refs: {} };
    },
  } as unknown as DomExecutor & { count: number };
}

interface Harness {
  session: AgentSession;
  gate: ReturnType<typeof fakeGate>;
  client: { calls: Array<{ messages?: ChatMessage[]; model?: string }>; chat: Mock };
  hooks: { assistant: string[]; toolStarts: Array<{ capabilityId: string; kind: string }>; toolEnds: ToolOutcome[] };
  dom: DomExecutor & { count: number };
}

function makeHarness(policyOverrides: Partial<IbhManifest['policies']> = {}): Harness {
  const manifest = makeManifest(policyOverrides);
  const gate = fakeGate();
  const hooks: Harness['hooks'] = { assistant: [], toolStarts: [], toolEnds: [] };
  const client = {
    calls: [] as Array<{ messages?: ChatMessage[]; model?: string }>,
    chat: vi.fn(),
  };
  const fakeDom = makeCountingDom();
  const session = new AgentSession({
    manifest,
    policy: new PolicyEngine(manifest),
    gate: gate as unknown as Gatekeeper,
    client: client as unknown as OpenRouterClient,
    dom: fakeDom,
    ledger: { append: vi.fn() } as unknown as import('@ibh/executor').AuditLedger,
    guide: 'guide text',
    hooks: {
      onAssistant: (t) => hooks.assistant.push(t),
      onToolStart: (i) => hooks.toolStarts.push(i),
      onToolEnd: (o) => hooks.toolEnds.push(o),
    } as AgentHooks,
  });
  return { session, gate, client, hooks, dom: fakeDom as DomExecutor & { count: number } };
}

describe('AgentSession (the gated loop)', () => {
  it('delivers a final answer and records history', async () => {
    const h = makeHarness();
    h.client.chat.mockImplementation(async (req: { messages?: ChatMessage[] }) => {
      h.client.calls.push({ messages: req.messages, model: 'm' });
      return { message: { role: 'assistant', content: 'hello!' }, usage: usage(10) };
    });
    const answer = await h.session.run('hi there');
    expect(answer).toBe('hello!');
    expect(h.hooks.assistant).toEqual(['hello!']);
    expect(h.session.history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.client.calls).toHaveLength(1);
  });

  it('sends attached images as multimodal user content and restores them in displayHistory', async () => {
    const h = makeHarness();
    h.client.chat.mockImplementation(async (req: { messages?: ChatMessage[] }) => {
      h.client.calls.push({ messages: req.messages, model: 'm' });
      return { message: { role: 'assistant', content: 'a cat' }, usage: usage(10) };
    });
    await h.session.run('what is this?', [{ url: 'data:image/png;base64,AAA', name: 'cat.png' }]);

    expect(h.session.history[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
    // the model call carries the multimodal content unchanged
    expect(h.client.calls[0]!.messages?.[1]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
    expect(h.session.displayHistory()).toEqual([
      { role: 'user', text: 'what is this?', images: ['data:image/png;base64,AAA'] },
      { role: 'assistant', text: 'a cat', images: [] },
    ]);
  });

  it('injects an attach_image result as a user message the model can see', async () => {
    const h = makeHarness();
    h.gate.resolve = async (intent): Promise<ToolOutcome> => ({
      ok: true,
      decision: 'allow',
      capabilityId: intent.kind === 'builtin' ? intent.name : intent.capabilityId,
      kind: 'builtin',
      result: { summary: 'attached image "art"', image: { url: 'data:image/png;base64,AAA', name: 'art' } },
    });
    let step = 0;
    h.client.chat.mockImplementation(async (req: { messages?: ChatMessage[] }) => {
      h.client.calls.push({ messages: req.messages });
      step += 1;
      if (step === 1) {
        return {
          message: { role: 'assistant', content: '', tool_calls: [toolCall('attach_image', { svg: '<svg/>' })] },
          usage: usage(10),
        };
      }
      return { message: { role: 'assistant', content: 'I can see it.' }, usage: usage(10) };
    });

    const answer = await h.session.run('look at the sprite');
    expect(answer).toBe('I can see it.');
    expect(h.session.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    const injected = h.session.history[3]!;
    expect(injected.content).toEqual([
      { type: 'text', text: '[attached image: art]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
    // the data URL must not leak into the tool observation text
    expect(h.session.history[2]!.content).not.toContain('data:image');
    // the model call after the attach carries the image
    const secondCall = h.client.calls[1]!.messages ?? [];
    expect(secondCall.some((m) => Array.isArray(m.content))).toBe(true);
  });

  it('executes tool calls, feeds results back, then answers', async () => {
    const h = makeHarness();
    let step = 0;
    h.client.chat.mockImplementation(async (req: { messages?: ChatMessage[] }) => {
      h.client.calls.push({ messages: req.messages, model: 'm' });
      step += 1;
      if (step === 1) {
        return {
          message: { role: 'assistant', content: '', tool_calls: [toolCall('api_list', { query: { q: '1' } })] },
          usage: usage(10),
        };
      }
      return { message: { role: 'assistant', content: 'found 3 sprites' }, usage: usage(10) };
    });

    const answer = await h.session.run('how many sprites?');
    expect(answer).toBe('found 3 sprites');
    expect(h.gate.resolved).toHaveLength(1);
    expect(h.gate.resolved[0]!).toEqual({
      kind: 'api',
      capabilityId: 'list',
      args: { path: undefined, query: { q: '1' }, body: undefined },
    });
    expect(h.hooks.toolStarts[0]).toEqual({ capabilityId: 'list', kind: 'api' });
    expect(h.hooks.toolEnds).toHaveLength(1);

    const roles = h.session.history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const toolMsg = h.session.history[2]!;
    if (toolMsg.role !== 'tool') throw new Error('expected tool message');
    expect(JSON.parse(typeof toolMsg.content === 'string' ? toolMsg.content : '{}')).toEqual({ done: true });
    // the second model call must include the tool result observation
    const secondCallMessages = h.client.calls[1]?.messages ?? [];
    expect(secondCallMessages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('maps dom, nav and analyze tool names to the right intents', async () => {
    const h = makeHarness();
    const script = [
      [toolCall('dom_publish', { ref: '#r3' })],
      [toolCall('nav_editor', { params: { id: '7' } })],
      [toolCall('analyze', { code: 'return 1', data: { x: 1 } })],
      [],
    ];
    let step = 0;
    h.client.chat.mockImplementation(async () => {
      step += 1;
      return {
        message: { role: 'assistant', content: '', tool_calls: script[Math.min(step - 1, 3)] },
        usage: usage(10),
      };
    });
    await h.session.run('do things');
    expect(h.gate.resolved[0]!).toMatchObject({ kind: 'dom', capabilityId: 'publish', args: { ref: '#r3' } });
    expect(h.gate.resolved[1]!).toMatchObject({ kind: 'nav', capabilityId: 'editor', args: { params: { id: '7' } } });
    expect(h.gate.resolved[2]!).toMatchObject({ kind: 'builtin', name: 'analyze', args: { code: 'return 1' } });
  });

  it('rejects unknown tools and bad JSON arguments as structured tool errors', async () => {
    const h = makeHarness();
    h.client.chat.mockImplementationOnce(async () => ({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          toolCall('api_nope', {}),
          { id: 'c2', type: 'function', function: { name: 'api_list', arguments: '{not json' } },
        ],
      },
      usage: usage(10),
    }));
    h.client.chat.mockResolvedValueOnce({ message: { role: 'assistant', content: 'ok' }, usage: usage(10) });
    await h.session.run('x');
    const payloads = h.session.history.filter((m) => m.role === 'tool').map((m) => JSON.parse(typeof m.content === 'string' ? m.content : '{}'));
    expect(payloads[0].error).toContain('unknown tool');
    expect(payloads[1].error).toContain('not valid JSON');
    expect(h.gate.resolved).toHaveLength(0);
  });

  it('stops at the per-turn step limit', async () => {
    const h = makeHarness({ maxStepsPerTurn: 2 });
    h.client.chat.mockResolvedValue({
      message: { role: 'assistant', content: '', tool_calls: [toolCall('api_list', {})] },
      usage: usage(10),
    });
    const answer = await h.session.run('loop forever');
    expect(answer).toContain('step limit');
  });

  it('enforces the per-turn tool-call budget with structured errors', async () => {
    const h = makeHarness({ maxToolCallsPerTurn: 1 });
    h.client.chat.mockResolvedValue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [toolCall('api_list', {}), toolCall('api_rename', { path: { id: '1' } })],
      },
      usage: usage(10),
    });
    await h.session.run('x');
    const payloads = h.session.history.filter((m) => m.role === 'tool').map((m) => JSON.parse(typeof m.content === 'string' ? m.content : '{}'));
    expect(payloads[0].done).toBe(true);
    expect(payloads[1].error).toContain('tool call budget exhausted');
    expect(h.gate.resolved).toHaveLength(1);
  });

  it('stops when the session token budget is exhausted', async () => {
    const h = makeHarness({ maxTokensPerSession: 45 });
    h.client.chat.mockResolvedValue({
      message: { role: 'assistant', content: '', tool_calls: [toolCall('api_list', {})] },
      usage: usage(20),
    });
    const answer = await h.session.run('spend tokens');
    expect(answer).toContain('token budget');
  });

  it('reports model errors as a notice', async () => {
    const h = makeHarness();
    h.client.chat.mockRejectedValue(new OpenRouterError('invalid OpenRouter API key (401)', 401));
    const answer = await h.session.run('hi');
    expect(answer).toContain('could not reach the model');
    expect(answer).toContain('invalid OpenRouter API key');
  });

  it('feeds denials back to the model as data', async () => {
    const h = makeHarness();
    let step = 0;
    h.gate.resolve = async (): Promise<ToolOutcome> => ({
      ok: false,
      error: 'capability "list" is denied by the site manifest',
      decision: 'deny',
      capabilityId: 'list',
      kind: 'api',
    });
    h.client.chat.mockImplementation(async () => {
      step += 1;
      if (step === 1) {
        return { message: { role: 'assistant', content: '', tool_calls: [toolCall('api_list', {})] }, usage: usage(10) };
      }
      return { message: { role: 'assistant', content: 'denied — telling the user why' }, usage: usage(10) };
    });
    const answer = await h.session.run('x');
    const toolMsg = h.session.history.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('denied');
    expect(answer).toBe('denied — telling the user why');
  });

  it('refuses concurrent runs', async () => {
    const h = makeHarness();
    let release: (v: unknown) => void = () => {};
    h.client.chat.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const first = h.session.run('one');
    await expect(h.session.run('two')).rejects.toThrow('already processing');
    release({ message: { role: 'assistant', content: 'one' }, usage: usage(10) });
    await first;
  });

  it('stop() aborts the in-flight model call and reports "Stopped by user."', async () => {
    const h = makeHarness();
    h.client.chat.mockImplementation((req: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new OpenRouterError('model request aborted', 408)));
      });
    });
    const pending = h.session.run('long question');
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    h.session.stop();
    expect(await pending).toBe('Stopped by user.');
  });

  it('clear() resets conversation history', async () => {
    const h = makeHarness();
    h.client.chat.mockResolvedValue({ message: { role: 'assistant', content: 'hey' }, usage: usage(5) });
    await h.session.run('hello');
    expect(h.session.history.length).toBe(2);
    h.session.clear();
    expect(h.session.history).toEqual([]);
  });

  it('always rebuilds the system prompt with a FRESH page snapshot before each call', async () => {
    const h = makeHarness();
    let step = 0;
    h.client.chat.mockImplementation(async (req?: { messages?: ChatMessage[] }) => {
      const messages = req?.messages ?? [];
      h.client.calls.push({ messages, model: 'm' });
      step += 1;
      if (step === 1) {
        return { message: { role: 'assistant', content: '', tool_calls: [toolCall('page_snapshot', {})] }, usage: usage(10) };
      }
      return { message: { role: 'assistant', content: 'done' }, usage: usage(10) };
    });
    await h.session.run('look around');
    const systems = h.client.calls.map((c) => c.messages?.[0]).filter((m) => m?.role === 'system');
    expect(systems).toHaveLength(2);
    // the snapshot counter increments per rebuild — call 1 must have seen snap 1,
    // call 2 must have seen snap 2 (a stale/cached context would repeat snap 1)
    expect(systems[0]!.content).toContain('url: /x?snap=1');
    expect(systems[1]!.content).toContain('url: /x?snap=2');
    expect(h.dom.count).toBe(2);
  });
});
