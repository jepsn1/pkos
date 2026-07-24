import { describe, expect, it } from 'vitest';
import { BibelselskabetSource, parseChapterHtml } from './bible-source';

// Mirrors bibelselskabet.dk markup: empty verse_number span then the verse text,
// several verses per <p>, a heading between verses, chrome before/after.
const CHAPTER_HTML = `
<html><body>
<header><nav>site menu</nav></header>
<h2>Overskrift der ikke er en vers</h2>
<div class="paragraph verse_style_p bible--verse">
  <p>
    <span class="verse_number" data-verse="21" data-text="V21"></span>
    Ikke enhver, som siger: Herre, Herre! til mig, skal komme ind i Himmeriget.
    <span class="verse_number" data-verse="22" data-text="V22"></span>
    Mange vil den dag sige til mig: Herre, Herre!
  </p>
</div>
<div class="paragraph verse_style_p bible--verse">
  <p>
    <span class="verse_number" data-verse="23" data-text="V23"></span>
    Og da vil jeg sige dem, som det er: Jeg har aldrig kendt jer.
  </p>
</div>
<footer>copyright bibelselskabet</footer>
</body></html>`;

describe('parseChapterHtml', () => {
  it('extracts each verse verbatim, keyed by data-verse', () => {
    const verses = parseChapterHtml(CHAPTER_HTML);
    expect(verses).toEqual([
      { verse: 21, text: 'Ikke enhver, som siger: Herre, Herre! til mig, skal komme ind i Himmeriget.' },
      { verse: 22, text: 'Mange vil den dag sige til mig: Herre, Herre!' },
      { verse: 23, text: 'Og da vil jeg sige dem, som det er: Jeg har aldrig kendt jer.' },
    ]);
  });

  it('does not leak the footer into the last verse', () => {
    const last = parseChapterHtml(CHAPTER_HTML).at(-1)!;
    expect(last.text).not.toContain('copyright');
  });

  it('decodes HTML entities', () => {
    const html = '<p><span class="verse_number" data-verse="1"></span>Far &amp; s&oslash;n sagde &#8217;ja&#8217;.</p>';
    expect(parseChapterHtml(html)).toEqual([{ verse: 1, text: 'Far & søn sagde ’ja’.' }]);
  });

  it('returns [] when there are no verse markers', () => {
    expect(parseChapterHtml('<p>no verses here</p>')).toEqual([]);
  });
});

describe('BibelselskabetSource', () => {
  it('fetches the chapter URL and returns parsed verses', async () => {
    let calledUrl = '';
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, text: async () => CHAPTER_HTML } as Response;
    }) as unknown as typeof fetch;
    const source = new BibelselskabetSource(fakeFetch);
    const verses = await source.fetchChapter('Matt', 7);
    expect(calledUrl).toContain('/Matt/7');
    expect(verses).toHaveLength(3);
    expect(verses[2].text).toContain('aldrig kendt jer');
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch;
    const source = new BibelselskabetSource(fakeFetch);
    await expect(source.fetchChapter('Matt', 999)).rejects.toThrow(/404/);
  });
});
