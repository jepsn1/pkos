import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
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

// Sermon transcription jobs (slice 7, issue #7). PRIMARY data: audio lives on
// disk under UPLOADS_PATH; transcript + chunks exist only here.
export const sermonJobs = pgTable('sermon_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  status: text('status', {
    enum: ['queued', 'processing', 'done', 'error'],
  })
    .notNull()
    .default('queued'),
  /** Filename as uploaded, e.g. "2026-07-12 John Piper.mp3". */
  originalFilename: text('original_filename').notNull(),
  /** Path relative to UPLOADS_PATH (host/container mounts differ). */
  audioPath: text('audio_path').notNull(),
  /** Set when status = error. */
  error: text('error'),
  /** Full transcript, set when status = done. */
  transcript: text('transcript'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  updated: timestamp('updated', { withTimezone: true }).notNull().defaultNow(),
});

/** ~500-word transcript chunks with timestamps, embedded for semantic search. */
export const transcriptChunks = pgTable(
  'transcript_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => sermonJobs.id, { onDelete: 'cascade' }),
    /** 0-based position of the chunk within the transcript. */
    seq: integer('seq').notNull(),
    text: text('text').notNull(),
    startSec: real('start_sec').notNull(),
    endSec: real('end_sec').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
  },
  (t) => [
    index('transcript_chunks_job_id_idx').on(t.jobId),
    index('transcript_chunks_embedding_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);
