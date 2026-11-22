import type { Artwork } from '../types.js';

/** A value that may be returned synchronously or as a promise. */
export type Awaitable<T> = T | Promise<T>;

/** The adapter version a cached object was produced under (see `Fetcher.adapterVersion`). */
export interface ObjectVersion {
  adapterVersion?: number;
}

/**
 * The minimal cache surface the federation engine depends on. Two methods for
 * normalized objects, two for search-result ID lists.
 *
 * Implementations may be synchronous or asynchronous: the MCP server's
 * `node:sqlite` cache returns values directly, while an edge deployment
 * (e.g. Cloudflare KV) returns promises. The federation `await`s every call,
 * so both satisfy this interface.
 *
 * Expiry: an object's lifetime should be measured from its rights check
 * (`license.verifiedAt`), not from the last write. The engine writes a cached
 * object back when it enriches it on read (a colour backfill); such a write
 * carries the same `verifiedAt` and must not restart the object's lifetime. Keeping the surface this small is what lets
 * the same engine run on a stdio server and on a Workers runtime that cannot
 * load `node:sqlite`.
 */
export interface CacheStore {
  /**
   * `expect.adapterVersion`, when given, is the version of the adapter that would now produce this record: a row
   * stored under any other version is a miss. A store that does not track versions may ignore it.
   */
  getObject(id: string, expect?: ObjectVersion): Awaitable<Artwork | null>;
  /** `meta.adapterVersion` is the version of the adapter that produced `art`, stored with the row. */
  upsertObject(art: Artwork, meta?: ObjectVersion): Awaitable<void>;
  /**
   * When the object's row was written, as an ISO timestamp, or null when there is no row. Optional: a store that
   * cannot say leaves `freshness.cachedAt` out of what it serves.
   */
  getCachedAt?(id: string): Awaitable<string | null>;
  getQuery(cacheKey: string): Awaitable<string[] | null>;
  putQuery(cacheKey: string, ids: string[]): Awaitable<void>;
}
