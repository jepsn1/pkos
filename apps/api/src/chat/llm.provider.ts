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
/** Reasoning effort: gpt-oss takes 'low'|'medium'|'high'; qwen3 takes a boolean. */
export type ThinkLevel = boolean | string;

export interface LlmProvider {
  chat(
    messages: LlmMessage[],
    tools?: LlmTool[],
    model?: string,
    think?: ThinkLevel,
  ): Promise<string | LlmReply>;
  /**
   * Streaming variant: `onToken` receives content deltas as they arrive; the
   * resolved LlmReply is the assembled final reply (content + tool_calls).
   * Once a tool_call appears in the stream, later content deltas are NOT
   * forwarded to `onToken` (tool rounds stay silent) but still land in
   * `reply.content`. Optional so simple test fakes stay valid.
   * `model` overrides LLM_MODEL for this call (per-request model selection).
   */
  chatStream?(
    messages: LlmMessage[],
    tools: LlmTool[] | undefined,
    onToken: (token: string) => void,
    onThinking?: (token: string) => void,
    model?: string,
    think?: ThinkLevel,
  ): Promise<LlmReply>;
}

/** Normalize either reply shape to an LlmReply. */
export function toReply(reply: string | LlmReply): LlmReply {
  return typeof reply === 'string' ? { content: reply, toolCalls: [] } : reply;
}

// qwen3:14b on the 6900 XT does ~50 tok/s, but long answers + cold model load add up
// (and other agents may queue on the shared ollama — override via env when needed).
/** Thinking control. Booleans for qwen3-style models (NOTE: qwen3:30b-a3b on
 *  ollama 0.31.x ignores think:false and leaks reasoning into content — use
 *  true there; reasoning then lands in the separate `thinking` field).
 *  gpt-oss takes effort LEVELS instead: LLM_THINK=low|medium|high. */
function parseThink(raw: string | undefined): boolean | string {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return raw === 'true';
}
const LLM_THINK = parseThink(process.env.LLM_THINK);
/** Context window + per-round generation cap. Defaults sized for qwen3:30b-a3b
 *  on 16GB VRAM: 4096 (ollama default) overflows on our system prompt + tools +
 *  thinking and sends the model into 19k-token runaway loops; the cap makes any
 *  future runaway die in ~75s instead of blocking the serial queue for minutes. */
const LLM_NUM_CTX = Number(process.env.LLM_NUM_CTX ?? 8192);
const LLM_NUM_PREDICT = Number(process.env.LLM_NUM_PREDICT ?? 4096);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

/** Remove qwen3 <think>…</think> blocks (belt and braces on top of think:false). */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longest suffix of `text` that is a proper prefix of `tag` (partial tag holdback). */
function partialTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Streaming counterpart of stripThink: push token deltas in, get filtered
 * deltas out. Suppresses <think>…</think> spans (tags may split across
 * deltas) and trims leading/trailing whitespace on the fly, so the
 * concatenation of emitted deltas === stripThink(concatenation of inputs)
 * for any closed-think input. `end()` flushes holdback and returns the
 * full emitted text.
 */
export class ThinkFilter {
  private buf = '';
  private inThink = false;
  private emittedAny = false;
  private pendingWs = '';
  private total = '';

  constructor(private readonly sink: (token: string) => void) {}

  push(delta: string): void {
    this.buf += delta;
    for (;;) {
      if (this.inThink) {
        const close = this.buf.indexOf(THINK_CLOSE);
        if (close === -1) {
          // keep only what could still be a partial closing tag
          this.buf = this.buf.slice(this.buf.length - partialTagSuffix(this.buf, THINK_CLOSE));
          return;
        }
        this.buf = this.buf.slice(close + THINK_CLOSE.length);
        this.inThink = false;
        continue;
      }
      const open = this.buf.indexOf(THINK_OPEN);
      if (open === -1) {
        const hold = partialTagSuffix(this.buf, THINK_OPEN);
        this.emit(this.buf.slice(0, this.buf.length - hold));
        this.buf = this.buf.slice(this.buf.length - hold);
        return;
      }
      this.emit(this.buf.slice(0, open));
      this.buf = this.buf.slice(open + THINK_OPEN.length);
      this.inThink = true;
    }
  }

