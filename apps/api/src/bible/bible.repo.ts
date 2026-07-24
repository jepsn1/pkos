import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { bibleVerses } from '../db/schema';

export const BIBLE_REPO = 'BIBLE_REPO';

export interface VerseRow {
  verse: number;
  text: string;
}

/** Local cache of fetched Bible verses (see schema.bibleVerses). */
export interface BibleRepo {
  /** All cached verses of a chapter, verse-ordered ([] when not yet cached). */
  getChapter(translation: string, book: string, chapter: number): Promise<VerseRow[]>;
  /** Insert a whole chapter's verses (idempotent — skips ones already present). */
  saveChapter(
    translation: string,
    book: string,
    chapter: number,
    verses: VerseRow[],
  ): Promise<void>;
}

export class DrizzleBibleRepo implements BibleRepo {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  async getChapter(translation: string, book: string, chapter: number): Promise<VerseRow[]> {
    const rows = await this.db
      .select({ verse: bibleVerses.verse, text: bibleVerses.text })
      .from(bibleVerses)
      .where(
        and(
          eq(bibleVerses.translation, translation),
          eq(bibleVerses.book, book),
          eq(bibleVerses.chapter, chapter),
        ),
      )
      .orderBy(asc(bibleVerses.verse));
    return rows;
  }

  async saveChapter(
    translation: string,
    book: string,
    chapter: number,
    verses: VerseRow[],
  ): Promise<void> {
    if (verses.length === 0) return;
    await this.db
      .insert(bibleVerses)
      .values(verses.map((v) => ({ translation, book, chapter, verse: v.verse, text: v.text })))
      .onConflictDoNothing();
  }
}
