import { z } from 'zod';
import { cite as citeArtwork, type CiteStyle } from '../cite.js';
import { dedupeWikimediaUploads } from '../dedupe.js';
import type { Fetcher } from '../fetchers/types.js';
import { MEDIUM_CATEGORIES } from '../medium.js';
import {
  COLOR_FAMILY_NAMES,
  ciede2000,
  hexToLab,
  type ColorData,
} from '../color/colorMath.js';
import type { Artwork } from '../types.js';
import { filterByYearRange } from '../yearFilter.js';
import type { CacheStore } from './cache.js';
import { wrapTier0, type Tier0Envelope } from './clearance/envelope.js';
import { buildClearancePayload } from './clearance/manifest.js';

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

// Overfetch buffer: how many candidate IDs to pull per requested result before
// the rights gate and image filter thin them down. Bumped from 2x to 3x after
// the Met search stopped pre-filtering to public-domain upstream — more fetched
// records are now rejected by the gate post-fetch, so a larger candidate pool is
// needed to still fill a page. Applied only when has_image is set (the common
// path); the cache key carries the resolved overfetch count.
const OVERFETCH_FACTOR = 3;

// Facets aggregate over a much larger candidate window than a single search page,
// so the counts are trustworthy rather than a 10-record sample. 50 candidates ×
// OVERFETCH_FACTOR = up to ~150 fetched records per museum; fetch concurrency is
// capped at DEFAULT_FETCH_CONCURRENCY, so this stays gentle upstream. It is a
// bounded window, not the whole corpus — the facets tool description says so.
const FACET_SAMPLE_SIZE = 50;

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
  medium: z.enum(MEDIUM_CATEGORIES).optional(),
  /** Hex (`#rrggbb` or `rrggbb`). Ranks results by CIEDE2000 nearest to this colour. */
  color: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/)
    .optional(),
  /** Coarse colour-family filter (one of the controlled bins). */
  color_family: z.enum(COLOR_FAMILY_NAMES).optional(),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export interface SearchResult {
  count: number;
  results: Artwork[];
}

/** One facet value and how many records in the query set carry it. */
export interface FacetCount {
  value: string;
  count: number;
}

/**
 * Available facet values + counts for a query, aggregated over a BOUNDED window
 * of the accepted (rights-verified) candidate set — up to FACET_SAMPLE_SIZE ×
 * OVERFETCH_FACTOR records per museum, not the whole corpus. Counts reflect the
 * head of the result set, not exhaustive totals. Only values actually present in
 * that window appear, so a facet UI renders no empty buckets. Pure aggregation —
 * Workers-safe, no native deps.
 */
export interface FacetResult {
  /** Medium categories present, by count (descending). */
  medium: FacetCount[];
  /** Century buckets (e.g. "1800–1899"), chronological. */
  dateBucket: FacetCount[];
  /** Top-N named artists, by count (descending). Anonymous works are excluded. */
  artist: FacetCount[];
  /** Colour families present, by count (descending). Records without colour are skipped. */
  colorFamily: FacetCount[];
}

// Cap on the artist facet — a swatch/chip list, not the full long tail.
const TOP_ARTISTS = 10;

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
  /**
   * Engine version string stamped into a Clearance Manifest's
   * `verification.tool` provenance field. The host (MCP server) supplies its
   * real package version; defaults to a placeholder so the core stays usable
   * without one.
   */
  engineVersion?: string;
  /**
   * Clock for the generation timestamp used where no determination timestamp
   * exists in the data (the clearance deny path has no `license.verifiedAt`).
   * Injectable so emitted manifests are deterministic in tests and fixtures.
   */
  clock?: () => string;
  /**
   * Node-only colour-extraction capability. When provided, the federation runs
   * it on each accepted record (after the rights gate, before caching) and
   * stores the result's colour on the artwork. INJECTED, not built-in, so the
   * core never imports `sharp`: Workers and the `.mcpb` bundle pass nothing and
   * read precomputed colour only. It fails OPEN — a null result or a thrown
   * error leaves colour unset and the record valid (colour is an enrichment,
   * not a gate). The MCP server wires in `createColorExtractor()`.
   */
  extractColor?: (artwork: Artwork) => Promise<ColorData | null>;
}

