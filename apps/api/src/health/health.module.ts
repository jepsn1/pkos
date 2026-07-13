import { Module } from '@nestjs/common';
import { pool } from '../db';
import { HealthController } from './health.controller';
import { DB_CLIENT, FETCH, HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: DB_CLIENT, useValue: pool },
    // bind: undici's fetch throws "Illegal invocation" when called detached
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class HealthModule {}
