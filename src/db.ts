import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Artwork } from './types.js';

const OBJECT_TTL_DAYS = 90;
const QUERY_TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CacheConfig {
  path: string;
}

/**
 * SQLite-backed cache for normalized artworks and search-result IDs.
 *
 * TTL contract:
 *   - `objects` rows live for {@link OBJECT_TTL_DAYS} days. Artworks don't
 *     change once accessioned, so the long TTL keeps cold-cache HTTP cost low.
 *   - `query_cache` rows live for {@link QUERY_TTL_DAYS} days. Museums add
 *     new open-access objects regularly, so queries refresh on a shorter cycle.
 *
 * Stale rows are pruned on construction (cheap bulk DELETE) so a long-lived
 * client doesn't accumulate dead rows indefinitely. Reads also treat expired
 * rows as misses; the next write overwrites the row via ON CONFLICT.
 *
 * The DB file is created with mode 0o600. Parameterized statements only —
 * no string-concatenated SQL paths.
 */
export class Cache {
  private db: Database.Database;

  constructor(config: CacheConfig) {
    if (!existsSync(dirname(config.path))) {
      mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
    }
    const fileExisted = existsSync(config.path);
    this.db = new Database(config.path);
    if (!fileExisted) {
      // Tighten file mode immediately on creation so the cache (which can
      // include rights metadata, snapshots of museum responses, etc.) isn't
      // group/world-readable under loose umasks.
      try {
        chmodSync(config.path, 0o600);
      } catch {
        // Best-effort; non-fatal on filesystems that don't support chmod.
      }
    }
    this.db.pragma('journal_mode = WAL');
    this.init();
    this.pruneExpired();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        museum_code TEXT NOT NULL,
        title TEXT NOT NULL,
        artist_name TEXT,
        attribution_type TEXT NOT NULL,
        display_date TEXT,
        year_start INTEGER,
        year_end INTEGER,
        medium TEXT,
        region TEXT,
        period TEXT,
        license_type TEXT NOT NULL,
        full_record TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_objects_year_start ON objects(year_start);
      CREATE INDEX IF NOT EXISTS idx_objects_year_end ON objects(year_end);
      CREATE INDEX IF NOT EXISTS idx_objects_region ON objects(region);
      CREATE INDEX IF NOT EXISTS idx_objects_period ON objects(period);
      CREATE INDEX IF NOT EXISTS idx_objects_artist ON objects(artist_name);
      CREATE INDEX IF NOT EXISTS idx_objects_museum ON objects(museum_code);

      CREATE TABLE IF NOT EXISTS query_cache (
        cache_key TEXT PRIMARY KEY,
        ids_json TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );

      -- Forward-compat scaffold for v1.0 artist obscurity scoring across the
      -- federated corpus. Not yet populated; do not depend on these columns.
      CREATE TABLE IF NOT EXISTS artists (
        name TEXT PRIMARY KEY,
        object_count INTEGER NOT NULL DEFAULT 0,
        museum_count INTEGER NOT NULL DEFAULT 0,
        museums_json TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  upsertObject(art: Artwork): void {
    const stmt = this.db.prepare(`
      INSERT INTO objects (
        id, museum_code, title, artist_name, attribution_type,
        display_date, year_start, year_end, medium, region, period,
        license_type, full_record, cached_at
      ) VALUES (
        @id, @museum_code, @title, @artist_name, @attribution_type,
        @display_date, @year_start, @year_end, @medium, @region, @period,
        @license_type, @full_record, @cached_at
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist_name = excluded.artist_name,
        attribution_type = excluded.attribution_type,
        display_date = excluded.display_date,
        year_start = excluded.year_start,
        year_end = excluded.year_end,
        medium = excluded.medium,
        region = excluded.region,
        period = excluded.period,
        license_type = excluded.license_type,
        full_record = excluded.full_record,
        cached_at = excluded.cached_at
    `);

    stmt.run({
      id: art.id,
      museum_code: art.museum.code,
      title: art.title,
      artist_name: art.artist.name,
      attribution_type: art.artist.attributionType,
      display_date: art.displayDate,
      year_start: art.yearStart,
      year_end: art.yearEnd,
      medium: art.medium,
      region: art.region,
      period: art.period,
      license_type: art.license.type,
      full_record: JSON.stringify(art),
      cached_at: new Date().toISOString(),
    });
  }

  getObject(id: string): Artwork | null {
    const row = this.db.prepare(`SELECT full_record, cached_at FROM objects WHERE id = ?`).get(id) as
      | { full_record: string; cached_at: string }
      | undefined;
    if (!row) return null;
    if (this.isExpired(row.cached_at, OBJECT_TTL_DAYS)) return null;
    try {
      return JSON.parse(row.full_record) as Artwork;
    } catch {
      // A malformed row (manual DB tinkering, OS-level corruption, schema
      // drift from a prior version) shouldn't poison the request — treat it
      // as a cache miss; the next write will overwrite the row.
      return null;
    }
  }

  putQuery(cacheKey: string, ids: string[]): void {
    this.db
      .prepare(
        `INSERT INTO query_cache (cache_key, ids_json, cached_at)
         VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET ids_json = excluded.ids_json, cached_at = excluded.cached_at`,
      )
      .run(cacheKey, JSON.stringify(ids), new Date().toISOString());
  }

  getQuery(cacheKey: string): string[] | null {
    const row = this.db.prepare(`SELECT ids_json, cached_at FROM query_cache WHERE cache_key = ?`).get(cacheKey) as
      | { ids_json: string; cached_at: string }
      | undefined;
    if (!row) return null;
    if (this.isExpired(row.cached_at, QUERY_TTL_DAYS)) return null;
    try {
      return JSON.parse(row.ids_json) as string[];
    } catch {
      return null;
    }
  }

  pruneExpired(): { objects: number; queries: number } {
    const objectsCutoff = new Date(Date.now() - OBJECT_TTL_DAYS * MS_PER_DAY).toISOString();
    const queriesCutoff = new Date(Date.now() - QUERY_TTL_DAYS * MS_PER_DAY).toISOString();
    const objects = this.db.prepare(`DELETE FROM objects WHERE cached_at < ?`).run(objectsCutoff);
    const queries = this.db.prepare(`DELETE FROM query_cache WHERE cached_at < ?`).run(queriesCutoff);
    return { objects: objects.changes, queries: queries.changes };
  }

  private isExpired(isoTimestamp: string, ttlDays: number): boolean {
    const cachedAt = new Date(isoTimestamp).getTime();
    const expiresAt = cachedAt + ttlDays * MS_PER_DAY;
    return Date.now() > expiresAt;
  }

  close(): void {
    this.db.close();
  }
}