export interface Federation {
  readonly fetchers: Record<string, Fetcher>;
  search(params: SearchParams): Promise<SearchResult>;
  /**
   * Available facet values + counts (medium, century date-buckets, top-N artist)
   * for a query, aggregated over a bounded window of the rights-verified
   * candidate set (see {@link FacetResult}). Workers-safe.
   */
  facets(params: SearchParams): Promise<FacetResult>;
  getArtwork(id: string): Promise<FetchOutcome>;
  cite(id: string, style: CiteStyle): Promise<CiteOutcome>;
  /**
   * Emit a portable, fail-closed Clearance Manifest (rights-clearance +
   * provenance + citation) for an artwork id, wrapped in a Tier-0 integrity
   * envelope. A non-cleared work — rejected by the rights gate, an unknown
   * museum, or an invalid id — returns a definitive *deny* manifest, never an
   * error: a deny is a valid answer.
   */
  clearanceManifest(id: string): Promise<Tier0Envelope>;
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
// That means limit:5 and limit:6 produce different keys (since 5*3=15 vs
// 6*3=18). The trade-off: more cache rows, but each row is guaranteed to
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

// Merge per-museum ID lists round-robin (museum 0's first, museum 1's first,
// ... then everyone's second, ...) so a federated search returns a museum MIX.
// `flat()` would concatenate the lists in fetcher order, letting whichever
// fetcher runs first (Met) fill the limited result page before the others are
// ever fetched — the cause of "search is Met-only" even when every museum
// returns matches. Each museum's own list stays in its relevance order; we just
// interleave across museums. Empty lists contribute nothing and are skipped.
function interleaveRoundRobin<T>(lists: T[][]): T[] {
  const merged: T[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      if (rank < list.length) merged.push(list[rank]);
    }
  }
  return merged;
}

// --- Facet aggregation (pure, Workers-safe) ---

function sortByCountThenName(a: FacetCount, b: FacetCount): number {
  return b.count - a.count || a.value.localeCompare(b.value);
}

