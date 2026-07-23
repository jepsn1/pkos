import { beforeEach, describe, expect, it } from 'vitest';
import { attachmentUrl } from '../attachments/attachments.service';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import { EmptyReadingError, parseTitleBody, VisionJobsService } from './vision-jobs.service';
import type { VisionJob, VisionRepo } from './vision.repo';

/** In-memory VisionRepo. */
class FakeVisionRepo implements VisionRepo {
  jobs: VisionJob[] = [];
  private seq = 0;

  async create(attachmentId: string, instructions: string | null, folder: string | null) {
    const now = new Date(2026, 0, 1, 0, 0, this.seq); // increasing so latest() is deterministic
    const job: VisionJob = {
      id: `vj-${++this.seq}`,
      status: 'pending',
      attachmentId,
      instructions,
      folder,
      resultText: null,
      itemId: null,
      itemPath: null,
      error: null,
      created: now,
      updated: now,
    };
    this.jobs.push(job);
    return job;
  }
  async getById(id: string) {
    return this.jobs.find((j) => j.id === id) ?? null;
  }
  async latest() {
    return [...this.jobs].sort((a, b) => b.created.getTime() - a.created.getTime())[0] ?? null;
  }
  async claimNext() {
    const job = this.jobs.find((j) => j.status === 'pending');
    if (!job) return null;
    job.status = 'running';
    return job;
  }
  async complete(id: string, resultText: string, itemId: string, itemPath: string) {
    const job = await this.getById(id);
    if (job) Object.assign(job, { status: 'done', resultText, itemId, itemPath, error: null });
  }
  async fail(id: string, error: string) {
    const job = await this.getById(id);
    if (job) Object.assign(job, { status: 'error', error });
  }
}

/** Records ingest calls; returns a saved item built from (folder, title). */
function knowledgeSpy() {
  const ingested: Array<Record<string, unknown>> = [];
  const knowledge = {
    ingest: async (req: Record<string, unknown>) => {
      ingested.push(req);
      const folder = (req.folder as string) ?? 'articles';
      return { id: 'k1', path: `${folder}/${req.title}.md`, title: req.title } as never;
    },
  } as unknown as KnowledgeService;
  return { knowledge, ingested };
}

let repo: FakeVisionRepo;

beforeEach(() => {
  repo = new FakeVisionRepo();
});

describe('VisionJobsService', () => {
  it('enqueue creates a pending job carrying the attachment, instructions and folder', async () => {
    const { knowledge } = knowledgeSpy();
    const svc = new VisionJobsService(repo, knowledge);
    const job = await svc.enqueue({ attachmentId: 'att-9', instructions: 'my Bible', folder: 'faith/bible-study' });
    expect(job).toMatchObject({
      status: 'pending',
      attachmentId: 'att-9',
      instructions: 'my Bible',
      folder: 'faith/bible-study',
    });
  });

  it('complete ingests a note with the image embedded + parsed title/body, and marks done', async () => {
    const { knowledge, ingested } = knowledgeSpy();
    const svc = new VisionJobsService(repo, knowledge);
    const job = await svc.enqueue({ attachmentId: 'att-9', folder: 'faith/bible-study' });

    const res = await svc.complete(job.id, 'TITLE: Galatians 3\n\n## Text\nFor freedom Christ set us free.');

    expect(ingested[0]).toMatchObject({ title: 'Galatians 3', folder: 'faith/bible-study', source: 'image' });
    expect(ingested[0].markdown).toBe(
      `![](${attachmentUrl('att-9')})\n\n## Text\nFor freedom Christ set us free.`,
    );
    expect(res).toEqual({ itemPath: 'faith/bible-study/Galatians 3.md', title: 'Galatians 3' });
    const stored = await repo.getById(job.id);
    expect(stored).toMatchObject({ status: 'done', itemId: 'k1', itemPath: 'faith/bible-study/Galatians 3.md' });
  });

  it('complete fails the job (no note) when the reading is empty / NO_TEXT', async () => {
    const { knowledge, ingested } = knowledgeSpy();
    const svc = new VisionJobsService(repo, knowledge);
    const job = await svc.enqueue({ attachmentId: 'att-9' });

    await expect(svc.complete(job.id, 'TITLE:\n\nNO_TEXT')).rejects.toBeInstanceOf(EmptyReadingError);
    expect(ingested).toHaveLength(0);
    expect((await repo.getById(job.id))?.status).toBe('error');
  });

  it('claimNext hands out a pending job once, then nothing', async () => {
    const { knowledge } = knowledgeSpy();
    const svc = new VisionJobsService(repo, knowledge);
    await svc.enqueue({ attachmentId: 'att-1' });
    expect((await svc.claimNext())?.attachmentId).toBe('att-1');
    expect(await svc.claimNext()).toBeNull(); // already running
  });

  it('latest returns the most recently enqueued job', async () => {
    const { knowledge } = knowledgeSpy();
    const svc = new VisionJobsService(repo, knowledge);
    await svc.enqueue({ attachmentId: 'a' });
    const second = await svc.enqueue({ attachmentId: 'b' });
    expect((await svc.latest())?.id).toBe(second.id);
  });
});

describe('parseTitleBody', () => {
  it('splits the TITLE line from the body', () => {
    expect(parseTitleBody('TITLE: On Grace\n\n## Text\nGrace is favor.')).toEqual({
      title: 'On Grace',
      body: '## Text\nGrace is favor.',
    });
  });

  it('falls back to instructions then a default title when TITLE is missing', () => {
    expect(parseTitleBody('## Text\nbody', 'a photo from church').title).toBe('a photo from church');
    expect(parseTitleBody('## Text\nbody').title).toBe('Image note');
  });

  it('throws EmptyReadingError on an empty / NO_TEXT body', () => {
    expect(() => parseTitleBody('TITLE: x\n\nNO_TEXT')).toThrow(EmptyReadingError);
    expect(() => parseTitleBody('TITLE: x\n\n')).toThrow(EmptyReadingError);
  });
});
