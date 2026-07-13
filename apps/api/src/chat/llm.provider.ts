import { Inject, Injectable } from '@nestjs/common';

export const LLM_PROVIDER = 'LLM_PROVIDER';
export const LLM_FETCH = 'LLM_FETCH';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Chat-completion LLM. Real impl calls ollama; tests inject a fake. */
export interface LlmProvider {
  chat(messages: LlmMessage[]): Promise<string>;
}

// qwen3:14b on the 6900 XT does ~50 tok/s, but long answers + cold model load add up.
const LLM_TIMEOUT_MS = 120_000;

/** Remove qwen3 <think>…</think> blocks (belt and braces on top of think:false). */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

@Injectable()
export class OllamaLlmProvider implements LlmProvider {
  constructor(@Inject(LLM_FETCH) private readonly fetchFn: typeof fetch) {}

  async chat(messages: LlmMessage[]): Promise<string> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    const model = process.env.LLM_MODEL ?? 'qwen3:14b';
    const res = await this.fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, think: false }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama chat failed: HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('ollama chat returned no content');
    }
    return stripThink(content);
  }
}
