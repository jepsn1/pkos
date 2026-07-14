import { Module } from '@nestjs/common';
import { LLM_FETCH } from '../chat/llm.provider';
import { db } from '../db';
import { FitnessController } from './fitness.controller';
import { FitnessToolsService } from './fitness-tools.service';
import { EXTRACT_LLM, ExtractionService, OllamaExtractionLlm } from './extraction.service';
import { DrizzleFitnessRepo, FITNESS_REPO } from './fitness.repo';

@Module({
  controllers: [FitnessController],
  providers: [
    FitnessToolsService,
    ExtractionService,
    { provide: FITNESS_REPO, useValue: new DrizzleFitnessRepo(db) },
    { provide: EXTRACT_LLM, useClass: OllamaExtractionLlm },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: LLM_FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
  exports: [FitnessToolsService],
})
export class FitnessModule {}
