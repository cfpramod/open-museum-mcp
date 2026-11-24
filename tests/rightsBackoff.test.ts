import { describe, expect, it } from 'vitest';
import { createFederation, type CacheStore } from '../src/core/index.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';

// When a live re-verification THROWS (source down, timeout), every read of a record past the rights bound used to
// retry the live fetch, timeout included. A short per-source backoff, held in memory, stops that: within it a
// past-bound read serves the cached record marked stale and makes no live attempt. A gate rejection is a real
// answer from the source, not a failure, and never starts a backoff.

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const START = Date.parse('2026-11-22T12:00:00.000Z');

function artwork(id: string, code: string, verifiedAt: string, title = 'Cached'): Artwork {
  return {
    id,
    museum: { code, name: code, url: 'https://example.org' },
    title,
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
    license: { type: 'CC0', rawValue: 'x', verificationSource: 'test', verifiedAt, confidence: 'high' },
    citation: { full: 'x', caption: 'x', short: 'x' },
  } as unknown as Artwork;
}

function setup(codes: string[]) {
  let now = START;
  const rows = new Map<string, Artwork>();
  let writeFails = false;
  const store: CacheStore = {
    getObject: (id: string) => rows.get(id) ?? null,
    upsertObject: (art: Artwork) => {
      if (writeFails) throw new Error('disk full');
      rows.set(art.id, art);
    },
    getCachedAt: (id: string) => (rows.has(id) ? '2026-11-01T08:00:00.000Z' : null),
    getQuery: () => null,
    putQuery: () => {},
  };
  const modes = new Map<string, 'accept' | 'throw' | 'reject'>(codes.map((c) => [c, 'throw']));
  const calls = new Map<string, number>(codes.map((c) => [c, 0]));
  const fetchers: Record<string, Fetcher> = {};
  for (const code of codes) {
    fetchers[code] = {
      code,
      name: code,
      async search() {
        return [];
      },
      async getRaw(id: string) {
        calls.set(code, (calls.get(code) ?? 0) + 1);
        if (modes.get(code) === 'throw') throw new Error('upstream down');
        return { id };
      },
      normalize(raw: unknown) {
        const id = (raw as { id: string }).id;
        if (modes.get(code) === 'reject') {
          return { status: 'rejected', rejection: { id, museumCode: code, reason: `${code}: no longer open`, rawSnapshot: raw } };
        }
        return { status: 'accepted', artwork: artwork(id, code, new Date(now).toISOString(), 'Re-verified') };
      },
    };
  }
  const federation = createFederation({
    fetchers,
    cache: store,
    clock: () => new Date(now).toISOString(),
    engineVersion: '9.9.9',
  });
  const stale = (id: string): void => {
    const code = id.slice(0, id.indexOf(':'));
    rows.set(id, artwork(id, code, new Date(now - 60 * DAY).toISOString()));
  };
  const fresh = (id: string): void => {
    const code = id.slice(0, id.indexOf(':'));
    rows.set(id, artwork(id, code, new Date(now - 2 * DAY).toISOString()));
  };
  return {
    federation,
    stale,
    fresh,
    calls: (code: string) => calls.get(code) ?? 0,
    mode: (code: string, m: 'accept' | 'throw' | 'reject') => modes.set(code, m),
    failWrites: (fail: boolean) => {
      writeFails = fail;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the re-verify failure backoff', () => {
  it('engages after one failed live re-verification: the next past-bound read makes no live attempt and is still stale', async () => {
    const t = setup(['met']);
    t.stale('met:1');
    t.stale('met:2');
    const first = await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(1);
    expect(first).toMatchObject({ ok: true, freshness: { servedFrom: 'cache', rightsStale: true } });

    // A different record of the same source, and the same record again: neither touches the network.
    const second = await t.federation.getArtwork('met:2');
    const again = await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(1);
    expect(second).toMatchObject({ ok: true, artwork: { title: 'Cached' }, freshness: { servedFrom: 'cache', rightsStale: true } });
    expect(again).toMatchObject({ ok: true, freshness: { rightsStale: true } });
  });

  it('does not start when the source answered but our cache write failed: a local fault is not a source failure', async () => {
    const t = setup(['met']);
    t.stale('met:1');
    t.stale('met:2');
    t.mode('met', 'accept');
    t.failWrites(true);
    const first = await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(1);
    // The fresh record could not be stored, so the cached one is served, marked stale, as on any failed re-verification.
    expect(first).toMatchObject({ ok: true, artwork: { title: 'Cached' }, freshness: { servedFrom: 'cache', rightsStale: true } });

    // The source is not backed off: the next past-bound read still goes live, and succeeds once writes work again.
    t.failWrites(false);
    const next = await t.federation.getArtwork('met:2');
    expect(t.calls('met')).toBe(2);
    expect(next).toMatchObject({ ok: true, artwork: { title: 'Re-verified' }, freshness: { servedFrom: 'live', rightsStale: false } });
  });

  it('is per source: a backed-off source does not stop another source being re-verified', async () => {
    const t = setup(['met', 'aic']);
    t.stale('met:1');
    t.stale('aic:1');
    t.mode('aic', 'accept');
    await t.federation.getArtwork('met:1'); // met fails: met is backed off
    const out = await t.federation.getArtwork('aic:1');
    expect(t.calls('aic')).toBe(1);
    expect(out).toMatchObject({ ok: true, artwork: { title: 'Re-verified' }, freshness: { servedFrom: 'live', rightsStale: false } });
  });

  it('does not start on a gate rejection: the source answered, so the next stale read still goes live', async () => {
    const t = setup(['met']);
    t.stale('met:1');
    t.stale('met:2');
    t.mode('met', 'reject');
    const rejected = await t.federation.getArtwork('met:1');
    expect(rejected).toMatchObject({ ok: false });
    t.mode('met', 'accept');
    const next = await t.federation.getArtwork('met:2');
    expect(t.calls('met')).toBe(2);
    expect(next).toMatchObject({ ok: true, freshness: { servedFrom: 'live', rightsStale: false } });
  });

  it('expires after 15 minutes: a live attempt happens again, and a success clears the backoff', async () => {
    const t = setup(['met']);
    t.stale('met:1');
    t.stale('met:2');
    await t.federation.getArtwork('met:1'); // fails at T0
    expect(t.calls('met')).toBe(1);

    t.advance(15 * MIN - 1); // still inside
    await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(1);

    t.advance(1); // exactly 15 minutes after the failure: expired
    t.mode('met', 'accept');
    const recovered = await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(2);
    expect(recovered).toMatchObject({ ok: true, freshness: { servedFrom: 'live', rightsStale: false } });

    // The success cleared it: the next stale record is re-verified at once (no second backoff left behind).
    const other = await t.federation.getArtwork('met:2');
    expect(t.calls('met')).toBe(3);
    expect(other).toMatchObject({ ok: true, freshness: { servedFrom: 'live' } });
  });

  it('starts a fresh 15 minutes when a live attempt after expiry fails again', async () => {
    const t = setup(['met']);
    t.stale('met:1');
    await t.federation.getArtwork('met:1');
    t.advance(15 * MIN);
    await t.federation.getArtwork('met:1'); // expired, fails again
    expect(t.calls('met')).toBe(2);
    t.advance(15 * MIN - 1);
    await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(2);
    t.advance(1);
    await t.federation.getArtwork('met:1');
    expect(t.calls('met')).toBe(3);
  });

  it('leaves a record inside the bound alone: it is served from the cache as fresh, backed off or not', async () => {
    const t = setup(['met']);
    t.stale('met:1');
    await t.federation.getArtwork('met:1'); // backs met off
    t.fresh('met:3');
    const out = await t.federation.getArtwork('met:3');
    expect(out).toMatchObject({ ok: true, freshness: { servedFrom: 'cache', rightsStale: false } });
    expect(t.calls('met')).toBe(1);
  });

  it('takes the backoff from rightsRetryBackoffMs, and refuses one that is not a positive finite number', async () => {
    let now = START;
    const rows = new Map<string, Artwork>();
    const store: CacheStore = {
      getObject: (id: string) => rows.get(id) ?? null,
      upsertObject: (a: Artwork) => void rows.set(a.id, a),
      getQuery: () => null,
      putQuery: () => {},
    };
    let calls = 0;
    const fetcher: Fetcher = {
      code: 'met',
      name: 'Met',
      async search() {
        return [];
      },
      async getRaw() {
        calls += 1;
        throw new Error('down');
      },
      normalize: () => {
        throw new Error('unreachable');
      },
    };
    const make = (rightsRetryBackoffMs: number) =>
      createFederation({ fetchers: { met: fetcher }, cache: store, clock: () => new Date(now).toISOString(), rightsRetryBackoffMs });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => make(bad)).toThrow(RangeError);
    }
    rows.set('met:1', artwork('met:1', 'met', new Date(now - 60 * DAY).toISOString()));
    const fed = make(1000);
    await fed.getArtwork('met:1');
    now += 999;
    await fed.getArtwork('met:1');
    expect(calls).toBe(1);
    now += 1;
    await fed.getArtwork('met:1');
    expect(calls).toBe(2);
  });
});
