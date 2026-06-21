import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rijksmuseumFetcher } from '../src/fetchers/rijksmuseum.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, 'fixtures', 'rijksmuseum-accepted-milkmaid.json'), 'utf-8'));
}
/** deep-clone so per-test mutations don't bleed. */
const clone = (o: unknown) => JSON.parse(JSON.stringify(o));

describe('Rijksmuseum direct (Linked-Art + Micrio IIIF) normalization', () => {
  it('normalizes The Milkmaid (Vermeer) into the Artwork shape', () => {
    const result = rijksmuseumFetcher.normalize(fixture());
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('rijksmuseum:200108369');
    expect(a.museum.code).toBe('rijksmuseum');
    expect(a.title).toBe('The Milkmaid');
    expect(a.artist.name).toBe('Johannes Vermeer');
    expect(a.artist.attributionType).toBe('named');
    expect(a.yearStart).toBe(1660);
    expect(a.yearEnd).toBe(1660);
    // image rights is the PD Mark on the VisualItem
    expect(a.license.type).toBe('PD');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.imageUrls.full).toBe('https://iiif.micr.io/QkOGy/full/max/0/default.jpg');
    expect(a.imageUrls.width).toBe(4649);
    expect(a.imageUrls.height).toBe(5177);
  });

  it('REJECTS when image rights are NonCommercial (commercial-POD gate)', () => {
    const b = clone(fixture());
    b.visualItem.subject_to[0].classified_as[0].id = 'https://creativecommons.org/licenses/by-nc/4.0/';
    const result = rijksmuseumFetcher.normalize(b);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/non-?commercial|nc/i);
  });

  it('REJECTS sub-print-resolution images (<3000px long edge)', () => {
    const b = clone(fixture());
    b.image.width = 1800;
    b.image.height = 1400;
    const result = rijksmuseumFetcher.normalize(b);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/resolution|3000|print/i);
  });

  it('REJECTS when no image was resolved', () => {
    const b = clone(fixture());
    delete b.image;
    expect(rijksmuseumFetcher.normalize(b).status).toBe('rejected');
  });

  it('REJECTS when rights are missing entirely (strict default deny)', () => {
    const b = clone(fixture());
    b.visualItem.subject_to = [];
    expect(rijksmuseumFetcher.normalize(b).status).toBe('rejected');
  });

  it('rejects garbage input gracefully', () => {
    expect(rijksmuseumFetcher.normalize(null).status).toBe('rejected');
    expect(rijksmuseumFetcher.normalize('nope').status).toBe('rejected');
    expect(rijksmuseumFetcher.normalize({}).status).toBe('rejected');
  });
});
