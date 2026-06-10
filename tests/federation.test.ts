import { describe, expect, it, vi } from 'vitest';
import { createFederation, UnknownMuseumError } from '../src/core/index.js';
import type { CacheStore } from '../src/core/index.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork, ValidationResult } from '../src/types.js';

function makeArtwork(id: string, over: Partial<Artwork> = {}): Artwork {
  const code = id.slice(0, id.indexOf(':'));
  return {
    id,
    museum: { code, name: code.toUpperCase(), url: `https://${code}.example` },
    title: `Work ${id}`,
    artist: { name: 'Anon', attributionType: 'named' },
    displayDate: '1700',
    yearStart: 1700,
    yearEnd: 1700,
    medium: 'oil',
    mediumCategory: 'painting',
    region: null,
    period: null,
    imageUrls: { full: `https://img.example/${id}.jpg` },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: `${code}.test`,
      verifiedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'high',
    },
    source: { apiUrl: `https://${code}.example/api/${id}`, pageUrl: `https://${code}.example/${id}` },
    ...over,
  };
}

function memoryCache() {
  const objects = new Map<string, Artwork>();
  const queries = new Map<string, string[]>();
  const store: CacheStore = {
    getObject: (id) => objects.get(id) ?? null,
    upsertObject: (a) => {
      objects.set(a.id, a);
    },
    getQuery: (k) => queries.get(k) ?? null,
    putQuery: (k, ids) => {
      queries.set(k, ids);
    },
  };
  return { store, objects, queries };
}

interface FakeConfig {
  /** IDs returned by search (the overfetch candidate list). */
  ids: string[];
  /** IDs the rights gate accepts; everything else is rejected. */
  accept: Set<string>;
  /** Accepted IDs that carry no image (empty `imageUrls.full`). */
  imageless?: Set<string>;
  /** Per-id Artwork overrides (e.g. to set yearStart for the date filter). */
  over?: Record<string, Partial<Artwork>>;
}

function fakeFetcher(code: string, config: FakeConfig) {
  let searchCalls = 0;
  const fetcher: Fetcher = {
    code,
    name: code.toUpperCase(),
    async search() {
      searchCalls++;
      return config.ids;
    },
    async getRaw(id: string) {
      return { id };
    },
    normalize(raw: unknown): ValidationResult {
      const id = (raw as { id: string }).id;
      if (!config.accept.has(id)) {
        return { status: 'rejected', rejection: { id, museumCode: code, reason: `${code}: not open`, rawSnapshot: raw } };
      }
      const over = { ...(config.over?.[id] ?? {}) };
      if (config.imageless?.has(id)) over.imageUrls = { full: '' };
      return { status: 'accepted', artwork: makeArtwork(id, over) };
    },
  };
  return { fetcher, get searchCalls() { return searchCalls; } };
}

