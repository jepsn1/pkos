import { ConflictException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmMessage, LlmProvider } from '../chat/llm.provider';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import type {
  KnowledgeItem,
  KnowledgeRepo,
  NewKnowledgeItem,
} from '../knowledge/knowledge.repo';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { VaultService } from '../knowledge/vault.service';
import {
  EnrichmentService,
  buildArticleBody,
  parseEnrichment,
  refToTag,
  refsToTags,
  splitByLength,
} from './enrichment.service';
import { FakeSermonRepo } from './fake-sermon-repo';
import type { SermonJob } from './sermons.repo';

class FakeLlm implements LlmProvider {
  calls: LlmMessage[][] = [];
  queue: string[] = [];

  async chat(messages: LlmMessage[]): Promise<string> {
    this.calls.push(messages);
    const next = this.queue.shift();
    if (!next) throw new Error('FakeLlm queue empty');
    return next;
  }
}

class FakeKnowledgeRepo implements KnowledgeRepo {
  items: KnowledgeItem[] = [];
  private seq = 0;

  async upsert(item: NewKnowledgeItem): Promise<KnowledgeItem> {
    const { embedding: _e, ...meta } = item;
    const existing = this.items.find((i) => i.path === item.path);
    if (existing) {
      Object.assign(existing, meta, { updated: new Date() });
      return existing;
    }
    const row = { ...meta, id: `k-${++this.seq}`, updated: new Date() };
    this.items.push(row);
    return row;
  }

  async getById(id: string): Promise<KnowledgeItem | null> {
    return this.items.find((i) => i.id === id) ?? null;
  }

  async list(): Promise<KnowledgeItem[]> {
    return this.items;
  }

  search(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  wipe(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }
}

const fakeEmbedder: EmbeddingProvider = { embed: async () => [1, 0, 0] };

const ENRICH_JSON = JSON.stringify({
  title: 'The Gospel of John',
  summary: 'John wrote so that we may believe Jesus is the Christ.',
  themes: ['belief', 'eternal life'],
  bible_references: ['John 3:16', 'John 20:31', '1 Corinthians 13:4-7'],
  action_points: ['Read one chapter of John this week'],
  key_quotes: ['These are written so that you may believe.'],
  tags: ['Gospel', 'john', 'faith'],
});

let root: string;
let repo: FakeSermonRepo;
let llm: FakeLlm;
let knowledgeRepo: FakeKnowledgeRepo;
let gitCalls: string[][];
let vault: VaultService;
let service: EnrichmentService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-enrich-'));
  repo = new FakeSermonRepo();
  llm = new FakeLlm();
  knowledgeRepo = new FakeKnowledgeRepo();
  gitCalls = [];
  vault = new VaultService(root, async (args) => {
    gitCalls.push(args);
  });
  const knowledge = new KnowledgeService(vault, knowledgeRepo, fakeEmbedder);
  service = new EnrichmentService(repo, llm, knowledge, 0); // pollMs 0 = no timer
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.ENRICH_INPUT_MAX_CHARS;
});

/** Job the worker already finished: status done + transcript. */
async function seedDoneJob(
  meta: { speaker?: string; date?: string; title?: string } = {},
  transcript = 'In the beginning was the Word... believe and have life.',
): Promise<SermonJob> {
  const job = await repo.create('sermon.mp3', 'abc.mp3', meta);
  job.status = 'done';
  job.transcript = transcript;
  return job;
}

