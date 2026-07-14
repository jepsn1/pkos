import { ConflictException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmMessage, LlmProvider } from '../chat/llm.provider';
import { GraphService } from '../graph/graph.service';
import type { Relationship, RelationshipRepo, RelationshipType } from '../graph/relationship.repo';
import type { EmbeddingProvider } from '../knowledge/embedding.provider';
import type { KnowledgeItem, KnowledgeRepo, NewKnowledgeItem } from '../knowledge/knowledge.repo';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { parseNote } from '../knowledge/note';
import { VaultService } from '../knowledge/vault.service';
import { SuggesterService } from './suggester.service';
import type {
  ItemMetaPatch,
  SimilarItem,
  Suggestion,
  SuggestionKind,
  SuggestionRepo,
  SuggestionStatus,
  SuggestionWithItem,
} from './suggestion.repo';
import { SuggestionsService } from './suggestions.service';

class FakeKnowledgeRepo implements KnowledgeRepo {
  rows: KnowledgeItem[] = [];
  private seq = 0;

  async list() {
    return this.rows;
  }

  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async upsert(item: NewKnowledgeItem): Promise<KnowledgeItem> {
    const { embedding: _e, ...rest } = item;
    const row: KnowledgeItem = { ...rest, id: `k-${++this.seq}`, updated: new Date() };
    this.rows.push(row);
    return row;
  }

  search = () => Promise.reject(new Error('unused'));
  wipe = () => Promise.reject(new Error('unused'));
}

class FakeSuggestionRepo implements SuggestionRepo {
  rows: Suggestion[] = [];
  neighbors: SimilarItem[] = [];
  vocab: string[] = [];
  itemPatches: Array<{ itemId: string; patch: ItemMetaPatch }> = [];
  private seq = 0;

  constructor(private readonly items: () => KnowledgeItem[]) {}

  async create(itemId: string, kind: SuggestionKind, payload: Record<string, unknown>) {
    const row: Suggestion = {
      id: `s-${++this.seq}`,
      itemId,
      kind,
      payload,
      status: 'pending',
      created: new Date(),
      resolved: null,
    };
    this.rows.push(row);
    return row;
  }

  async list(status?: SuggestionStatus): Promise<SuggestionWithItem[]> {
    const byId = new Map(this.items().map((i) => [i.id, i]));
    return this.rows
      .filter((r) => !status || r.status === status)
      .map((r) => ({
        ...r,
        path: byId.get(r.itemId)?.path ?? '?',
        title: byId.get(r.itemId)?.title ?? '?',
      }));
  }

  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async listPendingByItem(itemId: string) {
    return this.rows.filter((r) => r.itemId === itemId && r.status === 'pending');
  }

  async resolve(id: string, status: 'accepted' | 'rejected') {
    const row = this.rows.find((r) => r.id === id && r.status === 'pending');
    if (!row) return null;
    row.status = status;
    row.resolved = new Date();
    return row;
  }

  async similarTo() {
    return this.neighbors;
  }

  async tagVocabulary() {
    return this.vocab;
  }

  async updateItemMeta(itemId: string, patch: ItemMetaPatch) {
    this.itemPatches.push({ itemId, patch });
  }
}

/** Only create() is exercised (via GraphService.createEdge). */
class FakeRelationshipRepo implements RelationshipRepo {
  rows: Relationship[] = [];
  private seq = 0;

  async create(fromItem: string, toItem: string, type: RelationshipType) {
    if (this.rows.some((r) => r.fromItem === fromItem && r.toItem === toItem && r.type === type)) {
      return null;
    }
    const row = { id: `rel-${++this.seq}`, fromItem, toItem, type, created: new Date() };
    this.rows.push(row);
    return row;
  }

  getById = () => Promise.resolve(null);
  delete = () => Promise.reject(new Error('unused'));
  wipe = () => Promise.reject(new Error('unused'));
  count = () => Promise.reject(new Error('unused'));
  neighborhood = () => Promise.reject(new Error('unused'));
}

class FakeLlm implements LlmProvider {
  calls: LlmMessage[][] = [];
  reply = '{"tags": [], "links": [], "summary": "A summary."}';
  fail = false;

