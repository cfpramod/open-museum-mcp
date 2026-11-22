import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFederation } from '../src/core/index.js';
import { Cache } from '../src/db.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';

// A fix to an adapter's rights logic (a source flag read wrongly) does not reach rows already cached: they replay
// the old answer until their 90 days end. A fetcher that declares an adapterVersion evicts the rows stored under
// any other version, once, so the fix reaches them on the next read.

function artwork(id: string, imageOpenAccess: boolean): Artwork {
  return {
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
    imageUrls: { full: imageOpenAccess ? 'https://example.org/img.jpg' : '' },
    imageOpenAccess,
    metadataOpenAccess: true,
    license: { type: 'CC0', rawValue: 'x', verificationSource: 'test', verifiedAt: new Date().toISOString(), confidence: 'high' },
    citation: { full: 'x', caption: 'x', short: 'x' },
  } as unknown as Artwork;
}

function stubFetcher(adapterVersion: number | undefined): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher: Fetcher = {
    code: 'met',
    name: 'Met',
    async search() {
      return [];
    },
    async getRaw(id: string) {
      calls += 1;
      return { id };
    },
    normalize(raw: unknown) {
      return { status: 'accepted', artwork: artwork((raw as { id: string }).id, true) };
    },
    ...(adapterVersion !== undefined ? { adapterVersion } : {}),
  };
  return { fetcher, calls: () => calls };
}

describe('a fetcher adapterVersion evicts rows cached under another version', () => {
  let dir: string;
  let cache: Cache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omm-adapter-version-'));
    cache = new Cache({ path: join(dir, 'cache.db') });
  });
  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-reads a row cached before the fix, and the read replaces it with the corrected record', async () => {
    cache.upsertObject(artwork('met:1', false)); // cached before the fix: image reported closed
    const { fetcher, calls } = stubFetcher(2);
    const fed = createFederation({ fetchers: { met: fetcher }, cache });

    const out = await fed.getArtwork('met:1');
    expect(out.ok && out.artwork.imageOpenAccess).toBe(true);
    expect(calls()).toBe(1);

    const again = await fed.getArtwork('met:1'); // now served from the cache, written under version 2
    expect(again.ok && again.artwork.imageOpenAccess).toBe(true);
    expect(calls()).toBe(1);
  });

  it('serves a row cached under the current version without a fetch', async () => {
    cache.upsertObject(artwork('met:1', true), { adapterVersion: 2 });
    const { fetcher, calls } = stubFetcher(2);
    const fed = createFederation({ fetchers: { met: fetcher }, cache });
    const out = await fed.getArtwork('met:1');
    expect(out.ok).toBe(true);
    expect(calls()).toBe(0);
  });

  it('never evicts for a fetcher that declares no version', async () => {
    cache.upsertObject(artwork('met:1', false));
    const { fetcher, calls } = stubFetcher(undefined);
    const fed = createFederation({ fetchers: { met: fetcher }, cache });
    const out = await fed.getArtwork('met:1');
    expect(out.ok && out.artwork.imageOpenAccess).toBe(false); // the cached answer, as before
    expect(calls()).toBe(0);
  });
});