describe('EnrichmentService.pollOnce', () => {
  it('turns a done job into a vault article: PRD naming, frontmatter, sections, commit, pointer', async () => {
    const job = await seedDoneJob({ speaker: 'John Piper', date: '2026-07-12' });
    llm.queue.push(ENRICH_JSON);

    expect(await service.pollOnce()).toBe(1);

    const done = (await repo.getById(job.id))!;
    expect(done.status).toBe('enriched');
    expect(done.articleItemId).toBe('k-1');
    expect(done.articlePath).toBe(
      'faith/sermons/2026-07-12 The Gospel of John - John Piper.md',
    );
    expect(done.enrichError).toBeNull();

    const note = await vault.readNote(done.articlePath!);
    expect(note?.meta.title).toBe('The Gospel of John');
    expect(note?.meta.source).toBe(`sermon:${job.id}`);
    expect(note?.meta.summary).toContain('believe Jesus is the Christ');
    expect(note?.meta.created).toBe('2026-07-12');
    // LLM tags lowercased + structured Bible-ref tags
    expect(note?.meta.tags).toEqual([
      'gospel',
      'john',
      'faith',
      'ref:john-3',
      'ref:john-20',
      'ref:1-corinthians-13',
    ]);

    const body = note!.body;
    expect(body).toContain('## Summary');
    expect(body).toContain('## Main Themes');
    expect(body).toContain('- belief');
    expect(body).toContain('## Bible References');
    expect(body).toContain('- John 3:16');
    expect(body).toContain('## Action Points');
    expect(body).toContain('## Key Quotes');
    expect(body).toContain('> These are written so that you may believe.');
    // transcript stays attached via the job reference
    expect(body).toContain(`GET /api/sermons/${job.id}`);

    expect(gitCalls).toContainEqual(['add', done.articlePath]);

    // db row embedded via ingest
    const item = await knowledgeRepo.getById('k-1');
    expect(item?.source).toBe(`sermon:${job.id}`);
  });

  it('falls back to today + Unknown speaker without upload metadata', async () => {
    await seedDoneJob();
    llm.queue.push(ENRICH_JSON);

    await service.pollOnce();

    const today = new Date().toISOString().slice(0, 10);
    expect(repo.rows[0].articlePath).toBe(
      `faith/sermons/${today} The Gospel of John - Unknown.md`,
    );
  });

  it('prefers the upload title over the LLM suggestion', async () => {
    await seedDoneJob({ title: 'Sunday: Life in His Name', date: '2026-07-12' });
    llm.queue.push(ENRICH_JSON);

    await service.pollOnce();

    // sanitized filename (":" stripped), user title in frontmatter
    expect(repo.rows[0].articlePath).toBe(
      'faith/sermons/2026-07-12 Sunday Life in His Name - Unknown.md',
    );
    const note = await vault.readNote(repo.rows[0].articlePath!);
    expect(note?.meta.title).toBe('Sunday: Life in His Name');
  });

  it('is idempotent: one article per job, enriched jobs never re-claimed', async () => {
    await seedDoneJob({ date: '2026-07-12' });
    llm.queue.push(ENRICH_JSON);

    expect(await service.pollOnce()).toBe(1);
    expect(await service.pollOnce()).toBe(0); // nothing left to claim

    expect(knowledgeRepo.items).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('records the failure and keeps the transcript; job stays retryable', async () => {
    const job = await seedDoneJob();
    llm.queue.push('total garbage, no json');

    expect(await service.pollOnce()).toBe(0);

    const failed = (await repo.getById(job.id))!;
    expect(failed.status).toBe('enrich_error');
    expect(failed.enrichError).toMatch(/not usable JSON/);
    expect(failed.transcript).toContain('In the beginning');
    expect(failed.articleItemId).toBeNull();
    expect(knowledgeRepo.items).toHaveLength(0);

    // manual retry succeeds and clears the error
    llm.queue.push(ENRICH_JSON);
    const res = await service.enrich(job.id);
    expect(res.itemId).toBe('k-1');
    const done = (await repo.getById(job.id))!;
    expect(done.status).toBe('enriched');
    expect(done.enrichError).toBeNull();
  });

  it('condenses transcripts over the input budget before the JSON pass', async () => {
    process.env.ENRICH_INPUT_MAX_CHARS = '80';
    const knowledge = new KnowledgeService(vault, knowledgeRepo, fakeEmbedder);
    service = new EnrichmentService(repo, llm, knowledge, 0);

    const longTranscript = 'word '.repeat(50).trim(); // 249 chars > 80 budget
    const pieces = splitByLength(longTranscript, 80);
    expect(pieces.length).toBeGreaterThan(1);
    await seedDoneJob({ date: '2026-07-12' }, longTranscript);
    llm.queue.push(...pieces.map((_, i) => `notes ${i + 1}`), ENRICH_JSON);

    expect(await service.pollOnce()).toBe(1);

    expect(llm.calls).toHaveLength(pieces.length + 1); // per-piece condense + JSON pass
    expect(llm.calls[0][0].content).toContain('condense');
    const finalUser = llm.calls[pieces.length][1].content;
    expect(finalUser).toContain('notes 1');
    expect(finalUser).toContain(`notes ${pieces.length}`);
    expect(repo.rows[0].status).toBe('enriched');
  });
});

describe('EnrichmentService.enrich (manual trigger)', () => {
  it('404s on unknown job', async () => {
    await expect(service.enrich('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s with the existing article when already enriched', async () => {
    const job = await seedDoneJob({ date: '2026-07-12' });
    llm.queue.push(ENRICH_JSON);
    const first = await service.enrich(job.id);

    const err = await service.enrich(job.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<string, unknown>;
    expect(body.itemId).toBe(first.itemId);
    expect(body.path).toBe(first.path);
    expect(llm.calls).toHaveLength(1);
  });

  it('409s on jobs without a finished transcript', async () => {
    const job = await repo.create('sermon.mp3', 'abc.mp3'); // still queued
    await expect(service.enrich(job.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('parseEnrichment', () => {
  it('tolerates code fences and prose around the JSON', () => {
    const e = parseEnrichment('Sure!\n```json\n' + ENRICH_JSON + '\n```\nDone.');
    expect(e.title).toBe('The Gospel of John');
    expect(e.themes).toEqual(['belief', 'eternal life']);
    expect(e.bibleReferences).toContain('John 3:16');
  });

  it('accepts camelCase keys and coerces sloppy arrays', () => {
    const e = parseEnrichment(
      JSON.stringify({
        title: 'T',
        summary: 'S',
        bibleReferences: ['John 1', 42, '  '],
        keyQuotes: 'not an array',
      }),
    );
    expect(e.bibleReferences).toEqual(['John 1', '42']);
    expect(e.keyQuotes).toEqual([]);
    expect(e.tags).toEqual([]);
  });

  it('throws on non-JSON and on missing title/summary', () => {
    expect(() => parseEnrichment('no json here')).toThrow(/not usable JSON/);
    expect(() => parseEnrichment('{"title":"x"}')).toThrow(/not usable JSON/);
    expect(() => parseEnrichment('{"summary":"x"}')).toThrow(/not usable JSON/);
  });
});

describe('Bible refs → structured tags', () => {
  it.each([
    ['John 3:16', 'ref:john-3'],
    ['John 3', 'ref:john-3'],
    ['1 Corinthians 13:4-7', 'ref:1-corinthians-13'],
    ['Psalm 23:1', 'ref:psalm-23'],
    ['Song of Solomon 2:1', 'ref:song-of-solomon-2'],
    ['Jude', 'ref:jude'],
  ])('%s → %s', (ref, tag) => {
    expect(refToTag(ref)).toBe(tag);
  });

  it('drops garbage and dedupes chapters', () => {
    expect(refToTag('42')).toBeNull();
    expect(refToTag('  ')).toBeNull();
    expect(refsToTags(['John 3:16', 'John 3:17', 'John 4:1'])).toEqual([
      'ref:john-3',
      'ref:john-4',
    ]);
  });
});

describe('helpers', () => {
  it('splitByLength splits on whitespace within the budget', () => {
    const pieces = splitByLength('aaa bbb ccc ddd', 8);
    expect(pieces.join(' ')).toBe('aaa bbb ccc ddd');
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(8);
  });

  it('buildArticleBody omits empty sections', () => {
    const body = buildArticleBody(
      {
        title: 'T',
        summary: 'S',
        themes: [],
        bibleReferences: [],
        actionPoints: [],
        keyQuotes: [],
        tags: [],
      },
      'job-1',
    );
    expect(body).toContain('## Summary');
    expect(body).not.toContain('## Main Themes');
    expect(body).toContain('job-1');
  });
});
