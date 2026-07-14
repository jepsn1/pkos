import { Module } from '@nestjs/common';
import { LLM_FETCH, LLM_PROVIDER, OllamaLlmProvider } from '../chat/llm.provider';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SermonsModule } from './sermons.module';
import { EnrichmentController } from './enrichment.controller';
import { ENRICH_POLL_MS, EnrichmentService } from './enrichment.service';

// Poller cadence; 0 disables (ENRICH_POLL_INTERVAL_MS env override).
const pollMs = Number(process.env.ENRICH_POLL_INTERVAL_MS ?? 15_000);

@Module({
  imports: [SermonsModule, KnowledgeModule],
  controllers: [EnrichmentController],
  providers: [
    EnrichmentService,
    { provide: ENRICH_POLL_MS, useValue: pollMs },
    { provide: LLM_PROVIDER, useClass: OllamaLlmProvider },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: LLM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class EnrichmentModule {}
