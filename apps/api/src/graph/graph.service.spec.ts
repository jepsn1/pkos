import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeItem, KnowledgeRepo } from '../knowledge/knowledge.repo';
import { parseNote } from '../knowledge/note';
import { VaultService } from '../knowledge/vault.service';
import { GraphService } from './graph.service';
import type {
  GraphEdge,
  GraphNode,
  Neighborhood,
  Relationship,
  RelationshipRepo,
  RelationshipType,
} from './relationship.repo';

/** In-memory edge store; neighborhood = BFS mirroring the recursive-CTE semantics. */
class FakeRelationshipRepo implements RelationshipRepo {
  rows: Relationship[] = [];
  private seq = 0;

  constructor(private readonly items: () => KnowledgeItem[]) {}

  async create(fromItem: string, toItem: string, type: RelationshipType) {
    if (this.rows.some((r) => r.fromItem === fromItem && r.toItem === toItem && r.type === type)) {
      return null;
    }
    const row = { id: `rel-${++this.seq}`, fromItem, toItem, type, created: new Date() };
    this.rows.push(row);
    return row;
  }

  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async delete(id: string) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  async wipe() {
    this.rows = [];
  }

  async count() {
    return this.rows.length;
  }

  async neighborhood(itemId: string, depth: number): Promise<Neighborhood> {
    const depthOf = new Map<string, number>([[itemId, 0]]);
    let frontier = [itemId];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const r of this.rows) {
          const other =
            r.fromItem === id ? r.toItem : r.toItem === id ? r.fromItem : null;
          if (other && !depthOf.has(other)) {
            depthOf.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    const byId = new Map(this.items().map((i) => [i.id, i]));
    const nodes: GraphNode[] = [...depthOf.entries()]
      .filter(([id]) => byId.has(id))
      .map(([id, d]) => {
        const i = byId.get(id)!;
        return { id, path: i.path, title: i.title, summary: i.summary, depth: d };
      });
    const inHood = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = this.rows
      .filter((r) => inHood.has(r.fromItem) && inHood.has(r.toItem))
      .map((r) => ({
        id: r.id,
        fromId: r.fromItem,
        fromPath: byId.get(r.fromItem)!.path,
        toId: r.toItem,
        toPath: byId.get(r.toItem)!.path,
        type: r.type,
      }));
    return { nodes, edges };
  }
}

/** Only list/getById are exercised by GraphService. */
class FakeKnowledgeRepo implements KnowledgeRepo {
  rows: KnowledgeItem[] = [];

