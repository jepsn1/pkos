import { Injectable } from '@nestjs/common';
import type { RequestImage, ToolContext } from '../chat/chat.service';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { KnowledgeService } from './knowledge.service';
import type { KnowledgeItem } from './knowledge.repo';

/** Appended to the chat system prompt so the planner routes knowledge turns here. */
export const KNOWLEDGE_ROUTING = `You also have tools over the user's knowledge vault:
- save_note (WRITE): when the user asks you to remember, save, store or note down a fact, preference, idea or piece of information that is NOT a numeric measurement, call it with a short title and a clean markdown body. Do NOT use it for numeric measurements (those go to log_metric) or ordinary questions.
  NEVER use save_note to summarize a video, podcast, or article you were only given a LINK to — you cannot see its content, and writing a summary from its title or from unrelated retrieved notes is fabrication. For a video/audio URL use transcribe_video instead; for other links, tell the user you can't read the page yet.
  FOLDER: always choose the folder that best fits the content and pass it as \`folder\` — do not just accept the default. Options: faith (Bible study, theology, reflections, devotionals, sermons — nest as faith/bible-study, faith/reflections, faith/theology, faith/sermons when it fits), books (book notes/summaries), fitness (training notes), diet (nutrition/food), programming (code/tech), articles (essays or general writing — the fallback only). A pastor's/sermon/church-teaching notes go in faith/sermons, NOT articles or a top-level sermons folder. After saving, tell the user which folder you used so they can correct it.
- read_note (RECALL): when the user asks you to read back, recall, show or quote a SPECIFIC saved note ("read me my note on X", "what did I write about Y"), call it with the note's title (or exact path). It returns the note's FULL markdown so you can quote or summarise it. If it returns candidates instead of a note, ask the user which one; if it finds nothing, say so plainly.
  CONTEXT: if the user refers to their note about something already under discussion — e.g. right after you talked about a book or topic they ask "what does my own note say?", "and my note?", "what do MY notes say about it" — this is read_note for THAT specific item: use the title of the thing just discussed. Do NOT list the whole vault.
- list_notes (BROWSE): only for genuine inventory/browse requests — "what notes do I have", "list my faith notes", "what do we have in fitness". Pass the folder they named (faith, fitness, articles, books, programming) as the folder argument, and ALWAYS call it fresh (never answer a "what do I have / list" question from earlier turns — the folder changes between questions). If it returns count 0, say plainly that that folder has no notes yet; do NOT repeat a list from a previous answer. This is NOT for "what does my note say about <the current topic>" — that is read_note.
Semantic retrieval already runs every turn — reach for read_note when you need a note's full content rather than the retrieved snippet.`;

const KNOWLEDGE_TOOLS: LlmTool[] = [
  {
    name: 'save_note',
    description:
      "Save a note to the user's personal knowledge vault: facts, preferences, ideas — anything worth remembering that is not a numeric metric. Returns the saved vault path.",
    parameters: {
      type: 'object',
      required: ['title', 'markdown'],
      properties: {
        title: { type: 'string', description: 'Short note title.' },
        markdown: { type: 'string', description: 'Note body, markdown.' },
        folder: {
          type: 'string',
          description:
            'Best-fit vault folder: faith (or faith/bible-study, faith/reflections, faith/theology, faith/sermons), books, fitness, diet, programming, or articles as the fallback. Omit only when nothing fits.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lowercase topic tags.',
        },
        summary: { type: 'string', description: 'One-sentence summary.' },
      },
    },
  },
  {
    name: 'read_note',
    description:
      "Read back the FULL markdown of a saved vault note so you can quote or summarise it. Identify the note by title (preferred) or by exact vault path. If the title matches several notes it returns candidates to disambiguate; if none match it returns found:false.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title to recall (case-insensitive).' },
        path: {
          type: 'string',
          description: 'Exact vault path, e.g. faith/on-grace.md. Use instead of title when known.',
        },
      },
    },
  },
  {
    name: 'list_notes',
    description:
      "List saved vault notes (title, path, tags, summary) so you can tell the user what they have. Optionally filter by folder or tag.",
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Vault folder prefix, e.g. faith. Omit for all.' },
        tag: { type: 'string', description: 'Only notes carrying this tag.' },
      },
    },
  },
  {
    name: 'move_note',
    description:
      'Relocate a saved note to a different vault folder — use when a note was filed in the wrong place. Identify it by title (preferred) or exact path, and give the target folder (e.g. faith/sermons, faith/reflections). Returns the new path. If the title is ambiguous it returns candidates instead of moving.',
    parameters: {
      type: 'object',
      required: ['folder'],
      properties: {
        title: { type: 'string', description: 'Title of the note to move (case-insensitive).' },
        path: {
          type: 'string',
          description: 'Exact vault path of the note. Use instead of title when known.',
        },
        folder: {
          type: 'string',
          description: 'Target folder, e.g. faith/sermons or faith/reflections.',
        },
      },
    },
  },
];

