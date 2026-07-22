import { Inject, Injectable } from '@nestjs/common';
import type { RequestImage, ToolContext } from '../chat/chat.service';
import {
  LLM_PROVIDER,
  type LlmMessage,
  type LlmProvider,
  type LlmTool,
  type LlmToolCall,
} from '../chat/llm.provider';
import { KnowledgeService } from '../knowledge/knowledge.service';

/** Vision model (multimodal) — separate from LLM_MODEL; runs on the same ollama. */
const VISION_MODEL = process.env.VISION_MODEL ?? 'qwen2.5vl:7b';
/** GPU layer cap for the vision model. qwen2.5vl:32b (~20GB q4) + a 12MP image's
 *  ~1.8GB compute buffer overflows the 16GB card if ollama auto-fits; pinning
 *  layers below auto forces the rest onto CPU RAM so it fits reliably. Unset (0
 *  -> undefined) lets ollama decide, correct for a 7B that fits fully. */
const VISION_NUM_GPU = Number(process.env.VISION_NUM_GPU ?? 0) || undefined;
/** Vision extraction needs room for a full page of text; think off (qwen2.5vl is not a reasoner). */
const VISION_GEN = { numCtx: 8192, numPredict: 4000, numGpu: VISION_NUM_GPU };

/** Appended to the chat system prompt so the planner routes image-note turns here. */
export const VISION_ROUTING = `You also have a tool for making notes from images the user has attached:
- make_note_from_image (VISION): the ONLY way to turn an attached photo/screenshot/scan into a note. Call it when the user asks to "make a note from this", "note this", "save this image", "capture what's on this page", etc. AND an image is attached to the current message.
  CRITICAL: you CANNOT see the image yourself. NEVER describe, transcribe, quote, or summarise an attached image from your own guessing — that is fabrication. Only make_note_from_image can read it. If the user asks about an image but none is attached this turn, say so and ask them to attach it; do not call the tool.
  Pass \`instructions\` = any context the user gave (e.g. "this is from Pastor Lars's sermon on Romans"), and \`folder\` = the best-fit vault folder (faith/bible-study for a Bible photo, faith/sermons for sermon notes, etc.). The tool reads the image, writes the note, embeds the original image, and saves it. After it returns, just tell the user it's saved and which folder — do NOT call save_note for the same image.`;

const VISION_TOOLS: LlmTool[] = [
  {
    name: 'make_note_from_image',
    description:
      "Read the image(s) attached to the current message with a vision model and save ONE blended vault note: printed text (verbatim), the user's handwritten notes, and anything marked/underlined/highlighted, with the original image embedded. Returns the saved vault path. Only valid when an image is attached this turn.",
    parameters: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description:
            'Context the user gave about the image (source, speaker, topic, what to focus on). Optional.',
        },
        folder: {
          type: 'string',
          description:
            'Best-fit vault folder, e.g. faith/bible-study, faith/sermons, faith/reflections, books, articles. Omit only when nothing fits.',
        },
      },
    },
  },
];

/** The vision model's job: faithful, structured extraction — NOT a rewrite or a summary. */
const VISION_SYSTEM = `You are a careful vision transcriber for a personal knowledge vault. You are given one or more photos/scans (often a Bible page, a book, or study notes with hand annotations). Produce ONE blended markdown note that captures EVERYTHING on the page, faithfully.

Write the note in the SAME language as the source — do NOT translate. Transcribe printed text verbatim in its original language.

Output format — EXACTLY:
TITLE: <a short, specific title for this note>
<blank line>
<the markdown note body>

Study the page closely for hand markings, not just the print. Include every section below that applies:
## Text
The printed/typed text, transcribed VERBATIM in its original language (do not paraphrase, summarise, translate, or fix wording). Keep verse numbers and references (book chapter:verse) and structure.
## Highlighted
Each passage marked with a highlighter (e.g. yellow) — quote the highlighted words, one bullet each.
## Underlined
Each passage underlined or boxed by hand in pen/pencil — quote those words, one bullet each. Underlines are SEPARATE from highlighter; report both when both appear.
## Handwritten notes
The reader's own handwritten notes / margin annotations, transcribed as faithfully as you can, in their original language. IMPORTANT: this handwriting is often small and written at an ANGLE or slanted to fit a narrow margin — read it in place, do not ignore it. Mark any unreadable word as [illegible].
## Arrows / connections
Each arrow or line the reader drew: say what it goes FROM (usually one of the handwritten notes) and what it points TO (the word or verse it targets) — e.g. "arrow from the note 'X' to verse 13".

Rules:
- Transcribe only what is actually visible. NEVER invent text, verses, notes, arrows, highlights, or underlines that are not there.
- Do not add commentary, interpretation, or a summary of your own.
- If the image has no legible content at all, output TITLE: (empty) and a body of exactly: NO_TEXT`;

