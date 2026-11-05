import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metFetcher } from '../src/fetchers/met.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('Met adapter normalization', () => {
  it('normalizes a Tang dynasty CC0 object to yearStart=618', () => {
    const result = metFetcher.normalize(fixture('met-tang-fixture.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('met:39901');
    expect(a.yearStart).toBe(618);
    expect(a.yearEnd).toBe(907);
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('met.isPublicDomain');
    expect(a.license.confidence).toBe('high');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.museum.code).toBe('met');
    expect(a.region).toBe('china');
    expect(a.title).toContain('Funerary');
    expect(a.artist.attributionType).toBe('anonymous');
    expect(a.source.pageUrl).toContain('metmuseum.org');
  });

  it('rejects an object with isPublicDomain=false', () => {
    const result = metFetcher.normalize(fixture('met-rejected-copyrighted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('isPublicDomain=false');
  });

  it('rejects an object with missing isPublicDomain (strict default)', () => {
    const result = metFetcher.normalize(fixture('met-rejected-missing-field.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default');
  });

  it('rejects garbage input gracefully', () => {
    const result = metFetcher.normalize(null);
    expect(result.status).toBe('rejected');
  });

  // P0 spine guard: the rights gate must keep rejecting non-public-domain
  // objects even though the search call no longer pre-filters to
  // isPublicDomain=true upstream. normalize() is the enforcement point, not the
  // search filter — removing the filter must not weaken the gate.
  it('P0 spine: still rejects a non-PD object after the search pre-filter is removed', () => {
    const result = metFetcher.normalize(fixture('met-rejected-copyrighted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('isPublicDomain=false');
  });
});

describe('Met adapter search (relevance)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: URL) => number[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const objectIDs = handler(new URL(String(input)));
        return new Response(JSON.stringify({ objectIDs, total: objectIDs.length }), { status: 200 });
      }),
    );
  }

  it('passes the query through and no longer constrains to isPublicDomain', async () => {
    let captured: URL | undefined;
    stubFetch((url) => {
      captured = url;
      return [1, 2, 3];
    });

    await metFetcher.search('van gogh', 10);

    expect(captured?.searchParams.get('q')).toBe('van gogh');
    expect(captured?.searchParams.has('isPublicDomain')).toBe(false);
    expect(captured?.searchParams.get('hasImages')).toBe('true');
  });

  it('does not send isPublicDomain, so the query — not a fixed fallback — drives results', async () => {
    // This is a SIMPLIFIED MODEL of the upstream behaviour, not a fixture of it:
    // the real Met API does not document this fallback, and we don't assert what
    // its ranking is. The mock encodes only the one property this fix turns on —
    // that the request omits isPublicDomain, so the response is a function of `q`
    // rather than a query-independent constant. The branch below stands in for
    // "filter present => query-independent set" purely to prove our request shape
    // changed; it is not a claim about the Met's internal relevance algorithm.
    const FIXED_FALLBACK_WHEN_FILTERED = [1, 2, 3];
    stubFetch((url) => {
      if (url.searchParams.has('isPublicDomain')) return FIXED_FALLBACK_WHEN_FILTERED;
      const q = url.searchParams.get('q') ?? '';
      return q === 'van gogh' ? [11, 22, 33] : [];
    });

    const real = await metFetcher.search('van gogh', 10);
    const gibberish = await metFetcher.search('zxqwvk asdfgh qpwoeiruty', 10);

    expect(real).not.toEqual(gibberish);
    expect(real).toEqual(['met:11', 'met:22', 'met:33']);
    expect(gibberish).toEqual([]);
  });
});

