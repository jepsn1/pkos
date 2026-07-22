import { Injectable } from '@nestjs/common';
import type { LlmTool, LlmToolCall } from '../chat/llm.provider';
import { SermonsService } from './sermons.service';

/** Appended to the chat system prompt so the planner routes video links here. */
export const MEDIA_ROUTING = `You also have a video/audio transcription tool:
- transcribe_video (MEDIA): when the user shares a video or audio URL (YouTube etc.) and wants it turned into notes — "make notes from this", "transcribe this", "take sermon notes on this video" — call it with the url. Pass style "sermon" for a sermon / faith video, otherwise "general" (the default). It is ASYNC: after it returns, tell the user transcription has STARTED and the note will appear in their vault in a few minutes. Do NOT invent the note's contents or claim it is already finished.`;

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
