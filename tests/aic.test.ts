import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
    expect(a.imageUrls.full).toBe(
      'https://www.artic.edu/iiif/2/3c27b499-af56-f0d5-93b5-a7f2f1ad5813/full/843,/0/default.jpg',
    );
    expect(a.imageUrls.thumbnail).toContain('/full/200,/');
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
  });
});
