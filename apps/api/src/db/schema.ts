import {
  boolean,
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
// Enrichment (issue #8): worker sets `done`; api-side poller takes done →
// enriching → enriched (vault article created) or enrich_error (retryable).
export const sermonJobs = pgTable('sermon_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  status: text('status', {
    enum: [
      'queued',
      'processing',
      'done',
      'error',
      'enriching',
      'enriched',
      'enrich_error',
    ],
  })
    .notNull()
    .default('queued'),
  /** Filename as uploaded, e.g. "2026-07-12 John Piper.mp3" (or a URL job's title). */
  originalFilename: text('original_filename').notNull(),
  /** Path relative to UPLOADS_PATH; NULL for a URL job until the worker downloads. */
  audioPath: text('audio_path'),
  /** Source URL for a URL job (yt-dlp downloads it); NULL for an uploaded file. */
  sourceUrl: text('source_url'),
  /** Enrichment style: 'sermon' (→faith/sermons) | 'general' (→articles). */
  style: text('style').notNull().default('sermon'),
  /** Set when status = error. */
  error: text('error'),
  /** Full transcript, set when status = done. */
  transcript: text('transcript'),
  /** Upload metadata (optional): who preached, when, and a preferred title. */
  speaker: text('speaker'),
  sermonDate: date('sermon_date'),
  title: text('title'),
  /**
   * Vault article distilled from the transcript (null = not enriched yet).
   * set null on delete: rebuild-index wipes knowledge_items, then re-links via
   * the item's `source: sermon:<jobId>` frontmatter (canonical provenance).
   */
  articleItemId: uuid('article_item_id').references(() => knowledgeItems.id, {
    onDelete: 'set null',
  }),
  /** Vault-relative article path, denormalized for cheap job views. */
  articlePath: text('article_path'),
  /** Set when status = enrich_error; cleared on successful (re)enrichment. */
  enrichError: text('enrich_error'),
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

/**
 * Dynamic metric log — one row per measurement, nothing hardcoded per metric.
 * `name` is normalized lowercase snake_case with the unit baked in where natural
 * (weight_kg, height_cm, sleep_hours, protein_g); `unit` is a free-text fallback.
 */
export const metricEntries = pgTable(
  'metric_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    date: date('date').notNull(),
    value: numeric('value').notNull(),
    unit: text('unit'),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('metric_entries_name_date_idx').on(t.name, t.date)],
);

export const goals = pgTable('goals', {
  id: uuid('id').defaultRandom().primaryKey(),
  text: text('text').notNull(),
  done: boolean('done').notNull().default(false),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
});

// AI organization suggestions (slice 12, issue #12). Generated on ingest, user
// decides — never auto-applied. Rows are ephemeral review state (not rebuilt
// by rebuild-index); accepted effects land in the vault, the canonical store.
export const SUGGESTION_KINDS = ['tag', 'link', 'duplicate', 'summary'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];
export const suggestionKind = pgEnum('suggestion_kind', SUGGESTION_KINDS);

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export const suggestionStatus = pgEnum('suggestion_status', SUGGESTION_STATUSES);

/**
 * Per-kind payload shapes:
 * tag → {tag}; link → {toPath, type}; duplicate → {duplicateOfPath, similarity};
 * summary → {summary}.
 */
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    kind: suggestionKind('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: suggestionStatus('status').notNull().default('pending'),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
    /** Set when status leaves pending. */
    resolved: timestamp('resolved', { withTimezone: true }),
  },
  (t) => [
    index('suggestions_item_id_idx').on(t.itemId),
    index('suggestions_status_idx').on(t.status),
  ],
);

/**
 * Original uploaded files (docx/pptx/pdf/images) — the RAW source behind a note,
 * kept so the user never loses the original. Blobs live on disk under
 * ATTACHMENTS_PATH (deduped by sha256), NOT in the git vault. `itemId` links an
 * attachment to the knowledge note distilled from it (null when unlinked or the
 * note is deleted). Markdown references the blob by URL (GET /api/attachments/:id).
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Filename as uploaded, e.g. "MindofChrist.pptx". */
    filename: text('filename').notNull(),
    /** MIME type, e.g. application/pdf, image/png. */
    mime: text('mime').notNull(),
    /** Size in bytes. */
    size: integer('size').notNull(),
    /** sha256 of the bytes — dedupe key + on-disk name. */
    sha256: text('sha256').notNull(),
    /** Path relative to ATTACHMENTS_PATH (host/container mounts differ). */
    diskPath: text('disk_path').notNull(),
    /** The note distilled from this file, if any. */
    itemId: uuid('item_id').references(() => knowledgeItems.id, { onDelete: 'set null' }),
    created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attachments_sha256_idx').on(t.sha256),
    index('attachments_item_id_idx').on(t.itemId),
  ],
);