describe('createFederation.search', () => {
  it('overfetches, drops rights-gate rejections, and slices to limit', async () => {
    // limit 2, has_image true -> overFetch 6. Four candidates, one rejected.
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2', 'test:3', 'test:4'],
      accept: new Set(['test:1', 'test:2', 'test:3']),
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 2 });
    expect(out.count).toBe(2);
    expect(out.results.map((r) => r.id)).toEqual(['test:1', 'test:2']);
  });

  it('interleaves museums round-robin so no single fetcher fills the page', async () => {
    // Two museums each return 4 accepted candidates. With flat() concatenation,
    // the first fetcher (met) would fill the limit-4 page entirely. Round-robin
    // interleaving must yield an alternating mix.
    const met = fakeFetcher('met', {
      ids: ['met:1', 'met:2', 'met:3', 'met:4'],
      accept: new Set(['met:1', 'met:2', 'met:3', 'met:4']),
    });
    const cle = fakeFetcher('cleveland', {
      ids: ['cleveland:1', 'cleveland:2', 'cleveland:3', 'cleveland:4'],
      accept: new Set(['cleveland:1', 'cleveland:2', 'cleveland:3', 'cleveland:4']),
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { met: met.fetcher, cleveland: cle.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 4 });
    expect(out.results.map((r) => r.id)).toEqual(['met:1', 'cleveland:1', 'met:2', 'cleveland:2']);
    const codes = out.results.map((r) => r.museum.code);
    expect(codes.filter((c) => c === 'met')).toHaveLength(2);
    expect(codes.filter((c) => c === 'cleveland')).toHaveLength(2);
  });

  it('reuses the cached id list on a second identical search (no second fetcher.search)', async () => {
    const t = fakeFetcher('test', { ids: ['test:1', 'test:2'], accept: new Set(['test:1', 'test:2']) });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    await fed.search({ query: 'x', has_image: true, limit: 1 });
    await fed.search({ query: 'x', has_image: true, limit: 1 });
    expect(t.searchCalls).toBe(1);
  });

  it('does not cache the id list when a fetcher search throws (no 14-day poisoning)', async () => {
    // One museum is down; the federation should degrade (return the healthy
    // museum's results) but NOT persist the partial id list, so the next call
    // retries the failed search instead of serving a degraded result for the
    // full query-cache TTL.
    const healthy = fakeFetcher('cleveland', {
      ids: ['cleveland:1', 'cleveland:2'],
      accept: new Set(['cleveland:1', 'cleveland:2']),
    });
    let metSearchCalls = 0;
    const downMet: Fetcher = {
      code: 'met',
      name: 'MET',
      async search() {
        metSearchCalls++;
        throw new Error('met: upstream 503');
      },
      async getRaw(id: string) {
        return { id };
      },
      normalize(raw: unknown): ValidationResult {
        return { status: 'accepted', artwork: makeArtwork((raw as { id: string }).id) };
      },
    };
    const { store, queries } = memoryCache();
    const fed = createFederation({ fetchers: { met: downMet, cleveland: healthy.fetcher }, cache: store });

    const first = await fed.search({ query: 'x', has_image: true, limit: 4 });
    // Degrades to the healthy museum's results.
    expect(first.results.map((r) => r.id)).toEqual(['cleveland:1', 'cleveland:2']);
    // The partial result was NOT cached.
    expect(queries.size).toBe(0);

    // A second identical search re-runs both searches (no poisoned cache hit).
    await fed.search({ query: 'x', has_image: true, limit: 4 });
    expect(metSearchCalls).toBe(2);
    expect(healthy.searchCalls).toBe(2);
  });

  it('excludes image-less records when has_image is true', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2'],
      accept: new Set(['test:1', 'test:2']),
      imageless: new Set(['test:1']),
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10 });
    expect(out.results.map((r) => r.id)).toEqual(['test:2']);
  });

  it('applies the year-range filter to the result set', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2'],
      accept: new Set(['test:1', 'test:2']),
      over: {
        'test:1': { yearStart: 1500, yearEnd: 1500 },
        'test:2': { yearStart: 1900, yearEnd: 1900 },
      },
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10, year_min: 1800, year_max: 2000 });
    expect(out.results.map((r) => r.id)).toEqual(['test:2']);
  });

  it('throws UnknownMuseumError for an unregistered museum code', async () => {
    const t = fakeFetcher('test', { ids: [], accept: new Set() });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    await expect(fed.search({ query: 'x', has_image: true, limit: 5, museum: 'nope' })).rejects.toBeInstanceOf(
      UnknownMuseumError,
    );
  });

  // The 3x overfetch buffer is load-bearing, not decorative: with the Met search
  // no longer pre-filtering to public domain upstream, a realistic fraction of
  // fetched records are now rejected by the gate post-fetch. This fetcher honors
  // the overfetch count the federation actually requests (limit * 3 when
  // has_image), so the test exercises the real headroom rather than asserting it.
  function countHonoringFetcher(code: string, rejectFraction: number) {
    const fetcher: Fetcher = {
      code,
      name: code.toUpperCase(),
      // Return exactly as many candidate ids as the federation asks for.
      async search(_query: string, count: number) {
        return Array.from({ length: count }, (_, i) => `${code}:${i + 1}`);
      },
      async getRaw(id: string) {
        return { id };
      },
      normalize(raw: unknown): ValidationResult {
        const id = (raw as { id: string }).id;
        const n = Number(id.slice(id.indexOf(':') + 1));
        // Reject a deterministic ~rejectFraction of records (every Nth id).
        const period = Math.max(2, Math.round(1 / rejectFraction));
        if (n % period === 0) {
          return { status: 'rejected', rejection: { id, museumCode: code, reason: `${code}: not open`, rawSnapshot: raw } };
        }
        return { status: 'accepted', artwork: makeArtwork(id) };
      },
    };
    return fetcher;
  }

  it('fills a full page when ~half of fetched records are rejected by the gate (3x headroom)', async () => {
    // limit 10, has_image -> overFetch 30 candidates; ~half rejected leaves ~15
    // accepted, comfortably filling the 10-result page with margin. At the old 2x
    // factor this would only break even (20 candidates -> ~10 accepted, zero
    // headroom), so this asserts the buffer absorbs the higher rejection rate.
    const fed = createFederation({
      fetchers: { test: countHonoringFetcher('test', 0.5) },
      cache: memoryCache().store,
    });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10 });
    expect(out.count).toBe(10);
    expect(out.results).toHaveLength(10);
    // Every returned record is one the gate accepted (no rejected id leaked).
    for (const r of out.results) {
      const n = Number(r.id.slice(r.id.indexOf(':') + 1));
      expect(n % 2).not.toBe(0);
    }
  });
});

