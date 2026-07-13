import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { OpenAiCompatModule } from './openai-compat/openai-compat.module';

@Module({
  imports: [HealthModule, KnowledgeModule, ChatModule, OpenAiCompatModule],
})
export class AppModule {}
