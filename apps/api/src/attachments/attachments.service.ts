import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ATTACHMENTS_REPO,
  type Attachment,
  type AttachmentRepo,
} from './attachments.repo';

/** Root dir for blobs (host: /srv/data/uploads/pkos/attachments via compose). */
export const ATTACHMENTS_PATH = 'ATTACHMENTS_PATH';

export interface StoredFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Stores uploaded originals on disk (deduped by sha256) with metadata in the DB.
 * Blobs live under ATTACHMENTS_PATH, sharded by the sha prefix; they are NEVER
 * written into the git vault. Markdown references them by URL via the controller.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(ATTACHMENTS_REPO) private readonly repo: AttachmentRepo,
    @Inject(ATTACHMENTS_PATH) private readonly root: string,
  ) {}

  /** Persist a file (idempotent by content); optionally link it to a note. */
  async store(file: StoredFile, itemId?: string): Promise<Attachment> {
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.repo.findBySha(sha256);
    if (existing) return existing; // dedupe: same bytes, reuse the row + blob

    const ext = path.extname(file.originalname).toLowerCase().slice(0, 12);
    const diskPath = path.posix.join(sha256.slice(0, 2), `${sha256}${ext}`);
    const abs = path.join(this.root, diskPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.buffer);

    return this.repo.insert({
      filename: file.originalname,
      mime: file.mimetype || 'application/octet-stream',
      size: file.buffer.length,
      sha256,
      diskPath,
      itemId: itemId ?? null,
    });
  }

  /** Metadata row + absolute on-disk path for streaming. Throws if unknown. */
  async get(id: string): Promise<{ attachment: Attachment; absPath: string }> {
    const attachment = await this.repo.getById(id);
    if (!attachment) throw new NotFoundException(`no attachment ${id}`);
    return { attachment, absPath: path.join(this.root, attachment.diskPath) };
  }

  listByItem(itemId: string): Promise<Attachment[]> {
    return this.repo.listByItem(itemId);
  }
}
