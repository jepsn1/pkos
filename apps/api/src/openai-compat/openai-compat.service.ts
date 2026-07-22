import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Citation } from '../chat/chat.repo';
import { ChatService } from '../chat/chat.service';
import type { LlmMessage, ThinkLevel } from '../chat/llm.provider';
import { WebuiImportService } from '../webui-import/webui-import.service';

/**
 * Dropdown presets shown in Open WebUI. Same underlying model (gpt-oss via
 * LLM_MODEL) for all — only the reasoning effort changes. `id` round-trips
 * (webui sends the chosen id back as `model`); `name` is the dropdown label.
 * First entry = default/fallback (low = voice-friendly, matches prior behavior).
 */
export interface CompatModel {
  id: string;
  name: string;
  think: ThinkLevel;
}
export const COMPAT_MODELS: CompatModel[] = [
  { id: 'pkos-fast', name: 'Fast', think: 'low' },
  { id: 'pkos-balanced', name: 'Balanced', think: 'medium' },
  { id: 'pkos-deep', name: 'Deep', think: 'high' },
];

/** Resolve a requested id to a preset; legacy 'pkos'/unknown/missing → default. */
export function resolveModel(id?: string): CompatModel {
  return COMPAT_MODELS.find((m) => m.id === id) ?? COMPAT_MODELS[0];
}

/** Default/legacy id (Open WebUI configs may still have "pkos" saved). */
export const MODEL_ID = COMPAT_MODELS[0].id;

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
  constructor(
    private readonly chat: ChatService,
    @Optional() private readonly webuiImport?: WebuiImportService,
  ) {}

  /**
   * Import any webui-attached files into our store and append their pkos URLs to
   * the message, so the model embeds the portable URL when it saves a note.
   * Best-effort — returns the message unchanged when nothing is attached or the
   * import isn't configured.
   */
  private async withImportedAttachments(message: string): Promise<string> {
    const imported = (await this.webuiImport?.importFromMessage(message)) ?? [];
    if (imported.length === 0) return message;
    const lines = imported.map((f) => `- ${f.name} → ${f.url}`).join('\n');
    return `${message}\n\n[System: the attached file(s) are saved in the user's file store. If you save a note about them, embed the original by URL (images as ![](url), other files as [name](url)):\n${lines}\n]`;
  }

  listModels() {
    return {
      object: 'list' as const,
      data: COMPAT_MODELS.map((m) => ({
        id: m.id,
        object: 'model' as const,
        created: 0,
        owned_by: 'pkos',
        name: m.name,
      })),
    };
  }

  async complete(body: CompletionRequest): Promise<CompletionResponse> {
    const { message, history } = parseMessages(body);
    const preset = resolveModel(body.model);
    let content: string;
    try {
      const augmented = await this.withImportedAttachments(message);
      const { answer, citations } = await this.chat.answer(
        augmented,
        history,
        undefined,
        undefined,
        undefined,
        preset.think,
      );
      // Footer off by default (voice-first, matches the streaming path); opt in via env.
      content =
        process.env.COMPAT_SOURCES_FOOTER === 'true' ? withSources(answer, citations) : answer;
    } catch (err) {
      content = errorReply(err);
    }
    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: preset.id,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
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
    const preset = resolveModel(body.model);
    const base = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: preset.id,
    };
    const chunk = (
      delta: CompletionChunk['choices'][0]['delta'],
      finish: 'stop' | null = null,
    ): CompletionChunk => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });

    send(chunk({ role: 'assistant', content: '' }));
    // Voice-first defaults: DON'T stream the <think> block or the Sources footer.
    // Both get read aloud by webui TTS (reasoning + "path (zero point five one)"),
    // wasting seconds per turn. Reasoning still runs server-side (routing quality
    // kept) — it's just not forwarded. Re-enable for a text-only client via env.
    const streamThinking = process.env.COMPAT_STREAM_THINKING === 'true';
    const emitFooter = process.env.COMPAT_SOURCES_FOOTER === 'true';
    let thinkOpen = false;
    const closeThink = () => {
      if (thinkOpen) {
        send(chunk({ content: '</think>' }));
        thinkOpen = false;
      }
    };
    try {
      const augmented = await this.withImportedAttachments(message);
      const { citations } = await this.chat.answer(
        augmented,
        history,
        (token) => {
          closeThink();
          send(chunk({ content: token }));
        },
        streamThinking
          ? (thought) => {
              if (!thinkOpen) {
                send(chunk({ content: '<think>' }));
                thinkOpen = true;
              }
              send(chunk({ content: thought }));
            }
          : undefined,
        undefined,
        preset.think,
      );
      closeThink();
      if (emitFooter) {
        const footer = sourcesFooter(citations);
        if (footer) send(chunk({ content: footer }));
      }
    } catch (err) {
      closeThink();
      send(chunk({ content: `\n\n${errorReply(err)}` }));
    }
    send(chunk({}, 'stop'));
  }
}

/**
 * Turn a thrown error into a user-facing reply AND log it server-side. Errors were
 * being streamed to the client but never logged — so nothing was debuggable. The
 * user WANTS to see errors (transparency on a personal system), so we surface a
 * clean line; set COMPAT_SURFACE_ERRORS=false to hide them and show a generic note.
 */
export function errorReply(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[pkos] request failed:', err);
  if (process.env.COMPAT_SURFACE_ERRORS === 'false') {
    return '⚠️ Something went wrong handling that — check the server logs.';
  }
  return `⚠️ **pkos error:** ${msg}`;
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
