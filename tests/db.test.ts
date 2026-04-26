import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cache } from '../src/db.js';
import type { Artwork } from '../src/types.js';

const MUSEUMS: Record<string, { code: string; name: string; url: string }> = {
  met: { code: 'met', name: 'The Metropolitan Museum of Art', url: 'https://www.metmuseum.org' },
  cleveland: { code: 'cleveland', name: 'Cleveland Museum of Art', url: 'https://www.clevelandart.org' },
  aic: { code: 'aic', name: 'Art Institute of Chicago', url: 'https://www.artic.edu' },
};

function makeArtwork(id: string, overrides: Partial<Artwork> = {}): Artwork {
  const code = id.split(':')[0];
  return {
    id,
    museum: MUSEUMS[code] ?? MUSEUMS.met,
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
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: 'met.isPublicDomain',
      verifiedAt: '2026-04-25T00:00:00Z',
      confidence: 'high',
    },
    source: { apiUrl: 'https://example.org/api', pageUrl: 'https://example.org/page' },
    ...overrides,
  };
}

describe('Cache', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'open-museum-mcp-cache-'));
    path = join(dir, 'cache.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an artwork through upsert/get', () => {
    const cache = new Cache({ path });
    const art = makeArtwork('met:1');
    cache.upsertObject(art);
    expect(cache.getObject('met:1')).toEqual(art);
    cache.close();
  });

  it('returns null for an unknown id', () => {
    const cache = new Cache({ path });
    expect(cache.getObject('met:999')).toBe(null);
    cache.close();
  });

  it('overwrites on conflict', () => {
    const cache = new Cache({ path });
    const a1 = makeArtwork('met:1');
    cache.upsertObject(a1);
    const a2 = { ...a1, title: 'New Title' };
    cache.upsertObject(a2);
    expect(cache.getObject('met:1')?.title).toBe('New Title');
    cache.close();
  });

  it('treats expired object rows as cache misses', () => {
    const cache = new Cache({ path });
    cache.upsertObject(makeArtwork('met:1'));
    cache.close();

    // Directly age the row past the 90-day TTL.
    const db = new Database(path);
    const longAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE objects SET cached_at = ? WHERE id = ?').run(longAgo, 'met:1');
    db.close();

    const cache2 = new Cache({ path });
    // pruneExpired (run in constructor) removes the row entirely.
    expect(cache2.getObject('met:1')).toBe(null);
    cache2.close();
  });

  it('round-trips query cache and respects TTL', () => {
    const cache = new Cache({ path });
    cache.putQuery('q:foo', ['met:1', 'met:2']);
    expect(cache.getQuery('q:foo')).toEqual(['met:1', 'met:2']);
    cache.close();

    const db = new Database(path);
    const longAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE query_cache SET cached_at = ? WHERE cache_key = ?').run(longAgo, 'q:foo');
    db.close();

    const cache2 = new Cache({ path });
    expect(cache2.getQuery('q:foo')).toBe(null);
    cache2.close();
  });

  it('treats malformed JSON as a cache miss instead of throwing', () => {
    const cache = new Cache({ path });
    cache.upsertObject(makeArtwork('met:1'));
    cache.close();

    const db = new Database(path);
    db.prepare('UPDATE objects SET full_record = ? WHERE id = ?').run('{not json', 'met:1');
    db.close();

    const cache2 = new Cache({ path });
    expect(cache2.getObject('met:1')).toBe(null);
    cache2.close();
  });

  it('pruneExpired returns counts and clears stale rows', () => {
    const cache = new Cache({ path });
    cache.upsertObject(makeArtwork('met:1'));
    cache.upsertObject(makeArtwork('met:2'));
    cache.putQuery('q:a', ['met:1']);
    cache.close();

    const db = new Database(path);
    const longAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE objects SET cached_at = ? WHERE id = ?').run(longAgo, 'met:1');
    db.prepare('UPDATE query_cache SET cached_at = ?').run(longAgo);
    db.close();

    // Re-open: pruneExpired runs in the constructor.
    const cache2 = new Cache({ path });
    expect(cache2.getObject('met:1')).toBe(null);
    expect(cache2.getObject('met:2')).not.toBe(null);
    expect(cache2.getQuery('q:a')).toBe(null);
    // Calling prune again on a clean DB returns zero counts.
    expect(cache2.pruneExpired()).toEqual({ objects: 0, queries: 0 });
    cache2.close();
  });

  it('creates the cache file with mode 0o600', () => {
    const cache = new Cache({ path });
    cache.upsertObject(makeArtwork('met:1'));
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    cache.close();
  });
});

