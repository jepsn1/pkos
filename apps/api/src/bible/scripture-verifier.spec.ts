import { describe, expect, it } from 'vitest';
import { verifyScripture } from './scripture-verifier';
import type { ParsedReference } from './reference';
import type { VerseRow } from './bible.repo';

// Fake source: correct 1992 text for the passages the tests use.
const CANON: Record<string, VerseRow[]> = {
  'matthew 7': [
    { verse: 21, text: 'Ikke enhver, som siger: Herre, Herre! til mig, skal komme ind i Himmeriget, men kun den, der gør min himmelske faders vilje.' },
    { verse: 22, text: 'Mange vil den dag sige til mig: Herre, Herre! Har vi ikke profeteret i dit navn?' },
    { verse: 23, text: 'Og da vil jeg sige dem, som det er: Jeg har aldrig kendt jer. Bort fra mig, I, som begår lovbrud!' },
  ],
  'john 3': [{ verse: 16, text: 'For således elskede Gud verden, at han gav sin enbårne søn.' }],
};

const resolve = async (ref: ParsedReference): Promise<VerseRow[] | null> => {
  const chapter = CANON[`${ref.book} ${ref.chapter}`];
  if (!chapter) return null;
  if (ref.verseStart === undefined) return chapter;
  const end = ref.verseEnd ?? ref.verseStart;
  return chapter.filter((v) => v.verse >= ref.verseStart! && v.verse <= end);
};

describe('verifyScripture', () => {
  it('replaces a paraphrased blockquote under a reference heading with verbatim text', async () => {
    const md = [
      '## Matthæus 7:21-23',
      '> Ikke alle der siger Herre kommer ind, men de der gør Guds vilje.',
      '> Jeg kendte jer aldrig, gå væk fra mig.',
    ].join('\n');
    const { markdown, corrections } = await verifyScripture(md, resolve);
    expect(markdown).toContain('men kun den, der gør min himmelske faders vilje');
    expect(markdown).toContain('Bort fra mig, I, som begår lovbrud!');
    expect(markdown).not.toContain('gå væk fra mig');
    expect(corrections).toEqual(['Matthæus 7:21-23']);
  });

  it('leaves an already-correct quote unchanged and reports no correction', async () => {
    const md = [
      '## Johannes 3:16',
      '',
      '> 16 For således elskede Gud verden, at han gav sin enbårne søn.',
    ].join('\n');
    const { markdown, corrections } = await verifyScripture(md, resolve);
    expect(corrections).toEqual([]);
    expect(markdown).toContain('sin enbårne søn');
  });

  it('handles an inline reference on the same line as the quote intro', async () => {
    const md = ['Se her (John 3:16):', '> paraphrase that is wrong'].join('\n');
    const { markdown } = await verifyScripture(md, resolve);
    expect(markdown).toContain('For således elskede Gud verden');
    expect(markdown).not.toContain('paraphrase that is wrong');
  });

  it('never touches a blockquote that is not preceded by a reference', async () => {
    const md = ['## Some heading', '> a normal quote, not scripture'].join('\n');
    const { markdown, corrections } = await verifyScripture(md, resolve);
    expect(markdown).toBe(md);
    expect(corrections).toEqual([]);
  });

  it('leaves the note untouched when the reference cannot be resolved', async () => {
    const md = ['## Obadias 1:1', '> some text we cannot verify'].join('\n');
    const { markdown, corrections } = await verifyScripture(md, resolve);
    expect(markdown).toBe(md);
    expect(corrections).toEqual([]);
  });

  it('leaves prose (non-blockquote) after a reference untouched', async () => {
    const md = ['I like Matthæus 7:21 a lot.', 'It is a good verse.'].join('\n');
    const { markdown } = await verifyScripture(md, resolve);
    expect(markdown).toBe(md);
  });
});
