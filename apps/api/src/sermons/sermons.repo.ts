import { cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sermonJobs, transcriptChunks } from '../db/schema';

export const SERMON_REPO = 'SERMON_REPO';
export const TRANSCRIPT_SEARCH = 'TRANSCRIPT_SEARCH';

export type SermonJobStatus =
  | 'queued'
  | 'processing'
  | 'done'
  | 'error'
  | 'enriching'
  | 'enriched'
  | 'enrich_error';

export interface SermonJob {
  id: string;
  status: SermonJobStatus;
  originalFilename: string;
  /** Relative to UPLOADS_PATH. */
  audioPath: string;
  error: string | null;
  transcript: string | null;
  /** Upload metadata (optional). */
  speaker: string | null;
  /** ISO date (YYYY-MM-DD). */
  sermonDate: string | null;
  title: string | null;
  /** Vault article distilled from the transcript (enrichment, issue #8). */
  articleItemId: string | null;
  articlePath: string | null;
  enrichError: string | null;
  created: Date;
  updated: Date;
}

/** List view: transcript omitted (can be large). */
export type SermonJobSummary = Omit<SermonJob, 'transcript'>;

/** Optional metadata accepted alongside the upload. */
export interface SermonMeta {
  speaker?: string;
  /** ISO date (YYYY-MM-DD). */
  date?: string;
  title?: string;
}

/** Job store for sermon uploads. Faked in tests, Drizzle in prod. */
export interface SermonRepo {
  create(
    originalFilename: string,
    audioPath: string,
    meta?: SermonMeta,
  ): Promise<SermonJob>;
  list(): Promise<SermonJobSummary[]>;
  getById(id: string): Promise<SermonJob | null>;
  /** Atomically take one `done` job without an article → `enriching`; null when none. */
  claimForEnrichment(): Promise<SermonJob | null>;
  /** Manual path: `done`/`enrich_error` → `enriching`; null when not in a retryable state. */
  startEnrichment(id: string): Promise<SermonJob | null>;
  /** `enriching` → `enriched`, store the article pointer, clear enrich_error. */
  completeEnrichment(id: string, itemId: string, path: string): Promise<void>;
  /** `enriching` → `enrich_error` with the message; transcript untouched. */
  failEnrichment(id: string, message: string): Promise<void>;
}

/** A transcript chunk matched by semantic search. */
export interface SermonSearchHit {
  id: string;
  jobId: string;
  /** Original upload filename of the sermon the chunk belongs to. */
  title: string;
  text: string;
  seq: number;
  startSec: number;
  endSec: number;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

/** Cosine search over transcript chunks. Faked in tests, Drizzle in prod. */
export interface TranscriptSearch {
  search(embedding: number[], limit: number): Promise<SermonSearchHit[]>;
}

const SUMMARY_COLUMNS = {
  id: sermonJobs.id,
  status: sermonJobs.status,
  originalFilename: sermonJobs.originalFilename,
  audioPath: sermonJobs.audioPath,
  error: sermonJobs.error,
  speaker: sermonJobs.speaker,
  sermonDate: sermonJobs.sermonDate,
  title: sermonJobs.title,
  articleItemId: sermonJobs.articleItemId,
  articlePath: sermonJobs.articlePath,
  enrichError: sermonJobs.enrichError,
  created: sermonJobs.created,
  updated: sermonJobs.updated,
};

export class DrizzleSermonRepo implements SermonRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async create(
    originalFilename: string,
    audioPath: string,
    meta: SermonMeta = {},
  ): Promise<SermonJob> {
    const [row] = await this.db
      .insert(sermonJobs)
      .values({
        originalFilename,
        audioPath,
        speaker: meta.speaker ?? null,
        sermonDate: meta.date ?? null,
        title: meta.title ?? null,
      })
      .returning();
    return row;
  }

  async list(): Promise<SermonJobSummary[]> {
    return this.db
      .select(SUMMARY_COLUMNS)
      .from(sermonJobs)
      .orderBy(desc(sermonJobs.created));
  }

  async getById(id: string): Promise<SermonJob | null> {
    const [row] = await this.db
      .select()
      .from(sermonJobs)
      .where(eq(sermonJobs.id, id));
    return row ?? null;
  }

  // FOR UPDATE SKIP LOCKED: several api instances / a concurrent manual trigger
  // never enrich the same job twice.
  async claimForEnrichment(): Promise<SermonJob | null> {
    const [row] = await this.db
      .update(sermonJobs)
      .set({ status: 'enriching', updated: sql`now()` })
      .where(
        eq(
          sermonJobs.id,
          sql`(
            SELECT id FROM sermon_jobs
            WHERE status = 'done' AND article_item_id IS NULL
            ORDER BY created
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )`,
        ),
      )
      .returning();
    return row ?? null;
  }

  async startEnrichment(id: string): Promise<SermonJob | null> {
    const [row] = await this.db
      .update(sermonJobs)
      .set({ status: 'enriching', updated: sql`now()` })
      .where(
        sql`${sermonJobs.id} = ${id} AND ${sermonJobs.status} IN ('done', 'enrich_error')`,
      )
      .returning();
    return row ?? null;
  }

  async completeEnrichment(id: string, itemId: string, path: string): Promise<void> {
    await this.db
      .update(sermonJobs)
      .set({
        status: 'enriched',
        articleItemId: itemId,
        articlePath: path,
        enrichError: null,
        updated: sql`now()`,
      })
      .where(eq(sermonJobs.id, id));
  }

  async failEnrichment(id: string, message: string): Promise<void> {
    await this.db
      .update(sermonJobs)
      .set({
        status: 'enrich_error',
        enrichError: message.slice(0, 2000),
        updated: sql`now()`,
      })
      .where(eq(sermonJobs.id, id));
  }
}

export class DrizzleTranscriptSearch implements TranscriptSearch {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async search(embedding: number[], limit: number): Promise<SermonSearchHit[]> {
    const distance = cosineDistance(transcriptChunks.embedding, embedding);
    const rows = await this.db
      .select({
        id: transcriptChunks.id,
        jobId: transcriptChunks.jobId,
        title: sermonJobs.originalFilename,
        text: transcriptChunks.text,
        seq: transcriptChunks.seq,
        startSec: transcriptChunks.startSec,
        endSec: transcriptChunks.endSec,
        score: sql<string>`1 - (${distance})`,
      })
      .from(transcriptChunks)
      .innerJoin(sermonJobs, eq(transcriptChunks.jobId, sermonJobs.id))
      .orderBy(distance)
      .limit(limit);
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }
}
