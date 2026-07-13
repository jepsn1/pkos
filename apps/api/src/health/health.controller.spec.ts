import { ServiceUnavailableException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import { HealthService, type Health } from './health.service';

async function controllerWith(health: Health): Promise<HealthController> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: HealthService, useValue: { check: async () => health } }],
  }).compile();
  return module.get(HealthController);
}

const okHealth: Health = {
  status: 'ok',
  service: 'api',
  checks: { db: { ok: true, vector: true }, ollama: { ok: true } },
};

const errorHealth: Health = {
  status: 'error',
  service: 'api',
  checks: {
    db: { ok: false, vector: false, error: 'connection refused' },
    ollama: { ok: true },
  },
};

describe('HealthController', () => {
  it('returns the health report when all dependencies are ok', async () => {
    const controller = await controllerWith(okHealth);
    await expect(controller.getHealth()).resolves.toEqual(okHealth);
  });

  it('throws 503 with the full report when a dependency fails', async () => {
    const controller = await controllerWith(errorHealth);
    const err = await controller.getHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect((err as ServiceUnavailableException).getResponse()).toEqual(errorHealth);
  });
});
