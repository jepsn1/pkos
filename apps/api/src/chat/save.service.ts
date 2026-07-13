import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KNOWLEDGE_REPO, type KnowledgeRepo } from '../knowledge/knowledge.repo';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { CHAT_REPO, type ChatRepo, type Conversation, type Message } from './chat.repo';
import { LLM_PROVIDER, stripThink, type LlmProvider } from './llm.provider';

export interface SaveOptions {
  /** Vault folder for the article (default `conversations`). */
  folder?: string;
  /** Re-distill an already-saved conversation into a new file (else 409). */
  force?: boolean;
}

export interface SaveResult {
  itemId: string;
  path: string;
  title: string;
}

/** What the distill LLM must produce for one conversation. */
export interface Distilled {
  title: string;
  summary: string;
  tags: string[];
  markdown: string;
}

const DEFAULT_FOLDER = 'conversations';

const DISTILL_SYSTEM = `You distill a chat conversation into a durable knowledge-base article.
Write a structured markdown article (headings, short sections) that keeps the key insights,
facts and conclusions of the conversation. Do NOT dump the transcript or narrate turns
("the user asked..."); write the knowledge itself, timelessly.

Respond with ONLY a JSON object, no other text:
{
  "title": "short descriptive article title",
  "summary": "1-2 sentence summary of the article",
  "tags": ["lowercase", "topic", "tags"],
  "markdown": "the article body in markdown (no frontmatter, no top-level title heading)"
}`;

/**
 * PRD Long-Term Memory: valuable conversation -> distilled markdown article in the
 * vault (via KnowledgeService.ingest: file + git commit + row + embedding), with the
 * conversation pointing at the item and the item's frontmatter pointing back
 * (`source: conversation:<id>`).
 */
@Injectable()
export class SaveService {
  constructor(
    @Inject(CHAT_REPO) private readonly repo: ChatRepo,
    @Inject(KNOWLEDGE_REPO) private readonly knowledgeRepo: KnowledgeRepo,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly knowledge: KnowledgeService,
  ) {}

  async save(conversationId: string, opts: SaveOptions = {}): Promise<SaveResult> {
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw new NotFoundException(`no conversation ${conversationId}`);

    if (conversation.savedItemId && !opts.force) {
      const existing = await this.knowledgeRepo.getById(conversation.savedItemId);
      throw new ConflictException({
        message: 'conversation already saved (use force:true to save again)',
        itemId: conversation.savedItemId,
        path: existing?.path ?? null,
      });
    }

    const messages = await this.repo.listMessages(conversationId);
    if (messages.length === 0) {
      throw new BadRequestException('conversation has no messages to save');
    }

    const distilled = await this.distill(conversation, messages);
    const item = await this.knowledge.ingest({
      title: distilled.title,
      markdown: distilled.markdown,
      source: `conversation:${conversationId}`,
      tags: distilled.tags,
      summary: distilled.summary,
      folder: opts.folder ?? DEFAULT_FOLDER,
    });
    await this.repo.setSavedItem(conversationId, item.id);

    return { itemId: item.id, path: item.path, title: item.title };
  }

  private async distill(
    conversation: Conversation,
    messages: Message[],
  ): Promise<Distilled> {
    const transcript = messages.map((m) => `${m.role}:\n${m.content}`).join('\n\n');
    const raw = stripThink(
      await this.llm.chat([
        { role: 'system', content: DISTILL_SYSTEM },
        {
          role: 'user',
          content: `Conversation "${conversation.title}":\n\n${transcript}`,
        },
      ]),
    );
    return parseDistilled(raw);
  }
}

/** Lenient parse of the distill answer: tolerate code fences / prose around the JSON. */
export function parseDistilled(raw: string): Distilled {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw badDistill(raw);
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw badDistill(raw);
  }
  const d = data as Partial<Record<keyof Distilled, unknown>>;
  if (
    typeof d.title !== 'string' ||
    !d.title.trim() ||
    typeof d.markdown !== 'string' ||
    !d.markdown.trim()
  ) {
    throw badDistill(raw);
  }
  return {
    title: d.title.trim(),
    summary: typeof d.summary === 'string' ? d.summary.trim() : '',
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    markdown: d.markdown.trim(),
  };
}

function badDistill(raw: string): Error {
  return new Error(`LLM distill output not usable JSON: ${raw.slice(0, 200)}`);
}
