import { Controller, Param, Post } from '@nestjs/common';
import { EnrichmentService } from './enrichment.service';

/**
 * Lives in EnrichmentModule (not SermonsModule): enrichment needs
 * KnowledgeService, and KnowledgeModule already imports SermonsModule —
 * a second @Controller('sermons') avoids the import cycle.
 */
@Controller('sermons')
export class EnrichmentController {
  constructor(private readonly enrichment: EnrichmentService) {}

  /** Manual (re)trigger; runs synchronously (can take an LLM round trip or two). */
  @Post(':id/enrich')
  async enrich(@Param('id') id: string) {
    return this.enrichment.enrich(id);
  }
}