  async chat(messages: LlmMessage[]) {
    this.calls.push(messages);
    if (this.fail) throw new Error('ollama down');
    return this.reply;
  }
}

const fakeEmbedder: EmbeddingProvider = { embed: async () => [0.1, 0.2, 0.3] };

function item(id: string, relPath: string, title: string, tags: string[] = []): KnowledgeItem {
  return {
    id,
    path: relPath,
    title,
    source: null,
    tags,
    summary: null,
    importance: null,
    created: '2026-07-01',
    updated: new Date(),
  };
}

const GRACE = item('k-grace', 'faith/reflections/on-grace.md', 'On Grace', ['grace']);
const MERCY = item('k-mercy', 'faith/reflections/on-mercy.md', 'On Mercy');
const ROMANS = item('k-romans', 'faith/bible-study/romans-8.md', 'Romans 8');

let root: string;
let commits: string[];
let knowledge: FakeKnowledgeRepo;
let repo: FakeSuggestionRepo;
let rels: FakeRelationshipRepo;
let vault: VaultService;
let llm: FakeLlm;
let knowledgeService: KnowledgeService;
let suggester: SuggesterService;
let service: SuggestionsService;

async function writeVaultNote(relPath: string, title: string, extraFm = '') {
  await fs.mkdir(path.join(root, path.dirname(relPath)), { recursive: true });
  await fs.writeFile(
    path.join(root, relPath),
    `---\ntitle: ${title}\ncreated: 2026-07-01\n${extraFm}---\n\n${title} body.\n`,
  );
}