describe('createFederation.getArtwork', () => {
  it('rejects a malformed id before any fetch', async () => {
    const t = fakeFetcher('test', { ids: [], accept: new Set() });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.getArtwork('not a valid id');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('invalid artwork id');
  });

  it('does not cache rejected records and invokes onReject', async () => {
    const t = fakeFetcher('test', { ids: ['test:9'], accept: new Set() });
    const { store, objects } = memoryCache();
    const onReject = vi.fn();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store, onReject });

    const out = await fed.getArtwork('test:9');
    expect(out.ok).toBe(false);
    expect(objects.has('test:9')).toBe(false);
    expect(onReject).toHaveBeenCalledWith('test:9', expect.stringContaining('not open'));
  });

  it('caches an accepted record and serves the cache on the next call', async () => {
    const t = fakeFetcher('test', { ids: ['test:1'], accept: new Set(['test:1']) });
    const { store, objects } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const first = await fed.getArtwork('test:1');
    expect(first.ok).toBe(true);
    expect(objects.has('test:1')).toBe(true);

    const getRawSpy = vi.spyOn(t.fetcher, 'getRaw');
    const second = await fed.getArtwork('test:1');
    expect(second.ok).toBe(true);
    expect(getRawSpy).not.toHaveBeenCalled();
  });
});

describe('createFederation.cite', () => {
  it('renders a citation for an accepted record and propagates rejection reasons', async () => {
    const t = fakeFetcher('test', { ids: ['test:1'], accept: new Set(['test:1']) });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const ok = await fed.cite('test:1', 'short');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.citation.length).toBeGreaterThan(0);

    const bad = await fed.cite('test:404', 'short');
    expect(bad.ok).toBe(false);
  });
});

describe('createFederation.search medium filter', () => {
  it('returns only records whose mediumCategory matches the filter', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2', 'test:3'],
      accept: new Set(['test:1', 'test:2', 'test:3']),
      over: {
        'test:1': { mediumCategory: 'painting' },
        'test:2': { mediumCategory: 'print' },
        'test:3': { mediumCategory: 'painting' },
      },
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10, medium: 'print' });
    expect(out.results.map((r) => r.id)).toEqual(['test:2']);
  });

  it('returns all records when no medium filter is set', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2'],
      accept: new Set(['test:1', 'test:2']),
      over: { 'test:1': { mediumCategory: 'painting' }, 'test:2': { mediumCategory: 'print' } },
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10 });
    expect(out.count).toBe(2);
  });
});

