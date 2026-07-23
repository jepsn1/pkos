import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeToolsService } from './knowledge-tools.service';
import type {
  IngestRequest,
  KnowledgeService,
  UnifiedSearchHit,
} from './knowledge.service';
import type { KnowledgeItem } from './knowledge.repo';

type StoredItem = KnowledgeItem & { body: string };

function item(partial: Partial<StoredItem> & { id: string; path: string; title: string }): StoredItem {
  return {
    source: null,
    tags: [],
    summary: null,
    importance: null,
    created: '2026-07-14',
    updated: new Date(),
    body: `body of ${partial.title}`,
    ...partial,
  };
}

/** Records ingest calls, serves list/get/search from an in-memory set. */
class FakeKnowledgeService {
  ingested: IngestRequest[] = [];
  fail: Error | null = null;
  items: StoredItem[] = [];
  searchHits: UnifiedSearchHit[] = [];
  searched: string[] = [];

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

  async list(): Promise<KnowledgeItem[]> {
    return this.items.map(({ body: _body, ...rest }) => rest);
  }

  async get(id: string): Promise<StoredItem> {
    const found = this.items.find((i) => i.id === id);
    if (!found) throw new Error(`no knowledge item ${id}`);
    return found;
  }

  async search(query: string, limit: number): Promise<UnifiedSearchHit[]> {
    this.searched.push(query);
    return this.searchHits.slice(0, limit);
  }

