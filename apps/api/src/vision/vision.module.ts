import { Module } from '@nestjs/common';
import { LLM_FETCH, LLM_PROVIDER, OllamaLlmProvider } from '../chat/llm.provider';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { VisionToolsService } from './vision-tools.service';

/**
 * Vision → notes. Provides its OWN LLM provider (a vision model runs on the same
 * ollama, selected per-call via VISION_MODEL) so this module does not depend on
 * ChatModule — ChatModule imports THIS one to wire the toolset in.
 */
@Module({
  imports: [KnowledgeModule],
  providers: [
    VisionToolsService,
    { provide: LLM_PROVIDER, useClass: OllamaLlmProvider },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: LLM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  exports: [VisionToolsService],
})
export class VisionModule {}
