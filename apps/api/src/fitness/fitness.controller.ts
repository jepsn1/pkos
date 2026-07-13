import { Controller, Get, Inject } from '@nestjs/common';
import { FITNESS_REPO, type FitnessRepo } from './fitness.repo';

/** Thin REST fallback for UI/verification; logging happens through chat tools. */
@Controller('fitness')
export class FitnessController {
  constructor(@Inject(FITNESS_REPO) private readonly repo: FitnessRepo) {}

  @Get('workouts')
  async workouts() {
    return this.repo.recentWorkouts(50);
  }

  @Get('metrics')
  async metrics() {
    return this.repo.listMetrics();
  }
}
