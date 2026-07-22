import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MediaToolsService } from './media-tools.service';
import type { SermonsService } from './sermons.service';

function fakeSermons(jobs: Array<Record<string, unknown>> = []) {
  const calls: Array<{ url?: unknown; style?: unknown }> = [];
  const svc = {
    transcribeUrl: vi.fn(async (input: { url?: unknown; style?: unknown }) => {
      calls.push(input);
      if (!/^https?:\/\//.test(String(input.url ?? ''))) {
        throw new BadRequestException('a valid http(s) url is required');
      }
      return { id: 'job-1', status: 'queued', style: input.style === 'sermon' ? 'sermon' : 'general' };
    }),
    list: vi.fn(async () => jobs),
    get: vi.fn(async (id: string) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) throw new Error(`no sermon job ${id}`);
      return j;
    }),
  } as unknown as SermonsService;
  return { svc, calls };
}

async function status(svc: MediaToolsService, args: Record<string, unknown> = {}) {
  return JSON.parse(await svc.execute({ name: 'transcription_status', arguments: args }));
}

async function run(svc: MediaToolsService, args: Record<string, unknown>) {
  return JSON.parse(await svc.execute({ name: 'transcribe_video', arguments: args }));
}

describe('transcribe_video', () => {
  it('enqueues a URL job and reports started + job id', async () => {
    const { svc, calls } = fakeSermons();
    const res = await run(new MediaToolsService(svc), { url: 'https://youtu.be/x' });
    expect(res.started).toBe(true);
    expect(res.job_id).toBe('job-1');
    expect(res.status).toBe('queued');
    expect(res.style).toBe('general');
    expect(calls[0]).toEqual({ url: 'https://youtu.be/x', style: undefined });
  });

  it('passes an explicit style through', async () => {
    const { svc } = fakeSermons();
    const res = await run(new MediaToolsService(svc), { url: 'https://youtu.be/x', style: 'sermon' });
    expect(res.style).toBe('sermon');
  });

  it('bad url → {error}, never throws', async () => {
    const { svc } = fakeSermons();
    const res = await run(new MediaToolsService(svc), { url: 'not a url' });
    expect(res.error).toMatch(/url/);
    expect(res.started).toBeUndefined();
  });

  it('unknown tool name → {error}', async () => {
    const { svc } = fakeSermons();
    const res = JSON.parse(await new MediaToolsService(svc).execute({ name: 'nope', arguments: {} }));
    expect(res.error).toMatch(/unknown tool/);
  });
});

describe('transcription_status', () => {
  it('reports the latest job as still processing', async () => {
    const { svc } = fakeSermons([{ id: 'job-9', status: 'processing', title: 'A talk' }]);
    const res = await status(new MediaToolsService(svc));
    expect(res).toMatchObject({ found: true, job_id: 'job-9', done: false });
  });

  it('reports done + note path when enriched', async () => {
    const { svc } = fakeSermons([
      { id: 'job-9', status: 'enriched', title: 'A talk', articlePath: 'articles/a-talk.md' },
    ]);
    const res = await status(new MediaToolsService(svc));
    expect(res.done).toBe(true);
    expect(res.note_path).toBe('articles/a-talk.md');
  });

  it('surfaces a download failure with the reason', async () => {
    const { svc } = fakeSermons([
      { id: 'job-9', status: 'error', error: 'yt-dlp failed: confirm you are not a bot' },
    ]);
    const res = await status(new MediaToolsService(svc));
    expect(res.failed).toBe(true);
    expect(res.reason).toMatch(/bot/);
  });

  it('looks up a specific job id', async () => {
    const { svc } = fakeSermons([
      { id: 'a', status: 'enriched', articlePath: 'articles/a.md' },
      { id: 'b', status: 'processing' },
    ]);
    const res = await status(new MediaToolsService(svc), { job_id: 'b' });
    expect(res.job_id).toBe('b');
    expect(res.done).toBe(false);
  });

  it('no jobs → found:false', async () => {
    const { svc } = fakeSermons([]);
    const res = await status(new MediaToolsService(svc));
    expect(res.found).toBe(false);
  });
});
