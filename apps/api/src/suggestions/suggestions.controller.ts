import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SuggesterService } from './suggester.service';
import { SuggestionsService } from './suggestions.service';

@Controller()
export class SuggestionsController {
  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly suggester: SuggesterService,
  ) {}

  @Get('suggestions')
  async list(@Query('status') status?: string) {
    return this.suggestions.list(status);
  }

  @Post('suggestions/:id/accept')
  async accept(@Param('id') id: string) {
    return this.suggestions.accept(id);
  }

  @Post('suggestions/:id/reject')
  async reject(@Param('id') id: string) {
    return this.suggestions.reject(id);
  }

  /** Manual (re-)trigger; ingest fires the same generation asynchronously. */
  @Post('knowledge/:id/suggest')
  async suggest(@Param('id') id: string) {
    return this.suggester.generate(id);
  }
}
