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

// Every string path of a type, with `[]` for an array element. A union is read
// member by member: a value typed `string | number` or `string | { x: string }`
// is a string path, and its object and array members are followed as well.
export type StringPaths<T, Prefix extends string = ''> = Resolved<{
  [K in keyof T & string]-?: ValuePaths<NonNullable<T[K]>, `${Prefix}${K}`>;
}[keyof T & string]>;

// Spells the union out as literals, so a compile error names each path.
type Resolved<P> = P extends string ? P : never;

type ValuePaths<V, Path extends string> =
  | ([Extract<V, string>] extends [never] ? never : Path)
  | NestedPaths<Exclude<V, string>, Path>;

// Distributes over the union's non-string members.
type NestedPaths<V, Path extends string> = V extends readonly (infer E)[]
  ? ValuePaths<NonNullable<E>, `${Path}[]`>
  : V extends object
    ? StringPaths<V, `${Path}.`>
    : never;

// The string fields the final pass cleans: the ones textFields reads.
export const CLEANED_PATHS = [
  'museum.name',
  'title',
  'artist.name',
  'artist.nationality',
  'artist.lifespan',
  'displayDate',
  'medium',
  'region',
  'period',
  'description',
  'objectType',
  'dimensions',
  'creditLine.holder',
  'creditLine.fund',
  'creditLine.accession',
  'rawTags[]',
] as const;

// The string fields the final pass leaves alone, each with its reason.
// tests/types/artworkPaths.ts fails to compile when an Artwork string field is
// in neither list, so a new field cannot ship uncleaned unnoticed.
const ADAPTER_BUILT = 'built by the adapter, not upstream prose';
const VERBATIM = 'kept as the source sent it, by contract';
export const EXEMPT_PATHS = {
  id: ADAPTER_BUILT,
  'museum.code': ADAPTER_BUILT,
  'museum.url': 'a URL',
  'artist.attributionType': 'an enum',
  mediumCategory: 'an enum',
  'imageUrls.full': 'a URL',
  'imageUrls.large': 'a URL',
  'imageUrls.thumbnail': 'a URL',
  'imageUrls.master.url': 'a URL',
  'imageUrls.master.format': 'a MIME type',
  'license.type': 'an enum',
  'license.rawValue': VERBATIM,
  'license.verificationSource': ADAPTER_BUILT,
  'license.verifiedAt': 'a timestamp',
  'license.confidence': 'an enum',
  'source.apiUrl': 'a URL',
  'source.pageUrl': 'a URL',
  'source.originalUrl': 'a URL',
  dominantColor: 'computed from the image',
  'palette[].hex': 'computed from the image',
  colorFamily: 'an enum',
  'models3d[].url': 'a URL',
  'models3d[].source': 'a platform code',
  'models3d[].licence.type': 'an enum',
  'models3d[].licence.rawValue': VERBATIM,
  'models3d[].licence.verificationSource': ADAPTER_BUILT,
  'models3d[].licence.verifiedAt': 'a timestamp',
  'models3d[].licence.confidence': 'an enum',
  'models3d[].format[]': 'a format code',
  'provenance.raw': VERBATIM,
  'provenance.rawFormat': 'an enum',
  'provenance.entries[].description': VERBATIM,
  'provenance.entries[].date': VERBATIM,
  'provenance.caveat': VERBATIM,
} as const;

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