describe('Cache.getRandomObject', () => {
  let dir: string;
  let path: string;
  let cache: Cache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'open-museum-mcp-cache-'));
    path = join(dir, 'cache.db');
    cache = new Cache({ path });

    cache.upsertObject(
      makeArtwork('met:1', {
        region: 'china',
        period: 'tang dynasty',
        artist: { name: 'Anonymous', attributionType: 'anonymous' },
      }),
    );
    cache.upsertObject(
      makeArtwork('met:2', {
        region: 'japan',
        period: 'edo',
        artist: { name: 'Hokusai', attributionType: 'named' },
      }),
    );
    cache.upsertObject(
      makeArtwork('cleveland:3', {
        region: 'netherlands',
        period: null,
        artist: { name: 'Vincent van Gogh', attributionType: 'named' },
      }),
    );
    cache.upsertObject(
      makeArtwork('cleveland:4', {
        region: 'iran',
        period: 'safavid',
        artist: { name: 'Anonymous', attributionType: 'anonymous' },
      }),
    );
    cache.upsertObject(
      makeArtwork('aic:5', {
        region: 'france',
        period: null,
        artist: { name: 'Claude Monet', attributionType: 'named' },
      }),
    );
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('filters by region', () => {
    const result = cache.getRandomObject({ region: 'japan' });
    expect(result?.region).toBe('japan');
    expect(result?.id).toBe('met:2');
  });

  it('filters by period', () => {
    const result = cache.getRandomObject({ period: 'tang dynasty' });
    expect(result?.period).toBe('tang dynasty');
    expect(result?.id).toBe('met:1');
  });

  it('filters by museum code', () => {
    for (let i = 0; i < 10; i++) {
      const result = cache.getRandomObject({ museumCode: 'cleveland' });
      expect(result?.museum.code).toBe('cleveland');
    }
  });

  it('combines multiple constraints (AND)', () => {
    const result = cache.getRandomObject({ region: 'iran', period: 'safavid' });
    expect(result?.id).toBe('cleveland:4');
  });

  it('excludes artists in notArtist list', () => {
    for (let i = 0; i < 30; i++) {
      const result = cache.getRandomObject({ notArtist: ['Vincent van Gogh', 'Claude Monet'] });
      if (result) {
        expect(result.artist.name).not.toBe('Vincent van Gogh');
        expect(result.artist.name).not.toBe('Claude Monet');
      }
    }
  });

  it('returns null when no records match', () => {
    expect(cache.getRandomObject({ region: 'oceania' })).toBe(null);
    expect(cache.getRandomObject({ period: 'jomon' })).toBe(null);
    expect(cache.getRandomObject({ region: 'china', period: 'edo' })).toBe(null);
  });

  it('skips expired rows', () => {
    cache.close();
    const db = new Database(path);
    const longAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE objects SET cached_at = ?').run(longAgo);
    db.close();
    // Re-open: pruneExpired runs at construction, removing the rows.
    cache = new Cache({ path });
    expect(cache.getRandomObject({})).toBe(null);
  });

  it('returns randomized results across queries (statistical)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = cache.getRandomObject({});
      if (result) seen.add(result.id);
    }
    // With 5 records seeded, we should hit at least 2 distinct IDs over 100
    // pulls (the chance of single-ID outcome under uniform random is < 1e-69).
    expect(seen.size).toBeGreaterThan(1);
  });

  it('matches no rows when notArtist excludes everything', () => {
    const result = cache.getRandomObject({
      notArtist: ['Anonymous', 'Hokusai', 'Vincent van Gogh', 'Claude Monet'],
    });
    expect(result).toBe(null);
  });

  it('treats an empty notArtist array as no exclusion', () => {
    // Locks down the `notArtist.length > 0` guard. With an empty list and no
    // other filters, every cached record remains a candidate.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = cache.getRandomObject({ notArtist: [] });
      if (result) seen.add(result.id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
