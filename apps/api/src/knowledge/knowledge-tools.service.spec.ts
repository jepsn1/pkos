import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeToolsService } from './knowledge-tools.service';
import type { IngestRequest, KnowledgeService } from './knowledge.service';
import type { KnowledgeItem } from './knowledge.repo';

/** Records ingest calls; returns a canned item echoing the request. */
class FakeKnowledgeService {
  ingested: IngestRequest[] = [];
  fail: Error | null = null;

  async ingest(req: IngestRequest): Promise<KnowledgeItem> {
    if (this.fail) throw this.fail;
    this.ingested.push(req);
    return {
      id: 'item-1',
      path: `${req.folder ?? 'articles'}/slugged-title.md`,
      title: req.title,
      source: req.source ?? null,
      tags: req.tags ?? [],
      summary: req.summary ?? null,
      importance: null,
      created: '2026-07-14',
      updated: new Date(),
    };
  }
}

let knowledge: FakeKnowledgeService;
let service: KnowledgeToolsService;

beforeEach(() => {
  knowledge = new FakeKnowledgeService();
  service = new KnowledgeToolsService(knowledge as unknown as KnowledgeService);
});

async function run(name: string, args: Record<string, unknown>) {
  return JSON.parse(await service.execute({ name, arguments: args }));
}

describe('save_note', () => {
  it('ingests with source=chat and returns the saved path', async () => {
    const res = await run('save_note', {
      title: 'ESV preference',
      markdown: 'Marcus prefers the ESV translation.',
      folder: 'faith',
      tags: ['Bible', ' preferences '],
      summary: 'Preferred Bible translation.',
    });

    expect(res).toEqual({
      saved: true,
      item_id: 'item-1',
      path: 'faith/slugged-title.md',
      title: 'ESV preference',
    });
    expect(knowledge.ingested).toEqual([
      {
        title: 'ESV preference',
        markdown: 'Marcus prefers the ESV translation.',
        source: 'chat',
        folder: 'faith',
        tags: ['bible', 'preferences'], // trimmed + lowercased
        summary: 'Preferred Bible translation.',
      },
    ]);
  });

  it('minimal call: optionals omitted so ingest defaults apply', async () => {
    const res = await run('save_note', { title: 'A fact', markdown: 'Body.' });
    expect(res.saved).toBe(true);
    expect(knowledge.ingested[0]).toEqual({
      title: 'A fact',
      markdown: 'Body.',
      source: 'chat',
      folder: undefined,
      tags: undefined,
      summary: undefined,
    });
  });

  it('strips surrounding slashes from folder', async () => {
    await run('save_note', { title: 'T', markdown: 'B', folder: '/faith/notes/' });
    expect(knowledge.ingested[0].folder).toBe('faith/notes');
  });

  it('validation errors come back as {error}, nothing ingested', async () => {
    for (const args of [
      { markdown: 'no title' },
      { title: '  ', markdown: 'blank title' },
      { title: 'T' },
      { title: 'T', markdown: '' },
      { title: 'T', markdown: 'B', folder: '../escape' },
      { title: 'T', markdown: 'B', folder: 'a/../b' },
      { title: 'T', markdown: 'B', tags: 'not-an-array' },
      { title: 'T', markdown: 'B', tags: ['ok', 42] },
      { title: 'T', markdown: 'B', summary: 7 },
    ]) {
      const res = await run('save_note', args);
      expect(res.error, JSON.stringify(args)).toBeDefined();
    }
    expect(knowledge.ingested).toHaveLength(0);
  });

  it('unknown tool → {error}; ingest failures propagate (not swallowed)', async () => {
    expect((await run('nuke_vault', {})).error).toMatch(/unknown tool/);

    knowledge.fail = new Error('vault down');
    await expect(
      service.execute({ name: 'save_note', arguments: { title: 'T', markdown: 'B' } }),
    ).rejects.toThrow('vault down');
  });
});
