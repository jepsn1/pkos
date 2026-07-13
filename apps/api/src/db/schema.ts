import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

/** nomic-embed-text output dimensions. */
export const EMBEDDING_DIM = 768;

// DERIVED data only — canonical source is the markdown vault (jepsn1/knowledge).
// Every row must be rebuildable from vault frontmatter + body (`rebuild-index`).
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Vault-relative path, e.g. faith/reflections/on-grace.md */
    path: text('path').notNull().unique(),
    title: text('title').notNull(),
    source: text('source'),
    tags: text('tags').array().notNull().default([]),
    summary: text('summary'),
    importance: integer('importance'),
    created: date('created').notNull(),
    updated: timestamp('updated', { withTimezone: true }).notNull().defaultNow(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  },
  (t) => [
    index('knowledge_items_embedding_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);

/** Knowledge item cited by an assistant answer (stored as jsonb on the message). */
export interface Citation {
  path: string;
  title: string;
  /** Cosine similarity of the item to the query, [-1, 1]. */
  score: number;
}

// PRIMARY data (unlike knowledge_items): conversations exist only here.
export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Derived from the first user message, truncated. */
  title: text('title').notNull(),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  updated: timestamp('updated', { withTimezone: true }).notNull().defaultNow(),
  /**
   * Knowledge item this conversation was distilled into (null = plain history).
   * set null on delete: rebuild-index wipes knowledge_items, then re-links via
   * the item's `source: conversation:<id>` frontmatter (canonical provenance).
   */
  savedItemId: uuid('saved_item_id').references(() => knowledgeItems.id, {
    onDelete: 'set null',
  }),
});

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    /** Assistant messages only: knowledge items the answer was grounded in. */
    citations: jsonb('citations').$type<Citation[]>(),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_id_idx').on(t.conversationId)],
);
