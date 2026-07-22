import { BadRequestException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSermonRepo } from './fake-sermon-repo';
import { SermonsService } from './sermons.service';

let uploads: string;
let repo: FakeSermonRepo;
let service: SermonsService;

beforeEach(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-uploads-'));
  repo = new FakeSermonRepo();
  service = new SermonsService(repo, uploads);
});

afterEach(async () => {
  await fs.rm(uploads, { recursive: true, force: true });
});

const audio = (name: string) => ({
  originalname: name,
  buffer: Buffer.from('fake-audio-bytes'),
});

describe('SermonsService.upload', () => {
  it('saves the file under UPLOADS_PATH and creates a queued job', async () => {
    const job = await service.upload(audio('Sunday Sermon.mp3'));

    expect(job.status).toBe('queued');
    expect(job.originalFilename).toBe('Sunday Sermon.mp3');
    expect(job.audioPath).toMatch(/\.mp3$/);
    expect(job.audioPath).not.toContain('/'); // relative, sanitized name
    expect(job.transcript).toBeNull();
    expect(job.error).toBeNull();

    const saved = await fs.readFile(path.join(uploads, job.audioPath!));
    expect(saved.toString()).toBe('fake-audio-bytes');
  });

  it.each(['.mp3', '.m4a', '.wav'])('accepts %s', async (ext) => {
    const job = await service.upload(audio(`talk${ext}`));
    expect(job.audioPath?.endsWith(ext)).toBe(true);
  });

  it('accepts uppercase extensions', async () => {
    const job = await service.upload(audio('TALK.MP3'));
    expect(job.audioPath).toMatch(/\.mp3$/);
  });

  it.each(['notes.txt', 'video.mp4', 'archive.ogg', 'noext'])(
    'rejects %s',
    async (name) => {
      await expect(service.upload(audio(name))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.rows).toHaveLength(0);
    },
  );

  it('rejects missing file', async () => {
    await expect(service.upload(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never reuses the client filename on disk', async () => {
    const a = await service.upload(audio('same.mp3'));
    const b = await service.upload(audio('same.mp3'));
    expect(a.audioPath).not.toBe(b.audioPath);
  });

  it('stores optional speaker/date/title metadata, trimmed', async () => {
    const job = await service.upload(audio('a.mp3'), {
      speaker: '  John Piper ',
      date: '2026-07-12',
      title: ' The Gospel of John ',
    });
    expect(job.speaker).toBe('John Piper');
    expect(job.sermonDate).toBe('2026-07-12');
    expect(job.title).toBe('The Gospel of John');
  });

  it('defaults metadata to null when absent or blank', async () => {
    const job = await service.upload(audio('a.mp3'), { speaker: '  ' });
    expect(job.speaker).toBeNull();
    expect(job.sermonDate).toBeNull();
    expect(job.title).toBeNull();
  });

  it('400s on a malformed date', async () => {
    await expect(
      service.upload(audio('a.mp3'), { date: '12/07/2026' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.rows).toHaveLength(0);
  });
});

describe('SermonsService job lifecycle views', () => {
  it('lists jobs without transcripts, newest first', async () => {
    await service.upload(audio('a.mp3'));
    await service.upload(audio('b.wav'));
    const jobs = await service.list();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).not.toHaveProperty('transcript');
  });

  it('get returns transcript once the worker marks the job done', async () => {
    const job = await service.upload(audio('a.mp3'));

    // simulate worker completing the job
    const row = repo.rows[0];
    row.status = 'done';
    row.transcript = 'Four score and seven years ago...';

    const done = await service.get(job.id);
    expect(done.status).toBe('done');
    expect(done.transcript).toContain('Four score');
  });

  it('get surfaces worker errors', async () => {
    const job = await service.upload(audio('a.mp3'));
    repo.rows[0].status = 'error';
    repo.rows[0].error = 'ffmpeg exploded';

    const failed = await service.get(job.id);
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('ffmpeg exploded');
  });

  it('404s on unknown id', async () => {
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SermonsService.transcribeUrl', () => {
  it('enqueues a URL job: no audio yet, source_url set, default style general', async () => {
    const job = await service.transcribeUrl({ url: 'https://youtube.com/watch?v=abc' });
    expect(job.status).toBe('queued');
    expect(job.audioPath).toBeNull();
    expect(job.sourceUrl).toBe('https://youtube.com/watch?v=abc');
    expect(job.style).toBe('general');
  });

  it('respects an explicit sermon style', async () => {
    const job = await service.transcribeUrl({ url: 'https://youtu.be/x', style: 'sermon' });
    expect(job.style).toBe('sermon');
  });

  it('rejects a non-url', async () => {
    await expect(service.transcribeUrl({ url: 'not a url' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unknown style', async () => {
    await expect(
      service.transcribeUrl({ url: 'https://x.com/v', style: 'haiku' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
