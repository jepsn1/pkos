import { Module } from '@nestjs/common';
import { LLM_FETCH, LLM_PROVIDER, OllamaLlmProvider } from '../chat/llm.provider';
import { db } from '../db';
import { GraphModule } from '../graph/graph.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SuggesterService } from './suggester.service';
import { DrizzleSuggestionRepo, SUGGESTION_REPO } from './suggestion.repo';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';

@Module({
  imports: [KnowledgeModule, GraphModule],
  controllers: [SuggestionsController],
  providers: [
    SuggesterService,
    SuggestionsService,
    { provide: SUGGESTION_REPO, useValue: new DrizzleSuggestionRepo(db) },
    // Own LLM provider instance (ChatModule does not export its token).
    { provide: LLM_PROVIDER, useClass: OllamaLlmProvider },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: LLM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class SuggestionsModule {}
