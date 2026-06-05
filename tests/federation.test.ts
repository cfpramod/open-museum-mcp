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

  it('reuses the cached id list on a second identical search (no second fetcher.search)', async () => {
    const t = fakeFetcher('test', { ids: ['test:1', 'test:2'], accept: new Set(['test:1', 'test:2']) });
    const { store } = memoryCache();
    const fed = createFederation({ fetchers: { test: t.fetcher }, cache: store });

    await fed.search({ query: 'x', has_image: true, limit: 1 });
    await fed.search({ query: 'x', has_image: true, limit: 1 });
    expect(t.searchCalls).toBe(1);
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
