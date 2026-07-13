import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  numeric,
  pgTable,
  real,
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

// Fitness (slice 11) — PRIMARY data: workouts, body metrics, goals live only here.
export const workouts = pgTable('workouts', {
  id: uuid('id').defaultRandom().primaryKey(),
  date: date('date').notNull(),
  notes: text('notes'),
});

export const workoutSets = pgTable(
  'workout_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workoutId: uuid('workout_id')
      .notNull()
      .references(() => workouts.id, { onDelete: 'cascade' }),
    /** Normalized lowercase, e.g. "bench press". */
    exercise: text('exercise').notNull(),
    /** 1-based position of the set within the exercise. */
    setNo: integer('set_no').notNull(),
    reps: integer('reps').notNull(),
    /** Null for bodyweight sets. */
    weightKg: numeric('weight_kg', { precision: 6, scale: 2 }),
  },
  (t) => [
    index('workout_sets_workout_id_idx').on(t.workoutId),
    index('workout_sets_exercise_idx').on(t.exercise),
  ],
);

export const bodyMetrics = pgTable(
  'body_metrics',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    date: date('date').notNull(),
    weightKg: numeric('weight_kg', { precision: 5, scale: 2 }),
    calories: integer('calories'),
    proteinG: numeric('protein_g', { precision: 6, scale: 1 }),
  },
  (t) => [
    check(
      'body_metrics_at_least_one',
      sql`${t.weightKg} IS NOT NULL OR ${t.calories} IS NOT NULL OR ${t.proteinG} IS NOT NULL`,
    ),
  ],
);

export const goals = pgTable('goals', {
  id: uuid('id').defaultRandom().primaryKey(),
  text: text('text').notNull(),
  done: boolean('done').notNull().default(false),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
});
