import { Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { KnowledgeService } from './knowledge.service';

/** Appended to the chat system prompt so the planner routes "remember this" turns here. */
export const KNOWLEDGE_ROUTING = `You also have a save_note tool that writes to the user's knowledge vault.
- When the user asks you to remember, save, store or note down a fact, preference, idea or piece of information that is NOT a numeric measurement, call save_note with a short title and a clean markdown body capturing it.
- Do NOT call save_note for numeric measurements (those go to log_metric) or for ordinary questions.
- After save_note succeeds, confirm briefly and mention the saved path from the tool result.`;

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
];

/** Bad tool arguments — reported back to the model as {error}, never thrown out. */
class ToolArgError extends Error {}

type Args = Record<string, unknown>;

/** LLM tool surface over KnowledgeService.ingest — the assistant writes knowledge. */
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
      if (call.name !== 'save_note') {
        return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
      return JSON.stringify(await this.saveNote((call.arguments ?? {}) as Args));
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
