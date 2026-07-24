/**
 * External Bible text source. The default implementation reads a chapter from
 * bibelselskabet.dk (the authorized Danish 1992 translation) and parses its
 * verse markup. Fetched chapters are cached locally by BibleService, so the
 * source is hit at most once per chapter — a private, personal cache of the
 * copyrighted text, never redistributed.
 */

/** Token for the injected fetch (so tests supply a fake, matching web-search). */
export const BIBLE_FETCH = 'BIBLE_FETCH';
/** Token for the BibleSource implementation. */
export const BIBLE_SOURCE = 'BIBLE_SOURCE';

export interface SourceVerse {
  verse: number;
  text: string;
}

export interface BibleSource {
  /** The translation label stored alongside cached verses (e.g. "1992"). */
  readonly translation: string;
  /** Fetch and parse every verse of one chapter by the source's book slug. */
  fetchChapter(slug: string, chapter: number): Promise<SourceVerse[]>;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  // Danish letters (page is UTF-8, so these are rare — but decode them anyway)
  '&aelig;': 'æ',
  '&oslash;': 'ø',
  '&aring;': 'å',
  '&eacute;': 'é',
  '&Aelig;': 'Æ',
  '&Oslash;': 'Ø',
  '&Aring;': 'Å',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z]+;/g, (e) => ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? e);
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a bibelselskabet chapter page into verses. Each verse is an empty
 * `<span class="verse_number" data-verse="N"></span>` marker followed by that
 * verse's text, running until the next marker. Headings/scripts are dropped so
 * non-verse text is never merged into a verse; the final verse is bounded at its
 * paragraph close.
 */
export function parseChapterHtml(html: string): SourceVerse[] {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h[1-6][\s\S]*?<\/h[1-6]>/gi, '');
  const re = /<span[^>]*class="[^"]*verse_number[^"]*"[^>]*data-verse="(\d+)"[^>]*>\s*<\/span>/gi;
  const marks: { verse: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    marks.push({ verse: Number(m[1]), start: m.index, end: re.lastIndex });
  }
  const out: SourceVerse[] = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    let to = i + 1 < marks.length ? marks[i + 1].start : cleaned.length;
    if (i + 1 >= marks.length) {
      const close = cleaned.slice(from).search(/<\/p>|<\/div>/i);
      if (close !== -1) to = from + close;
    }
    const text = stripHtml(cleaned.slice(from, to));
    if (text) out.push({ verse: marks[i].verse, text });
  }
  return out;
}

const FETCH_TIMEOUT_MS = Number(process.env.BIBLE_FETCH_TIMEOUT_MS ?? 15000);
const BASE = process.env.BIBLE_SOURCE_BASE ?? 'https://www.bibelselskabet.dk/brugbibelen/bibelenonline';

/** Bibelen 1992 (authorized) via bibelselskabet.dk. */
export class BibelselskabetSource implements BibleSource {
  readonly translation = process.env.BIBLE_TRANSLATION ?? '1992';

  constructor(private readonly fetchFn: typeof fetch) {}

  async fetchChapter(slug: string, chapter: number): Promise<SourceVerse[]> {
    const url = `${BASE}/${slug}/${chapter}`;
    const res = await this.fetchFn(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (pkos personal bible lookup)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`bible source HTTP ${res.status} for ${slug}/${chapter}`);
    const verses = parseChapterHtml(await res.text());
    if (verses.length === 0) throw new Error(`no verses parsed for ${slug}/${chapter}`);
    return verses;
  }
}
