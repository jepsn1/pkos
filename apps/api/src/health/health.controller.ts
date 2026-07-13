import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService, type Health } from './health.service';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  async getHealth(): Promise<Health> {
    const result = await this.health.check();
    if (result.status !== 'ok') {
      // 503 with the full report so callers see which dependency failed
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
