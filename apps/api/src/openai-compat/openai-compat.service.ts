import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AttachmentsService, attachmentUrl } from '../attachments/attachments.service';
import type { Citation } from '../chat/chat.repo';
import { ChatService, type RequestImage } from '../chat/chat.service';
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

/** OpenAI content is a string or an array of typed parts (multimodal: text + image_url). */
type OpenAiPart = {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
};
type OpenAiContent = string | OpenAiPart[];

/** A base64 image pulled from the request (data: URI decoded into bytes-to-be). */
export interface InlineImage {
  base64: string;
  mime: string;
}

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
    @Optional() private readonly attachments?: AttachmentsService,
  ) {}

  /**
   * Pull any inline base64 images out of the request, store the originals (so the
   * note can embed a portable pkos URL), and return them ready for the vision
   * model. Best-effort: without an attachment store, or with no images, returns [].
   */
  private async collectImages(body: CompletionRequest): Promise<RequestImage[]> {
    if (!this.attachments) return [];
    const parts = extractImageParts(body);
    const out: RequestImage[] = [];
    for (const img of parts) {
      try {
        const buffer = Buffer.from(img.base64, 'base64');
        const ext = mimeExt(img.mime);
        const a = await this.attachments.store(
          { buffer, originalname: `image${ext}`, mimetype: img.mime },
          undefined,
        );
        out.push({ id: a.id, url: attachmentUrl(a.id), mime: a.mime, base64: img.base64 });
      } catch (err) {
        console.warn(`[compat] skip inline image: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * List every attachment on this turn — webui-imported files (docx etc.) AND
   * inline images — and append their pkos URLs to the message so the model embeds
   * the portable URL as a REFERENCE when it saves a note. Crucially it is told NOT
   * to transcribe/describe image contents: with vision dormant we can't read them,
   * so the note text must come from what the user said, and the image just rides
   * along embedded. Best-effort — returns the message unchanged when nothing is
   * attached or the import isn't configured.
   */
  private async withAttachmentContext(message: string, inlineImages: RequestImage[]): Promise<string> {
    const imported = (await this.webuiImport?.importFromMessage(message)) ?? [];
    const lines = [
      ...imported.map((f) => `- ${f.name} → ${f.url}`),
      ...inlineImages.map((im, i) => `- image ${i + 1} → ${im.url}`),
    ];
    if (lines.length === 0) return message;
    return `${message}\n\n[System: the user attached the file(s) below, saved in their store. Any attached IMAGE is embedded into the note automatically — you do NOT need to add it, and you CANNOT see inside it: never transcribe, quote, summarise, or guess an image's contents; write the note only from what the user themselves said. For non-image files, link them as [name](url) when relevant:\n${lines.join('\n')}\n]`;
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
      const images = await this.collectImages(body);
      const augmented = await this.withAttachmentContext(message, images);
      const { answer, citations } = await this.chat.answer(
        augmented,
        history,
        undefined,
        undefined,
        undefined,
        preset.think,
        images,
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
      const images = await this.collectImages(body);
      const augmented = await this.withAttachmentContext(message, images);
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
        images,
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
  const raw = err instanceof Error ? err.message : String(err);
  console.error('[pkos] request failed:', err); // full detail (incl. any payload) stays in the logs
  if (process.env.COMPAT_SURFACE_ERRORS === 'false') {
    return '⚠️ Something went wrong handling that — check the server logs.';
  }
  return `⚠️ **pkos error:** ${humanizeError(raw)}`;
}

/**
 * Make a raw error safe + meaningful to show in chat. Two jobs: (1) explain the
 * common local-model failure in plain words, (2) NEVER flood the chat with a huge
 * payload — ollama's tool-parse error embeds the entire malformed tool call (a
 * whole note body), which is what made a past error "look off". Full detail is
 * still logged server-side.
 */
export function humanizeError(raw: string): string {
  // gpt-oss occasionally emits invalid JSON for a tool call (esp. a large note
  // body with newlines/quotes/em-dashes) → ollama can't parse it and returns the
  // raw payload in the error. Explain + guide instead of dumping it.
  if (/error parsing tool call|parsing tool call/i.test(raw)) {
    return "the model produced a malformed tool call (usually a note too large/complex to save in one step), so nothing was saved. Try again, or ask for a shorter note.";
  }
  // Bound anything else so a long payload can never flood the reply.
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
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
  // A user turn counts if it has text OR an image (an attached photo with no
  // caption is a valid turn — the vision tool reads the image).
  const lastUserIdx = messages.findLastIndex(
    (m) => m?.role === 'user' && (contentText(m.content).trim() !== '' || hasImagePart(m.content)),
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

/**
 * Pull inline images out of the LAST user message (webui attaches vision images as
 * image_url parts with a `data:<mime>;base64,<data>` URI). Text parts are ignored
 * here — those are handled by parseMessages/contentText.
 */
export function extractImageParts(body: CompletionRequest): InlineImage[] {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return [];
  const lastUser = messages.filter((m) => m?.role === 'user').at(-1);
  const content = lastUser?.content;
  if (!Array.isArray(content)) return [];
  const out: InlineImage[] = [];
  for (const part of content) {
    if (part?.type !== 'image_url') continue;
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    const parsed = parseDataUri(url);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** True when a content array carries at least one image_url part. */
function hasImagePart(content: OpenAiContent | undefined): boolean {
  return Array.isArray(content) && content.some((p) => p?.type === 'image_url');
}

/** Decode a `data:<mime>;base64,<data>` URI; null for anything else (e.g. http URLs). */
function parseDataUri(url: string | undefined): InlineImage | null {
  if (!url) return null;
  const m = url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

/** File extension for a stored image blob, from its mime type. */
function mimeExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
  };
  return map[mime.toLowerCase()] ?? '.img';
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
