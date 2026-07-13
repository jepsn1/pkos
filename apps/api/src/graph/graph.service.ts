import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KNOWLEDGE_REPO, type KnowledgeRepo } from '../knowledge/knowledge.repo';
import { VaultService } from '../knowledge/vault.service';
import type { GraphNeighbor, GraphRetrieval } from './graph.retrieval';
import {
  isRelationshipType,
  RELATIONSHIP_REPO,
  RELATIONSHIP_TYPES,
  type Neighborhood,
  type Relationship,
  type RelationshipRepo,
  type RelationshipType,
} from './relationship.repo';

export interface CreateEdgeRequest {
  fromId?: string;
  fromPath?: string;
  toId?: string;
  toPath?: string;
  type?: string;
}

export interface EdgeResult extends Relationship {
  fromPath: string;
  toPath: string;
}

export const DEFAULT_DEPTH = 1;
export const MAX_DEPTH = 3;

interface ItemRef {
  id: string;
  path: string;
}

/**
 * Typed knowledge graph. Vault stays canonical: every edge lives as
 * `relationships: [{type, path}]` in the from-item's frontmatter; db rows are
 * derived and restored from frontmatter by the rebuild-index second pass.
 */
@Injectable()
export class GraphService implements GraphRetrieval {
  constructor(
    @Inject(RELATIONSHIP_REPO) private readonly rels: RelationshipRepo,
    @Inject(KNOWLEDGE_REPO) private readonly knowledge: KnowledgeRepo,
    private readonly vault: VaultService,
  ) {}

  /** Frontmatter rewrite + vault commit first (canonical), then the derived row. */
  async createEdge(req: CreateEdgeRequest): Promise<EdgeResult> {
    if (!isRelationshipType(req.type)) {
      throw new BadRequestException(`type must be one of: ${RELATIONSHIP_TYPES.join(', ')}`);
    }
    const from = await this.resolveItem('from', req.fromId, req.fromPath);
    const to = await this.resolveItem('to', req.toId, req.toPath);
    if (from.id === to.id) throw new BadRequestException('cannot link an item to itself');

    const note = await this.vault.readNote(from.path);
    if (!note) throw new NotFoundException(`vault file missing: ${from.path}`);
    const existing = note.meta.relationships ?? [];
    if (existing.some((r) => r.type === req.type && r.path === to.path)) {
      throw new ConflictException(
        `edge already exists: ${from.path} -[${req.type}]-> ${to.path}`,
      );
    }
    note.meta.relationships = [...existing, { type: req.type, path: to.path }];
    await this.vault.updateNote(
      from.path,
      note,
      `link ${from.path} -[${req.type}]-> ${to.path}`,
    );

    const row = await this.rels.create(from.id, to.id, req.type);
    if (!row) {
      // frontmatter was missing the edge but the db had it — heal by keeping the row
      throw new ConflictException(
        `edge already exists: ${from.path} -[${req.type}]-> ${to.path}`,
      );
    }
    return { ...row, fromPath: from.path, toPath: to.path };
  }

  /** Remove the frontmatter entry + vault commit, then the derived row. */
  async deleteEdge(id: string): Promise<void> {
    const row = await this.rels.getById(id);
    if (!row) throw new NotFoundException(`no relationship ${id}`);
    const from = await this.knowledge.getById(row.fromItem);
    const to = await this.knowledge.getById(row.toItem);

    if (from && to) {
      const note = await this.vault.readNote(from.path);
      const rels = note?.meta.relationships ?? [];
      const kept = rels.filter((r) => !(r.type === row.type && r.path === to.path));
      if (note && kept.length !== rels.length) {
        note.meta.relationships = kept.length > 0 ? kept : undefined;
        await this.vault.updateNote(
          from.path,
          note,
          `unlink ${from.path} -[${row.type}]-> ${to.path}`,
        );
      }
    }
    await this.rels.delete(id);
  }

  /** n-hop neighborhood (undirected walk, typed directional edges). Depth clamped to 1..3. */
  async graph(itemId: string, depth?: number): Promise<Neighborhood & { root: string; depth: number }> {
    const item = await this.knowledge.getById(itemId);
    if (!item) throw new NotFoundException(`no knowledge item ${itemId}`);
    const clamped = Math.min(Math.max(depth ?? DEFAULT_DEPTH, 1), MAX_DEPTH);
    const hood = await this.rels.neighborhood(itemId, clamped);
    return { root: itemId, depth: clamped, ...hood };
  }

  /** 1-hop neighbors of retrieval hits: one entry per unique edge touching a hit. */
  async neighbors(itemIds: string[]): Promise<GraphNeighbor[]> {
    const seenEdges = new Set<string>();
    const out: GraphNeighbor[] = [];
    for (const id of itemIds) {
      const { nodes, edges } = await this.rels.neighborhood(id, 1);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const rootPath = byId.get(id)?.path ?? id;
      for (const e of edges) {
        if (e.fromId !== id && e.toId !== id) continue;
        if (seenEdges.has(e.id)) continue;
        const neighborId = e.fromId === id ? e.toId : e.fromId;
        if (neighborId === id) continue;
        const node = byId.get(neighborId);
        if (!node) continue;
        seenEdges.add(e.id);
        out.push({
          id: node.id,
          path: node.path,
          title: node.title,
          summary: node.summary,
          type: e.type,
          direction: e.fromId === id ? 'out' : 'in',
          of: rootPath,
        });
      }
    }
    return out;
  }

  /**
   * Second rebuild pass: restore relationships rows from vault frontmatter
   * (paths → ids). Run after all items are re-indexed.
   */
  async restoreFromVault(): Promise<{ restored: number; skipped: string[] }> {
    const notes = await this.vault.listNotes();
    const items = await this.knowledge.list();
    const idByPath = new Map(items.map((i) => [i.path, i.id]));

    let restored = 0;
    const skipped: string[] = [];
    for (const { path, note } of notes) {
      for (const rel of note.meta.relationships ?? []) {
        const fromId = idByPath.get(path);
        const toId = idByPath.get(rel.path);
        if (!fromId || !toId || !isRelationshipType(rel.type)) {
          skipped.push(`${path} -[${rel.type}]-> ${rel.path}`);
          continue;
        }
        const row = await this.rels.create(fromId, toId, rel.type);
        if (row) restored++;
      }
    }
    return { restored, skipped };
  }

  private async resolveItem(side: 'from' | 'to', id?: unknown, path?: unknown): Promise<ItemRef> {
    if (typeof id === 'string' && id.trim()) {
      const item = await this.knowledge.getById(id);
      if (!item) throw new NotFoundException(`no knowledge item ${id}`);
      return { id: item.id, path: item.path };
    }
    if (typeof path === 'string' && path.trim()) {
      const items = await this.knowledge.list();
      const item = items.find((i) => i.path === path);
      if (!item) throw new NotFoundException(`no knowledge item at path ${path}`);
      return { id: item.id, path: item.path };
    }
    throw new BadRequestException(`${side}Path or ${side}Id required`);
  }
}
