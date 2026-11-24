import { describe, expect, it } from 'vitest';
import { createFederation, type CacheStore } from '../src/core/index.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';

// A cached record replays a rights check that may be old. The federation holds a bound (default 30 days) on how old
// that check may be when a record is served: past it, the record is re-verified live through the rights gate; if
// that fails, the cached record is still served but marked stale; if the gate now rejects it, it is not served.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const CACHED_AT = '2026-11-01T08:00:00.000Z';
const daysAgo = (d: number): string => new Date(NOW - d * DAY).toISOString();

function artwork(id: string, verifiedAt: string | undefined, over: Partial<Artwork> = {}): Artwork {
  const a = {
    id,
    museum: { code: 'met', name: 'The Metropolitan Museum of Art', url: 'https://www.metmuseum.org' },
    title: 'Test Work',
    artist: { name: 'Test Artist', attributionType: 'named' },
    displayDate: '1900',
    yearStart: 1900,
    yearEnd: 1900,
    medium: 'Oil on canvas',
    region: 'netherlands',
    period: null,
    imageUrls: { full: 'https://example.org/img.jpg' },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: { type: 'CC0', rawValue: 'x', verificationSource: 'test', ...(verifiedAt ? { verifiedAt } : {}), confidence: 'high' },
    citation: { full: 'x', caption: 'x', short: 'x' },
    ...over,
  };
  return a as unknown as Artwork;
}

function memoryStore(): { store: CacheStore; rows: Map<string, Artwork> } {
  const rows = new Map<string, Artwork>();
  const store: CacheStore = {
    getObject: (id: string) => rows.get(id) ?? null,
    upsertObject: (art: Artwork) => {
      rows.set(art.id, art);
    },
    getCachedAt: (id: string) => (rows.has(id) ? CACHED_AT : null),
    getQuery: () => null,
    putQuery: () => {},
  };
  return { store, rows };
}

type Live = 'accept' | 'reject' | 'throw';
function stubFetcher(live: Live, searchIds: string[] = []): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher: Fetcher = {
    code: 'met',
    name: 'Met',
    async search() {
      return searchIds;
    },
    async getRaw(id: string) {
      calls += 1;
      if (live === 'throw') throw new Error('upstream down');
      return { id };
    },
    normalize(raw: unknown) {
      const id = (raw as { id: string }).id;
      if (live === 'reject') {
        return { status: 'rejected', rejection: { id, museumCode: 'met', reason: 'met: no longer open', rawSnapshot: raw } };
      }
      return { status: 'accepted', artwork: artwork(id, new Date(NOW).toISOString(), { title: 'Re-verified' }) };
    },
  };
  return { fetcher, calls: () => calls };
}

const fed = (fetchers: Record<string, Fetcher>, store: CacheStore, extra: Record<string, unknown> = {}) =>
  createFederation({ fetchers, cache: store, clock: () => new Date(NOW).toISOString(), engineVersion: '9.9.9', ...extra });

