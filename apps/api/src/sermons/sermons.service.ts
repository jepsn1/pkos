import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SERMON_REPO,
  type SermonJob,
  type SermonJobSummary,
  type SermonMeta,
  type SermonRepo,
} from './sermons.repo';

export const UPLOADS_PATH = 'UPLOADS_PATH';

const ALLOWED_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Enrichment styles a URL job may request; default 'general' for arbitrary videos. */
const STYLES = new Set(['sermon', 'general']);

function normalizeStyle(value: unknown): string {
  if (value == null || value === '') return 'general';
  const s = String(value).trim().toLowerCase();
  if (!STYLES.has(s)) {
    throw new BadRequestException(`style must be one of: ${[...STYLES].join(', ')}`);
  }
  return s;
}

export interface UploadedAudio {
  originalname: string;
  buffer: Buffer;
}

@Injectable()
export class SermonsService {
  constructor(
    @Inject(SERMON_REPO) private readonly repo: SermonRepo,
    @Inject(UPLOADS_PATH) private readonly uploadsPath: string,
  ) {}

  /** Save the audio under UPLOADS_PATH and enqueue a transcription job. */
  async upload(
    file: UploadedAudio | undefined,
    meta: SermonMeta = {},
  ): Promise<SermonJob> {
    if (!file?.originalname || !file.buffer?.length) {
      throw new BadRequestException('audio file required (multipart field "file")');
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        `unsupported audio type "${ext || file.originalname}" — allowed: mp3, m4a, wav`,
      );
    }
    // Random name on disk: never trust client paths, avoid collisions.
    const audioPath = `${randomUUID()}${ext}`;
    await fs.mkdir(this.uploadsPath, { recursive: true });
    await fs.writeFile(path.join(this.uploadsPath, audioPath), file.buffer);
    return this.repo.create(file.originalname, audioPath, cleanMeta(meta));
  }

  /** Enqueue a URL job: yt-dlp (worker) downloads audio, then transcribe+enrich. */
  async transcribeUrl(input: {
    url?: unknown;
    style?: unknown;
    speaker?: string;
    date?: string;
    title?: string;
  }): Promise<SermonJob> {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new BadRequestException('a valid http(s) url is required');
    }
    const style = normalizeStyle(input.style);
    return this.repo.createUrlJob(url, style, cleanMeta(input));
  }

  async list(): Promise<SermonJobSummary[]> {
    return this.repo.list();
  }

  async get(id: string): Promise<SermonJob> {
    const job = await this.repo.getById(id);
    if (!job) throw new NotFoundException(`no sermon job ${id}`);
    return job;
  }
}

/** Trim optional upload metadata; 400 on a malformed date; drop empty strings. */
function cleanMeta(meta: SermonMeta): SermonMeta {
  const date = meta.date?.trim();
  if (date && !ISO_DATE.test(date)) {
    throw new BadRequestException(`date must be YYYY-MM-DD, got "${meta.date}"`);
  }
  return {
    speaker: meta.speaker?.trim() || undefined,
    date: date || undefined,
    title: meta.title?.trim() || undefined,
  };
}
