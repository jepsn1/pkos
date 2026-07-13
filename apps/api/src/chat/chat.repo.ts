import { asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { conversations, knowledgeItems, messages, type Citation } from '../db/schema';

export const CHAT_REPO = 'CHAT_REPO';

export type { Citation };

export interface Conversation {
  id: string;
  title: string;
  created: Date;
  updated: Date;
  /** Knowledge item this conversation was saved as; null = plain history. */
  savedItemId: string | null;
}

/** List row: saved status resolved to the vault path for display. */
export interface ConversationListItem extends Conversation {
  savedPath: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[] | null;
  created: Date;
}

export type NewMessage = Omit<Message, 'id' | 'created'>;

/** Conversation store. Faked in tests, Drizzle in prod. */
export interface ChatRepo {
  createConversation(title: string): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  listConversations(): Promise<ConversationListItem[]>;
  /** Bump `updated` so the list orders by recent activity. */
  touchConversation(id: string): Promise<void>;
  /** Point the conversation at the knowledge item it was saved as. */
  setSavedItem(conversationId: string, itemId: string): Promise<void>;
  addMessage(msg: NewMessage): Promise<Message>;
  /** Oldest first. */
  listMessages(conversationId: string): Promise<Message[]>;
}

export class DrizzleChatRepo implements ChatRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async createConversation(title: string): Promise<Conversation> {
    const [row] = await this.db.insert(conversations).values({ title }).returning();
    return row;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));
    return row ?? null;
  }

  async listConversations(): Promise<ConversationListItem[]> {
    const rows = await this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        created: conversations.created,
        updated: conversations.updated,
        savedItemId: conversations.savedItemId,
        savedPath: knowledgeItems.path,
      })
      .from(conversations)
      .leftJoin(knowledgeItems, eq(conversations.savedItemId, knowledgeItems.id))
      .orderBy(desc(conversations.updated));
    return rows.map((r) => ({ ...r, savedPath: r.savedPath ?? null }));
  }

  async touchConversation(id: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ updated: sql`now()` })
      .where(eq(conversations.id, id));
  }

  async setSavedItem(conversationId: string, itemId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ savedItemId: itemId })
      .where(eq(conversations.id, conversationId));
  }

  async addMessage(msg: NewMessage): Promise<Message> {
    const [row] = await this.db
      .insert(messages)
      .values({ ...msg, citations: msg.citations ?? undefined })
      .returning();
    return { ...row, citations: row.citations ?? null };
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    // role desc breaks created ties: 'user' sorts after 'assistant', and on
    // equal timestamps the user message of a turn must come first.
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.created), desc(messages.role));
    return rows.map((r) => ({ ...r, citations: r.citations ?? null }));
  }
}
