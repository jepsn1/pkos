import { NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import type { EmbeddingProvider } from './embedding.provider';
import type {
  KnowledgeItem,
  KnowledgeRepo,
  NewKnowledgeItem,
  SearchHit,
} from './knowledge.repo';
import { KnowledgeService } from './knowledge.service';
import { VaultService } from './vault.service';

/**
 * Deterministic fake embeddings: one dimension per keyword, counting
 * occurrences. Cosine ranking then behaves like the real thing.
 */
const KEYWORDS = ['grace', 'mercy', 'romans', 'forgive', 'protein'];
const fakeEmbedder: EmbeddingProvider = {
  embed: async (text) => {
    const lower = text.toLowerCase();
    return KEYWORDS.map((k) => lower.split(k).length - 1);
  },
};

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
}

/** In-memory repo mirroring pgvector cosine semantics. */
class FakeRepo implements KnowledgeRepo {
  rows: Array<KnowledgeItem & { embedding: number[] }> = [];
  private seq = 0;

  async upsert(item: NewKnowledgeItem) {
    const existing = this.rows.find((r) => r.path === item.path);
    const row = {
      ...item,
      id: existing?.id ?? `id-${++this.seq}`,
      updated: new Date(),
    };
    this.rows = this.rows.filter((r) => r.path !== item.path).concat(row);
    const { embedding, ...rest } = row;
    return rest;
  }

  async list() {
    return this.rows
      .map(({ embedding, ...rest }) => rest)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async getById(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    const { embedding, ...rest } = row;
    return rest;
  }

  async move(id: string, path: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.path = path;
    const { embedding, ...rest } = row;
    return rest;
  }

  async search(embedding: number[], limit: number): Promise<SearchHit[]> {
    return this.rows
      .map((r) => ({
        id: r.id,
        path: r.path,
        title: r.title,
        summary: r.summary,
        score: cosine(embedding, r.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async wipe() {
    this.rows = [];
  }
}

let root: string;
let repo: FakeRepo;
let service: KnowledgeService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-ks-'));
  repo = new FakeRepo();
  const vault = new VaultService(root, async () => {});
  service = new KnowledgeService(vault, repo, fakeEmbedder);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('KnowledgeService.ingest', () => {
  it('writes the vault file with frontmatter and stores the derived row + embedding', async () => {
    const item = await service.ingest({
      title: 'On Grace',
      markdown: 'Grace is unmerited favor. Grace changes everything.',
      tags: ['grace'],
      summary: 'Notes on grace.',
      importance: 4,
      folder: 'faith/reflections',
    });

    expect(item.path).toBe('faith/reflections/On Grace.md');
    expect(item.title).toBe('On Grace');
    expect(item.tags).toEqual(['grace']);

    const raw = await fs.readFile(path.join(root, item.path), 'utf8');
    const { data } = matter(raw);
    expect(data.title).toBe('On Grace');
    expect(data.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const row = repo.rows[0];
    // title + summary + body: 'grace'/'Grace' appears 4 times
    expect(row.embedding).toEqual([4, 0, 0, 0, 0]);
  });

  it('defaults folder to articles', async () => {
    const item = await service.ingest({ title: 'Random', markdown: 'x' });
    expect(item.path).toBe('articles/Random.md');
  });
});

describe('KnowledgeService.search', () => {
  it('ranks items by cosine similarity to the query embedding', async () => {
    await service.ingest({
      title: 'On Grace',
      markdown: 'Grace, grace, and more grace.',
      folder: 'faith/reflections',
    });
    await service.ingest({
      title: 'On Mercy',
      markdown: 'Mercy triumphs. A hint of grace too.',
      folder: 'faith/reflections',
    });
    await service.ingest({
      title: 'Protein Targets',
      markdown: 'Protein protein protein.',
      folder: 'fitness',
    });

    const hits = await service.search('what have I learned about grace?');
    expect(hits.map((h) => h.title)).toEqual([
      'On Grace',
      'On Mercy',
      'Protein Targets',
    ]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0]).toMatchObject({
      path: 'faith/reflections/On Grace.md',
      title: 'On Grace',
    });
  });

  it('respects limit', async () => {
    await service.ingest({ title: 'A', markdown: 'mercy' });
    await service.ingest({ title: 'B', markdown: 'grace' });
    const hits = await service.search('grace', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('B');
  });
});

describe('KnowledgeService.get', () => {
  it('returns the row plus the body read from the vault', async () => {
    const item = await service.ingest({
      title: 'Romans 8',
      markdown: 'No condemnation in Christ Jesus.',
      folder: 'faith/bible-study',
    });
    const full = await service.get(item.id);
    expect(full.body).toBe('No condemnation in Christ Jesus.');
    expect(full.title).toBe('Romans 8');
  });

  it('404s on unknown id', async () => {
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KnowledgeService.rebuild', () => {
  it('re-derives identical rows from the vault after the db is wiped', async () => {
    await service.ingest({
      title: 'On Grace',
      markdown: 'Grace grace.',
      tags: ['grace'],
      summary: 'grace notes',
      importance: 5,
      folder: 'faith/reflections',
    });
    await service.ingest({
      title: 'Forgiveness',
      markdown: 'Forgive as you were forgiven.',
      folder: 'faith/theology',
      source: 'Matthew 18',
    });

    const stable = (rows: Array<KnowledgeItem & { embedding: number[] }>) =>
      rows
        .map(({ id, updated, ...rest }) => rest)
        .sort((a, b) => a.path.localeCompare(b.path));
    const before = stable(repo.rows);

    await repo.wipe();
    expect(repo.rows).toHaveLength(0);

    const { indexed } = await service.rebuild();
    expect(indexed).toBe(2);
    expect(stable(repo.rows)).toEqual(before);

    // search works again after rebuild
    const hits = await service.search('grace');
    expect(hits[0].title).toBe('On Grace');
  });

  it('wipes stale rows not present in the vault', async () => {
    await repo.upsert({
      path: 'ghost.md',
      title: 'Ghost',
      source: null,
      tags: [],
      summary: null,
      importance: null,
      created: '2026-01-01',
      embedding: [1, 0, 0, 0, 0],
    });
    const { indexed } = await service.rebuild();
    expect(indexed).toBe(0);
    expect(repo.rows).toHaveLength(0);
  });
});
