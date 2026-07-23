import { Module } from '@nestjs/common';
import { db } from '../db';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { VisionController } from './vision.controller';
import { VisionJobsService } from './vision-jobs.service';
import { VisionToolsService } from './vision-tools.service';
import { DrizzleVisionRepo, VISION_REPO } from './vision.repo';

/**
 * Image → note (issue #28). The chat tool enqueues a vision_job; the api ingests
 * the note when a host-side Claude runner (#29) posts the reading back via the
 * controller. KnowledgeModule provides ingest.
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [VisionController],
  providers: [
    VisionJobsService,
    VisionToolsService,
    { provide: VISION_REPO, useValue: new DrizzleVisionRepo(db) },
  ],
  exports: [VisionToolsService],
})
export class VisionModule {}
