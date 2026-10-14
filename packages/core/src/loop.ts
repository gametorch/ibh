import type { IbhManifest, PolicyEngine } from '@ibh/policy';
import type { AuditLedger, DomExecutor, Gatekeeper, ToolOutcome } from '@ibh/executor';
import { intentKindToCapabilityKind, capabilityIdOfIntent } from '@ibh/executor';
import type { Intent } from '@ibh/executor';
import type { OpenRouterClient, ChatMessage, ToolCall, ImageAttachment } from './openrouter';
import { buildUserContent, splitContent } from './openrouter';
import { buildSystemPrompt, buildToolDefs, resolveGuide } from './prompt';
import { buildPageContext } from './context';
import type { ToolMapping } from './prompt';

export interface AgentHooks {
  onStatus?(text: string): void;
  onAssistant?(text: string): void;
  onToolStart?(info: { capabilityId: string; kind: string }): void;
  onToolEnd?(outcome: ToolOutcome): void;
}

export interface AgentSessionDeps {
  manifest: IbhManifest;
  policy: PolicyEngine;
  gate: Gatekeeper;
  client: OpenRouterClient;
  dom: DomExecutor;
  ledger: AuditLedger;
  guide?: string | (() => string);
  hooks?: AgentHooks;
}

interface IntentBuildResult {
  intent?: Intent;
  error?: string;
}

function buildIntentFromToolCall(
  tc: ToolCall,
  toolMap: Map<string, ToolMapping>
): IntentBuildResult {
  const mapping = toolMap.get(tc.function.name);
  if (!mapping) return { error: `unknown tool "${tc.function.name}" — only registered tools are callable` };

  let args: unknown = {};
  if (tc.function.arguments && tc.function.arguments.trim().length > 0) {
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return { error: `tool call arguments are not valid JSON: ${tc.function.arguments.slice(0, 200)}` };
    }
  }
  const obj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;

  switch (mapping.kind) {
    case 'api':
      return {
        intent: {
          kind: 'api',
          capabilityId: mapping.capabilityId,
          args: {
            path: (obj.path as Record<string, string> | undefined) ?? undefined,
            query: (obj.query as Record<string, unknown> | undefined) ?? undefined,
            body: obj.body,
          },
        },
      };
    case 'dom':
      return {
        intent: {
          kind: 'dom',
          capabilityId: mapping.capabilityId,
          args: {
            ref: typeof obj.ref === 'string' ? obj.ref : undefined,
            value: typeof obj.value === 'string' ? obj.value : undefined,
          },
        },
      };
    case 'nav':
      return {
        intent: {
          kind: 'nav',
          capabilityId: mapping.capabilityId,
          args: { params: (obj.params as Record<string, string> | undefined) ?? undefined },
        },
      };
    case 'builtin':
      if (mapping.capabilityId === 'page_snapshot') {
        return { intent: { kind: 'builtin', name: 'page_snapshot' } };
      }
      if (mapping.capabilityId === 'attach_image') {
        const detail =
          obj.detail === 'auto' || obj.detail === 'low' || obj.detail === 'high' ? obj.detail : undefined;
        return {
          intent: {
            kind: 'builtin',
            name: 'attach_image',
            args: {
              url: typeof obj.url === 'string' ? obj.url : undefined,
              selector: typeof obj.selector === 'string' ? obj.selector : undefined,
              ref: typeof obj.ref === 'string' ? obj.ref : undefined,
              svg: typeof obj.svg === 'string' ? obj.svg : undefined,
              detail,
              label: typeof obj.label === 'string' ? obj.label : undefined,
            },
          },
        };
      }
      if (typeof obj.code !== 'string') return { error: 'analyze requires a string "code" argument' };
      return {
        intent: { kind: 'builtin', name: 'analyze', args: { code: obj.code, data: obj.data } },
      };
  }
}

/** Pull the image out of an attach_image tool payload (structural check). */
function extractAttachedImage(payload: unknown): ImageAttachment | null {
  if (!payload || typeof payload !== 'object') return null;
  const image = (payload as { image?: unknown }).image;
  if (!image || typeof image !== 'object') return null;
  const { url, name, mime, size, detail } = image as Record<string, unknown>;
  if (typeof url !== 'string' || url.length === 0) return null;
  return {
    url,
    name: typeof name === 'string' ? name : undefined,
    mime: typeof mime === 'string' ? mime : undefined,
    size: typeof size === 'number' ? size : undefined,
    detail: detail === 'auto' || detail === 'low' || detail === 'high' ? detail : undefined,
  };
}

