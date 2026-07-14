import type {
  SermonJob,
  SermonJobSummary,
  SermonMeta,
  SermonRepo,
} from './sermons.repo';

/**
 * In-memory SermonRepo for specs, mirroring db defaults and the SQL claim
 * semantics (done + no article → enriching). Shared by sermons + enrichment specs.
 */
export class FakeSermonRepo implements SermonRepo {
  rows: SermonJob[] = [];
  private seq = 0;

  async create(
    originalFilename: string,
    audioPath: string,
    meta: SermonMeta = {},
  ): Promise<SermonJob> {
    const row: SermonJob = {
      id: `job-${++this.seq}`,
      status: 'queued',
      originalFilename,
      audioPath,
      error: null,
      transcript: null,
      speaker: meta.speaker ?? null,
      sermonDate: meta.date ?? null,
      title: meta.title ?? null,
      articleItemId: null,
      articlePath: null,
      enrichError: null,
      created: new Date(),
      updated: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async list(): Promise<SermonJobSummary[]> {
    return [...this.rows]
      .sort((a, b) => b.created.getTime() - a.created.getTime())
      .map(({ transcript: _t, ...rest }) => rest);
  }

  async getById(id: string): Promise<SermonJob | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async claimForEnrichment(): Promise<SermonJob | null> {
    const job = this.rows
      .filter((r) => r.status === 'done' && r.articleItemId === null)
      .sort((a, b) => a.created.getTime() - b.created.getTime())[0];
    if (!job) return null;
    job.status = 'enriching';
    job.updated = new Date();
    return job;
  }

  async startEnrichment(id: string): Promise<SermonJob | null> {
    const job = this.rows.find((r) => r.id === id);
    if (!job || (job.status !== 'done' && job.status !== 'enrich_error')) return null;
    job.status = 'enriching';
    job.updated = new Date();
    return job;
  }

  async completeEnrichment(id: string, itemId: string, path: string): Promise<void> {
    const job = this.rows.find((r) => r.id === id);
    if (!job) return;
    job.status = 'enriched';
    job.articleItemId = itemId;
    job.articlePath = path;
    job.enrichError = null;
    job.updated = new Date();
  }

  async failEnrichment(id: string, message: string): Promise<void> {
    const job = this.rows.find((r) => r.id === id);
    if (!job) return;
    job.status = 'enrich_error';
    job.enrichError = message.slice(0, 2000);
    job.updated = new Date();
  }
}
