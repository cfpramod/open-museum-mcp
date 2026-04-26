import { describe, expect, it } from 'vitest';
import { dedupeWikimediaUploads } from '../src/dedupe.js';
import type { Artwork } from '../src/types.js';

function art(overrides: Partial<Artwork> & { id: string }): Artwork {
  return {
    id: overrides.id,
    museum: overrides.museum ?? {
      code: 'wikimedia',
      name: 'Wikimedia Commons',
      url: 'https://commons.wikimedia.org',
    },
    title: overrides.title ?? 'Untitled',
    artist: overrides.artist ?? {
      name: 'Anonymous',
      attributionType: 'anonymous',
    },
    displayDate: overrides.displayDate ?? '',
    yearStart: overrides.yearStart ?? null,
    yearEnd: overrides.yearEnd ?? null,
    medium: overrides.medium ?? '',
    region: overrides.region ?? null,
    period: overrides.period ?? null,
    imageUrls: overrides.imageUrls ?? { full: 'https://example.org/img.jpg' },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'PD',
      rawValue: 'pd',
      verificationSource: 'test',
      verifiedAt: '2026-04-26',
      confidence: 'high',
    },
    source: overrides.source ?? {
      apiUrl: 'https://example.org/api',
      pageUrl: 'https://example.org/page',
    },
  };
}

