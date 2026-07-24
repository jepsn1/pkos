import { describe, expect, it } from 'vitest';
import { formatReference, parseReference } from './reference';

describe('parseReference', () => {
  it('parses English abbrev with a verse range', () => {
    expect(parseReference('Matt 7:21-23')).toEqual({
      book: 'matthew',
      slug: 'Matt',
      display: 'Matthæus',
      chapter: 7,
      verseStart: 21,
      verseEnd: 23,
    });
  });

  it('parses Danish book name + comma separator (Danish style)', () => {
    const ref = parseReference('Matthæus 7,21-23');
    expect(ref).toMatchObject({ book: 'matthew', chapter: 7, verseStart: 21, verseEnd: 23 });
  });

  it('parses Danish full name Romerne', () => {
    expect(parseReference('Romerne 10:9-13')).toMatchObject({
      book: 'romans',
      slug: 'Rom',
      chapter: 10,
      verseStart: 9,
      verseEnd: 13,
    });
  });

  it('parses a single verse (start == end)', () => {
    expect(parseReference('John 3:16')).toMatchObject({
      book: 'john',
      chapter: 3,
      verseStart: 16,
      verseEnd: 16,
    });
  });

  it('parses a whole chapter (no verse)', () => {
    expect(parseReference('Sl 23')).toEqual({
      book: 'psalms',
      slug: 'Sl',
      display: 'Salmernes Bog',
      chapter: 23,
      verseStart: undefined,
      verseEnd: undefined,
    });
  });

  it('parses numbered books with a leading digit and period', () => {
    expect(parseReference('1. Kor 13:4-7')).toMatchObject({ book: '1corinthians', slug: '1_Kor' });
    expect(parseReference('1 Mosebog 1:1')).toMatchObject({ book: 'genesis', slug: '1_Mos' });
  });

  it('returns null for an unknown book or malformed input', () => {
    expect(parseReference('Nonesuch 3:16')).toBeNull();
    expect(parseReference('just some text')).toBeNull();
    expect(parseReference('')).toBeNull();
  });

  it('rejects a backwards verse range', () => {
    expect(parseReference('Matt 7:23-21')).toBeNull();
  });
});

describe('formatReference', () => {
  it('formats a range, a single verse, and a whole chapter', () => {
    expect(formatReference(parseReference('Matt 7:21-23')!)).toBe('Matthæus 7:21-23');
    expect(formatReference(parseReference('John 3:16')!)).toBe('Johannes 3:16');
    expect(formatReference(parseReference('Sl 23')!)).toBe('Salmernes Bog 23');
  });
});
