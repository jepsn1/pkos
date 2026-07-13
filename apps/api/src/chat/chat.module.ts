import { Module } from '@nestjs/common';
import { db } from '../db';
import { FitnessModule } from '../fitness/fitness.module';
import { GraphModule } from '../graph/graph.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ChatController } from './chat.controller';
import { CHAT_REPO, DrizzleChatRepo } from './chat.repo';
import { ChatService } from './chat.service';
import { LLM_FETCH, LLM_PROVIDER, OllamaLlmProvider } from './llm.provider';
import { SaveService } from './save.service';

@Module({
  imports: [KnowledgeModule, GraphModule, FitnessModule],
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
