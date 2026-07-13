import matter from 'gray-matter';

/** Frontmatter carried by every vault note. Vault is canonical; db is derived. */
export interface NoteMeta {
  title: string;
  source?: string;
  tags: string[];
  summary?: string;
  importance?: number;
  /** ISO date (YYYY-MM-DD). */
  created: string;
}

export interface Note {
  meta: NoteMeta;
  body: string;
}

export function serializeNote(note: Note): string {
  const { title, source, tags, summary, importance, created } = note.meta;
  // Omit empty optionals so frontmatter stays clean
  const data: Record<string, unknown> = { title };
  if (source) data.source = source;
  data.tags = tags;
  if (summary) data.summary = summary;
  if (importance !== undefined) data.importance = importance;
  data.created = created;
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
    },
    body: content.trim(),
  };
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
