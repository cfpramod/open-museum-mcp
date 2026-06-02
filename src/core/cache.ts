import type { Artwork } from '../types.js';

/** A value that may be returned synchronously or as a promise. */
export type Awaitable<T> = T | Promise<T>;

/**
 * The minimal cache surface the federation engine depends on. Two methods for
 * normalized objects, two for search-result ID lists.
 *
 * Implementations may be synchronous or asynchronous: the MCP server's
 * `node:sqlite` cache returns values directly, while an edge deployment
 * (e.g. Cloudflare KV) returns promises. The federation `await`s every call,
 * so both satisfy this interface. Keeping the surface this small is what lets
 * the same engine run on a stdio server and on a Workers runtime that cannot
 * load `node:sqlite`.
 */
export interface CacheStore {
  getObject(id: string): Awaitable<Artwork | null>;
  upsertObject(art: Artwork): Awaitable<void>;
  getQuery(cacheKey: string): Awaitable<string[] | null>;
  putQuery(cacheKey: string, ids: string[]): Awaitable<void>;
}
