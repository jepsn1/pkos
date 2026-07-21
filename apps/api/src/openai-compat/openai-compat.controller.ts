import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { OpenAiCompatGuard } from './openai-compat.guard';
import {
  OpenAiCompatService,
  parseMessages,
  type CompletionRequest,
} from './openai-compat.service';

/** The slice of express.Response we use (avoids a @types/express dependency). */
interface Response {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): void;
  end(): void;
  json(body: unknown): void;
}

/** How often to write an SSE comment while the model is still thinking. */
const HEARTBEAT_MS = 15_000;

/**
 * OpenAI-compatible surface for Open WebUI (and any OpenAI client).
 * Routes live at /v1/* — excluded from the global /api prefix in main.ts.
 */
@Controller('v1')
@UseGuards(OpenAiCompatGuard)
export class OpenAiCompatController {
  constructor(private readonly service: OpenAiCompatService) {}

  @Get('models')
  models() {
    return this.service.listModels();
  }

  @Post('chat/completions')
  @HttpCode(200) // OpenAI spec returns 200; Nest's POST default is 201, which strict clients (Cumbersome) reject
  async completions(@Body() body: CompletionRequest, @Res() res: Response) {
    if (body?.stream !== true) {
      res.json(await this.service.complete(body));
      return;
    }
    // Validate BEFORE opening the stream so bad requests still get a JSON 400.
    parseMessages(body);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no'); // no proxy buffering
    res.flushHeaders();
    // SSE comments keep the connection warm during retrieval + first-token wait.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    try {
      // streamCompletion handles mid-stream errors itself (error delta + stop
      // chunk), so the stream always terminates with [DONE] instead of hanging.
      await this.service.streamCompletion(body, (chunk) =>
        res.write(`data: ${JSON.stringify(chunk)}\n\n`),
      );
    } finally {
      clearInterval(heartbeat);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
