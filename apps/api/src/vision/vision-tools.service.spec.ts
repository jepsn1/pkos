import { describe, expect, it } from 'vitest';
import type { RequestImage, ToolContext } from '../chat/chat.service';
import type { VisionJobsService } from './vision-jobs.service';
import type { VisionJob } from './vision.repo';
import { VisionToolsService } from './vision-tools.service';

const IMG: RequestImage = {
  id: 'att-1',
  url: 'http://pkos/api/attachments/att-1',
  mime: 'image/jpeg',
  base64: 'QUJD',
};

/** Records enqueue calls; canned get/latest. */
function jobsSpy(latest?: Partial<VisionJob>) {
  const enqueued: Array<Record<string, unknown>> = [];
  const jobs = {
    enqueue: async (input: Record<string, unknown>) => {
      enqueued.push(input);
      return { id: `vj-${enqueued.length}` } as VisionJob;
    },
    get: async (id: string) => ({ id, status: 'running' }) as VisionJob,
    latest: async () => (latest ? ({ id: 'vj-9', ...latest } as VisionJob) : null),
  } as unknown as VisionJobsService;
  return { jobs, enqueued };
}

const ctxWith = (...images: RequestImage[]): ToolContext => ({ images });

describe('VisionToolsService.make_note_from_image', () => {
  it('enqueues a read for the attached image and returns "started" (no synchronous read)', async () => {
    const { jobs, enqueued } = jobsSpy();
    const svc = new VisionToolsService(jobs);

    const out = JSON.parse(
      await svc.execute(
        { name: 'make_note_from_image', arguments: { instructions: 'my Bible', folder: 'faith/bible-study' } },
        ctxWith(IMG),
      ),
    );

    expect(enqueued).toEqual([
      { attachmentId: 'att-1', instructions: 'my Bible', folder: 'faith/bible-study' },
    ]);
    expect(out).toMatchObject({ started: true, job_ids: ['vj-1'] });
  });

  it('refuses (no fabrication, no enqueue) when no image is attached', async () => {
    const { jobs, enqueued } = jobsSpy();
    const svc = new VisionToolsService(jobs);
    const out = JSON.parse(
      await svc.execute({ name: 'make_note_from_image', arguments: {} }, ctxWith()),
    );
    expect(out.error).toMatch(/no image/i);
    expect(enqueued).toHaveLength(0);
  });
});

describe('VisionToolsService.vision_status', () => {
  it('reports a finished note with its path', async () => {
    const { jobs } = jobsSpy({ status: 'done', itemPath: 'faith/bible-study/Galatians 3.md' });
    const svc = new VisionToolsService(jobs);
    const out = JSON.parse(await svc.execute({ name: 'vision_status', arguments: {} }, ctxWith()));
    expect(out).toMatchObject({ done: true, note_path: 'faith/bible-study/Galatians 3.md' });
  });

  it('reports a failure with the reason', async () => {
    const { jobs } = jobsSpy({ status: 'error', error: 'claude timed out' });
    const svc = new VisionToolsService(jobs);
    const out = JSON.parse(await svc.execute({ name: 'vision_status', arguments: {} }, ctxWith()));
    expect(out).toMatchObject({ failed: true, reason: 'claude timed out' });
  });

  it('says so when there are no jobs', async () => {
    const { jobs } = jobsSpy(); // latest() → null
    const svc = new VisionToolsService(jobs);
    const out = JSON.parse(await svc.execute({ name: 'vision_status', arguments: {} }, ctxWith()));
    expect(out.found).toBe(false);
  });
});
