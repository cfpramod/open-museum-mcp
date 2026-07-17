import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aicFetcher } from '../src/fetchers/aic.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('AIC adapter normalization', () => {
  it('normalizes a public-domain record (named artist, with image) into the Artwork shape', () => {
    const result = aicFetcher.normalize(fixture('aic-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('aic:16568');
    expect(a.museum.code).toBe('aic');
    expect(a.museum.name).toBe('Art Institute of Chicago');
    expect(a.title).toBe('Water Lilies');
    expect(a.artist.name).toBe('Claude Monet');
    expect(a.artist.nationality).toBe('French');
    expect(a.artist.lifespan).toBe('1840–1926');
    expect(a.artist.attributionType).toBe('named');
    expect(a.yearStart).toBe(1906);
    expect(a.yearEnd).toBe(1906);
    expect(a.region).toBe('france');
    expect(a.medium).toBe('Oil on canvas');
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('aic.is_public_domain');
    expect(a.license.confidence).toBe('high');
    expect(a.license.rawValue).toBe('true');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    // `full` requests the IIIF source maximum (`/full/max/`), not the 843px
    // public-display size — AIC holds the scan at 3.5–4× that. Thumbnail stays 200px.
    expect(a.imageUrls.full).toBe(
      'https://www.artic.edu/iiif/2/3c27b499-af56-f0d5-93b5-a7f2f1ad5813/full/max/0/default.jpg',
    );
    expect(a.imageUrls.full).not.toContain('/full/843,/');
    expect(a.imageUrls.thumbnail).toContain('/full/200,/');
    // hotlinkRestricted is applied centrally by the federation (aicFetcher.hotlinkRestricted = true),
    // not by normalize — so it is absent on the raw normalize output.
    expect(a.imageUrls.hotlinkRestricted).toBeUndefined();
    // AIC thumbnail field carries full scan pixel dims — exposed as maxResolution.
    expect(a.imageUrls.maxResolution).toEqual({ width: 1024, height: 768 });
    expect(a.imageUrls.width).toBe(1024);
    expect(a.imageUrls.height).toBe(768);
    expect(a.source.pageUrl).toBe('https://www.artic.edu/artworks/16568');
    expect(a.source.apiUrl).toContain('api.artic.edu');
    expect(a.description).toBe('oil on canvas');
  });

  it('rejects a record with is_public_domain=false', () => {
    const result = aicFetcher.normalize(fixture('aic-rejected-restricted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('is_public_domain=false');
    expect(result.rejection.museumCode).toBe('aic');
  });

  it('rejects a record with no is_public_domain field (strict default)', () => {
    const result = aicFetcher.normalize(fixture('aic-rejected-missing-field.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
  });

  it('rejects garbage input gracefully', () => {
    expect(aicFetcher.normalize(null).status).toBe('rejected');
    expect(aicFetcher.normalize('not an object').status).toBe('rejected');
    expect(aicFetcher.normalize(42).status).toBe('rejected');
  });

  it('surfaces "aic:unknown" id on rights-pass + bad-id rejections', () => {
    const result = aicFetcher.normalize({ data: { is_public_domain: true } });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.id).toBe('aic:unknown');
    expect(result.rejection.reason).toContain('missing or non-integer id');
  });

  it('accepts a record passed without the {data:...} envelope', () => {
    const wrapped = fixture('aic-accepted.json') as { data: unknown };
    const result = aicFetcher.normalize(wrapped.data);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('aic:16568');
  });

  it('falls back to parseDisplayDate when date_start/date_end are missing', () => {
    const baseline = fixture('aic-accepted.json') as { data: Record<string, unknown> };
    const sparser = {
      data: {
        ...baseline.data,
        date_display: 'Tang dynasty (618–907)',
        date_start: undefined,
        date_end: undefined,
      },
    };
    const sparsed = JSON.parse(JSON.stringify(sparser));
    const result = aicFetcher.normalize(sparsed);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.yearStart).toBe(618);
    expect(result.artwork.yearEnd).toBe(907);
  });

  it('falls back to artist_display when artist_title is missing', () => {
    const baseline = fixture('aic-accepted.json') as { data: Record<string, unknown> };
    const noTitle = {
      data: { ...baseline.data, artist_title: '' },
    };
    const result = aicFetcher.normalize(noTitle);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.artist.name).toBe('Claude Monet');
    expect(result.artwork.artist.nationality).toBe('French');
  });

  it('emits empty image URLs when image_id is missing', () => {
    const baseline = fixture('aic-accepted.json') as { data: Record<string, unknown> };
    const noImage = {
      data: { ...baseline.data, image_id: null },
    };
    const result = aicFetcher.normalize(noImage);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageUrls.full).toBe('');
    expect(result.artwork.imageUrls.thumbnail).toBeUndefined();
    // hotlinkRestricted is applied by the federation, not by normalize.
    expect(result.artwork.imageUrls.hotlinkRestricted).toBeUndefined();
  });

  it('omits maxResolution when thumbnail dims are absent', () => {
    const baseline = fixture('aic-accepted.json') as { data: Record<string, unknown> };
    const noThumb = { data: { ...baseline.data, thumbnail: null } };
    const result = aicFetcher.normalize(noThumb);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageUrls.maxResolution).toBeUndefined();
    expect(result.artwork.imageUrls.width).toBeUndefined();
    expect(result.artwork.imageUrls.height).toBeUndefined();
  });

  it('does not surface "born YYYY" tokens as artist nationality', () => {
    // AIC's artist_display occasionally reads "X (born 1950)" for living
    // artists. Such records will normally fail the rights gate, but if one
    // ever flows through, the nationality field must not get the birth line.
    const baseline = fixture('aic-accepted.json') as { data: Record<string, unknown> };
    const livingArtist = {
      data: {
        ...baseline.data,
        artist_display: 'Some Artist (born 1950)',
        artist_title: 'Some Artist',
      },
    };
    const result = aicFetcher.normalize(livingArtist);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.artist.nationality).toBeUndefined();
    expect(result.artwork.artist.lifespan).toBe('born 1950');
  });

  it('does not surface digit-bearing tokens as nationality', () => {
    const baseline = fixture('aic-accepted.json') as { data: Record<string, unknown> };
    const malformed = {
      data: { ...baseline.data, artist_display: 'X (1880–1960)', artist_title: 'X' },
    };
    const result = aicFetcher.normalize(malformed);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.artist.nationality).toBeUndefined();
    expect(result.artwork.artist.lifespan).toBe('1880–1960');
  });

  it('rejects when is_public_domain is explicitly null (strict default)', () => {
    // Belt-and-suspenders contract: explicit `null` and field-absent both
    // hit the strict-default-deny path.
    const result = aicFetcher.normalize({ data: { id: 1, is_public_domain: null } });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
  });
});

