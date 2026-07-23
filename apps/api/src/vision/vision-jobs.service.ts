import { Inject, Injectable } from '@nestjs/common';
import { attachmentUrl } from '../attachments/attachments.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { VISION_REPO, type VisionJob, type VisionRepo } from './vision.repo';

/** Thrown when a reading has no usable text — the job is failed, no note saved. */
export class EmptyReadingError extends Error {}

/**
 * Owns the image→note job lifecycle (issue #28). The chat tool enqueues; a
 * host-side Claude runner (#29) claims a job, reads the image, and posts the
 * reading to complete(), which turns it into a vault note (image embedded).
 */
@Injectable()
export class VisionJobsService {
  constructor(
    @Inject(VISION_REPO) private readonly repo: VisionRepo,
    private readonly knowledge: KnowledgeService,
  ) {}

  enqueue(input: {
    attachmentId: string;
    instructions?: string | null;
    folder?: string | null;
  }): Promise<VisionJob> {
    return this.repo.create(input.attachmentId, input.instructions ?? null, input.folder ?? null);
  }

  claimNext(): Promise<VisionJob | null> {
    return this.repo.claimNext();
  }

  get(id: string): Promise<VisionJob | null> {
    return this.repo.getById(id);
  }

  latest(): Promise<VisionJob | null> {
    return this.repo.latest();
  }

  /**
   * Turn a runner's reading into a vault note: parse its TITLE/body, embed the
   * original image at the top, ingest. An empty/NO_TEXT reading fails the job
   * (no note saved) instead of writing a blank note.
   */
  async complete(id: string, text: string): Promise<{ itemPath: string; title: string }> {
    const job = await this.repo.getById(id);
    if (!job) throw new Error(`no vision job ${id}`);
    let title: string;
    let body: string;
    try {
      ({ title, body } = parseTitleBody(text, job.instructions));
    } catch (err) {
      if (err instanceof EmptyReadingError) {
        await this.repo.fail(id, err.message);
        throw err;
      }
      throw err;
    }
    const markdown = `![](${attachmentUrl(job.attachmentId)})\n\n${body}`;
    const item = await this.knowledge.ingest({
      title,
      markdown,
      source: 'image',
      folder: job.folder ?? undefined,
    });
    await this.repo.complete(id, text, item.id, item.path);
    return { itemPath: item.path, title: item.title };
  }

  fail(id: string, error: string): Promise<void> {
    return this.repo.fail(id, error);
  }
}

/**
 * Split a reading of the form "TITLE: x\n\n<body>" into title + body, with sane
 * fallbacks. An empty body — or the sentinel NO_TEXT the runner emits for an
 * unreadable image — raises EmptyReadingError so the job fails cleanly.
 */
export function parseTitleBody(
  raw: string,
  instructions?: string | null,
): { title: string; body: string } {
  const text = (raw ?? '').replace(/^﻿/, '');
  const firstNl = text.indexOf('\n');
  const firstLine = (firstNl === -1 ? text : text.slice(0, firstNl)).trim();
  let title = '';
  let body = text;
  const tm = firstLine.match(/^TITLE:\s*(.*)$/i);
  if (tm) {
    title = tm[1].trim();
    body = firstNl === -1 ? '' : text.slice(firstNl + 1);
  }
  body = body.trim();
  if (body === 'NO_TEXT' || !body) {
    throw new EmptyReadingError('the image had no legible text — ask for a clearer photo');
  }
  if (!title) title = instructions?.slice(0, 60).trim() || 'Image note';
  return { title, body };
}
