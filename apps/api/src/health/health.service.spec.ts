import { describe, expect, it } from 'vitest';
import { HealthService, type DbClient } from './health.service';

const okDb: DbClient = {
  query: async (sql: string) => ({
    rows: sql.includes('pg_extension') ? [{ '?column?': 1 }] : [{ '?column?': 1 }],
  }),
};

const noVectorDb: DbClient = {
  query: async (sql: string) => ({
    rows: sql.includes('pg_extension') ? [] : [{ '?column?': 1 }],
  }),
};

const downDb: DbClient = {
  query: async () => {
    throw new Error('connection refused');
  },
};

const okFetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
const brokenFetch = (async () => {
  throw new Error('fetch failed');
}) as unknown as typeof fetch;
const http500Fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;

describe('HealthService', () => {
  it('is ok when db (incl. vector extension) and ollama respond', async () => {
    const health = await new HealthService(okDb, okFetch).check();
    expect(health).toEqual({
      status: 'ok',
      service: 'api',
      checks: { db: { ok: true, vector: true }, ollama: { ok: true } },
    });
  });

  it('errors when db is down', async () => {
    const health = await new HealthService(downDb, okFetch).check();
    expect(health.status).toBe('error');
    expect(health.checks.db).toEqual({
      ok: false,
      vector: false,
      error: 'connection refused',
    });
    expect(health.checks.ollama.ok).toBe(true);
  });

  it('errors when vector extension is missing', async () => {
    const health = await new HealthService(noVectorDb, okFetch).check();
    expect(health.status).toBe('error');
    expect(health.checks.db).toEqual({
      ok: false,
      vector: false,
      error: 'vector extension missing',
    });
  });

  it('errors when ollama is unreachable', async () => {
    const health = await new HealthService(okDb, brokenFetch).check();
    expect(health.status).toBe('error');
    expect(health.checks.ollama).toEqual({ ok: false, error: 'fetch failed' });
    expect(health.checks.db.ok).toBe(true);
  });

  it('errors when ollama responds non-2xx', async () => {
    const health = await new HealthService(okDb, http500Fetch).check();
    expect(health.status).toBe('error');
    expect(health.checks.ollama).toEqual({ ok: false, error: 'HTTP 500' });
  });
});