describe('createFederation.facets', () => {
  it('aggregates medium, date-bucket, and top-artist counts over the query result set', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2', 'test:3', 'test:4'],
      accept: new Set(['test:1', 'test:2', 'test:3', 'test:4']),
      over: {
        'test:1': { mediumCategory: 'painting', yearStart: 1850, yearEnd: 1850, artist: { name: 'Monet', attributionType: 'named' } },
        'test:2': { mediumCategory: 'painting', yearStart: 1880, yearEnd: 1880, artist: { name: 'Monet', attributionType: 'named' } },
        'test:3': { mediumCategory: 'print', yearStart: 1700, yearEnd: 1700, artist: { name: 'Hokusai', attributionType: 'named' } },
        'test:4': { mediumCategory: 'print', yearStart: 1755, yearEnd: 1755, artist: { name: 'Nobody', attributionType: 'anonymous' } },
      },
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const f = await fed.facets({ query: 'x', has_image: true, limit: 10 });

    expect(f.medium).toContainEqual({ value: 'painting', count: 2 });
    expect(f.medium).toContainEqual({ value: 'print', count: 2 });

    expect(f.dateBucket).toContainEqual({ value: '1800–1899', count: 2 });
    expect(f.dateBucket).toContainEqual({ value: '1700–1799', count: 2 });

    expect(f.artist).toContainEqual({ value: 'Monet', count: 2 });
    expect(f.artist).toContainEqual({ value: 'Hokusai', count: 1 });
    // anonymous works are not a useful artist facet value
    expect(f.artist.find((a) => a.value === 'Nobody')).toBeUndefined();
  });

  it('does not pre-apply the medium filter to the medium facet (shows all available media)', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2'],
      accept: new Set(['test:1', 'test:2']),
      over: { 'test:1': { mediumCategory: 'painting' }, 'test:2': { mediumCategory: 'print' } },
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const f = await fed.facets({ query: 'x', has_image: true, limit: 10, medium: 'painting' });
    expect(f.medium).toContainEqual({ value: 'painting', count: 1 });
    expect(f.medium).toContainEqual({ value: 'print', count: 1 });
  });

  it('limits the artist facet to the top N by count', async () => {
    const over: Record<string, { artist: { name: string; attributionType: 'named' } }> = {};
    const ids: string[] = [];
    for (let i = 1; i <= 15; i++) {
      const id = `test:${i}`;
      ids.push(id);
      over[id] = { artist: { name: `Artist ${i}`, attributionType: 'named' } };
    }
    const t = fakeFetcher('test', { ids, accept: new Set(ids), over });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const f = await fed.facets({ query: 'x', has_image: true, limit: 50 });
    expect(f.artist.length).toBeLessThanOrEqual(10);
  });

  it('samples a much larger candidate window than the default search page', async () => {
    // A fetcher that honors the requested overfetch count and accepts everything.
    // facets must NOT use the caller's small `limit` (10) for its window — it
    // overrides to FACET_SAMPLE_SIZE so counts are trustworthy. With caller
    // limit 10, the search window would be 10*3 = 30; facets must sample far more.
    const fetcher: Fetcher = {
      code: 'test',
      name: 'TEST',
      async search(_query: string, count: number) {
        return Array.from({ length: count }, (_, i) => `test:${i + 1}`);
      },
      async getRaw(id: string) {
        return { id };
      },
      normalize(raw: unknown): ValidationResult {
        const id = (raw as { id: string }).id;
        return { status: 'accepted', artwork: makeArtwork(id, { mediumCategory: 'painting' }) };
      },
    };
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: fetcher }, cache: store });

    const f = await fed.facets({ query: 'x', has_image: true, limit: 10 });
    const painting = f.medium.find((m) => m.value === 'painting');
    expect(painting?.count ?? 0).toBeGreaterThan(100);
  });

  it('labels BCE date buckets with the earlier year first (load-bearing branch)', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1'],
      accept: new Set(['test:1']),
      over: { 'test:1': { yearStart: -450, yearEnd: -440 } }, // mid-5th century BCE
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const f = await fed.facets({ query: 'x', has_image: true, limit: 10 });
    expect(f.dateBucket).toContainEqual({ value: '500–401 BCE', count: 1 });
  });
});