function countMedium(arts: Artwork[]): FacetCount[] {
  const counts = new Map<string, number>();
  for (const a of arts) {
    const m = a.mediumCategory ?? 'other';
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort(sortByCountThenName);
}

// Bucket a signed year into its century. -500 -> -500 (the 500–401 BCE century).
function centuryStart(year: number): number {
  return Math.floor(year / 100) * 100;
}

function centuryLabel(start: number): string {
  const end = start + 99;
  // CE: "1800–1899". BCE: earlier year first, e.g. start -500 -> "500–401 BCE".
  return start >= 0 ? `${start}–${end}` : `${-start}–${-end} BCE`;
}

function countDateBuckets(arts: Artwork[]): FacetCount[] {
  const counts = new Map<number, number>();
  for (const a of arts) {
    if (a.yearStart === null || a.yearStart === undefined) continue;
    const start = centuryStart(a.yearStart);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => x[0] - y[0]) // chronological
    .map(([start, count]) => ({ value: centuryLabel(start), count }));
}

function countColorFamily(arts: Artwork[]): FacetCount[] {
  const counts = new Map<string, number>();
  for (const a of arts) {
    if (!a.colorFamily) continue; // colourless records (Workers / sharp-less) skipped
    counts.set(a.colorFamily, (counts.get(a.colorFamily) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort(sortByCountThenName);
}

function countArtists(arts: Artwork[]): FacetCount[] {
  const counts = new Map<string, number>();
  for (const a of arts) {
    // Anonymous works are not a usable artist filter value.
    if (a.artist.attributionType === 'anonymous') continue;
    const name = a.artist.name?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort(sortByCountThenName)
    .slice(0, TOP_ARTISTS);
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
  const engineVersion = opts.engineVersion ?? '0.0.0';
  const clock = opts.clock ?? (() => new Date().toISOString());
  const extractColor = opts.extractColor;

  async function getArtwork(id: string): Promise<FetchOutcome> {
    if (!ID_REGEX.test(id)) {
      return { ok: false, reason: `invalid artwork id: ${id}` };
    }

    const cached = await cache.getObject(id);
    if (cached) {
      // Backfill colour onto a record cached before it had any — a pre-v0.8b row
      // still within the 90-day TTL, or one written by a sharp-less/Workers
      // process. Without this, such rows would stay colourless until natural
      // expiry and silently under-return from colour search/facets.
      if (await enrichColor(cached)) await cache.upsertObject(cached);
      return { ok: true, artwork: cached };
    }

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

    await enrichColor(result.artwork);
    await cache.upsertObject(result.artwork);
    return { ok: true, artwork: result.artwork };
  }

  // Node-only colour enrichment. Runs the injected extractor on a record that has
  // no colour yet, mutating it in place. Returns true if colour was added (so the
  // caller can persist it). Fails open: a null result or a thrown error leaves
  // colour unset and the record valid. A no-op in Workers / the .mcpb bundle,
  // which inject no extractor, and for records that already carry colour.
  async function enrichColor(artwork: Artwork): Promise<boolean> {
    if (!extractColor || artwork.dominantColor !== undefined) return false;
    try {
      const color = await extractColor(artwork);
      if (!color) return false;
      artwork.dominantColor = color.dominantColor;
      artwork.palette = color.palette;
      artwork.colorFamily = color.colorFamily;
      return true;
    } catch {
      return false; // enrichment failure is non-fatal
    }
  }

  // Gather the accepted, image/dedup/year-filtered candidate set for a query.
  // Shared by search() (which then medium-filters + slices) and facets() (which
  // aggregates over it). Deliberately does NOT apply the medium filter or slice,
  // so the medium facet reflects every medium present in the query.
  async function gatherCandidates(params: SearchParams): Promise<Artwork[]> {
    const fetcherList = params.museum
      ? fetchers[params.museum]
        ? [fetchers[params.museum]]
        : []
      : Object.values(fetchers);
    if (fetcherList.length === 0) {
      throw new UnknownMuseumError(params.museum ?? '');
    }

    const overFetch = params.has_image ? params.limit * OVERFETCH_FACTOR : params.limit;
    const cacheKey = searchCacheKey(params.query, params.museum, params.has_image, overFetch);

    let allIds = await cache.getQuery(cacheKey);
    if (!allIds) {
      // A fetcher's search can throw (museum outage, rate limit, network). We
      // degrade gracefully — a throwing fetcher contributes no ids and the rest
      // of the federation still answers — but we must NOT cache a partial result:
      // `putQuery` has a 14-day TTL, so caching a list that's missing a museum's
      // contributions (or empty, if the only fetcher failed) would serve that
      // degraded result for two weeks. Track failures and skip the write when any
      // search threw, so the next call retries upstream.
      let anySearchFailed = false;
      const idLists = await Promise.all(
        fetcherList.map((f) =>
          f.search(params.query, overFetch, { hasImage: params.has_image }).catch(() => {
            anySearchFailed = true;
            return [] as string[];
          }),
        ),
      );
      allIds = interleaveRoundRobin(idLists);
      // A genuine empty result (every fetcher resolved with no matches) is still
      // cacheable; only an actual failure suppresses the write.
      if (!anySearchFailed) {
        await cache.putQuery(cacheKey, allIds);
      }
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
    return filterByYearRange(deduped, params.year_min, params.year_max);
  }

  async function search(params: SearchParams): Promise<SearchResult> {
    const dated = await gatherCandidates(params);
    // Medium is a post-fetch filter on the normalized category (like the year
    // filter), not an upstream search constraint. Because it runs over the
    // bounded overfetch window, a medium that is sparse in that window can leave
    // the page under `limit` — that is expected (we don't re-fetch to top up).
    // `?? 'other'` defends against any pre-v0.8a cached record predating the field.
    const byMedium = params.medium
      ? dated.filter((a) => (a.mediumCategory ?? 'other') === params.medium)
      : dated;

    // color_family is a post-fetch filter (like medium); a record without colour
    // (Workers / sharp-less enrichment) simply doesn't match.
    const byFamily = params.color_family
      ? byMedium.filter((a) => a.colorFamily === params.color_family)
      : byMedium;

    // `color` re-orders the survivors by CIEDE2000 nearness to the query colour.
    // Colourless records can't be ranked by colour, so they're dropped from a
    // colour-ranked search.
    let ordered = byFamily;
    if (params.color) {
      const queryLab = hexToLab(params.color);
      ordered = byFamily
        .filter((a): a is Artwork & { dominantColor: string } => Boolean(a.dominantColor))
        .map((a) => ({ a, d: ciede2000(queryLab, hexToLab(a.dominantColor)) }))
        .sort((x, y) => x.d - y.d)
        .map((x) => x.a);
    }

    const results = ordered.slice(0, params.limit);

    return { count: results.length, results };
  }

  async function facets(params: SearchParams): Promise<FacetResult> {
    // Override the caller's page `limit` with the larger facet sample window so
    // counts reflect a meaningful slice of the query, not one search page.
    const candidates = await gatherCandidates({ ...params, limit: FACET_SAMPLE_SIZE });
    return {
      medium: countMedium(candidates),
      dateBucket: countDateBuckets(candidates),
      artist: countArtists(candidates),
      colorFamily: countColorFamily(candidates),
    };
  }

  async function cite(id: string, style: CiteStyle): Promise<CiteOutcome> {
    const out = await getArtwork(id);
    if (!out.ok) return { ok: false, reason: out.reason };
    return { ok: true, citation: citeArtwork(out.artwork, style) };
  }

  async function clearanceManifest(
    id: string,
  ): Promise<Tier0Envelope> {
    const buildOpts = { engineVersion, now: clock() };
    const code = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';

    const deny = (reason: string) =>
      wrapTier0(
        buildClearancePayload(
          { status: 'rejected', rejection: { id, museumCode: code, reason, rawSnapshot: null } },
          buildOpts,
        ),
      );

    if (!ID_REGEX.test(id)) return deny(`invalid artwork id: ${id}`);

    const fetcher = fetchers[code];
    if (!fetcher) return deny(`unknown museum code: ${code}`);

    // Determinations are cheap and version-bound, so the manifest path does not
    // touch the object cache — it always reflects the current rights gate.
    const raw = await fetcher.getRaw(id);
    const result = fetcher.normalize(raw);
    if (result.status === 'rejected') onReject?.(id, result.rejection.reason);
    return wrapTier0(buildClearancePayload(result, buildOpts));
  }

  return { fetchers, search, facets, getArtwork, cite, clearanceManifest };
}
