import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { relationships, RELATIONSHIP_TYPES, type RelationshipType } from '../db/schema';

export type { RelationshipType };
export { RELATIONSHIP_TYPES };

export const RELATIONSHIP_REPO = 'RELATIONSHIP_REPO';

export function isRelationshipType(v: unknown): v is RelationshipType {
  return typeof v === 'string' && (RELATIONSHIP_TYPES as readonly string[]).includes(v);
}

export interface Relationship {
  id: string;
  fromItem: string;
  toItem: string;
  type: RelationshipType;
  created: Date;
}

export interface GraphNode {
  id: string;
  path: string;
  title: string;
  summary: string | null;
  /** Hops from the root item (0 = the root itself). */
  depth: number;
}

/** Directed, typed edge between two nodes of a neighborhood. */
export interface GraphEdge {
  id: string;
  fromId: string;
  fromPath: string;
  toId: string;
  toPath: string;
  type: RelationshipType;
}

export interface Neighborhood {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Derived edge store (canonical = vault frontmatter). Faked in tests, Drizzle in prod. */
export interface RelationshipRepo {
  /** Insert an edge; null when the (from, to, type) edge already exists. */
  create(fromItem: string, toItem: string, type: RelationshipType): Promise<Relationship | null>;
  getById(id: string): Promise<Relationship | null>;
  delete(id: string): Promise<void>;
  wipe(): Promise<void>;
  count(): Promise<number>;
  /**
   * Undirected n-hop neighborhood of an item (edges are followed both ways),
   * plus all edges between the visited nodes. Cycle-safe, depth-bounded.
   */
  neighborhood(itemId: string, depth: number): Promise<Neighborhood>;
}

export class DrizzleRelationshipRepo implements RelationshipRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async create(
    fromItem: string,
    toItem: string,
    type: RelationshipType,
  ): Promise<Relationship | null> {
    const [row] = await this.db
      .insert(relationships)
      .values({ fromItem, toItem, type })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async getById(id: string): Promise<Relationship | null> {
    const [row] = await this.db.select().from(relationships).where(eq(relationships.id, id));
    return row ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(relationships).where(eq(relationships.id, id));
  }

  async wipe(): Promise<void> {
    await this.db.delete(relationships);
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)` })
      .from(relationships);
    return Number(row.n);
  }

  async neighborhood(itemId: string, depth: number): Promise<Neighborhood> {
    // Recursive CTE walk, undirected: each hop crosses an edge in either direction.
    // UNION (not UNION ALL) dedups (item_id, depth) rows; the depth bound terminates cycles.
    const nodeRes = await this.db.execute(sql`
      WITH RECURSIVE walk AS (
        SELECT ${itemId}::uuid AS item_id, 0 AS depth
        UNION
        SELECT
          CASE WHEN r.from_item = w.item_id THEN r.to_item ELSE r.from_item END,
          w.depth + 1
        FROM relationships r
        JOIN walk w ON w.item_id IN (r.from_item, r.to_item)
        WHERE w.depth < ${depth}
      )
      SELECT k.id, k.path, k.title, k.summary, n.depth
      FROM (SELECT item_id, MIN(depth) AS depth FROM walk GROUP BY item_id) n
      JOIN knowledge_items k ON k.id = n.item_id
      ORDER BY n.depth, k.path
    `);
    const nodes: GraphNode[] = nodeRes.rows.map((r) => ({
      id: r.id as string,
      path: r.path as string,
      title: r.title as string,
      summary: (r.summary as string | null) ?? null,
      depth: Number(r.depth),
    }));

    const ids = nodes.map((n) => n.id);
    if (ids.length === 0) return { nodes, edges: [] };

    const edgeRes = await this.db.execute(sql`
      SELECT r.id, r.from_item, kf.path AS from_path, r.to_item, kt.path AS to_path, r.type
      FROM relationships r
      JOIN knowledge_items kf ON kf.id = r.from_item
      JOIN knowledge_items kt ON kt.id = r.to_item
      WHERE r.from_item = ANY(${ids}::uuid[]) AND r.to_item = ANY(${ids}::uuid[])
      ORDER BY kf.path, kt.path, r.type
    `);
    const edges: GraphEdge[] = edgeRes.rows.map((r) => ({
      id: r.id as string,
      fromId: r.from_item as string,
      fromPath: r.from_path as string,
      toId: r.to_item as string,
      toPath: r.to_path as string,
      type: r.type as RelationshipType,
    }));
    return { nodes, edges };
  }
}
