import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './embedding.provider';
import type {
  KnowledgeItem,
  KnowledgeRepo,
  NewKnowledgeItem,
  SearchHit,
} from './knowledge.repo';
import { KnowledgeService } from './knowledge.service';
import { VaultService } from './vault.service';
import type { SermonSearchHit, TranscriptSearch } from '../sermons/sermons.repo';

/** Keyword-count embeddings (same trick as knowledge.service.spec). */
const KEYWORDS = ['grace', 'gettysburg', 'protein'];
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

class FakeRepo implements KnowledgeRepo {
  rows: Array<KnowledgeItem & { embedding: number[] }> = [];
  private seq = 0;

  async upsert(item: NewKnowledgeItem) {
    const row = { ...item, id: `k-${++this.seq}`, updated: new Date() };
    this.rows = this.rows.filter((r) => r.path !== item.path).concat(row);
    const { embedding, ...rest } = row;
    return rest;
  }

  async list() {
    return this.rows.map(({ embedding, ...rest }) => rest);
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

/** In-memory transcript chunk index mirroring pgvector cosine ranking. */
class FakeTranscriptSearch implements TranscriptSearch {
  chunks: Array<Omit<SermonSearchHit, 'score'> & { embedding: number[] }> = [];

  async search(embedding: number[], limit: number): Promise<SermonSearchHit[]> {
    return this.chunks
      .map(({ embedding: e, ...rest }) => ({ ...rest, score: cosine(embedding, e) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

let root: string;
let repo: FakeRepo;
let transcripts: FakeTranscriptSearch;
let service: KnowledgeService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-su-'));
  repo = new FakeRepo();
  transcripts = new FakeTranscriptSearch();
  const vault = new VaultService(root, async () => {});
  service = new KnowledgeService(vault, repo, fakeEmbedder, transcripts);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function seed() {
  await service.ingest({
    title: 'On Grace',
    markdown: 'Grace grace grace.',
    folder: 'faith',
  });
  transcripts.chunks.push({
    id: 'c-1',
    jobId: 'job-1',
    title: 'lincoln.mp3',
    text: 'that this nation shall have a new birth of freedom at Gettysburg',
    seq: 0,
    startSec: 12.5,
    endSec: 47.1,
    embedding: await fakeEmbedder.embed('gettysburg gettysburg'),
  });
}

describe('GET /api/search union', () => {
  it('returns knowledge and sermon hits with a type discriminator', async () => {
    await seed();
    const hits = await service.search('grace and gettysburg');

    const types = hits.map((h) => h.type).sort();
    expect(types).toEqual(['knowledge', 'sermon']);

    const sermon = hits.find((h) => h.type === 'sermon');
    expect(sermon).toMatchObject({
      jobId: 'job-1',
      title: 'lincoln.mp3',
      seq: 0,
      startSec: 12.5,
      endSec: 47.1,
    });
    expect(sermon && 'text' in sermon && sermon.text).toContain('Gettysburg');
  });

  it('ranks the union by score across both sources', async () => {
    await seed();
    const hits = await service.search('gettysburg address speech');
    expect(hits[0].type).toBe('sermon');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    const graceFirst = await service.search('what about grace?');
    expect(graceFirst[0].type).toBe('knowledge');
    expect(graceFirst[0]).toMatchObject({ title: 'On Grace' });
  });

  it('applies limit to the merged result', async () => {
    await seed();
    const hits = await service.search('grace gettysburg', 1);
    expect(hits).toHaveLength(1);
  });

  it('keeps knowledge-only behavior when no transcript search is wired', async () => {
    const solo = new KnowledgeService(
      new VaultService(root, async () => {}),
      repo,
      fakeEmbedder,
    );
    await solo.ingest({ title: 'On Grace', markdown: 'grace', folder: 'faith' });
    const hits = await solo.search('grace');
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe('knowledge');
  });
});
