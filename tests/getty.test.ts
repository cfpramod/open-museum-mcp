import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gettyFetcher } from '../src/fetchers/getty.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('Getty adapter normalization', () => {
  it('normalizes a CC0-metadata, CC0-image record (real: Irises, 90.PA.20) into the Artwork shape', () => {
    const raw = { object: fixture('getty-object-accepted.json'), media: fixture('getty-media-accepted.json') };
    const result = gettyFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('getty:c88b3df0-de91-4f5b-a9ef-7b2b9a6d8abb');
    expect(a.museum.code).toBe('getty');
    expect(a.title).toBe('Irises');
    expect(a.artist.name).toBe('Vincent van Gogh');
    expect(a.artist.nationality).toBe('Dutch');
    expect(a.artist.lifespan).toBe('1853–1890');
    expect(a.artist.attributionType).toBe('named');
    expect(a.yearStart).toBe(1889);
    expect(a.yearEnd).toBe(1889);
    expect(a.displayDate).toBe('1889');
    expect(a.region).toBe('netherlands');
    expect(a.medium).toContain('Oil Paint');
    expect(a.mediumCategory).toBe('painting');
    expect(a.description).toBe('90.PA.20');

    // Metadata is always blanket-CC0 per Getty's Open Content Program, verified per-record.
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('getty.subject_to (Collection Metadata)');

    // Image rights are independently verified against the media entity.
    expect(a.imageOpenAccess).toBe(true);
    expect(a.imageUrls.full).toBe('https://media.getty.edu/iiif/image/8c255d80-7382-46db-9fa8-892c0d37247e/full/max/0/default.jpg');
    expect(a.imageUrls.thumbnail).toContain('600,600');
    expect(a.imageUrls.width).toBe(9021);
    expect(a.imageUrls.height).toBe(7122);
    expect(a.imageUrls.maxResolution).toEqual({ width: 9021, height: 7122 });

    expect(a.source.pageUrl).toBe('https://www.getty.edu/art/collection/object/103JNH');
    expect(a.source.apiUrl).toContain('data.getty.edu/museum/collection/object');
  });

  it('rejects a record whose collection-metadata rights are not CC0', () => {
    const raw = { object: fixture('getty-object-rejected-restricted.json'), media: null };
    const result = gettyFetcher.normalize(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.museumCode).toBe('getty');
  });

  it('rejects a record with no rights statement at all (strict default)', () => {
    const raw = { object: fixture('getty-object-rejected-missing-field.json'), media: null };
    const result = gettyFetcher.normalize(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
  });

  it('rejects garbage input gracefully', () => {
    expect(gettyFetcher.normalize(null).status).toBe('rejected');
    expect(gettyFetcher.normalize('not an object').status).toBe('rejected');
    expect(gettyFetcher.normalize(42).status).toBe('rejected');
    expect(gettyFetcher.normalize({}).status).toBe('rejected');
  });

  it('ACCEPTS the record but omits the image when metadata is CC0 but the specific image is not (two-tier, never inherits)', () => {
    const raw = { object: fixture('getty-object-accepted.json'), media: fixture('getty-media-rejected-restricted.json') };
    const result = gettyFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    expect(result.artwork.metadataOpenAccess).toBe(true);
    expect(result.artwork.imageOpenAccess).toBe(false);
    expect(result.artwork.imageUrls.full).toBe('');
    expect(result.artwork.imageUrls.thumbnail).toBeUndefined();
    expect(result.artwork.imageUrls.width).toBeUndefined();
  });

  it('ACCEPTS the record with no image at all (no `shows`, media null) — metadata-only', () => {
    const objectNoShows = { ...(fixture('getty-object-accepted.json') as Record<string, unknown>), shows: [] };
    const raw = { object: objectNoShows, media: null };
    const result = gettyFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageOpenAccess).toBe(false);
    expect(result.artwork.imageUrls.full).toBe('');
  });

  it('falls back to a bare object id when identified_by has no accession-number entry', () => {
    const objectSparse = {
      ...(fixture('getty-object-accepted.json') as Record<string, unknown>),
      identified_by: [],
    };
    const raw = { object: objectSparse, media: null };
    const result = gettyFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // Falls back to the `_label`, stripped of its trailing "(accession)" parenthetical.
    expect(result.artwork.title).toBe('Irises');
    expect(result.artwork.description).toBeUndefined();
  });
});

