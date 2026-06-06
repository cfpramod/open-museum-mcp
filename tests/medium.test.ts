import { describe, expect, it } from 'vitest';
import { MEDIUM_CATEGORIES, normalizeMedium } from '../src/medium.js';

describe('normalizeMedium — controlled vocabulary', () => {
  it('exposes exactly the eleven locked categories', () => {
    expect(MEDIUM_CATEGORIES).toEqual([
      'painting',
      'drawing',
      'print',
      'photograph',
      'sculpture',
      'textile',
      'ceramic',
      'metalwork',
      'furniture',
      'manuscript',
      'other',
    ]);
  });

  it('maps painting media', () => {
    expect(normalizeMedium('Oil on canvas')).toBe('painting');
    expect(normalizeMedium('Tempera and gold on panel')).toBe('painting');
    expect(normalizeMedium('Watercolor on paper')).toBe('painting');
    expect(normalizeMedium('Fresco')).toBe('painting');
  });

  it('maps drawing media', () => {
    expect(normalizeMedium('Charcoal and white chalk on paper')).toBe('drawing');
    expect(normalizeMedium('Graphite')).toBe('drawing');
    expect(normalizeMedium('Pastel on wove paper')).toBe('drawing');
  });

  it('maps print media', () => {
    expect(normalizeMedium('Woodblock print')).toBe('print');
    expect(normalizeMedium('Color woodcut')).toBe('print');
    expect(normalizeMedium('Etching and engraving')).toBe('print');
    expect(normalizeMedium('Lithograph')).toBe('print');
  });

  it('maps photograph media, beating an incidental "print" token (longest-match)', () => {
    // "Gelatin silver print" and "albumen ... negative" both contain "print";
    // the photographic keyword is longer/more specific and must win.
    expect(normalizeMedium('Gelatin silver print')).toBe('photograph');
    expect(normalizeMedium('Albumen silver print from glass negative')).toBe('photograph');
    expect(normalizeMedium('Daguerreotype')).toBe('photograph');
  });

  it('maps sculpture, with "sculpture" beating "bronze" by longest-match', () => {
    expect(normalizeMedium('Marble')).toBe('sculpture');
    expect(normalizeMedium('Bronze sculpture')).toBe('sculpture');
    expect(normalizeMedium('Limestone relief')).toBe('sculpture');
  });

  it('maps textile media', () => {
    expect(normalizeMedium('Silk and metal thread tapestry')).toBe('textile');
    expect(normalizeMedium('Wool carpet')).toBe('textile');
    expect(normalizeMedium('Cotton, embroidery')).toBe('textile');
  });

  it('maps ceramic media', () => {
    expect(normalizeMedium('Porcelain')).toBe('ceramic');
    expect(normalizeMedium('Glazed earthenware')).toBe('ceramic');
    expect(normalizeMedium('Stoneware with celadon glaze')).toBe('ceramic');
  });

  it('maps metalwork media (bare "bronze" without a sculpture cue)', () => {
    expect(normalizeMedium('Bronze')).toBe('metalwork');
    expect(normalizeMedium('Gilt silver')).toBe('metalwork');
    expect(normalizeMedium('Cast iron')).toBe('metalwork');
  });

  it('maps furniture media', () => {
    expect(normalizeMedium('Side chair')).toBe('furniture');
    expect(normalizeMedium('Walnut cabinet')).toBe('furniture');
  });

  it('maps manuscript media', () => {
    expect(normalizeMedium('Illuminated manuscript')).toBe('manuscript');
    expect(normalizeMedium('Ink and gold on parchment, codex')).toBe('manuscript');
  });

  it('falls back to "other" strictly — never guesses', () => {
    expect(normalizeMedium('')).toBe('other');
    expect(normalizeMedium('Unknown')).toBe('other');
    expect(normalizeMedium('Mixed media')).toBe('other');
    expect(normalizeMedium('Jade')).toBe('other');
    expect(normalizeMedium(null)).toBe('other');
    expect(normalizeMedium(undefined)).toBe('other');
  });

  it('does not match keywords inside unrelated substrings (word boundary)', () => {
    // "printed matter" should match print, but a stray non-word context must not
    // produce false matches; "open" must not match the "pen" drawing keyword.
    expect(normalizeMedium('Open-form vessel')).toBe('other');
  });
});
