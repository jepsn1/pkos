import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MediaToolsService } from './media-tools.service';
import type { SermonsService } from './sermons.service';

function fakeSermons() {
  const calls: Array<{ url?: unknown; style?: unknown }> = [];
  const svc = {
    transcribeUrl: vi.fn(async (input: { url?: unknown; style?: unknown }) => {
      calls.push(input);
      if (!/^https?:\/\//.test(String(input.url ?? ''))) {
        throw new BadRequestException('a valid http(s) url is required');
      }
      return { id: 'job-1', status: 'queued', style: input.style === 'sermon' ? 'sermon' : 'general' };
    }),
  } as unknown as SermonsService;
  return { svc, calls };
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
