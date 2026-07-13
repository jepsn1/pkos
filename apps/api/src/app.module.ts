import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { SermonsModule } from './sermons/sermons.module';

@Module({
  imports: [HealthModule, KnowledgeModule, ChatModule, SermonsModule],
})
export class AppModule {}
