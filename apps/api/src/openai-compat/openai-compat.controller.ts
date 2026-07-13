import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
import { OpenAiCompatGuard } from './openai-compat.guard';
import {
  OpenAiCompatService,
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
  async completions(@Body() body: CompletionRequest, @Res() res: Response) {
    if (body?.stream === true) {
      const chunks = await this.service.completeChunks(body);
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.flushHeaders();
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.json(await this.service.complete(body));
  }
}
