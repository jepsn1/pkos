import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Citation } from '../chat/chat.repo';
import { ChatService } from '../chat/chat.service';
import type { LlmMessage } from '../chat/llm.provider';

/** The single model this surface exposes; Open WebUI selects it by id. */
export const MODEL_ID = 'pkos';

// --- OpenAI wire types (the subset we speak) ---------------------------------

/** OpenAI content is a string or an array of typed parts (multimodal). */
type OpenAiContent = string | Array<{ type?: string; text?: string }>;

export interface OpenAiMessage {
  role: string;
  content?: OpenAiContent;
}

export interface CompletionRequest {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
}

export interface CompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface CompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: 'stop' | null;
  }>;
}

// ------------------------------------------------------------------------------

/**
 * Translates OpenAI chat-completions traffic onto ChatService retrieval+citations.
 *
 * Statefulness: OpenAI-style clients (Open WebUI) resend the FULL message history
 * every turn and persist conversations themselves, so we keep this surface
 * stateless — the last user message drives retrieval, prior user/assistant turns
 * are replayed to the LLM as context, and nothing is written to the pkos
 * conversations tables (those belong to the native /api/chat).
 */
@Injectable()
export class OpenAiCompatService {
  constructor(private readonly chat: ChatService) {}

  listModels() {
    return {
      object: 'list' as const,
      data: [
        { id: MODEL_ID, object: 'model' as const, created: 0, owned_by: 'pkos' },
      ],
    };
  }

  async complete(body: CompletionRequest): Promise<CompletionResponse> {
    const { message, history } = parseMessages(body);
    const { answer, citations } = await this.chat.answer(message, history);
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: withSources(answer, citations) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  /**
   * `stream: true` variant — REAL token streaming. Emits, in order: a role
   * chunk, one content delta per LLM token as it arrives (ChatService keeps
   * tool rounds silent), the Sources footer as its own final content delta,
   * then a finish_reason:stop chunk. Errors after the stream has opened become
   * an error content delta (still followed by the stop chunk) so clients
   * terminate cleanly instead of hanging.
   */
  async streamCompletion(
    body: CompletionRequest,
    send: (chunk: CompletionChunk) => void,
  ): Promise<void> {
    const { message, history } = parseMessages(body);
    const base = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
    };
    const chunk = (
      delta: CompletionChunk['choices'][0]['delta'],
      finish: 'stop' | null = null,
    ): CompletionChunk => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });

    send(chunk({ role: 'assistant', content: '' }));
    try {
      const { citations } = await this.chat.answer(message, history, (token) =>
        send(chunk({ content: token })),
      );
      const footer = sourcesFooter(citations);
      if (footer) send(chunk({ content: footer }));
    } catch (err) {
      send(chunk({ content: `\n\n[pkos error: ${err instanceof Error ? err.message : err}]` }));
    }
    send(chunk({}, 'stop'));
  }
}

/** Markdown "Sources:" footer so citations survive any OpenAI-speaking client. */
export function withSources(answer: string, citations: Citation[]): string {
  return `${answer}${sourcesFooter(citations)}`;
}

/** The footer alone ('' when no citations) — streamed as its own delta. */
export function sourcesFooter(citations: Citation[]): string {
  if (citations.length === 0) return '';
  const lines = citations.map(
    (c) => `- \`${c.path}\` — ${c.title} (${c.score !== undefined ? c.score.toFixed(2) : `via graph: ${c.relation}`})`,
  );
  return `\n\n---\n**Sources:**\n${lines.join('\n')}`;
}

/**
 * Last user message = retrieval query; everything before it (user/assistant only)
 * = LLM context. Client-sent system prompts are dropped — grounding owns the
 * system slot. Trailing assistant messages after the last user turn are ignored.
 */
export function parseMessages(body: CompletionRequest): {
  message: string;
  history: LlmMessage[];
} {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestException('messages array required');
  }
  const lastUserIdx = messages.findLastIndex(
    (m) => m?.role === 'user' && contentText(m.content).trim() !== '',
  );
  if (lastUserIdx === -1) {
    throw new BadRequestException('at least one non-empty user message required');
  }
  const history = messages
    .slice(0, lastUserIdx)
    .filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .map((m): LlmMessage => ({
      role: m.role as 'user' | 'assistant',
      content: contentText(m.content),
    }))
    .filter((m) => m.content.trim() !== '');
  return { message: contentText(messages[lastUserIdx].content), history };
}

/** Flatten string-or-parts OpenAI content to plain text. */
function contentText(content: OpenAiContent | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}