describe('Met adapter search endpoint (v1.1, paginated)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The Met retired `/public/collection/v1/search` (HTTP 410) and replaced it with
  // the paginated `/v1.1/search`. These tests pin the request contract so a revert
  // to the retired path, or a request the new endpoint would clamp, fails here.
  function stubPages(all: number[], opts: { cap?: number } = {}) {
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        requests.push(url);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const asked = Number(url.searchParams.get('limit') ?? 100);
        const size = Math.min(asked, opts.cap ?? 500);
        const objectIDs = all.slice(offset, offset + size);
        return new Response(JSON.stringify({ total: all.length, objectIDs }), { status: 200 });
      }),
    );
    return requests;
  }

  it('targets the v1.1 search path, never the retired v1 one', async () => {
    const requests = stubPages([1, 2, 3]);
    await metFetcher.search('horse', 5);
    expect(requests).toHaveLength(1);
    expect(requests[0].pathname).toBe('/public/collection/v1.1/search');
  });

  it('asks for exactly the requested count with an explicit offset', async () => {
    const requests = stubPages(Array.from({ length: 300 }, (_, i) => i + 1));
    const ids = await metFetcher.search('horse', 20);
    expect(requests[0].searchParams.get('limit')).toBe('20');
    expect(requests[0].searchParams.get('offset')).toBe('0');
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('met:1');
  });

  it('pages past the 500-per-call ceiling and preserves upstream order', async () => {
    const all = Array.from({ length: 1200 }, (_, i) => i + 1);
    const requests = stubPages(all);
    const ids = await metFetcher.search('horse', 1100);
    expect(ids).toHaveLength(1100);
    expect(ids[0]).toBe('met:1');
    expect(ids[1099]).toBe('met:1100');
    expect(requests.map((r) => r.searchParams.get('offset'))).toEqual(['0', '500', '1000']);
    expect(requests.every((r) => Number(r.searchParams.get('limit')) <= 500)).toBe(true);
  });

  it('stops when the result set is exhausted instead of re-requesting', async () => {
    const requests = stubPages([7, 8, 9]);
    const ids = await metFetcher.search('rare query', 50);
    expect(ids).toEqual(['met:7', 'met:8', 'met:9']);
    expect(requests).toHaveLength(1);
  });

  it('returns an empty list for a query with no matches', async () => {
    stubPages([]);
    expect(await metFetcher.search('zxqwvk', 10)).toEqual([]);
  });

  it('treats a null objectIDs body as no matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ total: 0, objectIDs: null }), { status: 200 })),
    );
    expect(await metFetcher.search('nothing', 10)).toEqual([]);
  });

  it('drops malformed ids rather than emitting an id the route regex would reject', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ total: 4, objectIDs: [5, 'x', -1, null, 6] }), { status: 200 }),
      ),
    );
    expect(await metFetcher.search('q', 10)).toEqual(['met:5', 'met:6']);
  });

  it('advances the next offset by the raw count the server sent, not the validated count', async () => {
    // Page 1 carries a malformed ID. If the offset followed the validated count
    // (2) rather than the raw count (3), page 2 would re-read from the wrong place.
    const pages: Record<string, unknown[]> = { '0': [1, 'x', 2], '3': [3, 4, 5] };
    const offsets: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const offset = new URL(String(input)).searchParams.get('offset') ?? '0';
        offsets.push(offset);
        return new Response(JSON.stringify({ total: 6, objectIDs: pages[offset] ?? [] }), { status: 200 });
      }),
    );
    const ids = await metFetcher.search('q', 5);
    expect(offsets).toEqual(['0', '3']);
    expect(ids).toEqual(['met:1', 'met:2', 'met:3', 'met:4', 'met:5']);
  });

  it('returns each id once when the same id ends one page and starts the next', async () => {
    const pages: Record<string, number[]> = { '0': [1, 2, 3], '3': [3, 4, 5] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const offset = new URL(String(input)).searchParams.get('offset') ?? '0';
        return new Response(JSON.stringify({ total: 6, objectIDs: pages[offset] ?? [] }), { status: 200 });
      }),
    );
    const ids = await metFetcher.search('q', 5);
    expect(ids).toEqual(['met:1', 'met:2', 'met:3', 'met:4', 'met:5']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('surfaces a retired-endpoint response as an error, not as zero results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'retired' }), { status: 410 })),
    );
    await expect(metFetcher.search('horse', 10)).rejects.toThrow(/Met search failed: 410/);
  });

  it('bounds the page loop if upstream keeps returning non-empty pages', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ total: 1e9, objectIDs: [1, 2, 3] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await metFetcher.search('loop', 1_000_000);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('returns nothing for a non-positive limit without calling upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await metFetcher.search('horse', 0)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Met adapter mediumCategory', () => {
  it('normalizes the raw `medium` field to the controlled vocab', () => {
    const result = metFetcher.normalize(fixture('met-tang-fixture.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // "Earthenware with sancai (three-color) glaze" -> ceramic
    expect(result.artwork.mediumCategory).toBe('ceramic');
  });

  it('falls back to "other" when the raw `medium` carries no known signal', () => {
    const raw = structuredClone(fixture('met-tang-fixture.json')) as Record<string, unknown>;
    raw.medium = 'Jade'; // a material with no controlled-vocab keyword
    const result = metFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.mediumCategory).toBe('other');
  });
});

describe('Met provenance (v0.20.0): source publishes none via API', () => {
  it('never fabricates provenance — the field is absent on Met records', () => {
    const result = metFetcher.normalize(fixture('met-tang-fixture.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect('provenance' in result.artwork).toBe(false);
  });
});

describe('Met dimensions and credit line', () => {
  it('carries the dimensions string, credit line and accession number verbatim', () => {
    const result = metFetcher.normalize(fixture('met-accepted-credit-dimensions.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.dimensions).toBe('46 5/8 x 18 3/4 in. (118.4 x 47.6 cm)');
    expect(result.artwork.creditLine).toEqual({
      holder: 'The Metropolitan Museum of Art',
      fund: 'The Howard Mansfield Collection, Purchase, Rogers Fund, 1936',
      accession: '36.100.45',
    });
  });

  it('omits both when the Met publishes neither', () => {
    const result = metFetcher.normalize(fixture('met-tang-fixture.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.dimensions).toBeUndefined();
    expect(result.artwork.creditLine).toBeUndefined();
  });
});