/** How many notes list_notes returns at most, and how many recall candidates we offer. */
const LIST_LIMIT = 100;
const CANDIDATE_LIMIT = 5;
// read_note semantic fallback: auto-read the top hit when it's clearly THE note
// (high cosine + a clear gap over the runner-up), else return candidates. Stops
// "read my note about grace" bouncing candidates when it's obviously "On Grace".
// Tuned for bge-m3 (multilingual): its cosine scores run lower than nomic's
// (on-topic ~0.47-0.65, noise ~0.35), so a confident match sits ~0.55, not 0.7.
const READ_NOTE_AUTOREAD_SCORE = Number(process.env.READ_NOTE_AUTOREAD_SCORE ?? 0.55);
const READ_NOTE_MARGIN = 0.08;

/** Bad tool arguments — reported back to the model as {error}, never thrown out. */
class ToolArgError extends Error {}

type Args = Record<string, unknown>;

/** LLM tool surface over KnowledgeService — the assistant writes AND recalls knowledge. */
@Injectable()
export class KnowledgeToolsService {
  readonly tools = KNOWLEDGE_TOOLS;

  constructor(private readonly knowledge: KnowledgeService) {}

  routingPrompt(): string {
    return KNOWLEDGE_ROUTING;
  }

  /** Run one tool call; result (or {error}) JSON-serialized for the tool message. */
  async execute(call: LlmToolCall, ctx?: ToolContext): Promise<string> {
    try {
      const args = (call.arguments ?? {}) as Args;
      switch (call.name) {
        case 'save_note':
          return JSON.stringify(await this.saveNote(args, ctx?.images ?? []));
        case 'read_note':
          return JSON.stringify(await this.readNote(args));
        case 'list_notes':
          return JSON.stringify(await this.listNotes(args));
        case 'move_note':
          return JSON.stringify(await this.moveNote(args));
        default:
          return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
    } catch (err) {
      if (err instanceof ToolArgError) return JSON.stringify({ error: err.message });
      throw err;
    }
  }

  private async saveNote(args: Args, images: RequestImage[] = []) {
    const title = requiredString(args.title, 'title');
    const markdown = withImageEmbeds(requiredString(args.markdown, 'markdown'), images);
    const folder = optionalFolder(args.folder);
    const tags = optionalTags(args.tags);
    const summary = optionalString(args.summary, 'summary');
    const item = await this.knowledge.ingest({
      title,
      markdown,
      source: 'chat',
      folder: folder ?? undefined,
      tags: tags ?? undefined,
      summary: summary ?? undefined,
    });
    return { saved: true, item_id: item.id, path: item.path, title: item.title };
  }

  /**
   * Resolve one note from {path|title}. Order:
   *   path (exact) → title (exact, case-insensitive) → confident semantic.
   * Returns {item} when unambiguous; otherwise a found:false payload with
   * candidates for the assistant to disambiguate — never guesses a fuzzy match.
   * Shared by read_note and move_note so both resolve identically.
   */
  private async resolve(
    args: Args,
  ): Promise<{ item: KnowledgeItem } | { found: false; candidates: unknown[]; message: string }> {
    const path = optionalString(args.path, 'path');
    const title = optionalString(args.title, 'title');
    if (!path && !title) {
      throw new ToolArgError('provide a note title or path');
    }
    const items = await this.knowledge.list();

    if (path) {
      const hit = items.find((i) => i.path === path);
      return hit
        ? { item: hit }
        : { found: false, candidates: [], message: `no note at path "${path}"` };
    }

    const wanted = title!.trim().toLowerCase();
    const exact = items.filter((i) => i.title.trim().toLowerCase() === wanted);
    if (exact.length === 1) return { item: exact[0] };
    if (exact.length > 1) {
      return {
        found: false,
        candidates: exact.slice(0, CANDIDATE_LIMIT).map(cite),
        message: `several notes are titled "${title}" — ask the user which path`,
      };
    }

    // No exact title — fall back to semantics. Accept a confident single match
    // (high score + clear gap over #2); otherwise offer candidates to disambiguate.
    const hits = (await this.knowledge.search(title!, CANDIDATE_LIMIT)).filter(
      (h) => h.type === 'knowledge',
    );
    if (hits.length === 0) {
      return { found: false, candidates: [], message: `no note found matching "${title}"` };
    }
    const top = hits[0];
    const clearGap = hits.length === 1 || top.score - hits[1].score >= READ_NOTE_MARGIN;
    if (top.score >= READ_NOTE_AUTOREAD_SCORE && clearGap) {
      const item = items.find((i) => i.path === top.path);
      if (item) return { item };
    }
    return {
      found: false,
      candidates: hits.map((h) => ({ title: h.title, path: h.path })),
      message: `no exact title match for "${title}" — closest notes offered as candidates`,
    };
  }

  /** Recall one note in full (see resolve for how the note is identified). */
  private async readNote(args: Args) {
    const resolved = await this.resolve(args);
    if (!('item' in resolved)) return resolved;
    return this.body(resolved.item.id);
  }

  /** Relocate a note to another folder (see resolve for identification). */
  private async moveNote(args: Args) {
    const folder = requiredFolder(args.folder);
    const resolved = await this.resolve(args);
    if (!('item' in resolved)) return resolved;
    const moved = await this.knowledge.move(resolved.item.id, folder);
    return { moved: true, ...moved };
  }

  private async body(id: string) {
    const item = await this.knowledge.get(id);
    return {
      found: true,
      title: item.title,
      path: item.path,
      tags: item.tags,
      summary: item.summary ?? undefined,
      markdown: item.body,
    };
  }

  private async listNotes(args: Args) {
    const folder = optionalFolder(args.folder);
    const tag = optionalString(args.tag, 'tag')?.trim().toLowerCase();
    let items = await this.knowledge.list();
    if (folder) items = items.filter((i) => i.path === `${folder}` || i.path.startsWith(`${folder}/`));
    if (tag) items = items.filter((i) => i.tags.some((t) => t.toLowerCase() === tag));
    const notes = items.slice(0, LIST_LIMIT).map(cite);
    return { count: notes.length, notes };
  }
}

/**
 * Prepend `![](url)` embeds for any image attached this turn that the model didn't
 * already reference — so a dictated note reliably keeps its photo as a visual
 * reference (vision is dormant; the model writes the text, we attach the image).
 * Dedup-safe: an already-embedded URL is skipped, so no doubles.
 */
function withImageEmbeds(markdown: string, images: RequestImage[]): string {
  const embeds = images
    .filter((im) => !markdown.includes(im.url))
    .map((im) => `![](${im.url})`);
  return embeds.length ? `${embeds.join('\n')}\n\n${markdown}` : markdown;
}

/** A note reference the assistant can quote or feed back into read_note. */
function cite(i: { title: string; path: string; tags: string[]; summary: string | null }) {
  return { title: i.title, path: i.path, tags: i.tags, summary: i.summary ?? undefined };
}

function requiredString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolArgError(`${field} must be a non-empty string`);
  }
  return v.trim();
}

function optionalString(v: unknown, field: string): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new ToolArgError(`${field} must be a string`);
  return v;
}

/** Vault-relative folder — plain path segments only, no escaping the vault. */
function optionalFolder(v: unknown): string | null {
  const folder = optionalString(v, 'folder');
  if (folder === null) return null;
  const clean = folder.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new ToolArgError('folder must be a relative vault path like "articles"');
  }
  return clean;
}

// Mirrors the vault's own folder rule so a bad target is reported as {error}
// instead of crashing the tool loop with a BadRequestException.
const FOLDER_RE = /^[a-z0-9][a-z0-9/_-]*$/;
function requiredFolder(v: unknown): string {
  const folder = optionalFolder(v);
  if (!folder) throw new ToolArgError('provide a target folder to move the note to');
  if (!FOLDER_RE.test(folder)) {
    throw new ToolArgError(`invalid folder "${folder}" — use lowercase, e.g. faith/sermons or faith/reflections`);
  }
  return folder;
}

function optionalTags(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new ToolArgError('tags must be an array of non-empty strings');
  }
  return v.map((t: string) => t.trim().toLowerCase());
}
