import { beforeEach, describe, expect, it } from 'vitest';
import { BibleService } from './bible.service';
import type { BibleRepo, VerseRow } from './bible.repo';
import type { BibleSource, SourceVerse } from './bible-source';
import { parseReference } from './reference';
import { BibleToolsService } from './bible-tools.service';

class FakeRepo implements BibleRepo {
  store = new Map<string, VerseRow[]>();
  private key = (t: string, b: string, c: number) => `${t}|${b}|${c}`;
  async getChapter(t: string, b: string, c: number): Promise<VerseRow[]> {
    return this.store.get(this.key(t, b, c)) ?? [];
  }
  async saveChapter(t: string, b: string, c: number, verses: VerseRow[]): Promise<void> {
    this.store.set(this.key(t, b, c), verses);
  }
}

class FakeSource implements BibleSource {
  readonly translation = '1992';
  fetches = 0;
  chapter: SourceVerse[] = [
    { verse: 21, text: 'v21 text' },
    { verse: 22, text: 'v22 text' },
    { verse: 23, text: 'v23 text' },
  ];
  async fetchChapter(): Promise<SourceVerse[]> {
    this.fetches++;
    return this.chapter;
  }
}

let repo: FakeRepo;
let source: FakeSource;
let service: BibleService;

beforeEach(() => {
  repo = new FakeRepo();
  source = new FakeSource();
  service = new BibleService(repo, source);
});

describe('BibleService.getVerses', () => {
  it('fetches on a cache miss, caches the chapter, then serves locally (no refetch)', async () => {
    const ref = parseReference('Matt 7:22')!;
    expect(await service.getVerses(ref)).toEqual([{ verse: 22, text: 'v22 text' }]);
    expect(source.fetches).toBe(1);
    // second call for a DIFFERENT verse of the same chapter → cache hit, no fetch
    expect(await service.getVerses(parseReference('Matt 7:23')!)).toEqual([
      { verse: 23, text: 'v23 text' },
    ]);
    expect(source.fetches).toBe(1);
  });

  it('returns a verse range', async () => {
    const verses = await service.getVerses(parseReference('Matt 7:21-23')!);
    expect(verses.map((v) => v.verse)).toEqual([21, 22, 23]);
  });

  it('returns the whole chapter when no verse is given', async () => {
    const verses = await service.getVerses(parseReference('Matt 7')!);
    expect(verses).toHaveLength(3);
  });

  it('returns [] for a verse not present in the chapter', async () => {
    expect(await service.getVerses(parseReference('Matt 7:99')!)).toEqual([]);
  });
});

describe('BibleToolsService.get_verse', () => {
  async function run(reference: unknown) {
    return JSON.parse(
      await new BibleToolsService(service).execute({ name: 'get_verse', arguments: { reference } }),
    );
  }

  it('returns verbatim verses, translation, and joined text', async () => {
    const res = await run('Matt 7:21-23');
    expect(res).toMatchObject({
      reference: 'Matthæus 7:21-23',
      translation: '1992',
      verses: [
        { verse: 21, text: 'v21 text' },
        { verse: 22, text: 'v22 text' },
        { verse: 23, text: 'v23 text' },
      ],
    });
    expect(res.text).toBe('21 v21 text\n22 v22 text\n23 v23 text');
  });

  it('reports an error for an unparseable reference', async () => {
    expect((await run('not a reference')).error).toMatch(/could not parse/);
  });

  it('reports an error (not a crash) when the source fails', async () => {
    source.fetchChapter = async () => {
      throw new Error('network down');
    };
    expect((await run('Luk 2:1')).error).toMatch(/network down/);
  });

  it('rejects a missing reference argument', async () => {
    expect((await run(undefined)).error).toMatch(/reference must be/);
  });
});
