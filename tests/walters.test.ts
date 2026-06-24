import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { waltersFetcher } from '../src/fetchers/walters.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
}

describe('Walters adapter normalization', () => {
  it('normalizes a CC0 record (Mamluk Qur’an leaf) into the Artwork shape', () => {
    const result = waltersFetcher.normalize(fixture('walters-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('walters:90607');
    expect(a.museum.code).toBe('walters');
    expect(a.museum.name).toBe('Walters Art Museum');
    expect(a.title).toContain('Qur');
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('walters.dataset_cc0');
    expect(a.license.confidence).toBe('high');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.imageUrls.full).toMatch(/^https:\/\/art\.thewalters\.org\/images\/raw\/.+\.jpg$/);
    expect(a.source.pageUrl).toContain('purl.thewalters.org/art/');
    expect(a.yearEnd).toBeLessThan(1928);
  });

  it('treats a single-word culture creator ("Egyptian") as anonymous, not a named artist', () => {
    // Walters catalogs anonymous works with the culture as the "creator". A bare
    // demonym must not surface as a named person.
    const result = waltersFetcher.normalize(fixture('walters-accepted.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.artist.attributionType).toBe('anonymous');
    expect(result.artwork.artist.name).toBe('Unknown');
  });

  it('keeps a real personal-name creator as a named artist', () => {
    const raw = { ...(fixture('walters-accepted.json') as Record<string, unknown>), r: "Riza 'Abbasi" };
    const result = waltersFetcher.normalize(raw);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.artist.attributionType).toBe('named');
    expect(result.artwork.artist.name).toBe("Riza 'Abbasi");
  });

  it('rejects a record dated at/after the 1928 copyright cutoff', () => {
    const result = waltersFetcher.normalize(fixture('walters-rejected-modern.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/1928|copyright/i);
    expect(result.rejection.museumCode).toBe('walters');
  });

  it('rejects a record with no image (outside the image-bearing CC0 subset)', () => {
    const result = waltersFetcher.normalize(fixture('walters-rejected-missing-image.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/image/i);
  });

  it('rejects a record with no resolvable end-year (strict default)', () => {
    const raw = { ...(fixture('walters-accepted.json') as Record<string, unknown>), b: null };
    const result = waltersFetcher.normalize(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/end-year|public domain/i);
  });

  it('rejects garbage input gracefully', () => {
    expect(waltersFetcher.normalize(null).status).toBe('rejected');
    expect(waltersFetcher.normalize('not an object').status).toBe('rejected');
    expect(waltersFetcher.normalize(42).status).toBe('rejected');
  });
});

describe('Walters adapter search + getRaw (bundled index)', () => {
  // Warm the lazy bundle once. The first dynamic import of the ~5MB JSON under
  // vitest's dev transform is slow; in production it's a one-time JSON.parse.
  beforeAll(async () => {
    await waltersFetcher.search('warm', 1);
  }, 30_000);

  it('finds Mamluk Qur’an leaves despite the apostrophe ("Quran" -> "Qur’an")', async () => {
    const ids = await waltersFetcher.search('Mamluk Quran', 5);
    expect(ids.length).toBeGreaterThan(0);
    // Every id round-trips through getRaw + normalize as an accepted CC0 artwork.
    const raw = await waltersFetcher.getRaw(ids[0]);
    const r = waltersFetcher.normalize(raw);
    expect(r.status).toBe('accepted');
    if (r.status !== 'accepted') return;
    expect(r.artwork.title.toLowerCase()).toContain('qur');
  });

  it('OR-ranks so a two-word query still recalls (Persian manuscript)', async () => {
    const ids = await waltersFetcher.search('Persian manuscript', 5);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith('walters:'))).toBe(true);
  });

  it('returns an empty list for an empty query', async () => {
    expect(await waltersFetcher.search('   ', 5)).toEqual([]);
  });

  it('getRaw returns null for an unknown id', async () => {
    expect(await waltersFetcher.getRaw('walters:does-not-exist')).toBeNull();
  });

  it('respects the limit', async () => {
    const ids = await waltersFetcher.search('plate', 3);
    expect(ids.length).toBeLessThanOrEqual(3);
  });
});
