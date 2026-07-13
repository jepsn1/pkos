import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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

/** PRD "Knowledge Relationships" edge types. */
export const RELATIONSHIP_TYPES = [
  'related_to',
  'references',
  'supports',
  'contradicts',
  'parent',
  'child',
  'mentioned_in',
  'written_by',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const relationshipType = pgEnum('relationship_type', RELATIONSHIP_TYPES);

// DERIVED data — canonical form is `relationships: [{type, path}]` in the from-item's
// vault frontmatter. `rebuild-index` second pass restores these rows (paths → ids).
export const relationships = pgTable(
  'relationships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fromItem: uuid('from_item')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    toItem: uuid('to_item')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    type: relationshipType('type').notNull(),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('relationships_from_to_type_uq').on(t.fromItem, t.toItem, t.type),
    index('relationships_from_item_idx').on(t.fromItem),
    index('relationships_to_item_idx').on(t.toItem),
  ],
);

/** Knowledge item cited by an assistant answer (stored as jsonb on the message). */
export interface Citation {
  path: string;
  title: string;
  /** Cosine similarity of the item to the query, [-1, 1]. Absent for graph-sourced items. */
  score?: number;
  /** 'graph' when the item entered context via a relationship edge, not vector search. */
  via?: 'graph';
  /** Relationship label for graph-sourced items, e.g. 'related_to' or 'references (incoming)'. */
  relation?: string;
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
