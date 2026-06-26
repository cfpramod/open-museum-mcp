import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ngaFetcher } from '../src/fetchers/nga.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
}

describe('NGA adapter normalization', () => {
  it('normalizes a CC0 open-access record (Girl with the Red Hat) into the Artwork shape', () => {
    const result = ngaFetcher.normalize(fixture('nga-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('nga:60');
    expect(a.museum.code).toBe('nga');
    expect(a.title).toContain('Red Hat');
    expect(a.artist.name).toBe('Johannes Vermeer');
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('nga.published_images.openaccess');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.imageUrls.full).toMatch(/^https:\/\/api\.nga\.gov\/iiif\/.+\/full\/full\/0\/default\.jpg$/);
    expect(a.imageUrls.width).toBe(12070);
    expect(a.imageUrls.height).toBe(15257);
    expect(a.imageUrls.maxResolution).toEqual({ width: 12070, height: 15257 });
    expect(a.source.pageUrl).toContain('nga.gov/collection');
  });

  it('rejects a record not flagged open-access (o !== 1)', () => {
    const result = ngaFetcher.normalize(fixture('nga-rejected-no-oa.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/open-access|strict default/i);
    expect(result.rejection.museumCode).toBe('nga');
  });

  it('rejects a record with no image', () => {
    const result = ngaFetcher.normalize(fixture('nga-rejected-no-image.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/image/i);
  });

  it('rejects garbage input gracefully', () => {
    expect(ngaFetcher.normalize(null).status).toBe('rejected');
    expect(ngaFetcher.normalize('nope').status).toBe('rejected');
    expect(ngaFetcher.normalize(42).status).toBe('rejected');
  });
});

describe('NGA adapter search + getRaw (gzipped bundle)', () => {
  // Warm the lazy gz bundle once (decompress + index).
  beforeAll(async () => {
    await ngaFetcher.search('warm', 1);
  }, 30_000);

  it('finds works by keyword and round-trips through getRaw + normalize', async () => {
    const ids = await ngaFetcher.search('Monet', 5);
    expect(ids.length).toBeGreaterThan(0);
    const raw = await ngaFetcher.getRaw(ids[0]);
    const r = ngaFetcher.normalize(raw);
    expect(r.status).toBe('accepted');
    if (r.status !== 'accepted') return;
    expect(r.artwork.license.type).toBe('CC0');
  });

  it('returns an empty list for an empty query', async () => {
    expect(await ngaFetcher.search('   ', 5)).toEqual([]);
  });

  it('getRaw returns null for an unknown id', async () => {
    expect(await ngaFetcher.getRaw('nga:does-not-exist')).toBeNull();
  });

  it('respects the limit', async () => {
    const ids = await ngaFetcher.search('portrait', 3);
    expect(ids.length).toBeLessThanOrEqual(3);
  });
});
