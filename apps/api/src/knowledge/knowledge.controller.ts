import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { KnowledgeService, type IngestRequest } from './knowledge.service';

const MAX_SEARCH_LIMIT = 50;

@Controller()
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post('knowledge')
  async ingest(@Body() body: Partial<IngestRequest>) {
    if (!body?.title?.trim()) throw new BadRequestException('title required');
    if (!body.markdown?.trim()) throw new BadRequestException('markdown required');
    if (body.tags !== undefined && !Array.isArray(body.tags)) {
      throw new BadRequestException('tags must be an array');
    }
    return this.knowledge.ingest(body as IngestRequest);
  }

  @Get('knowledge')
  async list() {
    return this.knowledge.list();
  }

  @Get('knowledge/:id')
  async get(@Param('id') id: string) {
    return this.knowledge.get(id);
  }

  @Get('search')
  async search(@Query('q') q?: string, @Query('limit') limit?: string) {
    if (!q?.trim()) throw new BadRequestException('q required');
    const n = limit ? Number(limit) : undefined;
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_SEARCH_LIMIT)) {
      throw new BadRequestException(`limit must be 1-${MAX_SEARCH_LIMIT}`);
    }
    return this.knowledge.search(q, n);
  }
}