describe('Getty getRaw: SSRF host guard on the media hydration fetch', () => {
  afterEach(() => vi.restoreAllMocks());

  function objectFixtureWithShowsId(showsId: string): unknown {
    return { ...(fixture('getty-object-accepted.json') as Record<string, unknown>), shows: [{ id: showsId }] };
  }

  it('does NOT fetch shows[0].id when its host is not *.getty.edu (SSRF vector)', async () => {
    const objectUrl = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify(objectFixtureWithShowsId(objectUrl)), { status: 200 });
    }) as unknown as typeof fetch;

    const raw = (await gettyFetcher.getRaw('getty:c88b3df0-de91-4f5b-a9ef-7b2b9a6d8abb')) as { media: unknown };

    // Only the object fetch happened; the attacker-controlled cloud-metadata URL was never requested.
    expect(calls).toHaveLength(1);
    expect(calls.some((u) => u.includes('169.254.169.254'))).toBe(false);
    expect(raw.media).toBeNull();
  });

  it('does NOT fetch a plausible-but-wrong lookalike host (evil-getty.edu / getty.edu.evil.com)', async () => {
    for (const lookalike of ['https://evil-getty.edu/x', 'https://media.getty.edu.evil.com/x', 'https://xgetty.edu/x']) {
      const calls: string[] = [];
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        return new Response(JSON.stringify(objectFixtureWithShowsId(lookalike)), { status: 200 });
      }) as unknown as typeof fetch;

      const raw = (await gettyFetcher.getRaw('getty:c88b3df0-de91-4f5b-a9ef-7b2b9a6d8abb')) as { media: unknown };
      expect(calls).toHaveLength(1);
      expect(raw.media).toBeNull();
    }
  });

  it('DOES fetch a legitimate media.getty.edu URL (no coverage loss from the guard)', async () => {
    const mediaUrl = 'https://media.getty.edu/museum/collection/media/12345';
    let mediaFetched = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === mediaUrl) {
        mediaFetched = true;
        return new Response(JSON.stringify(fixture('getty-media-accepted.json')), { status: 200 });
      }
      return new Response(JSON.stringify(objectFixtureWithShowsId(mediaUrl)), { status: 200 });
    }) as unknown as typeof fetch;

    const raw = (await gettyFetcher.getRaw('getty:c88b3df0-de91-4f5b-a9ef-7b2b9a6d8abb')) as { media: unknown };
    expect(mediaFetched).toBe(true);
    expect(raw.media).not.toBeNull();
  });

  it('DOES fetch the bare getty.edu apex host (no subdomain)', async () => {
    const mediaUrl = 'https://getty.edu/museum/collection/media/12345';
    let mediaFetched = false;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === mediaUrl) {
        mediaFetched = true;
        return new Response(JSON.stringify(fixture('getty-media-accepted.json')), { status: 200 });
      }
      return new Response(JSON.stringify(objectFixtureWithShowsId(mediaUrl)), { status: 200 });
    }) as unknown as typeof fetch;

    await gettyFetcher.getRaw('getty:c88b3df0-de91-4f5b-a9ef-7b2b9a6d8abb');
    expect(mediaFetched).toBe(true);
  });

  it('does NOT fetch a malformed shows[0].id that fails URL parsing', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify(objectFixtureWithShowsId('not a url')), { status: 200 });
    }) as unknown as typeof fetch;

    const raw = (await gettyFetcher.getRaw('getty:c88b3df0-de91-4f5b-a9ef-7b2b9a6d8abb')) as { media: unknown };
    expect(calls).toHaveLength(1);
    expect(raw.media).toBeNull();
  });
});