/** Bad tool arguments / no image — reported back to the model as {error}, never thrown. */
class VisionError extends Error {}

type Args = Record<string, unknown>;

/**
 * LLM tool that turns an attached image into a vault note via a local vision model.
 * The vision model writes the note body DIRECTLY (so verbatim scripture is never
 * laundered through the text model); this tool embeds the stored original and saves.
 */
@Injectable()
export class VisionToolsService {
  readonly tools = VISION_TOOLS;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly knowledge: KnowledgeService,
  ) {}

  routingPrompt(): string {
    return VISION_ROUTING;
  }

  async execute(call: LlmToolCall, ctx?: ToolContext): Promise<string> {
    try {
      if (call.name !== 'make_note_from_image') {
        return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
      const images = ctx?.images ?? [];
      if (images.length === 0) {
        return JSON.stringify({
          error:
            'no image is attached to this message — ask the user to attach the photo, then try again',
        });
      }
      const args = (call.arguments ?? {}) as Args;
      const instructions =
        typeof args.instructions === 'string' && args.instructions.trim()
          ? args.instructions.trim()
          : undefined;
      const folder = optionalFolder(args.folder);

      const { title, body } = await this.extract(images, instructions);
      const markdown = embedImages(images) + body;
      const item = await this.knowledge.ingest({
        title,
        markdown,
        source: 'image',
        folder: folder ?? undefined,
      });
      return JSON.stringify({ saved: true, path: item.path, title: item.title, folder: folder ?? 'articles' });
    } catch (err) {
      if (err instanceof VisionError) return JSON.stringify({ error: err.message });
      return JSON.stringify({ error: (err as Error).message ?? 'vision tool failed' });
    }
  }

  /** Run the vision model over the image(s); parse its TITLE + body. */
  private async extract(
    images: RequestImage[],
    instructions?: string,
  ): Promise<{ title: string; body: string }> {
    const userText = instructions
      ? `Context from the user: ${instructions}\n\nTranscribe the attached image(s) as instructed.`
      : 'Transcribe the attached image(s) as instructed.';
    const messages: LlmMessage[] = [
      { role: 'system', content: VISION_SYSTEM },
      { role: 'user', content: userText, images: images.map((i) => i.base64) },
    ];
    const reply = await this.llm.chat(messages, undefined, VISION_MODEL, false, VISION_GEN);
    const raw = (typeof reply === 'string' ? reply : reply.content).trim();
    return parseTitleBody(raw, instructions);
  }
}

/** Markdown image embeds for every stored original, at the top of the note. */
function embedImages(images: RequestImage[]): string {
  return images.map((i) => `![](${i.url})`).join('\n') + '\n\n';
}

/** Split the vision model's "TITLE: x\n\n<body>" reply; sane fallbacks if it drifts. */
export function parseTitleBody(
  raw: string,
  instructions?: string,
): { title: string; body: string } {
  const m = raw.match(/^\s*TITLE:\s*(.*?)\s*\n([\s\S]*)$/i);
  let title = m?.[1]?.trim() ?? '';
  let body = (m ? m[2] : raw).trim();
  if (body === 'NO_TEXT' || !body) {
    throw new VisionError(
      'the vision model could not read any legible text in the image — ask the user for a clearer photo',
    );
  }
  if (!title) title = instructions?.slice(0, 60).trim() || 'Image note';
  return { title, body };
}

/** Vault-relative folder — plain path segments only, no escaping the vault. */
function optionalFolder(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new VisionError('folder must be a string');
  const clean = v.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new VisionError('folder must be a relative vault path like "faith/bible-study"');
  }
  return clean;
}
