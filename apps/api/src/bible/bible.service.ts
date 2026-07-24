import { Inject, Injectable } from '@nestjs/common';
import { BIBLE_REPO, type BibleRepo, type VerseRow } from './bible.repo';
import { BIBLE_SOURCE, type BibleSource } from './bible-source';
import type { ParsedReference } from './reference';

/**
 * Verbatim scripture lookup with a local cache. On a cache miss the whole chapter
 * is fetched from the source once and stored, so subsequent lookups (any verse in
 * that chapter) are served locally — deterministic, offline, one request per
 * chapter for the life of the cache.
 */
@Injectable()
export class BibleService {
  constructor(
    @Inject(BIBLE_REPO) private readonly repo: BibleRepo,
    @Inject(BIBLE_SOURCE) private readonly source: BibleSource,
  ) {}

  get translation(): string {
    return this.source.translation;
  }

  /** Verses for a reference (whole chapter when no verse given); [] if none found. */
  async getVerses(ref: ParsedReference): Promise<VerseRow[]> {
    const t = this.source.translation;
    let chapter = await this.repo.getChapter(t, ref.book, ref.chapter);
    if (chapter.length === 0) {
      const fetched = await this.source.fetchChapter(ref.slug, ref.chapter);
      await this.repo.saveChapter(t, ref.book, ref.chapter, fetched);
      chapter = [...fetched].sort((a, b) => a.verse - b.verse);
    }
    if (ref.verseStart === undefined) return chapter;
    const end = ref.verseEnd ?? ref.verseStart;
    return chapter.filter((v) => v.verse >= ref.verseStart! && v.verse <= end);
  }
}
