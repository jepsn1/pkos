import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  knowledgeItems,
  suggestions,
  SUGGESTION_KINDS,
  SUGGESTION_STATUSES,
  type SuggestionKind,
  type SuggestionStatus,
} from '../db/schema';

export type { SuggestionKind, SuggestionStatus };
export { SUGGESTION_KINDS, SUGGESTION_STATUSES };

export const SUGGESTION_REPO = 'SUGGESTION_REPO';

export function isSuggestionStatus(v: unknown): v is SuggestionStatus {
  return typeof v === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(v);
}

export interface Suggestion {
  id: string;
  itemId: string;
  kind: SuggestionKind;
  /** tag → {tag}; link → {toPath, type}; duplicate → {duplicateOfPath, similarity}; summary → {summary} */
  payload: Record<string, unknown>;
  status: SuggestionStatus;
  created: Date;
  resolved: Date | null;
}

/** List rows carry the target item's path/title for review UIs. */
export interface SuggestionWithItem extends Suggestion {
  path: string;
  title: string;
}

/** Cosine neighbor of an item, computed from stored embeddings. */
export interface SimilarItem {
  id: string;
  path: string;
  title: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

/** Patch applied to a knowledge_items row when a suggestion is accepted. */
export interface ItemMetaPatch {
  tags?: string[];
  summary?: string;
  embedding?: number[];
}

/** Suggestion store + the knowledge_items reads/writes accepting needs. Faked in tests. */
export interface SuggestionRepo {
  create(itemId: string, kind: SuggestionKind, payload: Record<string, unknown>): Promise<Suggestion>;
  list(status?: SuggestionStatus): Promise<SuggestionWithItem[]>;
  getById(id: string): Promise<Suggestion | null>;
  /** Pending suggestions for one item (dedup guard for re-triggered generation). */
  listPendingByItem(itemId: string): Promise<Suggestion[]>;
  /** pending → status; null when the row is missing or already resolved. */
  resolve(id: string, status: 'accepted' | 'rejected'): Promise<Suggestion | null>;
  /** Cosine neighbors of an item using its stored embedding (item itself excluded). */
  similarTo(itemId: string, limit: number): Promise<SimilarItem[]>;
  /** Distinct tags across all knowledge items, sorted. */
  tagVocabulary(): Promise<string[]>;
  /** Apply an accepted suggestion's derived-row side (vault write happens first). */
  updateItemMeta(itemId: string, patch: ItemMetaPatch): Promise<void>;
}

const SUGGESTION_COLUMNS = {
  id: suggestions.id,
  itemId: suggestions.itemId,
  kind: suggestions.kind,
  payload: suggestions.payload,
  status: suggestions.status,
  created: suggestions.created,
  resolved: suggestions.resolved,
};

export class DrizzleSuggestionRepo implements SuggestionRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async create(
    itemId: string,
    kind: SuggestionKind,
    payload: Record<string, unknown>,
  ): Promise<Suggestion> {
    const [row] = await this.db
      .insert(suggestions)
      .values({ itemId, kind, payload })
      .returning(SUGGESTION_COLUMNS);
    return row;
  }

  async list(status?: SuggestionStatus): Promise<SuggestionWithItem[]> {
    return this.db
      .select({
        ...SUGGESTION_COLUMNS,
        path: knowledgeItems.path,
        title: knowledgeItems.title,
      })
      .from(suggestions)
      .innerJoin(knowledgeItems, eq(knowledgeItems.id, suggestions.itemId))
      .where(status ? eq(suggestions.status, status) : undefined)
      .orderBy(desc(suggestions.created));
  }

  async getById(id: string): Promise<Suggestion | null> {
    const [row] = await this.db
      .select(SUGGESTION_COLUMNS)
      .from(suggestions)
      .where(eq(suggestions.id, id));
    return row ?? null;
  }

  async listPendingByItem(itemId: string): Promise<Suggestion[]> {
    return this.db
      .select(SUGGESTION_COLUMNS)
      .from(suggestions)
      .where(and(eq(suggestions.itemId, itemId), eq(suggestions.status, 'pending')));
  }

  async resolve(id: string, status: 'accepted' | 'rejected'): Promise<Suggestion | null> {
    const [row] = await this.db
      .update(suggestions)
      .set({ status, resolved: sql`now()` })
      .where(and(eq(suggestions.id, id), eq(suggestions.status, 'pending')))
      .returning(SUGGESTION_COLUMNS);
    return row ?? null;
  }

  async similarTo(itemId: string, limit: number): Promise<SimilarItem[]> {
    const res = await this.db.execute(sql`
      SELECT k.id, k.path, k.title, 1 - (k.embedding <=> t.embedding) AS score
      FROM knowledge_items k,
           (SELECT embedding FROM knowledge_items WHERE id = ${itemId}::uuid) t
      WHERE k.id <> ${itemId}::uuid
      ORDER BY k.embedding <=> t.embedding
      LIMIT ${limit}
    `);
    return res.rows.map((r) => ({
      id: r.id as string,
      path: r.path as string,
      title: r.title as string,
      score: Number(r.score),
    }));
  }

  async tagVocabulary(): Promise<string[]> {
    const res = await this.db.execute(
      sql`SELECT DISTINCT unnest(tags) AS tag FROM knowledge_items ORDER BY tag`,
    );
    return res.rows.map((r) => r.tag as string);
  }

  async updateItemMeta(itemId: string, patch: ItemMetaPatch): Promise<void> {
    await this.db
      .update(knowledgeItems)
      .set({ ...patch, updated: sql`now()` })
      .where(eq(knowledgeItems.id, itemId));
  }
}
