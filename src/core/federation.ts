import { z } from 'zod';
import { cite as citeArtwork, type CiteStyle } from '../cite.js';
import { dedupeWikimediaUploads } from '../dedupe.js';
import type { Fetcher } from '../fetchers/types.js';
import type { Artwork } from '../types.js';
import { filterByYearRange } from '../yearFilter.js';
import type { CacheStore } from './cache.js';

// Museum IDs follow `<code>:<segment>(/<segment>)*`. Each segment is
// alphanumeric, underscore, or hyphen. The four numeric-ID museums (Met,
// Cleveland, AIC, Wikimedia) match a single all-digit segment; Europeana's
// hierarchical IDs (`9200338/BibliographicResource_3000093834108`) match
// multiple slash-separated segments. The negative lookahead blocks `..`
// path-traversal attempts cleanly.
export const ID_REGEX = /^[a-z]+:(?!.*\.\.)[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

// Cap concurrent fetches to one museum's API. The Met has no batch endpoint,
// so a search of limit 50 fans out into up to 50 object fetches; without a
// cap, we'd hammer the upstream and risk rate-limit errors. 8 is empirically
// gentle and keeps wall-clock time within the same order of magnitude.
const DEFAULT_FETCH_CONCURRENCY = 8;

/**
 * Parsed parameters for a federation search. Shared by every front door (MCP
 * tool, HTTP endpoint) so validation lives in one place. The date bounds gate
 * the *result set*, not the upstream search call — each museum's free-text
 * search runs unchanged, and records whose [yearStart, yearEnd] fall outside
 * the window are dropped after the fact. BCE is a negative integer.
 */
export const SearchParamsSchema = z.object({
  query: z.string().min(1),
  museum: z.string().optional(),
  has_image: z.boolean().default(true),
  limit: z.number().int().min(1).max(50).default(10),
  year_min: z.number().int().optional(),
  year_max: z.number().int().optional(),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export interface SearchResult {
  count: number;
  results: Artwork[];
}

export type FetchOutcome =
  | { ok: true; artwork: Artwork }
  | { ok: false; reason: string };

export type CiteOutcome =
  | { ok: true; citation: string }
  | { ok: false; reason: string };

/**
 * Thrown when a search or lookup names a museum code that is not in the
 * registry. Hosts catch this to render their own error shape (MCP error
 * result, HTTP 400, etc.) rather than leaking an empty result set.
 */
export class UnknownMuseumError extends Error {
  constructor(public readonly museum: string) {
    super(`unknown museum: ${museum}`);
    this.name = 'UnknownMuseumError';
  }
}

export interface FederationOptions {
  fetchers: Record<string, Fetcher>;
  cache: CacheStore;
  /** Override the per-museum fetch concurrency cap (default 8). */
  concurrency?: number;
  /**
   * Invoked when a fetched record is rejected by its rights gate. Rejections
   * are expected — strict-default-deny is the project's spine — so this is a
   * diagnostic hook, not an error path. The MCP server logs to stderr here.
   */
  onReject?: (id: string, reason: string) => void;
}

export interface Federation {
  readonly fetchers: Record<string, Fetcher>;
  search(params: SearchParams): Promise<SearchResult>;
  getArtwork(id: string): Promise<FetchOutcome>;
  cite(id: string, style: CiteStyle): Promise<CiteOutcome>;
}

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

// The cache key includes the overfetch count, not the user-facing `limit`.
// That means limit:5 and limit:6 produce different keys (since 5*2=10 vs
// 6*2=12). The trade-off: more cache rows, but each row is guaranteed to
// hold enough IDs to satisfy a request at its overfetch tier even after
// rights-gate rejections. Bucketing would need explicit refill logic.
function searchCacheKey(
  query: string,
  museum: string | undefined,
  hasImage: boolean,
  overFetch: number,
): string {
  return JSON.stringify({ q: query, m: museum ?? '*', hi: hasImage, of: overFetch });
}

/**
 * Build a federation over a set of museum fetchers and a cache. This is the
 * shared engine behind every front door: the MCP server wraps it for stdio
 * JSON-RPC; an HTTP service wraps it for the web. All rights-gate enforcement
 * lives in `fetcher.normalize`, so a rejected record never reaches the cache
 * or a caller — regardless of which front door asked.
 */
export function createFederation(opts: FederationOptions): Federation {
  const { fetchers, cache } = opts;
  const concurrency = opts.concurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const onReject = opts.onReject;

  async function getArtwork(id: string): Promise<FetchOutcome> {
    if (!ID_REGEX.test(id)) {
      return { ok: false, reason: `invalid artwork id: ${id}` };
    }

    const cached = await cache.getObject(id);
    if (cached) return { ok: true, artwork: cached };

    // ID_REGEX guarantees a non-empty `[a-z]+` segment before ':'.
    const code = id.slice(0, id.indexOf(':'));
    const fetcher = fetchers[code];
    if (!fetcher) return { ok: false, reason: `unknown museum code: ${code}` };

    const raw = await fetcher.getRaw(id);
    const result = fetcher.normalize(raw);
    if (result.status === 'rejected') {
      onReject?.(id, result.rejection.reason);
      return { ok: false, reason: result.rejection.reason };
    }

    await cache.upsertObject(result.artwork);
    return { ok: true, artwork: result.artwork };
  }

  async function search(params: SearchParams): Promise<SearchResult> {
    const fetcherList = params.museum
      ? fetchers[params.museum]
        ? [fetchers[params.museum]]
        : []
      : Object.values(fetchers);
    if (fetcherList.length === 0) {
      throw new UnknownMuseumError(params.museum ?? '');
    }

    const overFetch = params.has_image ? params.limit * 2 : params.limit;
    const cacheKey = searchCacheKey(params.query, params.museum, params.has_image, overFetch);

    let allIds = await cache.getQuery(cacheKey);
    if (!allIds) {
      const idLists = await Promise.all(
        fetcherList.map((f) =>
          f.search(params.query, overFetch, { hasImage: params.has_image }).catch(() => [] as string[]),
        ),
      );
      allIds = idLists.flat();
      await cache.putQuery(cacheKey, allIds);
    }

    const fetched = await withConcurrency(allIds, concurrency, (id) =>
      getArtwork(id).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : 'fetch failed',
      })),
    );
    const accepted: Artwork[] = fetched
      .filter((r): r is { ok: true; artwork: Artwork } => r.ok)
      .map((r) => r.artwork);
    const filtered = accepted.filter((a) => !params.has_image || Boolean(a.imageUrls.full));
    const deduped = dedupeWikimediaUploads(filtered);
    const dated = filterByYearRange(deduped, params.year_min, params.year_max);
    const results = dated.slice(0, params.limit);

    return { count: results.length, results };
  }

  async function cite(id: string, style: CiteStyle): Promise<CiteOutcome> {
    const out = await getArtwork(id);
    if (!out.ok) return { ok: false, reason: out.reason };
    return { ok: true, citation: citeArtwork(out.artwork, style) };
  }

  return { fetchers, search, getArtwork, cite };
}
