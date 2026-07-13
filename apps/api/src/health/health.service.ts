import { Inject, Injectable } from '@nestjs/common';

/** Minimal query surface the health check needs (satisfied by pg.Pool). */
export interface DbClient {
  query(sql: string): Promise<{ rows: unknown[] }>;
}

export const DB_CLIENT = 'DB_CLIENT';
export const FETCH = 'FETCH';

export interface DependencyStatus {
  ok: boolean;
  error?: string;
}

export interface DbStatus extends DependencyStatus {
  vector: boolean;
}

export interface Health {
  status: 'ok' | 'error';
  service: 'api';
  checks: {
    db: DbStatus;
    ollama: DependencyStatus;
  };
}

const OLLAMA_TIMEOUT_MS = 3000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  async check(): Promise<Health> {
    const [db, ollama] = await Promise.all([this.checkDb(), this.checkOllama()]);
    return {
      status: db.ok && ollama.ok ? 'ok' : 'error',
      service: 'api',
      checks: { db, ollama },
    };
  }

  private async checkDb(): Promise<DbStatus> {
    try {
      await this.db.query('SELECT 1');
      const { rows } = await this.db.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
      );
      if (rows.length === 0) {
        return { ok: false, vector: false, error: 'vector extension missing' };
      }
      return { ok: true, vector: true };
    } catch (err) {
      return { ok: false, vector: false, error: message(err) };
    }
  }

  private async checkOllama(): Promise<DependencyStatus> {
    const base = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    try {
      const res = await this.fetchFn(`${base}/api/tags`, {
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
