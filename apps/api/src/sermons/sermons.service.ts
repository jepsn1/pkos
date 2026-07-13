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
  type SermonRepo,
} from './sermons.repo';

export const UPLOADS_PATH = 'UPLOADS_PATH';

const ALLOWED_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav']);

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
  async upload(file: UploadedAudio | undefined): Promise<SermonJob> {
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
    return this.repo.create(file.originalname, audioPath);
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