  moved: Array<{ id: string; folder: string }> = [];
  async move(id: string, folder: string): Promise<{ from: string; to: string; title: string }> {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new Error(`no item ${id}`);
    this.moved.push({ id, folder });
    const from = it.path;
    it.path = `${folder}/${from.split('/').pop()}`;
    return { from, to: it.path, title: it.title };
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

  it('auto-embeds an image attached this turn at the top of the note (dedup-safe)', async () => {
    const img = { id: 'x', url: 'http://pkos/api/attachments/x', mime: 'image/jpeg', base64: 'QUJD' };

    // model wrote only the dictated text -> we prepend the embed
    await service.execute(
      { name: 'save_note', arguments: { title: 'Paper note', markdown: 'My dictated note.' } },
      { images: [img] },
    );
    expect(knowledge.ingested[0].markdown).toBe(
      '![](http://pkos/api/attachments/x)\n\nMy dictated note.',
    );

    // model already embedded it -> no duplicate
    await service.execute(
      {
        name: 'save_note',
        arguments: { title: 'Paper note 2', markdown: 'Text ![](http://pkos/api/attachments/x) here.' },
      },
      { images: [img] },
    );
    expect(knowledge.ingested[1].markdown).toBe('Text ![](http://pkos/api/attachments/x) here.');
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

describe('read_note', () => {
  beforeEach(() => {
    knowledge.items = [
      item({ id: 'g', path: 'faith/on-grace.md', title: 'On Grace', tags: ['faith'] }),
      item({ id: 'm', path: 'faith/on-mercy.md', title: 'On Mercy', tags: ['faith'] }),
    ];
  });

  it('recalls full markdown by exact title (case-insensitive)', async () => {
    const res = await run('read_note', { title: 'on grace' });
    expect(res).toEqual({
      found: true,
      title: 'On Grace',
      path: 'faith/on-grace.md',
      tags: ['faith'],
      markdown: 'body of On Grace',
    });
    // exact hit resolves without touching semantic search
    expect(knowledge.searched).toEqual([]);
  });

  it('recalls by exact vault path', async () => {
    const res = await run('read_note', { path: 'faith/on-mercy.md' });
    expect(res.found).toBe(true);
    expect(res.markdown).toBe('body of On Mercy');
  });

  it('ambiguous title → candidates, no body', async () => {
    knowledge.items.push(item({ id: 'g2', path: 'articles/grace.md', title: 'On Grace' }));
    const res = await run('read_note', { title: 'On Grace' });
    expect(res.found).toBe(false);
    expect(res.candidates.map((c: { path: string }) => c.path)).toEqual([
      'faith/on-grace.md',
      'articles/grace.md',
    ]);
    expect(knowledge.searched).toEqual([]); // ambiguity resolved before fallback
  });

  it('no exact title → offers closest semantic candidates, still found:false', async () => {
    knowledge.searchHits = [
      {
        type: 'knowledge',
        id: 'g',
        path: 'faith/on-grace.md',
        title: 'On Grace',
        summary: null,
        score: 0.6,
      },
    ];
    const res = await run('read_note', { title: 'unmerited favor' });
    expect(res.found).toBe(false);
    expect(res.candidates).toEqual([{ title: 'On Grace', path: 'faith/on-grace.md' }]);
    expect(knowledge.searched).toEqual(['unmerited favor']);
  });

  it('confident single semantic hit → auto-reads it in full', async () => {
    knowledge.items = [item({ id: 'g', path: 'faith/on-grace.md', title: 'On Grace' })];
    knowledge.searchHits = [
      { type: 'knowledge', id: 'g', path: 'faith/on-grace.md', title: 'On Grace', summary: null, score: 0.82 },
    ];
    const res = await run('read_note', { title: 'note about grace' });
    expect(res.found).toBe(true);
    expect(res.path).toBe('faith/on-grace.md');
    expect(res.markdown).toBe('body of On Grace');
  });

  it('strong top but close runner-up → offers candidates, does not guess', async () => {
    knowledge.items = [item({ id: 'g', path: 'faith/on-grace.md', title: 'On Grace' })];
    knowledge.searchHits = [
      { type: 'knowledge', id: 'g', path: 'faith/on-grace.md', title: 'On Grace', summary: null, score: 0.82 },
      { type: 'knowledge', id: 'm', path: 'faith/on-mercy.md', title: 'On Mercy', summary: null, score: 0.8 },
    ];
    const res = await run('read_note', { title: 'grace and mercy' });
    expect(res.found).toBe(false);
    expect(res.candidates).toHaveLength(2);
  });

  it('nothing matches → found:false with empty candidates', async () => {
    const res = await run('read_note', { title: 'quantum chromodynamics' });
    expect(res).toEqual({
      found: false,
      candidates: [],
      message: 'no note found matching "quantum chromodynamics"',
    });
  });

  it('unknown path → found:false', async () => {
    const res = await run('read_note', { path: 'faith/nope.md' });
    expect(res.found).toBe(false);
    expect(res.candidates).toEqual([]);
  });

  it('neither title nor path → {error}', async () => {
    expect((await run('read_note', {})).error).toMatch(/title or path/);
  });
});

describe('list_notes', () => {
  beforeEach(() => {
    knowledge.items = [
      item({ id: 'g', path: 'faith/on-grace.md', title: 'On Grace', tags: ['faith', 'grace'] }),
      item({ id: 'm', path: 'faith/on-mercy.md', title: 'On Mercy', tags: ['faith'] }),
      item({ id: 'e', path: 'articles/esv.md', title: 'ESV', tags: ['bible'], summary: 'pref' }),
    ];
  });

  it('lists every note as title/path/tags/summary', async () => {
    const res = await run('list_notes', {});
    expect(res.count).toBe(3);
    expect(res.notes).toContainEqual({
      title: 'ESV',
      path: 'articles/esv.md',
      tags: ['bible'],
      summary: 'pref',
    });
  });

  it('filters by folder prefix', async () => {
    const res = await run('list_notes', { folder: 'faith' });
    expect(res.notes.map((n: { path: string }) => n.path)).toEqual([
      'faith/on-grace.md',
      'faith/on-mercy.md',
    ]);
  });

  it('filters by tag', async () => {
    const res = await run('list_notes', { tag: 'grace' });
    expect(res.notes.map((n: { path: string }) => n.path)).toEqual(['faith/on-grace.md']);
  });

  it('rejects a traversal folder', async () => {
    expect((await run('list_notes', { folder: '../etc' })).error).toBeDefined();
  });
});

describe('move_note', () => {
  it('moves a note identified by exact title to the target folder', async () => {
    knowledge.items = [
      item({ id: 'p', path: 'articles/pastor-notes.md', title: 'Pastor Notes' }),
    ];
    const res = await run('move_note', { title: 'Pastor Notes', folder: 'sermons' });
    expect(res.moved).toBe(true);
    expect(res.from).toBe('articles/pastor-notes.md');
    expect(res.to).toBe('sermons/pastor-notes.md');
    expect(knowledge.moved).toEqual([{ id: 'p', folder: 'sermons' }]);
  });

  it('moves a note identified by exact path', async () => {
    knowledge.items = [item({ id: 'g', path: 'articles/on-grace.md', title: 'On Grace' })];
    const res = await run('move_note', { path: 'articles/on-grace.md', folder: 'faith/reflections' });
    expect(res.moved).toBe(true);
    expect(res.to).toBe('faith/reflections/on-grace.md');
  });

  it('ambiguous title → returns candidates, does not move', async () => {
    knowledge.items = [
      item({ id: 'a', path: 'articles/note.md', title: 'Notes' }),
      item({ id: 'b', path: 'faith/note.md', title: 'Notes' }),
    ];
    const res = await run('move_note', { title: 'Notes', folder: 'sermons' });
    expect(res.moved).toBeUndefined();
    expect(res.found).toBe(false);
    expect(knowledge.moved).toEqual([]);
  });

  it('missing folder → {error}', async () => {
    knowledge.items = [item({ id: 'p', path: 'articles/x.md', title: 'X' })];
    expect((await run('move_note', { title: 'X' })).error).toMatch(/folder/);
  });

  it('rejects a traversal / invalid folder', async () => {
    knowledge.items = [item({ id: 'p', path: 'articles/x.md', title: 'X' })];
    expect((await run('move_note', { title: 'X', folder: '../etc' })).error).toBeDefined();
    expect(knowledge.moved).toEqual([]);
  });

  it('unknown note → found:false, no move', async () => {
    const res = await run('move_note', { title: 'nonexistent', folder: 'sermons' });
    expect(res.found).toBe(false);
    expect(knowledge.moved).toEqual([]);
  });
});
