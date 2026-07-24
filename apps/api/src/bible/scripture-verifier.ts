import { formatReference, parseReference, type ParsedReference } from './reference';
import type { VerseRow } from './bible.repo';

/**
 * Deterministic safety net for scripture in saved notes: any markdown blockquote
 * that directly follows a verse reference is replaced with the verbatim text from
 * the authoritative source. This removes the model's discretion — even if it
 * skipped get_verse and quoted from memory, the persisted note ends up correct.
 *
 * Scope is deliberately narrow: it only rewrites a `>` blockquote that sits right
 * after a line containing a parseable reference (optionally one blank line
 * between), so ordinary prose is never touched. A block whose reference can't be
 * resolved (parse fail, source error) is left exactly as written.
 */

export type VerseResolver = (ref: ParsedReference) => Promise<VerseRow[] | null>;

const REF_IN_LINE =
  /(?:[1-3]\.?\s*)?[A-Za-zÆØÅæøå][A-Za-zÆØÅæøå.]*(?:\s+[A-Za-zÆØÅæøå.]+)?\s+\d+\s*[:,]\s*\d+(?:\s*[-–]\s*\d+)?/g;

const isBlockquote = (line: string): boolean => /^\s*>/.test(line);

/** First substring of `line` that parses as a real reference, or null. */
function firstReference(line: string): ParsedReference | null {
  const matches = line.match(REF_IN_LINE);
  if (!matches) return null;
  for (const m of matches) {
    const ref = parseReference(m.trim());
    if (ref) return ref;
  }
  return null;
}

/** Loose normalization so a formatting-only difference isn't reported as a fix. */
function normalize(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/^\s*>/gm, '')
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface VerifyResult {
  markdown: string;
  /** References whose quoted text was actually changed. */
  corrections: string[];
}

/** Rewrite reference-anchored blockquotes to verbatim source text. */
export async function verifyScripture(
  markdown: string,
  resolve: VerseResolver,
): Promise<VerifyResult> {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const corrections: string[] = [];
  let i = 0;
  while (i < lines.length) {
    out.push(lines[i]);
    const ref = firstReference(lines[i]);
    if (ref) {
      // allow a single blank line between the reference and its blockquote
      let j = i + 1;
      const gap: string[] = [];
      if (j < lines.length && lines[j].trim() === '') {
        gap.push(lines[j]);
        j++;
      }
      if (j < lines.length && isBlockquote(lines[j])) {
        let k = j;
        while (k < lines.length && isBlockquote(lines[k])) k++;
        let verses: VerseRow[] | null = null;
        try {
          verses = await resolve(ref);
        } catch {
          verses = null;
        }
        if (verses && verses.length > 0) {
          const canonical = verses.map((v) => `> ${v.verse} ${v.text}`);
          if (normalize(lines.slice(j, k)) !== normalize(canonical)) {
            corrections.push(formatReference(ref));
          }
          out.push(...gap, ...canonical);
          i = k;
          continue;
        }
      }
    }
    i++;
  }
  return { markdown: out.join('\n'), corrections };
}
