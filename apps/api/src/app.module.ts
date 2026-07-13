import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { GraphModule } from './graph/graph.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { OpenAiCompatModule } from './openai-compat/openai-compat.module';
import { SermonsModule } from './sermons/sermons.module';

@Module({
  imports: [
    HealthModule,
    KnowledgeModule,
    ChatModule,
    OpenAiCompatModule,
    GraphModule,
    SermonsModule,
  ],
})
export class AppModule {}
