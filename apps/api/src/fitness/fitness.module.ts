import { Module } from '@nestjs/common';
import { db } from '../db';
import { FitnessController } from './fitness.controller';
import { FitnessToolsService } from './fitness-tools.service';
import { DrizzleFitnessRepo, FITNESS_REPO } from './fitness.repo';

@Module({
  controllers: [FitnessController],
  providers: [
    FitnessToolsService,
    { provide: FITNESS_REPO, useValue: new DrizzleFitnessRepo(db) },
  ],
  exports: [FitnessToolsService],
})
export class FitnessModule {}
