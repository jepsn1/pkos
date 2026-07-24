/**
 * Bible reference parsing: a user- or model-supplied string like "Matt 7:21-23",
 * "Matthæus 7,21-23", "Romerne 10:9-13", "1 Kor 13:4-7" or "Sl 23" is turned into
 * a structured reference with the source's URL slug. Danish AND English book names
 * and common abbreviations are accepted; verse separator may be ":" or "," (Danish
 * style); an en-dash or hyphen ranges verses; a bare chapter means the whole chapter.
 *
 * `slug` is the path segment bibelselskabet.dk uses (Matt, Rom, 1_Mos, Sl, …).
 */

export interface ParsedReference {
  /** Canonical lowercase English key, stable across editions (e.g. "matthew"). */
  book: string;
  /** bibelselskabet.dk URL slug for the book (e.g. "Matt", "1_Mos"). */
  slug: string;
  /** Danish display name (e.g. "Matthæus"). */
  display: string;
  chapter: number;
  /** Undefined for a whole-chapter reference. */
  verseStart?: number;
  /** Equals verseStart for a single verse; undefined for a whole chapter. */
  verseEnd?: number;
}

interface BookDef {
  key: string;
  slug: string;
  da: string;
  en: string;
  aliases?: string[];
}

// Danish (authorized 1992) name, English name, and bibelselskabet slug per book.
// aliases add common abbreviations/spellings; da/en/slug are auto-added as aliases.
const BOOKS: BookDef[] = [
  { key: 'genesis', slug: '1_Mos', da: '1. Mosebog', en: 'Genesis', aliases: ['1 mos', '1mos', '1 mosebog', 'gen', '1 mos.'] },
  { key: 'exodus', slug: '2_Mos', da: '2. Mosebog', en: 'Exodus', aliases: ['2 mos', '2mos', '2 mosebog', 'exod', 'ex'] },
  { key: 'leviticus', slug: '3_Mos', da: '3. Mosebog', en: 'Leviticus', aliases: ['3 mos', '3mos', '3 mosebog', 'lev'] },
  { key: 'numbers', slug: '4_Mos', da: '4. Mosebog', en: 'Numbers', aliases: ['4 mos', '4mos', '4 mosebog', 'num'] },
  { key: 'deuteronomy', slug: '5_Mos', da: '5. Mosebog', en: 'Deuteronomy', aliases: ['5 mos', '5mos', '5 mosebog', 'deut', 'dt'] },
  { key: 'joshua', slug: 'Jos', da: 'Josva', en: 'Joshua', aliases: ['josh'] },
  { key: 'judges', slug: 'Dom', da: 'Dommerbogen', en: 'Judges', aliases: ['dommer', 'judg'] },
  { key: 'ruth', slug: 'Ruth', da: 'Ruth', en: 'Ruth' },
  { key: '1samuel', slug: '1_Sam', da: '1. Samuelsbog', en: '1 Samuel', aliases: ['1 sam', '1sam'] },
  { key: '2samuel', slug: '2_Sam', da: '2. Samuelsbog', en: '2 Samuel', aliases: ['2 sam', '2sam'] },
  { key: '1kings', slug: '1_Kong', da: '1. Kongebog', en: '1 Kings', aliases: ['1 kong', '1kong', '1 kgs'] },
  { key: '2kings', slug: '2_Kong', da: '2. Kongebog', en: '2 Kings', aliases: ['2 kong', '2kong', '2 kgs'] },
  { key: '1chronicles', slug: '1_Krøn', da: '1. Krønikebog', en: '1 Chronicles', aliases: ['1 krøn', '1kron', '1 chr'] },
  { key: '2chronicles', slug: '2_Krøn', da: '2. Krønikebog', en: '2 Chronicles', aliases: ['2 krøn', '2kron', '2 chr'] },
  { key: 'ezra', slug: 'Ezra', da: 'Ezras Bog', en: 'Ezra' },
  { key: 'nehemiah', slug: 'Neh', da: 'Nehemias’ Bog', en: 'Nehemiah', aliases: ['nehemias', 'neh'] },
  { key: 'esther', slug: 'Est', da: 'Esters Bog', en: 'Esther', aliases: ['ester'] },
  { key: 'job', slug: 'Job', da: 'Jobs Bog', en: 'Job' },
  { key: 'psalms', slug: 'Sl', da: 'Salmernes Bog', en: 'Psalms', aliases: ['salme', 'salmerne', 'sl', 'ps', 'psalm'] },
  { key: 'proverbs', slug: 'Ordsp', da: 'Ordsprogenes Bog', en: 'Proverbs', aliases: ['ordsprog', 'ordsp', 'prov'] },
  { key: 'ecclesiastes', slug: 'Præd', da: 'Prædikerens Bog', en: 'Ecclesiastes', aliases: ['prædikeren', 'præd', 'eccl'] },
  { key: 'songofsongs', slug: 'Højs', da: 'Højsangen', en: 'Song of Songs', aliases: ['højsang', 'højs', 'song'] },
  { key: 'isaiah', slug: 'Es', da: 'Esajas’ Bog', en: 'Isaiah', aliases: ['esajas', 'es', 'isa'] },
  { key: 'jeremiah', slug: 'Jer', da: 'Jeremias’ Bog', en: 'Jeremiah', aliases: ['jeremias', 'jer'] },
  { key: 'lamentations', slug: 'Klages', da: 'Klagesangene', en: 'Lamentations', aliases: ['klages', 'lam'] },
  { key: 'ezekiel', slug: 'Ez', da: 'Ezekiels Bog', en: 'Ezekiel', aliases: ['ezekiel', 'ez', 'ezek'] },
  { key: 'daniel', slug: 'Dan', da: 'Daniels Bog', en: 'Daniel', aliases: ['dan'] },
  { key: 'hosea', slug: 'Hos', da: 'Hoseas’ Bog', en: 'Hosea', aliases: ['hoseas', 'hos'] },
  { key: 'joel', slug: 'Joel', da: 'Joels Bog', en: 'Joel' },
  { key: 'amos', slug: 'Am', da: 'Amos’ Bog', en: 'Amos', aliases: ['am'] },
  { key: 'obadiah', slug: 'Obad', da: 'Obadias’ Bog', en: 'Obadiah', aliases: ['obadias', 'obad'] },
  { key: 'jonah', slug: 'Jon', da: 'Jonas’ Bog', en: 'Jonah', aliases: ['jonas', 'jon'] },
  { key: 'micah', slug: 'Mika', da: 'Mikas Bog', en: 'Micah', aliases: ['mika', 'mic'] },
  { key: 'nahum', slug: 'Nah', da: 'Nahums Bog', en: 'Nahum', aliases: ['nah'] },
  { key: 'habakkuk', slug: 'Hab', da: 'Habakkuks Bog', en: 'Habakkuk', aliases: ['hab'] },
  { key: 'zephaniah', slug: 'Sef', da: 'Sefanias’ Bog', en: 'Zephaniah', aliases: ['sefanias', 'sef', 'zeph'] },
  { key: 'haggai', slug: 'Hagg', da: 'Haggajs Bog', en: 'Haggai', aliases: ['haggaj', 'hagg', 'hag'] },
  { key: 'zechariah', slug: 'Zak', da: 'Zakarias’ Bog', en: 'Zechariah', aliases: ['zakarias', 'zak', 'zech'] },
  { key: 'malachi', slug: 'Mal', da: 'Malakias’ Bog', en: 'Malachi', aliases: ['malakias', 'mal'] },
  { key: 'matthew', slug: 'Matt', da: 'Matthæus', en: 'Matthew', aliases: ['matthæus', 'matt', 'mt', 'matthæusevangeliet'] },
  { key: 'mark', slug: 'Mark', da: 'Markus', en: 'Mark', aliases: ['markus', 'mk', 'markusevangeliet'] },
  { key: 'luke', slug: 'Luk', da: 'Lukas', en: 'Luke', aliases: ['lukas', 'luk', 'lk', 'lukasevangeliet'] },
  { key: 'john', slug: 'Joh', da: 'Johannes', en: 'John', aliases: ['johannes', 'joh', 'jn', 'johannesevangeliet'] },
  { key: 'acts', slug: 'ApG', da: 'Apostlenes Gerninger', en: 'Acts', aliases: ['apostlenes gerninger', 'apg', 'act'] },
  { key: 'romans', slug: 'Rom', da: 'Romerbrevet', en: 'Romans', aliases: ['romerne', 'rom', 'romerbrevet'] },
  { key: '1corinthians', slug: '1_Kor', da: '1. Korintherbrev', en: '1 Corinthians', aliases: ['1 kor', '1kor', '1 korinther', '1 korintherne', '1 cor'] },
  { key: '2corinthians', slug: '2_Kor', da: '2. Korintherbrev', en: '2 Corinthians', aliases: ['2 kor', '2kor', '2 korinther', '2 korintherne', '2 cor'] },
  { key: 'galatians', slug: 'Gal', da: 'Galaterbrevet', en: 'Galatians', aliases: ['galaterne', 'gal', 'galaterbrevet'] },
  { key: 'ephesians', slug: 'Ef', da: 'Efeserbrevet', en: 'Ephesians', aliases: ['efeserne', 'ef', 'eph', 'efeserbrevet'] },
  { key: 'philippians', slug: 'Fil', da: 'Filipperbrevet', en: 'Philippians', aliases: ['filipperne', 'fil', 'phil', 'filipperbrevet'] },
  { key: 'colossians', slug: 'Kol', da: 'Kolossenserbrevet', en: 'Colossians', aliases: ['kolossenserne', 'kol', 'col'] },
  { key: '1thessalonians', slug: '1_Thess', da: '1. Thessalonikerbrev', en: '1 Thessalonians', aliases: ['1 thess', '1thess', '1 tess', '1 thes'] },
  { key: '2thessalonians', slug: '2_Thess', da: '2. Thessalonikerbrev', en: '2 Thessalonians', aliases: ['2 thess', '2thess', '2 tess', '2 thes'] },
  { key: '1timothy', slug: '1_Tim', da: '1. Timotheusbrev', en: '1 Timothy', aliases: ['1 tim', '1tim', '1 timotheus'] },
  { key: '2timothy', slug: '2_Tim', da: '2. Timotheusbrev', en: '2 Timothy', aliases: ['2 tim', '2tim', '2 timotheus'] },
  { key: 'titus', slug: 'Tit', da: 'Titusbrevet', en: 'Titus', aliases: ['tit'] },
  { key: 'philemon', slug: 'Filem', da: 'Filemonbrevet', en: 'Philemon', aliases: ['filemon', 'filem', 'phlm'] },
  { key: 'hebrews', slug: 'Hebr', da: 'Hebræerbrevet', en: 'Hebrews', aliases: ['hebræerne', 'hebr', 'heb'] },
  { key: 'james', slug: 'Jak', da: 'Jakobsbrevet', en: 'James', aliases: ['jakob', 'jak', 'jas'] },
  { key: '1peter', slug: '1_Pet', da: '1. Petersbrev', en: '1 Peter', aliases: ['1 pet', '1pet', '1 peter'] },
  { key: '2peter', slug: '2_Pet', da: '2. Petersbrev', en: '2 Peter', aliases: ['2 pet', '2pet', '2 peter'] },
  { key: '1john', slug: '1_Joh', da: '1. Johannesbrev', en: '1 John', aliases: ['1 joh', '1joh', '1 johannes', '1 jn'] },
  { key: '2john', slug: '2_Joh', da: '2. Johannesbrev', en: '2 John', aliases: ['2 joh', '2joh', '2 johannes', '2 jn'] },
  { key: '3john', slug: '3_Joh', da: '3. Johannesbrev', en: '3 John', aliases: ['3 joh', '3joh', '3 johannes', '3 jn'] },
  { key: 'jude', slug: 'Jud', da: 'Judasbrevet', en: 'Jude', aliases: ['judas', 'jud'] },
  { key: 'revelation', slug: 'Åb', da: 'Johannes’ Åbenbaring', en: 'Revelation', aliases: ['åbenbaringen', 'åb', 'aab', 'rev', 'johannes åbenbaring'] },
];