/**
 * The gated agent loop:
 *   user message -> model -> tool calls -> gatekeeper (validate/policy/consent/execute/audit)
 *   -> observations -> model -> ... -> final text answer
 */export class AgentSession {
  history: ChatMessage[] = [];
  private running = false;
  private controller: AbortController | null = null;
  private readonly tools: ReturnType<typeof buildToolDefs>;

  constructor(private readonly deps: AgentSessionDeps) {
    this.tools = buildToolDefs(deps.policy);
  }

  get isRunning(): boolean {
    return this.running;
  }

  stop(): void {
    this.controller?.abort();
  }

  clear(): void {
    this.history = [];
  }

  /** Replace the conversation history (used to restore an opted-in persisted session). */
  restoreHistory(messages: readonly ChatMessage[]): void {
    this.history = messages.map((m) => ({ ...m }));
  }

  /** User/assistant messages with text (and any attached image URLs), in order —
   *  the panel renders these. */
  displayHistory(): Array<{ role: 'user' | 'assistant'; text: string; images: string[] }> {
    const out: Array<{ role: 'user' | 'assistant'; text: string; images: string[] }> = [];
    for (const m of this.history) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const { text, images } = splitContent(m.content);
      if (text.trim().length > 0 || images.length > 0) out.push({ role: m.role, text, images });
    }
    return out;
  }

  /** Execute one model tool call through the gatekeeper and return the tool-message payload. */
  private async executeToolCall(
    tc: ToolCall,
    hooks: AgentHooks | undefined,
    budgetLeft: boolean
  ): Promise<unknown> {
    const { ledger } = this.deps;
    if (!budgetLeft) {
      return { error: 'per-turn tool call budget exhausted' };
    }
    const built = buildIntentFromToolCall(tc, this.tools.toolMap);
    if (built.error) {
      ledger.append({ kind: 'llm', decision: 'error', summary: `tool call rejected: ${built.error}` });
      return { error: built.error };
    }
    const intent = built.intent as Intent;
    hooks?.onToolStart?.({
      capabilityId: capabilityIdOfIntent(intent),
      kind: intentKindToCapabilityKind(intent),
    });
    const outcome = await this.deps.gate.resolve(intent);
    hooks?.onToolEnd?.(outcome);
    return outcome.ok ? (outcome.result ?? { ok: true }) : { error: outcome.error };
  }

  /** Process a model response's tool calls through the gatekeeper, appending observations. */
  private async processToolCalls(
    msg: ChatMessage,
    hooks: AgentHooks | undefined,
    limits: ReturnType<PolicyEngine['effectiveLimits']>,
    toolCalls: number
  ): Promise<number> {
    if (!msg.tool_calls) return toolCalls;
    this.history.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      const hasBudget = toolCalls < limits.maxToolCallsPerTurn;
      const resultPayload = await this.executeToolCall(tc, hooks, hasBudget);
      if (hasBudget) toolCalls += 1;
      const mapping = this.tools.toolMap.get(tc.function.name);
      const attached =
        mapping?.kind === 'builtin' && mapping.capabilityId === 'attach_image'
          ? extractAttachedImage(resultPayload)
          : null;
      if (attached) {
        // The tool observation carries only the summary; the image itself is
        // injected as a user message so the next model call can SEE it (a data
        // URL in the tool text would just be noise to the model).
        const { image: _image, ...observation } = resultPayload as { image?: unknown; summary?: string };
        this.history.push(
          { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(observation) },
          { role: 'user', content: buildUserContent(`[attached image: ${attached.name ?? 'image'}]`, [attached]) }
        );
      } else {
        this.history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(resultPayload ?? { ok: true }),
        });
      }
    }
    return toolCalls;
  }

  async run(userText: string, images: readonly ImageAttachment[] = []): Promise<string> {
    if (this.running) throw new Error('ibh is already processing a message');
    this.running = true;
    this.controller = new AbortController();
    const { policy, client, dom, ledger, hooks } = this.deps;
    const limits = policy.effectiveLimits();
    const guide = resolveGuide(this.deps.guide);

    try {
      this.history.push({ role: 'user', content: buildUserContent(userText, images) });
      let steps = 0;
      let toolCalls = 0;

      while (steps < limits.maxStepsPerTurn) {
        const budget = policy.checkTokenBudget();
        if (!budget.ok) {
          return this.finishAsNotice(`Stopped: ${budget.reason}`);
        }

        steps += 1;
        hooks?.onStatus?.(steps > 1 ? 'thinking…' : 'reading the page…');
        const system: ChatMessage = {
          role: 'system',
          content: buildSystemPrompt({ manifest: this.deps.manifest, guide, pageContext: buildPageContext(dom) }),
        };

        let response;
        try {
          hooks?.onStatus?.('thinking…');
          response = await client.chat({
            model: this.deps.manifest.llm.defaultModel,
            messages: [system, ...this.history],
            tools: this.tools.tools,
            signal: this.controller.signal,
          });
        } catch (e) {
          if (this.controller.signal.aborted) return this.finishAsNotice('Stopped by user.');
          const msg = e instanceof Error ? e.message : String(e);
          ledger.append({ kind: 'llm', decision: 'error', summary: `model error: ${msg}` });
          return this.finishAsNotice(`(ibh could not reach the model: ${msg})`);
        }

        policy.recordTokens(response.usage.total_tokens);
        ledger.append({
          kind: 'llm',
          decision: 'allow',
          summary: `${this.deps.manifest.llm.defaultModel}: +${response.usage.total_tokens} tokens (session ${policy.getTokensSpent()})`,
        });

        const msg = response.message;
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          toolCalls = (await this.processToolCalls(msg, hooks, limits, toolCalls)) ?? toolCalls;
          continue;
        }

        // Final answer.
        const text = typeof msg.content === 'string' ? msg.content : splitContent(msg.content).text;
        this.history.push({ role: 'assistant', content: text });
        hooks?.onAssistant?.(text);
        return text;
      }

      return this.finishAsNotice(`Stopped: reached the per-turn step limit (${limits.maxStepsPerTurn}).`);
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  private finishAsNotice(notice: string): string {
    this.history.push({ role: 'assistant', content: notice });
    this.deps.hooks?.onAssistant?.(notice);
    return notice;
  }
}