describe('AIC search query construction (#28)', () => {
  // Capture the URL passed to fetch without making a live call. AIC proxies
  // the `query[...]` params straight into Elasticsearch, so the exact param
  // shape is what the bug is about: two sibling clauses in one query object
  // (`query[term]` + `query[exists]`) is invalid ES and AIC returns HTTP 400.
  // The clauses must be combined under a single `bool/must` array instead.
  function stubFetchCapturingUrl(): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        urls.push(input.toString());
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 11 }] }),
        } as Response;
      }),
    );
    return { urls };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('combines the rights and image filters under a single bool/must array', async () => {
    const cap = stubFetchCapturingUrl();
    await aicFetcher.search('Hopper Nighthawks', 3, { hasImage: true });
    const params = new URL(cap.urls[0]).searchParams;

    // The bug shape: two sibling query clauses. Neither may appear.
    expect(params.has('query[term][is_public_domain]')).toBe(false);
    expect(params.has('query[exists][field]')).toBe(false);

    // The fix shape: a bool/must array carrying both clauses.
    expect(params.get('query[bool][must][0][term][is_public_domain]')).toBe('true');
    expect(params.get('query[bool][must][1][exists][field]')).toBe('image_id');

    // Free-text query and field projection are unchanged.
    expect(params.get('q')).toBe('Hopper Nighthawks');
    expect(params.get('fields')).toBe('id');
  });

  it('omits the image-exists clause when hasImage is false', async () => {
    const cap = stubFetchCapturingUrl();
    await aicFetcher.search('Monet', 5, { hasImage: false });
    const params = new URL(cap.urls[0]).searchParams;

    expect(params.get('query[bool][must][0][term][is_public_domain]')).toBe('true');
    expect(params.has('query[bool][must][1][exists][field]')).toBe(false);
  });

  it('maps numeric response ids to aic:-prefixed strings', async () => {
    stubFetchCapturingUrl();
    const ids = await aicFetcher.search('Monet', 3, {});
    expect(ids).toEqual(['aic:11']);
  });
});

describe('AIC adapter mediumCategory', () => {
  it('normalizes the raw `medium_display` field to the controlled vocab', () => {
    const result = aicFetcher.normalize(fixture('aic-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // "Oil on canvas" -> painting
    expect(result.artwork.mediumCategory).toBe('painting');
  });

  it('falls back to "other" when `medium_display` carries no known signal', () => {
    const raw = structuredClone(fixture('aic-accepted.json')) as { data: Record<string, unknown> };
    raw.data.medium_display = 'Mixed media';
    const result = aicFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.mediumCategory).toBe('other');
  });
});

describe('AIC provenance mapping (v0.20.0, openclearance P-7 posture)', () => {
  it('carries provenance_text as verbatim raw text plus a single-entry interpretation', () => {
    const result = aicFetcher.normalize(fixture('aic-accepted.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    const prov = result.artwork.provenance;
    expect(prov).toBeDefined();
    expect(prov!.rawFormat).toBe('text');
    expect(prov!.raw).toContain('Durand-Ruel');
    expect(prov!.entries!.length).toBe(1);
    expect(prov!.entries![0].description).toBe(prov!.raw); // interpretation IS the text, unaltered
  });
});