describe('dedupeWikimediaUploads', () => {
  it('keeps the largest of multiple Commons uploads sharing title+artist', () => {
    // Real-world case: Commons has the same Modigliani painting uploaded
    // twice. The 306×584 entry would break the lightbox; the 1187×1993
    // entry is the one we want surfaced.
    const small = art({
      id: 'wikimedia:1',
      title: 'Lunia Czechowska',
      artist: { name: 'Amedeo Modigliani', attributionType: 'named' },
      imageUrls: { full: 'https://example.org/small.jpg', width: 306, height: 584 },
    });
    const large = art({
      id: 'wikimedia:2',
      title: 'Lunia Czechowska',
      artist: { name: 'Amedeo Modigliani', attributionType: 'named' },
      imageUrls: { full: 'https://example.org/large.jpg', width: 1187, height: 1993 },
    });
    const out = dedupeWikimediaUploads([small, large]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('wikimedia:2');
  });

  it('is order-independent: largest wins regardless of input position', () => {
    const small = art({
      id: 'wikimedia:1',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'a', width: 100, height: 100 },
    });
    const large = art({
      id: 'wikimedia:2',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'b', width: 1000, height: 1000 },
    });
    expect(dedupeWikimediaUploads([small, large]).map((a) => a.id)).toEqual(['wikimedia:2']);
    expect(dedupeWikimediaUploads([large, small]).map((a) => a.id)).toEqual(['wikimedia:2']);
  });

  it('case-insensitive on title and artist (Commons casing varies)', () => {
    const a = art({
      id: 'wikimedia:1',
      title: 'Water Lilies',
      artist: { name: 'Claude Monet', attributionType: 'named' },
      imageUrls: { full: 'a', width: 500, height: 500 },
    });
    const b = art({
      id: 'wikimedia:2',
      title: 'water lilies',
      artist: { name: 'CLAUDE MONET', attributionType: 'named' },
      imageUrls: { full: 'b', width: 2000, height: 2000 },
    });
    const out = dedupeWikimediaUploads([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('wikimedia:2');
  });

  it('keeps both when titles differ even by a whisker (distinct works)', () => {
    // "Water Lilies, c. 1915" vs "Water Lilies, 1916" — distinct paintings
    // in Monet's series. They must not collapse.
    const a = art({
      id: 'wikimedia:1',
      title: 'Water Lilies, c. 1915',
      artist: { name: 'Claude Monet', attributionType: 'named' },
      imageUrls: { full: 'a', width: 1000, height: 1000 },
    });
    const b = art({
      id: 'wikimedia:2',
      title: 'Water Lilies, 1916',
      artist: { name: 'Claude Monet', attributionType: 'named' },
      imageUrls: { full: 'b', width: 1500, height: 1500 },
    });
    const out = dedupeWikimediaUploads([a, b]);
    expect(out).toHaveLength(2);
  });

  it('does not collapse same-title works by different artists', () => {
    const a = art({
      id: 'wikimedia:1',
      title: 'Self-portrait',
      artist: { name: 'Vincent van Gogh', attributionType: 'named' },
      imageUrls: { full: 'a', width: 1000, height: 1000 },
    });
    const b = art({
      id: 'wikimedia:2',
      title: 'Self-portrait',
      artist: { name: 'Rembrandt van Rijn', attributionType: 'named' },
      imageUrls: { full: 'b', width: 1500, height: 1500 },
    });
    const out = dedupeWikimediaUploads([a, b]);
    expect(out).toHaveLength(2);
  });

  it('passes through records with Unknown artist (key is not trustworthy)', () => {
    // "Unknown" appears constantly across genuinely-distinct anonymous
    // works. Collapsing them by title alone would erase real diversity.
    const a = art({
      id: 'wikimedia:1',
      title: 'Saint',
      artist: { name: 'Unknown', attributionType: 'anonymous' },
      imageUrls: { full: 'a', width: 100, height: 100 },
    });
    const b = art({
      id: 'wikimedia:2',
      title: 'Saint',
      artist: { name: 'Unknown', attributionType: 'anonymous' },
      imageUrls: { full: 'b', width: 2000, height: 2000 },
    });
    const out = dedupeWikimediaUploads([a, b]);
    expect(out).toHaveLength(2);
  });

  it('does not touch records from other museums', () => {
    // Met / Cleveland / AIC use unique IDs per artwork; a title+artist
    // match across them is rare but real (multi-cast bronzes, etc.) and
    // should not collapse.
    const met = art({
      id: 'met:111',
      museum: { code: 'met', name: 'Met', url: 'https://metmuseum.org' },
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'a', width: 500, height: 500 },
    });
    const wm1 = art({
      id: 'wikimedia:1',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'b', width: 1000, height: 1000 },
    });
    const wm2 = art({
      id: 'wikimedia:2',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'c', width: 2000, height: 2000 },
    });
    const out = dedupeWikimediaUploads([met, wm1, wm2]);
    expect(out.map((a) => a.id).sort()).toEqual(['met:111', 'wikimedia:2']);
  });

  it('preserves the original output position of the winning record', () => {
    // The dedupe should not reorder — the slot the winner appears in is
    // the slot the winner came from. Other surrounding records keep
    // their original positions.
    const filler = art({
      id: 'met:1',
      museum: { code: 'met', name: 'Met', url: 'https://metmuseum.org' },
    });
    const small = art({
      id: 'wikimedia:1',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'a', width: 100, height: 100 },
    });
    const large = art({
      id: 'wikimedia:2',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'b', width: 1000, height: 1000 },
    });
    const out = dedupeWikimediaUploads([filler, small, large]);
    // small dropped; large kept in its original position 2.
    expect(out.map((a) => a.id)).toEqual(['met:1', 'wikimedia:2']);
  });

  it('handles missing dimensions: undefined area = 0, ties keep first', () => {
    // Some records publish width/height/size; others don't. Records
    // with missing dimensions sort to the bottom (area 0). When all
    // candidates lack dimensions, the first one wins by tie-break.
    const noDims1 = art({
      id: 'wikimedia:1',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'a' },
    });
    const noDims2 = art({
      id: 'wikimedia:2',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'b' },
    });
    const sized = art({
      id: 'wikimedia:3',
      title: 'X',
      artist: { name: 'Y', attributionType: 'named' },
      imageUrls: { full: 'c', width: 50, height: 50 },
    });
    expect(dedupeWikimediaUploads([noDims1, noDims2]).map((a) => a.id)).toEqual(['wikimedia:1']);
    expect(dedupeWikimediaUploads([noDims1, sized]).map((a) => a.id)).toEqual(['wikimedia:3']);
  });

  it('returns the input unchanged when there are no duplicates', () => {
    const a = art({
      id: 'wikimedia:1',
      title: 'A',
      artist: { name: 'X', attributionType: 'named' },
    });
    const b = art({
      id: 'wikimedia:2',
      title: 'B',
      artist: { name: 'Y', attributionType: 'named' },
    });
    expect(dedupeWikimediaUploads([a, b]).map((x) => x.id)).toEqual(['wikimedia:1', 'wikimedia:2']);
  });
});
