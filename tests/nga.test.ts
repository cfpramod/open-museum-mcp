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

// --- Bundle-loader seam (Workers-safe /core export, mirrors Walters) -----------

import { createNgaFetcher, type NgaBundle } from '../src/fetchers/nga.js';

const TINY_BUNDLE: NgaBundle = {
  meta: { source: 'test' },
  objects: [
    {
      i: '60', t: 'Girl with the Red Hat', d: 'c. 1665/1666', a: 1665, b: 1666,
      m: 'oil on panel', c: 'Johannes Vermeer', l: 'painting', g: 'nga-60-uuid',
      w: 12070, h: 15257, o: 1,
    },
    {
      i: '61', t: 'Woman Holding a Balance', d: 'c. 1664', a: 1664, b: 1664,
      m: 'oil on canvas', c: 'Johannes Vermeer', l: 'painting', g: 'nga-61-uuid',
      w: 4000, h: 4600, o: 1,
    },
  ],
};

describe('NGA bundle-loader seam (createNgaFetcher)', () => {
  it('searches and hydrates against an INJECTED bundle (no filesystem)', async () => {
    let loads = 0;
    const fetcher = createNgaFetcher(() => { loads++; return TINY_BUNDLE; });
    const ids = await fetcher.search('red hat', 10);
    expect(ids).toEqual(['nga:60']);
    const raw = await fetcher.getRaw('nga:60');
    const result = fetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('nga:60');
    // Loader runs once; the parsed index is cached per fetcher instance.
    await fetcher.search('balance', 10);
    expect(loads).toBe(1);
  });

  it('accepts an async loader (Promise-returning), matching the CacheStore Awaitable pattern', async () => {
    const fetcher = createNgaFetcher(async () => TINY_BUNDLE);
    const ids = await fetcher.search('woman balance', 10);
    expect(ids[0]).toBe('nga:61');
  });

  it('keeps instances isolated: injected bundle never leaks into the default fetcher', async () => {
    const injected = createNgaFetcher(() => TINY_BUNDLE);
    await injected.search('red hat', 5);
    // The default (fs-backed) fetcher still resolves real bundle records.
    const raw = await ngaFetcher.getRaw('nga:60');
    expect(raw).not.toBeNull();
  });

  it('module stays Workers-safe: no static node:* imports in the source', () => {
    // The /core export guarantee: importing nga.js must not crash a Workers
    // bundle. Node built-ins may only be reached via lazy dynamic import inside
    // the DEFAULT loader. This guards the module's import graph at source level.
    const src = readFileSync(join(here, '..', 'src', 'fetchers', 'nga.ts'), 'utf-8');
    expect(src).not.toMatch(/^import .* from 'node:/m);
  });

  it('exports from /core: ngaFetcher + createNgaFetcher are on the public surface', async () => {
    const core = await import('../src/core/index.js');
    expect(core.ngaFetcher.code).toBe('nga');
    expect(typeof core.createNgaFetcher).toBe('function');
  });
});
