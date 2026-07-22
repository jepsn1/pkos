import { Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { SermonsService } from './sermons.service';

/** Appended to the chat system prompt so the planner routes video links here. */
export const MEDIA_ROUTING = `You also have a video/audio transcription tool:
- transcribe_video (MEDIA): the ONLY correct way to make notes from a video or audio URL (YouTube etc.). Whenever the user shares such a URL and wants notes / a summary / transcription, you MUST call transcribe_video with the url (style "sermon" for a sermon or faith video, else "general").
  CRITICAL: you have NOT seen the video's content. A page title, description, or channel name is NOT the content. NEVER write a summary or call save_note about a video from its title, your own memory, or retrieved notes — that is fabrication and is forbidden. The real notes come only from the transcript, which transcribe_video produces.
  It is ASYNC: after calling it, tell the user transcription has STARTED and the note will appear in a few minutes. Do NOT also call save_note for the video, and do NOT claim it is finished.`;

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
      if (call.name !== 'transcribe_video') {
        return JSON.stringify({ error: `unknown tool: ${call.name}` });
      }
      const args = (call.arguments ?? {}) as { url?: unknown; style?: unknown };
      const job = await this.sermons.transcribeUrl({ url: args.url, style: args.style });
      return JSON.stringify({
        started: true,
        job_id: job.id,
        status: job.status,
        style: job.style,
        message:
          'Transcription started. The note will appear in the vault in a few minutes — do not claim it is done yet.',
      });
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message ?? 'transcription failed to start' });
    }
  }
}
