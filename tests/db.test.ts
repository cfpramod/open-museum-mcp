import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cache } from '../src/db.js';
import type { Artwork } from '../src/types.js';

function makeArtwork(id: string): Artwork {
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
