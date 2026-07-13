import { asc, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { conversations, messages, type Citation } from '../db/schema';

export const CHAT_REPO = 'CHAT_REPO';

export type { Citation };

export interface Conversation {
  id: string;
  title: string;
  created: Date;
  updated: Date;
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
  listConversations(): Promise<Conversation[]>;
  /** Bump `updated` so the list orders by recent activity. */
  touchConversation(id: string): Promise<void>;
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

  async listConversations(): Promise<Conversation[]> {
    return this.db.select().from(conversations).orderBy(desc(conversations.updated));
  }

  async touchConversation(id: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ updated: sql`now()` })
      .where(eq(conversations.id, id));
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
