import { cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sermonJobs, transcriptChunks } from '../db/schema';

export const SERMON_REPO = 'SERMON_REPO';
export const TRANSCRIPT_SEARCH = 'TRANSCRIPT_SEARCH';

export type SermonJobStatus = 'queued' | 'processing' | 'done' | 'error';

export interface SermonJob {
  id: string;
  status: SermonJobStatus;
  originalFilename: string;
  /** Relative to UPLOADS_PATH. */
  audioPath: string;
  error: string | null;
  transcript: string | null;
  created: Date;
  updated: Date;
}

/** List view: transcript omitted (can be large). */
export type SermonJobSummary = Omit<SermonJob, 'transcript'>;

/** Job store for sermon uploads. Faked in tests, Drizzle in prod. */
export interface SermonRepo {
  create(originalFilename: string, audioPath: string): Promise<SermonJob>;
  list(): Promise<SermonJobSummary[]>;
  getById(id: string): Promise<SermonJob | null>;
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
  created: sermonJobs.created,
  updated: sermonJobs.updated,
};

export class DrizzleSermonRepo implements SermonRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async create(originalFilename: string, audioPath: string): Promise<SermonJob> {
    const [row] = await this.db
      .insert(sermonJobs)
      .values({ originalFilename, audioPath })
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