describe('createFederation.search medium filter — bounded under-delivery', () => {
  it('returns fewer than limit when the target medium is sparse in the candidate window', async () => {
    // Honor the overfetch count (limit*3) and make only 2 candidates 'print'.
    // The medium filter is post-fetch over that bounded window, so the page
    // legitimately under-delivers rather than fetching more — same contract as
    // the year filter.
    const fetcher: Fetcher = {
      code: 'test',
      name: 'TEST',
      async search(_query: string, count: number) {
        return Array.from({ length: count }, (_, i) => `test:${i + 1}`);
      },
      async getRaw(id: string) {
        return { id };
      },
      normalize(raw: unknown): ValidationResult {
        const id = (raw as { id: string }).id;
        const n = Number(id.slice(id.indexOf(':') + 1));
        const mediumCategory = n <= 2 ? 'print' : 'painting';
        return { status: 'accepted', artwork: makeArtwork(id, { mediumCategory }) };
      },
    };
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 5, medium: 'print' });
    // overFetch = 5*3 = 15 candidates, only 2 are 'print' -> under-delivers to 2.
    expect(out.count).toBe(2);
    expect(out.results.every((r) => r.mediumCategory === 'print')).toBe(true);
  });
});

describe('createFederation colour enrichment (Node capability, fail-open)', () => {
  it('applies an injected extractColor to accepted records before caching', async () => {
    const t = fakeFetcher('test', { ids: ['test:1'], accept: new Set(['test:1']) });
    const { store, objects } = memoryCache();
    const fed = createFederation({
      fetchers: { test: t.fetcher },
      cache: store,
      extractColor: async () => ({
        dominantColor: '#3a5f7d',
        palette: [{ hex: '#3a5f7d', weight: 1 }],
        colorFamily: 'blue',
        lab: { l: 40, a: -5, b: -20 },
      }),
    });

    const out = await fed.getArtwork('test:1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artwork.dominantColor).toBe('#3a5f7d');
    expect(out.artwork.colorFamily).toBe('blue');
    expect(out.artwork.palette).toEqual([{ hex: '#3a5f7d', weight: 1 }]);
    // colour is persisted on the cached record
    expect(objects.get('test:1')?.colorFamily).toBe('blue');
  });

  it('leaves colour unset when no extractor is injected (Workers / sharp-less read path)', async () => {
    const t = fakeFetcher('test', { ids: ['test:1'], accept: new Set(['test:1']) });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.getArtwork('test:1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artwork.dominantColor).toBeUndefined();
    expect(out.artwork.colorFamily).toBeUndefined();
  });

  it('fails open: an extractor that returns null or throws does not fail the record', async () => {
    const t = fakeFetcher('test', { ids: ['test:1', 'test:2'], accept: new Set(['test:1', 'test:2']) });
    const { store } = memoryCache();
    const fed = createFederation({
      fetchers: { test: t.fetcher },
      cache: store,
      extractColor: async (a) => {
        if (a.id === 'test:2') throw new Error('extract boom');
        return null;
      },
    });

    const a1 = await fed.getArtwork('test:1');
    const a2 = await fed.getArtwork('test:2');
    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);
    if (a1.ok) expect(a1.artwork.colorFamily).toBeUndefined();
    if (a2.ok) expect(a2.artwork.colorFamily).toBeUndefined();
  });
});

describe('createFederation.search colour', () => {
  function colourFetcher() {
    const over: Record<string, Partial<Artwork>> = {
      'test:1': { dominantColor: '#ff0000', colorFamily: 'red' },
      'test:2': { dominantColor: '#0000ff', colorFamily: 'blue' },
      'test:3': { dominantColor: '#00a000', colorFamily: 'green' },
      'test:4': {}, // no colour (enrichment failed / Workers)
    };
    return fakeFetcher('test', {
      ids: ['test:1', 'test:2', 'test:3', 'test:4'],
      accept: new Set(['test:1', 'test:2', 'test:3', 'test:4']),
      over,
    });
  }

  it('ranks results by CIEDE2000 nearest to the query colour', async () => {
    const t = colourFetcher();
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10, color: '#1010ee' });
    // nearest to a blue query is the blue record
    expect(out.results[0].id).toBe('test:2');
  });

  it('excludes colourless records from a colour-ranked search', async () => {
    const t = colourFetcher();
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10, color: '#1010ee' });
    expect(out.results.map((r) => r.id)).not.toContain('test:4');
  });

  it('filters by color_family', async () => {
    const t = colourFetcher();
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const out = await fed.search({ query: 'x', has_image: true, limit: 10, color_family: 'red' });
    expect(out.results.map((r) => r.id)).toEqual(['test:1']);
  });
});