describe('the rights bound on a cache hit', () => {
  it('serves a record whose rights check is inside the bound, from the cache, with its freshness', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(10), { title: 'Cached' }));
    const s = stubFetcher('accept');
    const out = await fed({ met: s.fetcher }, store).getArtwork('met:1');
    expect(out).toEqual({
      ok: true,
      artwork: expect.objectContaining({ title: 'Cached' }),
      freshness: {
        servedFrom: 'cache',
        cachedAt: CACHED_AT,
        rightsVerifiedAt: daysAgo(10),
        rightsAgeDays: 10,
        rightsStale: false,
        engineVersion: '9.9.9',
      },
    });
    expect(s.calls()).toBe(0);
  });

  it('treats exactly the bound as fresh and anything past it as stale', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(30)));
    rows.set('met:2', artwork('met:2', new Date(NOW - 30 * DAY - 1000).toISOString()));
    const s = stubFetcher('accept');
    const f = fed({ met: s.fetcher }, store);
    await f.getArtwork('met:1');
    expect(s.calls()).toBe(0);
    await f.getArtwork('met:2');
    expect(s.calls()).toBe(1);
  });

  it('re-verifies a stale record live through the gate, returns the fresh record as live, and stores it', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(45), { title: 'Cached' }));
    const s = stubFetcher('accept');
    const f = fed({ met: s.fetcher }, store);
    const out = await f.getArtwork('met:1');
    expect(out.ok && out.artwork.title).toBe('Re-verified');
    expect(out.ok && out.freshness).toEqual({
      servedFrom: 'live',
      rightsVerifiedAt: new Date(NOW).toISOString(),
      rightsAgeDays: 0,
      rightsStale: false,
      engineVersion: '9.9.9',
    });
    expect(s.calls()).toBe(1);
    expect(rows.get('met:1')?.title).toBe('Re-verified');
    await f.getArtwork('met:1'); // now inside the bound: served from the cache
    expect(s.calls()).toBe(1);
  });

  it('serves the cached record with rightsStale true when the re-verification fails', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(45), { title: 'Cached' }));
    const s = stubFetcher('throw');
    const out = await fed({ met: s.fetcher }, store).getArtwork('met:1');
    expect(out).toEqual({
      ok: true,
      artwork: expect.objectContaining({ title: 'Cached' }),
      freshness: {
        servedFrom: 'cache',
        cachedAt: CACHED_AT,
        rightsVerifiedAt: daysAgo(45),
        rightsAgeDays: 45,
        rightsStale: true,
        engineVersion: '9.9.9',
      },
    });
    expect(s.calls()).toBe(1);
  });

  it('does not serve a record the gate now rejects', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(45)));
    const s = stubFetcher('reject');
    const out = await fed({ met: s.fetcher }, store).getArtwork('met:1');
    expect(out).toEqual({ ok: false, reason: 'met: no longer open' });
  });

  it('treats a record with no usable verifiedAt as stale, and says so with nulls rather than invented values', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', undefined));
    rows.set('met:2', artwork('met:2', 'not a date'));
    const s = stubFetcher('throw');
    const f = fed({ met: s.fetcher }, store);
    const one = await f.getArtwork('met:1');
    const two = await f.getArtwork('met:2');
    // The first live attempt threw, so the source is backed off and the second read makes none (tests/rightsBackoff.test.ts).
    expect(s.calls()).toBe(1);
    expect(one.ok && one.freshness).toMatchObject({ rightsVerifiedAt: null, rightsAgeDays: null, rightsStale: true });
    expect(two.ok && two.freshness).toMatchObject({ rightsVerifiedAt: null, rightsAgeDays: null, rightsStale: true });
  });

  it('serves a stale record with rightsStale true when its fetcher is not registered (nothing to re-verify with)', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(45)));
    const out = await fed({}, store).getArtwork('met:1');
    expect(out.ok && out.freshness).toMatchObject({ servedFrom: 'cache', rightsStale: true });
  });

  it('leaves cachedAt out when the cache store cannot say when a row was written', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(10)));
    const noCachedAt: CacheStore = { ...store, getCachedAt: undefined };
    const out = await fed({ met: stubFetcher('accept').fetcher }, noCachedAt).getArtwork('met:1');
    expect(out.ok && 'cachedAt' in out.freshness).toBe(false);
  });

  it('reports the engine version it was created with', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(1)));
    const out = await fed({ met: stubFetcher('accept').fetcher }, store, { engineVersion: '1.2.3' }).getArtwork('met:1');
    expect(out.ok && out.freshness.engineVersion).toBe('1.2.3');
  });

  it('takes the bound from rightsMaxAgeDays, and refuses a bound that is not a positive finite number', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(45)));
    const s = stubFetcher('accept');
    await fed({ met: s.fetcher }, store, { rightsMaxAgeDays: 60 }).getArtwork('met:1');
    expect(s.calls()).toBe(0);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fed({ met: s.fetcher }, store, { rightsMaxAgeDays: bad })).toThrow(RangeError);
    }
  });
});

describe('the rights bound in search', () => {
  it('re-verifies stale hits, and gives every result its freshness, with the unverified ones marked stale', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(10)));
    rows.set('met:2', artwork('met:2', daysAgo(45)));
    const s = stubFetcher('throw', ['met:1', 'met:2']);
    const out = await fed({ met: s.fetcher }, store).search({ query: 'x', limit: 10 });
    expect(out.results.map((r) => r.id).sort()).toEqual(['met:1', 'met:2']);
    expect(Object.keys(out.freshness).sort()).toEqual(['met:1', 'met:2']);
    expect(out.freshness['met:1']).toMatchObject({ servedFrom: 'cache', rightsAgeDays: 10, rightsStale: false });
    expect(out.freshness['met:2']).toMatchObject({ servedFrom: 'cache', rightsAgeDays: 45, rightsStale: true });
  });

  it('marks a result re-verified for this search as live and not stale', async () => {
    const { store, rows } = memoryStore();
    rows.set('met:1', artwork('met:1', daysAgo(45)));
    const s = stubFetcher('accept', ['met:1']);
    const out = await fed({ met: s.fetcher }, store).search({ query: 'x', limit: 10 });
    expect(out.freshness['met:1']).toMatchObject({ servedFrom: 'live', rightsAgeDays: 0, rightsStale: false });
  });
});
