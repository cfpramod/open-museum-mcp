// A complete accepted record, and every text field the final pass cleans.

import type { Artwork } from '../../src/types.js';

export function makeArtwork(over: Partial<Artwork> = {}): Artwork {
  return {
    id: 'test:1',
    museum: { code: 'test', name: 'Test Museum', url: 'https://test.example' },
    title: 'Water Lilies',
    artist: { name: 'Claude Monet', attributionType: 'named' },
    displayDate: '1906',
    yearStart: 1906,
    yearEnd: 1906,
    medium: 'Oil on canvas',
    mediumCategory: 'painting',
    region: null,
    period: null,
    imageUrls: { full: 'https://img.example/1.jpg' },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: 'test.isPublicDomain',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'high',
    },
    source: { apiUrl: 'https://test.example/api/1', pageUrl: 'https://test.example/1' },
    ...over,
  };
}

// Every text field the record carries, with the two verbatim-by-contract
// fields left out on purpose.
export function textFields(a: Artwork): Record<string, string | undefined | null> {
  return {
    'museum.name': a.museum.name,
    title: a.title,
    'artist.name': a.artist.name,
    'artist.nationality': a.artist.nationality,
    'artist.lifespan': a.artist.lifespan,
    displayDate: a.displayDate,
    medium: a.medium,
    region: a.region,
    period: a.period,
    description: a.description,
    objectType: a.objectType,
    dimensions: a.dimensions,
    'creditLine.holder': a.creditLine?.holder,
    'creditLine.fund': a.creditLine?.fund,
    'creditLine.accession': a.creditLine?.accession,
    ...Object.fromEntries((a.rawTags ?? []).map((t, i) => [`rawTags[${i}]`, t])),
  };
}
