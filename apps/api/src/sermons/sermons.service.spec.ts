import { BadRequestException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SermonJob,
  SermonJobStatus,
  SermonRepo,
} from './sermons.repo';
import { SermonsService } from './sermons.service';

/** In-memory job store mirroring db defaults (status queued). */
class FakeSermonRepo implements SermonRepo {
  rows: SermonJob[] = [];
  private seq = 0;

  async create(originalFilename: string, audioPath: string): Promise<SermonJob> {
    const row: SermonJob = {
      id: `job-${++this.seq}`,
      status: 'queued' as SermonJobStatus,
      originalFilename,
      audioPath,
      error: null,
      transcript: null,
      created: new Date(),
      updated: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async list() {
    return [...this.rows]
      .sort((a, b) => b.created.getTime() - a.created.getTime())
      .map(({ transcript, ...rest }) => rest);
  }

  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
}

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

    const saved = await fs.readFile(path.join(uploads, job.audioPath));
    expect(saved.toString()).toBe('fake-audio-bytes');
  });

  it.each(['.mp3', '.m4a', '.wav'])('accepts %s', async (ext) => {
    const job = await service.upload(audio(`talk${ext}`));
    expect(job.audioPath.endsWith(ext)).toBe(true);
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
