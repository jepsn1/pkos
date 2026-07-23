import { Injectable } from '@nestjs/common';
import type { ToolContext } from '../chat/chat.service';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { VisionJobsService } from './vision-jobs.service';

/** Appended to the chat system prompt so the planner routes image-note turns here. */
export const VISION_ROUTING = `You also have tools for making notes from images the user attached:
- make_note_from_image (VISION): the ONLY way to turn an attached photo/scan/screenshot into a note by READING it. Call it when the user asks to "make a note from this", "read this image", "capture what's on this page", etc. AND an image is attached to the current message.
  CRITICAL: you cannot see the image yourself. NEVER transcribe, quote, summarise, or guess its contents — that is fabrication. Only make_note_from_image can read it (a capable vision model does the reading). If the user asks about an image but none is attached this turn, say so and ask them to attach it; do not call the tool.
  It is ASYNC: after calling it, tell the user the image is being read and the note will appear shortly. Do NOT also call save_note for the same image, and do NOT claim it is done.
  Pass \`instructions\` = any context the user gave (e.g. "from my Galatians study"), and \`folder\` = the best-fit vault folder (faith/bible-study for a Bible photo, etc.).
- vision_status (VISION): when the user asks whether the image note is ready / "is it done?", call this (pass the job_id from make_note_from_image if you have it, else omit for the latest). Report honestly: done (give the note path), still reading, or failed with the reason.`;

const VISION_TOOLS: LlmTool[] = [
  {
    name: 'make_note_from_image',
    description:
      'Read the image attached to the current message with a vision model and save it as a vault note (the original image embedded). Asynchronous — returns a job id immediately; the note appears shortly. Only valid when an image is attached this turn.',
    parameters: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description: 'Context the user gave about the image (source, topic). Optional.',
        },
        folder: {
          type: 'string',
          description:
            'Best-fit vault folder, e.g. faith/bible-study, faith/sermons, books, articles. Omit if unsure.',
        },
      },
    },
  },
  {
    name: 'vision_status',
    description:
      'Check an image-reading job: done (with the note path), still reading, or failed (with the reason). Pass job_id, or omit for the most recent.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id from make_note_from_image; omit for latest.' },
      },
    },
  },
];

type Args = Record<string, unknown>;

/**
 * Chat tools over the image→note pipeline (issue #28). make_note_from_image
 * ENQUEUES a job (a host-side Claude runner reads the image, #29); it does not
 * read the image itself. vision_status reports progress.
 */
@Injectable()
export class VisionToolsService {
  readonly tools = VISION_TOOLS;

  constructor(private readonly jobs: VisionJobsService) {}

  routingPrompt(): string {
    return VISION_ROUTING;
  }

  async execute(call: LlmToolCall, ctx?: ToolContext): Promise<string> {
    try {
      const args = (call.arguments ?? {}) as Args;
      if (call.name === 'make_note_from_image') return JSON.stringify(await this.enqueue(args, ctx));
      if (call.name === 'vision_status') return JSON.stringify(await this.status(args));
      return JSON.stringify({ error: `unknown tool: ${call.name}` });
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message ?? 'vision tool failed' });
    }
  }

  private async enqueue(args: Args, ctx?: ToolContext) {
    const images = ctx?.images ?? [];
    if (images.length === 0) {
      return {
        error: 'no image is attached to this message — ask the user to attach the photo, then try again',
      };
    }
    const instructions =
      typeof args.instructions === 'string' && args.instructions.trim()
        ? args.instructions.trim()
        : null;
    const folder = optionalFolder(args.folder);
    const jobIds: string[] = [];
    for (const img of images) {
      const job = await this.jobs.enqueue({ attachmentId: img.id, instructions, folder });
      jobIds.push(job.id);
    }
    return {
      started: true,
      job_ids: jobIds,
      message:
        'Reading the image now — the note will appear in the vault shortly. Do not claim it is done yet.',
    };
  }

  private async status(args: Args) {
    const jobId = typeof args.job_id === 'string' && args.job_id.trim() ? args.job_id.trim() : undefined;
    const job = jobId ? await this.jobs.get(jobId) : await this.jobs.latest();
    if (!job) return { found: false, message: 'no image-reading jobs found' };
    const base = { found: true, job_id: job.id, status: job.status };
    switch (job.status) {
      case 'done':
        return { ...base, done: true, note_path: job.itemPath, message: 'Done — note is in the vault.' };
      case 'error':
        return { ...base, done: false, failed: true, reason: job.error, message: `Reading failed: ${job.error ?? 'unknown error'}` };
      default:
        return { ...base, done: false, message: 'Still reading — check back shortly.' };
    }
  }
}

/** Vault-relative folder — plain path segments only, no escaping the vault. */
function optionalFolder(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return null;
  const clean = v.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null;
  return clean;
}
