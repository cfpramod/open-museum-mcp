import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFederation } from '../src/core/index.js';
import { Cache } from '../src/db.js';
import { pickDiscoverable } from '../src/discover.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';

// discover_random reads cached rows by SQL, which bypasses the adapter version and the rights bound. It must serve a
// work no differently from get_artwork: the pick goes through the same read path.

const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();

function artwork(id: string, verifiedDaysAgo: number, over: Partial<Artwork> = {}): Artwork {
  return {
    id,
    museum: { code: 'met', name: 'The Metropolitan Museum of Art', url: 'https://www.metmuseum.org' },
    title: 'Cached',
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
    license: { type: 'CC0', rawValue: 'x', verificationSource: 'test', verifiedAt: iso(verifiedDaysAgo), confidence: 'high' },
    citation: { full: 'x', caption: 'x', short: 'x' },
    ...over,
  } as unknown as Artwork;
}

function fetcherFor(live: 'accept' | 'reject' | 'throw', adapterVersion?: number): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher: Fetcher = {
    code: 'met',
    name: 'Met',
    async search() {
      return [];
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
      return { status: 'accepted', artwork: artwork(id, 0, { title: 'Re-verified' }) };
    },
    ...(adapterVersion !== undefined ? { adapterVersion } : {}),
  };
  return { fetcher, calls: () => calls };
}

describe('pickDiscoverable serves a work the way get_artwork does', () => {
  let dir: string;
  let cache: Cache;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omm-discover-'));
    cache = new Cache({ path: join(dir, 'cache.db') });
  });
  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a work inside the bound as it is cached, not marked', async () => {
    cache.upsertObject(artwork('met:1', 5));
    const s = fetcherFor('accept');
    const out = await pickDiscoverable({ cache, federation: createFederation({ fetchers: { met: s.fetcher }, cache }), lookup: {} });
    expect(out?.artwork.title).toBe('Cached');
    expect(out?.freshness.rightsStale).toBe(false);
    expect(s.calls()).toBe(0);
  });

  it('re-verifies a work past the rights bound before serving it', async () => {
    cache.upsertObject(artwork('met:1', 45));
    const s = fetcherFor('accept');
    const out = await pickDiscoverable({ cache, federation: createFederation({ fetchers: { met: s.fetcher }, cache }), lookup: {} });
    expect(out?.artwork.title).toBe('Re-verified');
    expect(out?.freshness.rightsStale).toBe(false);
    expect(s.calls()).toBe(1);
  });

  it('marks a work stale when its re-verification fails', async () => {
    cache.upsertObject(artwork('met:1', 45));
    const s = fetcherFor('throw');
    const out = await pickDiscoverable({ cache, federation: createFederation({ fetchers: { met: s.fetcher }, cache }), lookup: {} });
    expect(out?.artwork.title).toBe('Cached');
    expect(out?.freshness.rightsStale).toBe(true);
  });

  it('re-reads a work cached under an older adapter version', async () => {
    cache.upsertObject(artwork('met:1', 1, { title: 'Old logic', imageOpenAccess: false }), { adapterVersion: 1 });
    const s = fetcherFor('accept', 2);
    const out = await pickDiscoverable({ cache, federation: createFederation({ fetchers: { met: s.fetcher }, cache }), lookup: {} });
    expect(out?.artwork.title).toBe('Re-verified');
    expect(s.calls()).toBe(1);
  });

  it('never serves a work the gate now rejects, and skips it for another that is open', async () => {
    cache.upsertObject(artwork('met:1', 45, { title: 'Withdrawn' }));
    cache.upsertObject(artwork('met:2', 2, { title: 'Still open' }));
    const rejecting: Fetcher = {
      ...fetcherFor('accept').fetcher,
      async getRaw(id: string) { return { id }; },
      normalize(raw: unknown) {
        const id = (raw as { id: string }).id;
        return { status: 'rejected', rejection: { id, museumCode: 'met', reason: 'no longer open', rawSnapshot: raw } };
      },
    };
    for (let i = 0; i < 20; i += 1) {
      const out = await pickDiscoverable({ cache, federation: createFederation({ fetchers: { met: rejecting }, cache }), lookup: {} });
      expect(out?.artwork.id).toBe('met:2');
    }
  });

  it('returns null when every candidate is rejected', async () => {
    cache.upsertObject(artwork('met:1', 45));
    const s = fetcherFor('reject');
    const out = await pickDiscoverable({ cache, federation: createFederation({ fetchers: { met: s.fetcher }, cache }), lookup: {} });
    expect(out).toBe(null);
  });
});
