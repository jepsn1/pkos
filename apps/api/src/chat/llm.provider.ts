import { Inject, Injectable } from '@nestjs/common';

export const LLM_PROVIDER = 'LLM_PROVIDER';
export const LLM_FETCH = 'LLM_FETCH';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant messages only: tool calls the model made (replayed in tool loops). */
  toolCalls?: LlmToolCall[];
  /** Tool-result messages only: which tool produced this content. */
  toolName?: string;
}

/** Tool offered to the model (ollama /api/chat wraps this as {type:'function', function}). */
export interface LlmTool {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmReply {
  content: string;
  toolCalls: LlmToolCall[];
}

/** Chat-completion LLM. Real impl calls ollama; tests inject a fake.
 *  Without `tools` the reply is a plain string (legacy behavior); with `tools`
 *  it is an LlmReply that may carry tool calls. */
export interface LlmProvider {
  chat(messages: LlmMessage[], tools?: LlmTool[]): Promise<string | LlmReply>;
}

/** Normalize either reply shape to an LlmReply. */
export function toReply(reply: string | LlmReply): LlmReply {
  return typeof reply === 'string' ? { content: reply, toolCalls: [] } : reply;
}

// qwen3:14b on the 6900 XT does ~50 tok/s, but long answers + cold model load add up
// (and other agents may queue on the shared ollama — override via env when needed).
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/** Remove qwen3 <think>…</think> blocks (belt and braces on top of think:false). */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

@Injectable()
export class OllamaLlmProvider implements LlmProvider {
  constructor(@Inject(LLM_FETCH) private readonly fetchFn: typeof fetch) {}

  async chat(messages: LlmMessage[], tools?: LlmTool[]): Promise<string | LlmReply> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.LLM_MODEL ?? 'qwen3:14b';
    const res = await this.fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages.map(toOllamaMessage),
        stream: false,
        think: false,
        ...(tools?.length
          ? { tools: tools.map((t) => ({ type: 'function', function: t })) }
          : {}),
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama chat failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: Record<string, unknown> };
        }>;
      };
    };
    const content = typeof data.message?.content === 'string' ? data.message.content : '';
    if (tools) {
      const toolCalls: LlmToolCall[] = (data.message?.tool_calls ?? []).map((tc) => ({
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? {},
      }));
      return { content: stripThink(content), toolCalls };
    }
    if (!content.trim()) throw new Error('ollama chat returned no content');
    return stripThink(content);
  }
}

/** ollama /api/chat message shape: tool_calls nested under `function`, tool_name flat. */
function toOllamaMessage(m: LlmMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls?.length
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : {}),
    ...(m.toolName ? { tool_name: m.toolName } : {}),
  };
}
