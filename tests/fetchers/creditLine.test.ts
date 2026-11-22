import { describe, expect, it } from 'vitest';
import {
  ACCESSION_MAX,
  CREDIT_LINE_MAX,
  buildCreditLine,
  optionalText,
  sanitizeDescription,
} from '../../src/fetchers/sanitize.js';
import type { CreditLine as CoreCreditLine } from '../../src/core/index.js';

// Compile-time guard: CreditLine is part of the /core public surface.
const creditLineSurfaceCheck: (c: CoreCreditLine) => string = (c) => c.holder;
void creditLineSurfaceCheck;

describe('buildCreditLine', () => {
  it('keeps the credit line and accession number verbatim', () => {
    expect(
      buildCreditLine('The Metropolitan Museum of Art', 'The Howard Mansfield Collection, Purchase, Rogers Fund, 1936', '36.100.45'),
    ).toEqual({
      holder: 'The Metropolitan Museum of Art',
      fund: 'The Howard Mansfield Collection, Purchase, Rogers Fund, 1936',
      accession: '36.100.45',
    });
  });

  it('does not strip a leading holder name from the credit line', () => {
    const c = buildCreditLine('Smithsonian American Art Museum', 'Smithsonian American Art Museum, Gift of John Gellatly', undefined);
    expect(c?.fund).toBe('Smithsonian American Art Museum, Gift of John Gellatly');
  });

  it('is absent when the record publishes neither a credit line nor an accession number', () => {
    expect(buildCreditLine('Rijksmuseum', undefined, undefined)).toBeUndefined();
    expect(buildCreditLine('Rijksmuseum', '', '   ')).toBeUndefined();
    expect(buildCreditLine('Rijksmuseum', 42, null)).toBeUndefined();
  });

  it('omits the part that is missing rather than emitting an empty string', () => {
    const onlyAccession = buildCreditLine('Rijksmuseum', undefined, 'SK-A-2344');
    expect(onlyAccession).toEqual({ holder: 'Rijksmuseum', accession: 'SK-A-2344' });
    expect(onlyAccession).not.toHaveProperty('fund');
    const onlyFund = buildCreditLine('Cleveland Museum of Art', 'Mr. and Mrs. William H. Marlatt Fund', '');
    expect(onlyFund).toEqual({ holder: 'Cleveland Museum of Art', fund: 'Mr. and Mrs. William H. Marlatt Fund' });
    expect(onlyFund).not.toHaveProperty('accession');
  });

  it('is absent when the holder is empty, since a credit line without a holder says nothing', () => {
    expect(buildCreditLine('', 'Gift of X', '1.2')).toBeUndefined();
    expect(buildCreditLine('<b></b>', 'Gift of X', '1.2')).toBeUndefined();
  });

  it('strips markup and decodes entities in every part', () => {
    const c = buildCreditLine('Harvard Art Museums', 'Gift of <i>Eric Schroeder</i> &amp; family', '<span>1968.47</span>');
    expect(c).toEqual({ holder: 'Harvard Art Museums', fund: 'Gift of Eric Schroeder & family', accession: '1968.47' });
  });

  it('caps the credit line and accession number', () => {
    const c = buildCreditLine('Museum', 'x'.repeat(CREDIT_LINE_MAX + 50), '9'.repeat(ACCESSION_MAX + 50));
    expect(c?.fund).toHaveLength(CREDIT_LINE_MAX);
    expect(c?.accession).toHaveLength(ACCESSION_MAX);
  });
});

describe('optionalText', () => {
  it('returns the sanitised text, or undefined when nothing is left', () => {
    expect(optionalText('46 5/8 x 18 3/4 in. (118.4 x 47.6 cm)', sanitizeDescription)).toBe('46 5/8 x 18 3/4 in. (118.4 x 47.6 cm)');
    expect(optionalText('  <br/> ', sanitizeDescription)).toBeUndefined();
    expect(optionalText('', sanitizeDescription)).toBeUndefined();
    expect(optionalText(undefined, sanitizeDescription)).toBeUndefined();
    expect(optionalText({ h: 1 }, sanitizeDescription)).toBeUndefined();
  });
});
