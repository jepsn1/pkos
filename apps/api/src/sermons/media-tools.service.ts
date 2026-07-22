import { Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { SermonsService } from './sermons.service';

/** Appended to the chat system prompt so the planner routes video links here. */
export const MEDIA_ROUTING = `You also have a video/audio transcription tool:
- transcribe_video (MEDIA): the ONLY correct way to make notes from a video or audio URL (YouTube etc.). Whenever the user shares such a URL and wants notes / a summary / transcription, you MUST call transcribe_video with the url (style "sermon" for a sermon or faith video, else "general").
  CRITICAL: you have NOT seen the video's content. A page title, description, or channel name is NOT the content. NEVER write a summary or call save_note about a video from its title, your own memory, or retrieved notes — that is fabrication and is forbidden. The real notes come only from the transcript, which transcribe_video produces.
  It is ASYNC: after calling it, tell the user transcription has STARTED and the note will appear in a few minutes. Do NOT also call save_note for the video, and do NOT claim it is finished.
- transcription_status (MEDIA): when the user asks whether a transcription is done / where the note is / "is it ready?", call this (pass the job_id from the transcribe_video result if you have it, else omit for the latest job). Report honestly what it returns: done (give the note title/folder), still processing, or FAILED with the reason — never say "still waiting" without checking.`;

const MEDIA_TOOLS: LlmTool[] = [
  {
    name: 'transcribe_video',
    description:
      'Download and transcribe a video/audio URL (YouTube etc.) into a vault note. Asynchronous — returns a job id immediately; the note appears in a few minutes. style "sermon" → sermon-style note in faith/sermons; "general" (default) → a summary in articles.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The video/audio URL to transcribe.' },
        style: {
          type: 'string',
          enum: ['sermon', 'general'],
          description: 'sermon → faith/sermons; general (default) → articles.',
        },
      },
    },
  },
  {
    name: 'transcription_status',
    description:
      'Check a transcription job: done (with the note path), still processing, or failed (with the reason). Pass job_id, or omit for the most recent job.',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id from transcribe_video; omit for latest.' },
      },
    },
  },
];

/** LLM tool over the media→notes pipeline: enqueue a URL transcription from chat. */
@Injectable()
export class MediaToolsService {
  readonly tools = MEDIA_TOOLS;

  constructor(private readonly sermons: SermonsService) {}

  routingPrompt(): string {
    return MEDIA_ROUTING;
  }

  async execute(call: LlmToolCall): Promise<string> {
    try {
      const args = (call.arguments ?? {}) as { url?: unknown; style?: unknown; job_id?: unknown };
      if (call.name === 'transcribe_video') {
        const job = await this.sermons.transcribeUrl({ url: args.url, style: args.style });
        return JSON.stringify({
          started: true,
          job_id: job.id,
          status: job.status,
          style: job.style,
          message:
            'Transcription started. The note will appear in the vault in a few minutes — do not claim it is done yet.',
        });
      }
      if (call.name === 'transcription_status') {
        return JSON.stringify(await this.status(typeof args.job_id === 'string' ? args.job_id : undefined));
      }
      return JSON.stringify({ error: `unknown tool: ${call.name}` });
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message ?? 'media tool failed' });
    }
  }

  /** Human-facing status of a job (latest when no id): done / processing / failed. */
  private async status(jobId?: string) {
    const job = jobId
      ? await this.sermons.get(jobId).catch(() => null)
      : (await this.sermons.list())[0];
    if (!job) return { found: false, message: 'no transcription jobs found' };
    const base = { found: true, job_id: job.id, status: job.status, title: job.title ?? null };
    switch (job.status) {
      case 'enriched':
        return { ...base, done: true, note_path: job.articlePath, message: 'Done — note is in the vault.' };
      case 'error':
        return { ...base, done: false, failed: true, reason: job.error, message: `Download/transcription failed: ${job.error ?? 'unknown error'}` };
      case 'enrich_error':
        return { ...base, done: false, failed: true, reason: job.enrichError, message: `Transcribed, but note generation failed: ${job.enrichError ?? 'unknown error'}` };
      default:
        return { ...base, done: false, message: 'Still processing — check back shortly.' };
    }
  }
}
