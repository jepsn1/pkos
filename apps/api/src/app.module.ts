import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';

@Module({
  imports: [HealthModule, KnowledgeModule],
})
export class AppModule {}
