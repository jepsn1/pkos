import { Module } from '@nestjs/common';
import { db } from '../db';
import { BibleModule } from '../bible/bible.module';
import { FitnessModule } from '../fitness/fitness.module';
import { GraphModule } from '../graph/graph.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SermonsModule } from '../sermons/sermons.module';
import { VisionModule } from '../vision/vision.module';
import { WebSearchModule } from '../web-search/web-search.module';
import { ChatController } from './chat.controller';
import { CHAT_REPO, DrizzleChatRepo } from './chat.repo';
import { ChatService } from './chat.service';
import { LLM_FETCH, LLM_PROVIDER, OllamaLlmProvider } from './llm.provider';
import { SaveService } from './save.service';

@Module({
  imports: [KnowledgeModule, GraphModule, FitnessModule, BibleModule, WebSearchModule, SermonsModule, VisionModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    SaveService,
    { provide: CHAT_REPO, useValue: new DrizzleChatRepo(db) },
    { provide: LLM_PROVIDER, useClass: OllamaLlmProvider },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: LLM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  exports: [ChatService],
})
export class ChatModule {}