  /** Flush non-think holdback (a lone "<thi" that never became a tag is real text). */
  end(): string {
    if (!this.inThink && this.buf) {
      this.emit(this.buf);
      this.buf = '';
    }
    return this.total;
  }

  /** Whitespace-aware emit: drops leading ws, holds trailing ws until more text follows. */
  private emit(text: string): void {
    if (!text) return;
    if (!this.emittedAny) {
      this.pendingWs = ''; // pre-first-text whitespace = leading, drop it
      text = text.replace(/^\s+/, '');
      if (!text) return;
    }
    const combined = this.pendingWs + text;
    const trailing = /\s+$/.exec(combined)?.[0] ?? '';
    const out = combined.slice(0, combined.length - trailing.length);
    this.pendingWs = trailing;
    if (out) {
      this.emittedAny = true;
      this.total += out;
      this.sink(out);
    }
  }
}

@Injectable()
export class OllamaLlmProvider implements LlmProvider {
  constructor(@Inject(LLM_FETCH) private readonly fetchFn: typeof fetch) {}

  async chat(
    messages: LlmMessage[],
    tools?: LlmTool[],
    model?: string,
    think?: ThinkLevel,
  ): Promise<string | LlmReply> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    model = model ?? process.env.LLM_MODEL ?? 'qwen3:14b';
    const res = await this.fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages.map(toOllamaMessage),
        stream: false,
        think: think ?? LLM_THINK,
        options: { num_ctx: LLM_NUM_CTX, num_predict: LLM_NUM_PREDICT },
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

  /**
   * Streaming /api/chat (stream:true → NDJSON lines). Content deltas go to
   * `onToken` as they arrive; once a tool_calls chunk shows up the rest of the
   * round stays silent (content still assembled into the reply). Returns the
   * assembled final reply, same shape as chat() with tools.
   */
  async chatStream(
    messages: LlmMessage[],
    tools: LlmTool[] | undefined,
    onToken: (token: string) => void,
    onThinking?: (token: string) => void,
    model?: string,
    think?: ThinkLevel,
  ): Promise<LlmReply> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    model = model ?? process.env.LLM_MODEL ?? 'qwen3:14b';
    const res = await this.fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messages.map(toOllamaMessage),
        stream: true,
        think: think ?? LLM_THINK,
        options: { num_ctx: LLM_NUM_CTX, num_predict: LLM_NUM_PREDICT },
        ...(tools?.length
          ? { tools: tools.map((t) => ({ type: 'function', function: t })) }
          : {}),
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama chat failed: HTTP ${res.status}`);
    if (!res.body) throw new Error('ollama chat returned no body');

    let content = '';
    const toolCalls: LlmToolCall[] = [];
    const decoder = new TextDecoder();
    let pending = '';
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const obj = JSON.parse(line) as {
        message?: {
          content?: string;
          tool_calls?: Array<{
            function?: { name?: string; arguments?: Record<string, unknown> };
          }>;
        };
        error?: string;
      };
      if (obj.error) throw new Error(`ollama chat stream error: ${obj.error}`);
      for (const tc of obj.message?.tool_calls ?? []) {
        toolCalls.push({ name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? {} });
      }
      const thinkDelta = (obj.message as { thinking?: string } | undefined)?.thinking;
      // Thinking streams even during tool rounds — it's the only sign of life
      // while the model reasons over tool results (can be thousands of tokens).
      if (typeof thinkDelta === 'string' && thinkDelta) onThinking?.(thinkDelta);
      const delta = typeof obj.message?.content === 'string' ? obj.message.content : '';
      if (delta) {
        content += delta;
        if (toolCalls.length === 0) onToken(delta);
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        handleLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    }
    handleLine(pending + decoder.decode());
    return { content: stripThink(content), toolCalls };
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
