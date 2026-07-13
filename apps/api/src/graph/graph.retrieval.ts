import type { RelationshipType } from './relationship.repo';

export const GRAPH_RETRIEVAL = 'GRAPH_RETRIEVAL';

/** Graph neighbor of a retrieved knowledge item (for graph-augmented chat retrieval). */
export interface GraphNeighbor {
  id: string;
  path: string;
  title: string;
  summary: string | null;
  type: RelationshipType;
  /** 'out' = the retrieved item points at this neighbor; 'in' = the neighbor points at it. */
  direction: 'out' | 'in';
  /** Path of the retrieved item this neighbor is linked to. */
  of: string;
}

/** e.g. 'related_to' for outgoing, 'references (incoming)' for incoming edges. */
export function relationLabel(n: Pick<GraphNeighbor, 'type' | 'direction'>): string {
  return n.direction === 'in' ? `${n.type} (incoming)` : n.type;
}

/** Small seam ChatService pulls 1-hop neighbors through. Implemented by GraphService. */
export interface GraphRetrieval {
  /** 1-hop neighbors of the given items, deduped, excluding the items themselves. */
  neighbors(itemIds: string[]): Promise<GraphNeighbor[]>;
}
