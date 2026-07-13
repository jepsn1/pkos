import { Module } from '@nestjs/common';
import { ChatModule } from './chat/chat.module';
import { FitnessModule } from './fitness/fitness.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';

@Module({
  imports: [HealthModule, KnowledgeModule, ChatModule, FitnessModule],
})
export class AppModule {}
