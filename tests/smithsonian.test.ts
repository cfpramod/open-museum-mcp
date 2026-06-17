import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowlistedImageHost } from '../src/color/extract.js';
import { smithsonianFetcher } from '../src/fetchers/smithsonian.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// Deep-clone a fixture so per-test mutations don't bleed across tests.
function clone(name: string): Record<string, unknown> {
  return structuredClone(fixture(name)) as Record<string, unknown>;
}

describe('Smithsonian adapter normalization', () => {
  it('normalizes a CC0 record (anonymous maker, BCE–CE date, image) into the Artwork shape', () => {
    const result = smithsonianFetcher.normalize(fixture('smithsonian-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('smithsonian:ld1-1643381040022-1643381058802-1');
    expect(a.museum.code).toBe('smithsonian');
    // The contributing unit's full name is surfaced for accurate citation.
    expect(a.museum.name).toBe('Smithsonian American Art Museum');
    expect(a.museum.url).toBe('https://www.si.edu');
    expect(a.title).toBe('Necklace');
    // "Unidentified" maps to an anonymous attribution.
    expect(a.artist.attributionType).toBe('anonymous');
    expect(a.displayDate).toBe('100 B.C.-100 A.D.');
    // End-to-end proof of the cross-era "B.C.-A.D." parse fix: not {-100, -100}.
    expect(a.yearStart).toBe(-100);
    expect(a.yearEnd).toBe(100);
    expect(a.medium).toBe('faience and glass');
    expect(a.mediumCategory).toBe('ceramic');
    expect(a.region).toBeNull();
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('smithsonian.metadata_usage.access');
    expect(a.license.confidence).toBe('high');
    expect(a.license.rawValue).toBe('CC0');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('ids.si.edu');
    expect(a.imageUrls.thumbnail).toContain('ids.si.edu');
    expect(a.imageUrls.width).toBe(2200);
    expect(a.imageUrls.height).toBe(3000);
    expect(a.source.apiUrl).toContain('api.si.edu/openaccess');
    expect(a.source.pageUrl).toContain('americanart.si.edu');
    expect(a.description).toBe('Decorative Arts-Jewelry');
  });

  it('surfaces the maker-labelled name and never the Sitter on a portrait', () => {
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as { content: { freetext: Record<string, unknown> } };
    response.content.freetext.name = [
      { label: 'Sitter', content: 'George Washington' },
      { label: 'Artist', content: 'Gilbert Stuart' },
    ];
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.artist.name).toBe('Gilbert Stuart');
    expect(result.artwork.artist.attributionType).toBe('named');
  });

  it('parses a verbose comma-delimited attribution into name/nationality/lifespan', () => {
    // Real live shape (Cooper Hewitt): the whole attribution is one string.
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as { content: { freetext: Record<string, unknown> } };
    response.content.freetext.name = [
      { label: 'Artist', content: 'Vincent Van Gogh, The Netherlands, active in France, 1853 – 1890' },
    ];
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.artist.name).toBe('Vincent Van Gogh');
    expect(result.artwork.artist.nationality).toBe('The Netherlands');
    expect(result.artwork.artist.lifespan).toBe('1853–1890');
    expect(result.artwork.artist.attributionType).toBe('named');
  });

  it('does not promote a Sitter-only record to a named artist', () => {
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as { content: { freetext: Record<string, unknown> } };
    response.content.freetext.name = [{ label: 'Sitter', content: 'George Washington' }];
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.artist.name).toBe('Unknown');
    expect(result.artwork.artist.attributionType).toBe('anonymous');
  });

  it('accepts a metadata-CC0 record but withholds an image whose media usage is not CC0', () => {
    // The two-tier case: open catalog metadata, restricted image. The record is
    // accepted as open metadata, but imageOpenAccess is false and the restricted
    // image URL is NOT surfaced (so the federation's has_image filter drops it).
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as {
      content: { descriptiveNonRepeating: { online_media: { media: Array<Record<string, unknown>> } } };
    };
    response.content.descriptiveNonRepeating.online_media.media[0].usage = {
      access: 'Usage conditions apply',
    };
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.metadataOpenAccess).toBe(true);
    expect(result.artwork.imageOpenAccess).toBe(false);
    expect(result.artwork.imageUrls.full).toBe('');
  });

  it('rejects a record whose metadata_usage.access is "Usage conditions apply"', () => {
    const result = smithsonianFetcher.normalize(fixture('smithsonian-rejected-restricted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('Usage conditions apply');
    expect(result.rejection.museumCode).toBe('smithsonian');
  });

  it('rejects a record with no metadata_usage block (strict default)', () => {
    const result = smithsonianFetcher.normalize(fixture('smithsonian-rejected-missing-field.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('missing');
  });

  it('rejects a CC0 Libraries "Books" record as non-art (curation gate)', () => {
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as {
      content: { indexedStructured: Record<string, unknown>; freetext: Record<string, unknown> };
    };
    response.content.indexedStructured.object_type = ['Books'];
    response.content.freetext.objectType = [{ label: 'Type', content: 'Books' }];
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('curation reject');
    expect(result.rejection.reason).toContain('Books');
  });

  it('rejects a CC0 Natural History specimen (no object_type) as non-art', () => {
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as {
      content: { indexedStructured: Record<string, unknown>; freetext: Record<string, unknown> };
    };
    delete response.content.indexedStructured.object_type;
    delete response.content.freetext.objectType;
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('curation reject');
  });

  it('rejects garbage input gracefully', () => {
    expect(smithsonianFetcher.normalize(null).status).toBe('rejected');
    expect(smithsonianFetcher.normalize('not an object').status).toBe('rejected');
    expect(smithsonianFetcher.normalize(42).status).toBe('rejected');
  });

  it('surfaces "smithsonian:unknown" id on CC0-but-missing-id rejections', () => {
    const result = smithsonianFetcher.normalize({
      response: {
        content: { descriptiveNonRepeating: { metadata_usage: { access: 'CC0' } } },
      },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.id).toBe('smithsonian:unknown');
    expect(result.rejection.reason).toContain('missing or non-string id');
  });

  it('accepts a bare record passed without the {response:...} envelope', () => {
    // A search row is a bare record; the /content endpoint wraps it. Tolerate both.
    const wrapped = fixture('smithsonian-accepted.json') as { response: unknown };
    const result = smithsonianFetcher.normalize(wrapped.response);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('smithsonian:ld1-1643381040022-1643381058802-1');
  });
});

describe('Smithsonian adapter mediumCategory', () => {
  it('falls back to "other" when no Medium label is present', () => {
    const raw = clone('smithsonian-accepted.json');
    const response = raw.response as { content: { freetext: Record<string, unknown> } };
    response.content.freetext.physicalDescription = [
      { label: 'Dimensions', content: 'length: 15 in.' },
    ];
    const result = smithsonianFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.medium).toBe('');
    expect(result.artwork.mediumCategory).toBe('other');
  });
});

describe('Smithsonian CDN allowlist (SSRF surface)', () => {
  it('permits the ids.si.edu image host and rejects a look-alike', () => {
    expect(isAllowlistedImageHost('https://ids.si.edu/ids/deliveryService?id=SAAM-1')).toBe(true);
    // Suffix look-alikes and subdomains of the real host must NOT pass — the
    // allowlist is an exact hostname match, closing the DNS-rebinding vector.
    expect(isAllowlistedImageHost('https://ids.si.edu.evil.example/x')).toBe(false);
    expect(isAllowlistedImageHost('https://evil-ids.si.edu.attacker.test/x')).toBe(false);
    expect(isAllowlistedImageHost('https://si.edu/x')).toBe(false);
  });
});

describe('Smithsonian adapter search', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.SI_API_KEY;
  const realSmithKey = process.env.SMITHSONIAN_API_KEY;

  beforeEach(() => {
    // Use the SI_API_KEY alias path; clear the canonical var for determinism.
    delete process.env.SMITHSONIAN_API_KEY;
    process.env.SI_API_KEY = 'test-key';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.SI_API_KEY;
    else process.env.SI_API_KEY = realKey;
    if (realSmithKey === undefined) delete process.env.SMITHSONIAN_API_KEY;
    else process.env.SMITHSONIAN_API_KEY = realSmithKey;
    vi.restoreAllMocks();
  });

  it('extracts stable string ids from search rows and applies the image filter + api key', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          response: {
            rows: [
              { id: 'ld1-aaa-1' },
              { id: 'ld1-bbb-2' },
              { id: 12345 }, // non-string id is dropped
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const ids = await smithsonianFetcher.search('egyptian necklace', 10, { hasImage: true });
    expect(ids).toEqual(['smithsonian:ld1-aaa-1', 'smithsonian:ld1-bbb-2']);
    expect(capturedUrl).toContain('api.si.edu/openaccess/api/v1.0/search');
    expect(capturedUrl).toContain('api_key=test-key');
    // When has_image is set, the query carries an EDAN `online_media_type:"Images"`
    // clause alongside the user's terms. This filter is LOAD-BEARING, not a hint:
    // without it Smithsonian search is dominated by Libraries bibliographic records
    // (live, "vincent van gogh" returns ~189 matches that are almost all `SIL` books
    // and only ~1 actual artwork). CC0 is NOT filtered server-side — the strict gate
    // in normalize re-validates it on every fetched record (defense in depth).
    // (URLSearchParams encodes spaces as '+', which decodeURIComponent leaves.)
    const decodedQuery = decodeURIComponent(capturedUrl).replace(/\+/g, ' ');
    expect(decodedQuery).toContain('egyptian necklace');
    expect(decodedQuery).toContain('online_media_type:"Images"');
  });

  it('throws a clear error when no Smithsonian key is set', async () => {
    delete process.env.SI_API_KEY;
    delete process.env.SMITHSONIAN_API_KEY;
    await expect(smithsonianFetcher.search('q', 5)).rejects.toThrow(/SMITHSONIAN_API_KEY not set/);
  });

  it('accepts the canonical SMITHSONIAN_API_KEY var', async () => {
    delete process.env.SI_API_KEY;
    process.env.SMITHSONIAN_API_KEY = 'canonical-key';
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ response: { rows: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await smithsonianFetcher.search('q', 5);
    expect(capturedUrl).toContain('api_key=canonical-key');
  });
});