  async list() {
    return this.rows;
  }

  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  upsert = () => Promise.reject(new Error('unused'));
  search = () => Promise.reject(new Error('unused'));
  wipe = () => Promise.reject(new Error('unused'));
}

function item(id: string, relPath: string, title: string): KnowledgeItem {
  return {
    id,
    path: relPath,
    title,
    source: null,
    tags: [],
    summary: null,
    importance: null,
    created: '2026-07-01',
    updated: new Date(),
  };
}

const GRACE = item('k-grace', 'faith/reflections/on-grace.md', 'On Grace');
const MERCY = item('k-mercy', 'faith/reflections/on-mercy.md', 'On Mercy');
const ROMANS = item('k-romans', 'faith/bible-study/romans-8.md', 'Romans 8');

let root: string;
let commits: string[];
let knowledge: FakeKnowledgeRepo;
let rels: FakeRelationshipRepo;
let vault: VaultService;
let service: GraphService;

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-graph-'));
  commits = [];
  await writeVaultNote(GRACE.path, 'On Grace');
  await writeVaultNote(MERCY.path, 'On Mercy');
  await writeVaultNote(ROMANS.path, 'Romans 8');
  knowledge = new FakeKnowledgeRepo();
  knowledge.rows = [GRACE, MERCY, ROMANS];
  rels = new FakeRelationshipRepo(() => knowledge.rows);
  vault = new VaultService(root, async (args) => {
    if (args[0] === 'commit') commits.push(args[2]);
  });
  service = new GraphService(rels, knowledge, vault);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('GraphService.createEdge', () => {
  it('creates a row and rewrites the from-item frontmatter + vault commit', async () => {
    const edge = await service.createEdge({
      fromPath: GRACE.path,
      toPath: MERCY.path,
      type: 'related_to',
    });

    expect(edge).toMatchObject({
      fromItem: GRACE.id,
      toItem: MERCY.id,
      type: 'related_to',
      fromPath: GRACE.path,
      toPath: MERCY.path,
    });
    expect(rels.rows).toHaveLength(1);

    const meta = await readFrontmatter(GRACE.path);
    expect(meta.relationships).toEqual([{ type: 'related_to', path: MERCY.path }]);
    expect(commits).toEqual([
      `link ${GRACE.path} -[related_to]-> ${MERCY.path}`,
    ]);
  });

  it('resolves items by id too and appends to existing relationships', async () => {
    await service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' });
    await service.createEdge({ fromId: GRACE.id, toId: ROMANS.id, type: 'references' });

    const meta = await readFrontmatter(GRACE.path);
    expect(meta.relationships).toEqual([
      { type: 'related_to', path: MERCY.path },
      { type: 'references', path: ROMANS.path },
    ]);
    expect(rels.rows).toHaveLength(2);
  });

  it('409s on duplicate (from, to, type)', async () => {
    await service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' });
    await expect(
      service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' }),
    ).rejects.toThrow(ConflictException);
    expect(rels.rows).toHaveLength(1);
    expect((await readFrontmatter(GRACE.path)).relationships).toHaveLength(1);
  });

  it('rejects bad input: unknown type, missing endpoint, self-link, unknown path', async () => {
    const base = { fromPath: GRACE.path, toPath: MERCY.path };
    await expect(service.createEdge({ ...base, type: 'friend_of' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.createEdge({ toPath: MERCY.path, type: 'related_to' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.createEdge({ fromPath: GRACE.path, toPath: GRACE.path, type: 'related_to' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.createEdge({ fromPath: 'nope.md', toPath: MERCY.path, type: 'related_to' }),
    ).rejects.toThrow(NotFoundException);
    expect(rels.rows).toHaveLength(0);
  });
});

describe('GraphService.deleteEdge', () => {
  it('removes the frontmatter entry (keeping others) + row, commits unlink', async () => {
    const a = await service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' });
    await service.createEdge({ fromPath: GRACE.path, toPath: ROMANS.path, type: 'references' });

    await service.deleteEdge(a.id);

    expect(rels.rows.map((r) => r.type)).toEqual(['references']);
    const meta = await readFrontmatter(GRACE.path);
    expect(meta.relationships).toEqual([{ type: 'references', path: ROMANS.path }]);
    expect(commits.at(-1)).toBe(`unlink ${GRACE.path} -[related_to]-> ${MERCY.path}`);
  });

  it('drops the relationships key entirely when the last edge goes; 404 on unknown id', async () => {
    const a = await service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' });
    await service.deleteEdge(a.id);

    expect((await readFrontmatter(GRACE.path)).relationships).toBeUndefined();
    await expect(service.deleteEdge('nope')).rejects.toThrow(NotFoundException);
  });
});

describe('GraphService.graph traversal', () => {
  beforeEach(async () => {
    // grace -related_to-> mercy, romans -references-> grace
    await service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' });
    await service.createEdge({ fromPath: ROMANS.path, toPath: GRACE.path, type: 'references' });
  });

  it('depth defaults to 1: direct neighbors only, edges typed + directional', async () => {
    const g = await service.graph(MERCY.id);

    expect(g.depth).toBe(1);
    expect(g.nodes.map((n) => `${n.path}@${n.depth}`).sort()).toEqual([
      `${GRACE.path}@1`,
      `${MERCY.path}@0`,
    ]);
    expect(g.edges).toEqual([
      expect.objectContaining({
        fromId: GRACE.id,
        toId: MERCY.id,
        fromPath: GRACE.path,
        toPath: MERCY.path,
        type: 'related_to',
      }),
    ]);
  });

  it('depth 2 reaches romans from mercy (undirected walk, directed edges)', async () => {
    const g = await service.graph(MERCY.id, 2);
    expect(g.nodes.map((n) => n.path).sort()).toEqual(
      [GRACE.path, MERCY.path, ROMANS.path].sort(),
    );
    expect(g.edges).toHaveLength(2);
  });

  it('caps depth at 3 and survives cycles without duplicating nodes', async () => {
    await service.createEdge({ fromPath: MERCY.path, toPath: ROMANS.path, type: 'supports' });
    // cycle: grace -> mercy -> romans -> grace

    const g = await service.graph(GRACE.id, 99);

    expect(g.depth).toBe(3);
    expect(g.nodes).toHaveLength(3); // each node exactly once
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(3);
    expect(g.edges).toHaveLength(3);
  });

  it('404s on unknown item', async () => {
    await expect(service.graph('nope')).rejects.toThrow(NotFoundException);
  });
});

describe('GraphService.neighbors (chat retrieval seam)', () => {
  it('returns deduped 1-hop neighbors with direction, excluding the hits', async () => {
    await service.createEdge({ fromPath: GRACE.path, toPath: MERCY.path, type: 'related_to' });
    await service.createEdge({ fromPath: ROMANS.path, toPath: GRACE.path, type: 'references' });

    const neighbors = await service.neighbors([GRACE.id]);

    expect(neighbors).toEqual([
      expect.objectContaining({
        id: MERCY.id,
        path: MERCY.path,
        type: 'related_to',
        direction: 'out',
        of: GRACE.path,
      }),
      expect.objectContaining({
        id: ROMANS.id,
        path: ROMANS.path,
        type: 'references',
        direction: 'in',
        of: GRACE.path,
      }),
    ]);

    // hit set members never come back as neighbors
    const none = await service.neighbors([GRACE.id, MERCY.id, ROMANS.id]);
    expect(none).toEqual([]);
  });
});

describe('GraphService.restoreFromVault', () => {
  it('restores edges from frontmatter (paths → ids), skipping unresolvable targets', async () => {
    await writeVaultNote(
      GRACE.path,
      'On Grace',
      `relationships:\n  - type: related_to\n    path: ${MERCY.path}\n  - type: references\n    path: missing/nope.md\n  - type: friend_of\n    path: ${ROMANS.path}\n`,
    );
    await writeVaultNote(
      ROMANS.path,
      'Romans 8',
      `relationships:\n  - type: references\n    path: ${GRACE.path}\n`,
    );

    const { restored, skipped } = await service.restoreFromVault();

    expect(restored).toBe(2);
    expect(skipped).toEqual([
      `${GRACE.path} -[references]-> missing/nope.md`,
      `${GRACE.path} -[friend_of]-> ${ROMANS.path}`,
    ]);
    expect(rels.rows.map((r) => `${r.fromItem}-${r.type}->${r.toItem}`).sort()).toEqual([
      `${GRACE.id}-related_to->${MERCY.id}`,
      `${ROMANS.id}-references->${GRACE.id}`,
    ]);

    // idempotent: running again restores nothing new
    const again = await service.restoreFromVault();
    expect(again.restored).toBe(0);
    expect(rels.rows).toHaveLength(2);
  });
});
