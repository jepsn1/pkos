import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { GraphModule } from './graph/graph.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';

@Module({
  imports: [HealthModule, KnowledgeModule, ChatModule, GraphModule],
})
export class AppModule {}