async function readFrontmatter(relPath: string) {
  const raw = await fs.readFile(path.join(root, relPath), 'utf8');
  return parseNote(raw)!.meta;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-suggest-'));
  commits = [];
  await writeVaultNote(GRACE.path, 'On Grace', 'tags:\n  - grace\n');
  await writeVaultNote(MERCY.path, 'On Mercy');
  await writeVaultNote(ROMANS.path, 'Romans 8');
  knowledge = new FakeKnowledgeRepo();
  knowledge.rows = [structuredClone(GRACE), structuredClone(MERCY), structuredClone(ROMANS)];
  repo = new FakeSuggestionRepo(() => knowledge.rows);
  rels = new FakeRelationshipRepo();
  llm = new FakeLlm();
  vault = new VaultService(root, async (args) => {
    if (args[0] === 'commit') commits.push(args[2]);
  });
  knowledgeService = new KnowledgeService(vault, knowledge, fakeEmbedder);
  suggester = new SuggesterService(repo, knowledge, llm, vault, knowledgeService);
  const graph = new GraphService(rels, knowledge, vault);
  service = new SuggestionsService(repo, knowledge, fakeEmbedder, vault, graph);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function ofKind(kind: SuggestionKind) {
  return repo.rows.filter((r) => r.kind === kind);
}

describe('SuggesterService.generate — duplicates & links (embedding bands)', () => {
  it('flags neighbors at/above 0.9 as duplicates with similarity', async () => {
    repo.neighbors = [
      { id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.93 },
      { id: ROMANS.id, path: ROMANS.path, title: ROMANS.title, score: 0.42 },
    ];
    await suggester.generate(GRACE.id);

    expect(ofKind('duplicate').map((s) => s.payload)).toEqual([
      { duplicateOfPath: MERCY.path, similarity: 0.93 },
    ]);
    expect(ofKind('link')).toHaveLength(0); // 0.42 below band, 0.93 above
    expect(repo.rows.every((s) => s.status === 'pending')).toBe(true);
  });

  it('suggests links for the 0.65–0.9 band only, default type related_to', async () => {
    repo.neighbors = [
      { id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.72 },
      { id: ROMANS.id, path: ROMANS.path, title: ROMANS.title, score: 0.64 },
    ];
    await suggester.generate(GRACE.id);

    expect(ofKind('link').map((s) => s.payload)).toEqual([
      { toPath: MERCY.path, type: 'related_to' },
    ]);
    expect(ofKind('duplicate')).toHaveLength(0);
  });

  it('skips band neighbors already linked in frontmatter', async () => {
    await writeVaultNote(
      GRACE.path,
      'On Grace',
      `relationships:\n  - type: related_to\n    path: ${MERCY.path}\n`,
    );
    repo.neighbors = [{ id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.72 }];
    await suggester.generate(GRACE.id);

    expect(ofKind('link')).toHaveLength(0);
  });

  it('re-trigger does not duplicate identical pending suggestions', async () => {
    repo.neighbors = [{ id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.72 }];
    await suggester.generate(GRACE.id);
    const second = await suggester.generate(GRACE.id);

    expect(second).toHaveLength(0);
    expect(ofKind('link')).toHaveLength(1);
  });
});

describe('SuggesterService.generate — LLM tags, link types, summary', () => {
  it('prompt carries note body, tag vocabulary and link candidates', async () => {
    repo.vocab = ['grace', 'salvation', 'mercy'];
    repo.neighbors = [{ id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.7 }];
    await suggester.generate(GRACE.id);

    const prompt = llm.calls[0][0].content;
    expect(prompt).toContain('On Grace body.');
    expect(prompt).toContain('grace, salvation, mercy');
    expect(prompt).toContain(MERCY.path);
  });

  it('parses tags: lowercased, deduped, existing tags dropped, capped at 5', async () => {
    llm.reply = `<think>hm</think>Here you go:
      {"tags": ["Grace", "faith", "faith", "hope", "love", "joy", "peace", "patience"], "links": [], "summary": "s"}`;
    await suggester.generate(GRACE.id);

    // "grace" already on the item; 5 remain from the rest
    expect(ofKind('tag').map((s) => s.payload.tag)).toEqual([
      'faith',
      'hope',
      'love',
      'joy',
      'peace',
    ]);
  });

  it('honors a valid LLM link type, falls back to related_to on invalid', async () => {
    repo.neighbors = [
      { id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.7 },
      { id: ROMANS.id, path: ROMANS.path, title: ROMANS.title, score: 0.8 },
    ];
    llm.reply = JSON.stringify({
      tags: [],
      links: [
        { path: MERCY.path, type: 'supports' },
        { path: ROMANS.path, type: 'bff_of' },
      ],
    });
    await suggester.generate(GRACE.id);

    expect(ofKind('link').map((s) => s.payload)).toEqual([
      { toPath: MERCY.path, type: 'supports' },
      { toPath: ROMANS.path, type: 'related_to' },
    ]);
  });

  it('suggests a summary only when the note has none', async () => {
    llm.reply = '{"tags": [], "links": [], "summary": "Grace summarized."}';
    await suggester.generate(GRACE.id); // GRACE note has no summary
    expect(ofKind('summary').map((s) => s.payload)).toEqual([{ summary: 'Grace summarized.' }]);

    repo.rows = [];
    await writeVaultNote(MERCY.path, 'On Mercy', 'summary: already has one\n');
    await suggester.generate(MERCY.id);
    expect(ofKind('summary')).toHaveLength(0);
  });

  it('LLM failure loses tags/summary but keeps embedding-derived suggestions', async () => {
    llm.fail = true;
    repo.neighbors = [
      { id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.95 },
      { id: ROMANS.id, path: ROMANS.path, title: ROMANS.title, score: 0.7 },
    ];
    await suggester.generate(GRACE.id);

    expect(ofKind('duplicate')).toHaveLength(1);
    expect(ofKind('link').map((s) => s.payload)).toEqual([
      { toPath: ROMANS.path, type: 'related_to' },
    ]);
    expect(ofKind('tag')).toHaveLength(0);
    expect(ofKind('summary')).toHaveLength(0);
  });

  it('404s on unknown item', async () => {
    await expect(suggester.generate('nope')).rejects.toThrow(NotFoundException);
  });
});

describe('ingest hook', () => {
  it('ingest resolves even when the suggester throws', async () => {
    suggester.onModuleInit();
    repo.similarTo = () => Promise.reject(new Error('db exploded'));
    const errorSpy = vi.spyOn(suggester['logger'], 'error').mockImplementation(() => {});

    const item = await knowledgeService.ingest({ title: 'New Note', markdown: 'Body.' });

    expect(item.title).toBe('New Note');
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(repo.rows).toHaveLength(0);
  });

  it('ingest fires generation for the new item', async () => {
    suggester.onModuleInit();
    repo.neighbors = [{ id: MERCY.id, path: MERCY.path, title: MERCY.title, score: 0.95 }];

    await knowledgeService.ingest({ title: 'New Note', markdown: 'Body.' });

    await vi.waitFor(() => expect(ofKind('duplicate')).toHaveLength(1));
    expect(ofKind('duplicate')[0].payload).toEqual({
      duplicateOfPath: MERCY.path,
      similarity: 0.95,
    });
  });
});

describe('SuggestionsService.accept', () => {
  it('tag: rewrites frontmatter + commits + patches the row, marks accepted', async () => {
    const s = await repo.create(GRACE.id, 'tag', { tag: 'faith' });

    const out = await service.accept(s.id);

    expect(out.status).toBe('accepted');
    expect(out.resolved).toBeInstanceOf(Date);
    expect((await readFrontmatter(GRACE.path)).tags).toEqual(['grace', 'faith']);
    expect(commits).toEqual([`tag ${GRACE.path}: +faith (accepted suggestion)`]);
    expect(repo.itemPatches).toEqual([{ itemId: GRACE.id, patch: { tags: ['grace', 'faith'] } }]);
  });

  it('link: creates the graph edge (frontmatter + row)', async () => {
    const s = await repo.create(GRACE.id, 'link', { toPath: MERCY.path, type: 'supports' });

    await service.accept(s.id);

    expect(rels.rows).toEqual([
      expect.objectContaining({ fromItem: GRACE.id, toItem: MERCY.id, type: 'supports' }),
    ]);
    expect((await readFrontmatter(GRACE.path)).relationships).toEqual([
      { type: 'supports', path: MERCY.path },
    ]);
    expect(commits).toEqual([`link ${GRACE.path} -[supports]-> ${MERCY.path}`]);
  });

  it('summary: rewrites frontmatter + re-embeds the row', async () => {
    const s = await repo.create(GRACE.id, 'summary', { summary: 'Grace, summarized.' });

    await service.accept(s.id);

    expect((await readFrontmatter(GRACE.path)).summary).toBe('Grace, summarized.');
    expect(repo.itemPatches).toEqual([
      {
        itemId: GRACE.id,
        patch: { summary: 'Grace, summarized.', embedding: [0.1, 0.2, 0.3] },
      },
    ]);
  });

  it('duplicate: informational only — accepted, nothing touched', async () => {
    const s = await repo.create(GRACE.id, 'duplicate', {
      duplicateOfPath: MERCY.path,
      similarity: 0.95,
    });

    const out = await service.accept(s.id);

    expect(out.status).toBe('accepted');
    expect(commits).toEqual([]);
    expect(rels.rows).toEqual([]);
    expect(repo.itemPatches).toEqual([]);
  });

  it('404 unknown id; 409 already resolved', async () => {
    await expect(service.accept('nope')).rejects.toThrow(NotFoundException);
    const s = await repo.create(GRACE.id, 'duplicate', { duplicateOfPath: MERCY.path });
    await service.accept(s.id);
    await expect(service.accept(s.id)).rejects.toThrow(ConflictException);
    await expect(service.reject(s.id)).rejects.toThrow(ConflictException);
  });
});

describe('SuggestionsService.reject', () => {
  it('marks rejected and applies nothing', async () => {
    const s = await repo.create(GRACE.id, 'tag', { tag: 'faith' });

    const out = await service.reject(s.id);

    expect(out.status).toBe('rejected');
    expect(out.resolved).toBeInstanceOf(Date);
    expect((await readFrontmatter(GRACE.path)).tags).toEqual(['grace']);
    expect(commits).toEqual([]);
    expect(rels.rows).toEqual([]);
    expect(repo.itemPatches).toEqual([]);
  });
});

describe('SuggestionsService.list', () => {
  it('joins item path/title and filters by status; rejects bad status', async () => {
    const a = await repo.create(GRACE.id, 'tag', { tag: 'faith' });
    await repo.create(MERCY.id, 'summary', { summary: 's' });
    await service.reject(a.id);

    const pending = await service.list('pending');
    expect(pending).toEqual([
      expect.objectContaining({ kind: 'summary', path: MERCY.path, title: MERCY.title }),
    ]);
    expect(await service.list()).toHaveLength(2);
    await expect(service.list('bogus')).rejects.toThrow('status must be one of');
  });
});
