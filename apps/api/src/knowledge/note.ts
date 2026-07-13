import matter from 'gray-matter';

/** Typed outgoing edge in frontmatter. `type` validated against the db enum at the API. */
export interface NoteRelationship {
  type: string;
  /** Vault-relative path of the target note, e.g. faith/reflections/on-mercy.md */
  path: string;
}

/** Frontmatter carried by every vault note. Vault is canonical; db is derived. */
export interface NoteMeta {
  title: string;
  source?: string;
  tags: string[];
  summary?: string;
  importance?: number;
  /** ISO date (YYYY-MM-DD). */
  created: string;
  /** Outgoing typed edges; canonical form of the `relationships` db table. */
  relationships?: NoteRelationship[];
}

export interface Note {
  meta: NoteMeta;
  body: string;
}

export function serializeNote(note: Note): string {
  const { title, source, tags, summary, importance, created, relationships } = note.meta;
  // Omit empty optionals so frontmatter stays clean
  const data: Record<string, unknown> = { title };
  if (source) data.source = source;
  data.tags = tags;
  if (summary) data.summary = summary;
  if (importance !== undefined) data.importance = importance;
  data.created = created;
  if (relationships?.length) {
    data.relationships = relationships.map(({ type, path }) => ({ type, path }));
  }
  return matter.stringify(`\n${note.body.trim()}\n`, data);
}

/** Parse a vault markdown file. Returns null when it is not a note (no title). */
export function parseNote(raw: string): Note | null {
  const { data, content } = matter(raw);
  if (typeof data.title !== 'string' || data.title.length === 0) return null;
  return {
    meta: {
      title: data.title,
      source: typeof data.source === 'string' ? data.source : undefined,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      summary: typeof data.summary === 'string' ? data.summary : undefined,
      importance: typeof data.importance === 'number' ? data.importance : undefined,
      created: toIsoDate(data.created),
      relationships: parseRelationships(data.relationships),
    },
    body: content.trim(),
  };
}

/** Keep only well-formed `{type, path}` entries; undefined when none survive. */
function parseRelationships(value: unknown): NoteRelationship[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rels = value
    .filter(
      (r): r is { type: string; path: string } =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>).type === 'string' &&
        typeof (r as Record<string, unknown>).path === 'string',
    )
    .map(({ type, path }) => ({ type, path }));
  return rels.length > 0 ? rels : undefined;
}

/** js-yaml parses bare dates into Date objects — normalize back to YYYY-MM-DD. */
function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && value.length > 0) return value.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/** Text fed to the embedding model for a note. */
export function embeddingText(note: Note): string {
  return [note.meta.title, note.meta.summary, note.body]
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'note'
  );
}
