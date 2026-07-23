import { desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { visionJobs } from '../db/schema';

export const VISION_REPO = 'VISION_REPO';

export type VisionJobStatus = 'pending' | 'running' | 'done' | 'error';

export interface VisionJob {
  id: string;
  status: VisionJobStatus;
  attachmentId: string;
  instructions: string | null;
  folder: string | null;
  resultText: string | null;
  itemId: string | null;
  itemPath: string | null;
  error: string | null;
  created: Date;
  updated: Date;
}

/** Job store for image→note reads (issue #28). Faked in tests, Drizzle in prod. */
export interface VisionRepo {
  /** Queue an image to be read; status = pending. */
  create(attachmentId: string, instructions: string | null, folder: string | null): Promise<VisionJob>;
  getById(id: string): Promise<VisionJob | null>;
  /** Most recently created job (for "is my note ready?" with no id); null when none. */
  latest(): Promise<VisionJob | null>;
  /** Atomically take the oldest pending job → running; null when none. */
  claimNext(): Promise<VisionJob | null>;
  /** running → done, storing the reading + saved-note pointer. */
  complete(id: string, resultText: string, itemId: string, itemPath: string): Promise<void>;
  /** running → error with the message. */
  fail(id: string, error: string): Promise<void>;
}

export class DrizzleVisionRepo implements VisionRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async create(
    attachmentId: string,
    instructions: string | null,
    folder: string | null,
  ): Promise<VisionJob> {
    const [row] = await this.db
      .insert(visionJobs)
      .values({ attachmentId, instructions, folder })
      .returning();
    return row as VisionJob;
  }

  async getById(id: string): Promise<VisionJob | null> {
    const [row] = await this.db.select().from(visionJobs).where(eq(visionJobs.id, id));
    return (row as VisionJob) ?? null;
  }

  async latest(): Promise<VisionJob | null> {
    const [row] = await this.db
      .select()
      .from(visionJobs)
      .orderBy(desc(visionJobs.created))
      .limit(1);
    return (row as VisionJob) ?? null;
  }

  // FOR UPDATE SKIP LOCKED: a job is never handed to two runner polls at once.
  async claimNext(): Promise<VisionJob | null> {
    const [row] = await this.db
      .update(visionJobs)
      .set({ status: 'running', updated: sql`now()` })
      .where(
        eq(
          visionJobs.id,
          sql`(
            SELECT id FROM vision_jobs
            WHERE status = 'pending'
            ORDER BY created
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )`,
        ),
      )
      .returning();
    return (row as VisionJob) ?? null;
  }

  async complete(id: string, resultText: string, itemId: string, itemPath: string): Promise<void> {
    await this.db
      .update(visionJobs)
      .set({ status: 'done', resultText, itemId, itemPath, error: null, updated: sql`now()` })
      .where(eq(visionJobs.id, id));
  }

  async fail(id: string, error: string): Promise<void> {
    await this.db
      .update(visionJobs)
      .set({ status: 'error', error, updated: sql`now()` })
      .where(eq(visionJobs.id, id));
  }
}
