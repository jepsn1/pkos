import { Module } from '@nestjs/common';
import { db } from '../db';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ChatController } from './chat.controller';
import { CHAT_REPO, DrizzleChatRepo } from './chat.repo';
import { ChatService } from './chat.service';
import { LLM_FETCH, LLM_PROVIDER, OllamaLlmProvider } from './llm.provider';
import { SaveService } from './save.service';

@Module({
  imports: [KnowledgeModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    SaveService,
    { provide: CHAT_REPO, useValue: new DrizzleChatRepo(db) },
    { provide: LLM_PROVIDER, useClass: OllamaLlmProvider },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: LLM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class ChatModule {}