/** normalize a book token: lowercase, drop periods, collapse spaces. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

const BY_ALIAS = new Map<string, BookDef>();
for (const b of BOOKS) {
  for (const a of [b.da, b.en, b.slug, b.key, ...(b.aliases ?? [])]) {
    BY_ALIAS.set(norm(a), b);
  }
}

// book (letters/spaces, optional leading number) + chapter + optional verse[-verse].
// separators: ":" or "," between chapter and verse; "-" or "–" for a verse range.
const REF_RE = /^\s*([1-3]?\s*[.]?\s*[A-Za-zÆØÅæøå][A-Za-zÆØÅæøå.\s]*?)\s+(\d+)(?:\s*[:,]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?\s*$/;

/** Parse a reference string; returns null when it doesn't look like a reference. */
export function parseReference(raw: string): ParsedReference | null {
  if (typeof raw !== 'string') return null;
  const m = REF_RE.exec(raw.trim());
  if (!m) return null;
  const book = BY_ALIAS.get(norm(m[1]));
  if (!book) return null;
  const chapter = Number(m[2]);
  if (!Number.isInteger(chapter) || chapter < 1) return null;
  const verseStart = m[3] ? Number(m[3]) : undefined;
  const verseEnd = m[4] ? Number(m[4]) : verseStart;
  if (verseStart !== undefined && verseEnd !== undefined && verseEnd < verseStart) return null;
  return { book: book.key, slug: book.slug, display: book.da, chapter, verseStart, verseEnd };
}

/** Human-readable label, e.g. "Matthæus 7:21-23" or "Salmernes Bog 23". */
export function formatReference(ref: ParsedReference): string {
  if (ref.verseStart === undefined) return `${ref.display} ${ref.chapter}`;
  const range = ref.verseEnd && ref.verseEnd !== ref.verseStart ? `-${ref.verseEnd}` : '';
  return `${ref.display} ${ref.chapter}:${ref.verseStart}${range}`;
}
