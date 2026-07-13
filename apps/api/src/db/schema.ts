import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
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
