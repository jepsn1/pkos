import { cosineDistance, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { knowledgeItems } from '../db/schema';

export const KNOWLEDGE_REPO = 'KNOWLEDGE_REPO';

export interface KnowledgeItem {
  id: string;
  path: string;
  title: string;
  source: string | null;
  tags: string[];
  summary: string | null;
  importance: number | null;
  created: string;
  updated: Date;
}

export type NewKnowledgeItem = Omit<KnowledgeItem, 'id' | 'updated'> & {
  embedding: number[];
};

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  summary: string | null;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

/** Derived-data store for knowledge items. Faked in tests, Drizzle in prod. */
export interface KnowledgeRepo {
  upsert(item: NewKnowledgeItem): Promise<KnowledgeItem>;
  list(): Promise<KnowledgeItem[]>;
  getById(id: string): Promise<KnowledgeItem | null>;
  search(embedding: number[], limit: number): Promise<SearchHit[]>;
  wipe(): Promise<void>;
}

const ITEM_COLUMNS = {
  id: knowledgeItems.id,
  path: knowledgeItems.path,
  title: knowledgeItems.title,
  source: knowledgeItems.source,
  tags: knowledgeItems.tags,
  summary: knowledgeItems.summary,
  importance: knowledgeItems.importance,
  created: knowledgeItems.created,
  updated: knowledgeItems.updated,
};

export class DrizzleKnowledgeRepo implements KnowledgeRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async upsert(item: NewKnowledgeItem): Promise<KnowledgeItem> {
    const [row] = await this.db
      .insert(knowledgeItems)
      .values(item)
      .onConflictDoUpdate({
        target: knowledgeItems.path,
        set: { ...item, updated: sql`now()` },
      })
      .returning(ITEM_COLUMNS);
    return row;
  }

  async list(): Promise<KnowledgeItem[]> {
    return this.db.select(ITEM_COLUMNS).from(knowledgeItems).orderBy(knowledgeItems.path);
  }

  async getById(id: string): Promise<KnowledgeItem | null> {
    const [row] = await this.db
      .select(ITEM_COLUMNS)
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, id));
    return row ?? null;
  }

  async search(embedding: number[], limit: number): Promise<SearchHit[]> {
    const distance = cosineDistance(knowledgeItems.embedding, embedding);
    const rows = await this.db
      .select({
        id: knowledgeItems.id,
        path: knowledgeItems.path,
        title: knowledgeItems.title,
        summary: knowledgeItems.summary,
        score: sql<string>`1 - (${distance})`,
      })
      .from(knowledgeItems)
      .orderBy(distance)
      .limit(limit);
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  async wipe(): Promise<void> {
    await this.db.delete(knowledgeItems);
  }
}