describe('createFederation.facets colour', () => {
  it('aggregates a colorFamily bucket over the sample (skipping colourless)', async () => {
    const t = fakeFetcher('test', {
      ids: ['test:1', 'test:2', 'test:3'],
      accept: new Set(['test:1', 'test:2', 'test:3']),
      over: {
        'test:1': { colorFamily: 'blue' },
        'test:2': { colorFamily: 'blue' },
        'test:3': { colorFamily: 'red' },
      },
    });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    const f = await fed.facets({ query: 'x', has_image: true, limit: 10 });
    expect(f.colorFamily).toContainEqual({ value: 'blue', count: 2 });
    expect(f.colorFamily).toContainEqual({ value: 'red', count: 1 });
  });
});

describe('createFederation colour backfill on cached records', () => {
  it('backfills colour onto an already-cached colourless record when an extractor is present', async () => {
    const t = fakeFetcher('test', { ids: ['test:1'], accept: new Set(['test:1']) });
    const { store, objects } = memoryCache();
    // a record cached before colour existed (pre-v0.8b row, or a sharp-less write)
    objects.set('test:1', makeArtwork('test:1'));
    const fed = createFederation({
      fetchers: { test: t.fetcher },
      cache: store,
      extractColor: async () => ({
        dominantColor: '#3a5f7d',
        palette: [{ hex: '#3a5f7d', weight: 1 }],
        colorFamily: 'blue',
        lab: { l: 40, a: -5, b: -20 },
      }),
    });
    const getRawSpy = vi.spyOn(t.fetcher, 'getRaw');

    const out = await fed.getArtwork('test:1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artwork.colorFamily).toBe('blue');
    // persisted back to the cache
    expect(objects.get('test:1')?.colorFamily).toBe('blue');
    // served from cache, not re-fetched upstream — only enriched
    expect(getRawSpy).not.toHaveBeenCalled();
  });

  it('does not re-enrich a cached record that already has colour', async () => {
    const { store, objects } = memoryCache();
    objects.set(
      'test:1',
      makeArtwork('test:1', {
        dominantColor: '#111111',
        colorFamily: 'black',
        palette: [{ hex: '#111111', weight: 1 }],
      }),
    );
    const extractColor = vi.fn(async () => {
      throw new Error('extractor must not be called for an already-coloured record');
    });
    const fed = createFederation({ fetchers: {}, cache: store, extractColor });

    const out = await fed.getArtwork('test:1');
    expect(out.ok).toBe(true);
    expect(extractColor).not.toHaveBeenCalled();
  });
});
