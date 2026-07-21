import { Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { KnowledgeService } from './knowledge.service';

/** Appended to the chat system prompt so the planner routes knowledge turns here. */
export const KNOWLEDGE_ROUTING = `You also have tools over the user's knowledge vault:
- save_note (WRITE): when the user asks you to remember, save, store or note down a fact, preference, idea or piece of information that is NOT a numeric measurement, call it with a short title and a clean markdown body. Do NOT use it for numeric measurements (those go to log_metric) or ordinary questions. After it succeeds, confirm briefly and mention the saved path.
- read_note (RECALL): when the user asks you to read back, recall, show or quote a SPECIFIC saved note ("read me my note on X", "what did I write about Y"), call it with the note's title (or exact path). It returns the note's FULL markdown so you can quote or summarise it. If it returns candidates instead of a note, ask the user which one; if it finds nothing, say so plainly.
- list_notes (BROWSE): when the user asks what they've saved or to browse notes ("what notes do I have on faith", "list my articles", "what do we have in fitness"), ALWAYS call it — pass the folder they named (faith, fitness, articles, books, programming) as the folder argument. Never answer a "what do I have / list" question from earlier turns or memory; call the tool fresh every time, because the folder changes between questions. If it returns count 0, say plainly that that folder has no notes yet — do NOT repeat a list from a previous answer.
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
          description: 'Vault folder, e.g. articles or faith. Omit for the default.',
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
];

/** How many notes list_notes returns at most, and how many recall candidates we offer. */
const LIST_LIMIT = 100;
const CANDIDATE_LIMIT = 5;
// read_note semantic fallback: auto-read the top hit when it's clearly THE note
// (high cosine + a clear gap over the runner-up), else return candidates. Stops
// "read my note about grace" bouncing candidates when it's obviously "On Grace".
const READ_NOTE_AUTOREAD_SCORE = 0.7;
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
  async execute(call: LlmToolCall): Promise<string> {
    try {
      const args = (call.arguments ?? {}) as Args;
      switch (call.name) {
        case 'save_note':
          return JSON.stringify(await this.saveNote(args));
        case 'read_note':
          return JSON.stringify(await this.readNote(args));
        case 'list_notes':
          return JSON.stringify(await this.listNotes(args));
        default:
          return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
    } catch (err) {
      if (err instanceof ToolArgError) return JSON.stringify({ error: err.message });
      throw err;
    }
  }

  private async saveNote(args: Args) {
    const title = requiredString(args.title, 'title');
    const markdown = requiredString(args.markdown, 'markdown');
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
   * Recall one note in full. Resolution order:
   *   path (exact) → title (exact, case-insensitive) → semantic fallback.
   * Never auto-reads a fuzzy guess: an ambiguous or fuzzy-only match returns
   * candidates for the assistant to disambiguate rather than a note body.
   */
  private async readNote(args: Args) {
    const path = optionalString(args.path, 'path');
    const title = optionalString(args.title, 'title');
    if (!path && !title) {
      throw new ToolArgError('provide a note title or path to read');
    }
    const items = await this.knowledge.list();

    if (path) {
      const hit = items.find((i) => i.path === path);
      if (!hit) return { found: false, candidates: [], message: `no note at path "${path}"` };
      return this.body(hit.id);
    }

    const wanted = title!.trim().toLowerCase();
    const exact = items.filter((i) => i.title.trim().toLowerCase() === wanted);
    if (exact.length === 1) return this.body(exact[0].id);
    if (exact.length > 1) {
      return {
        found: false,
        candidates: exact.slice(0, CANDIDATE_LIMIT).map(cite),
        message: `several notes are titled "${title}" — ask the user which path`,
      };
    }

    // No exact title — fall back to semantics. Auto-read a confident single match
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
      return this.body(top.id);
    }
    return {
      found: false,
      candidates: hits.map((h) => ({ title: h.title, path: h.path })),
      message: `no exact title match for "${title}" — closest notes offered as candidates`,
    };
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

function optionalTags(v: unknown): string[] | null {
  if (v == null) return null;
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new ToolArgError('tags must be an array of non-empty strings');
  }
  return v.map((t: string) => t.trim().toLowerCase());
}
