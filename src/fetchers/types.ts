import type { ValidationResult } from '../types.js';

export interface SearchOptions {
  hasImage?: boolean;
}

export interface Fetcher {
  code: string;
  name: string;
  search(query: string, limit: number, options?: SearchOptions): Promise<string[]>;
  getRaw(id: string): Promise<unknown>;
  normalize(raw: unknown): ValidationResult;
  /**
   * When true, the federation never reads or writes this source's full records to
   * the object cache — they are fetched live every time. Set for sources whose
   * terms forbid caching (e.g. Harvard Art Museums: no caching beyond two weeks).
   */
  noCache?: boolean;
  /**
   * When true, ALL image URLs from this fetcher are hotlink-restricted: they 403
   * (or serve a bot-challenge page) from server / cloud / CLI environments, and
   * also from a browser when embedded cross-origin (e.g. an `<img>` on another
   * site's page) — only a direct, same-origin visit to the source museum's own
   * page loads reliably. The federation sets
   * `imageUrls.hotlinkRestricted = true` centrally on every record from this
   * fetcher — no per-record logic needed in adapters. Adding a new blocking source
   * is a one-line change here; no normalize changes required.
   *
   * Confirmed blocking sources: AIC (Cloudflare WAF on iiif/2),
   * Walters (art.thewalters.org), Smithsonian (ids.si.edu).
   */
  hotlinkRestricted?: true;
  /**
   * Env var name a host must set to enable this source (e.g.
   * `'EUROPEANA_API_KEY'`). Unset for sources that need no key. Purely
   * descriptive — each adapter still reads its own env var itself (or via a
   * helper like `smithsonianApiKey()`); this field lets a caller (e.g. a
   * `/museums` page) describe the federation's coverage without hand-listing
   * it separately from the fetchers themselves.
   */
  requiresApiKey?: string;
  /**
   * True when this source has no live query API and instead serves a bundled,
   * build-time-ingested snapshot (e.g. Walters, NGA) rather than fetching per
   * query. Distinguishes FEDERATE from INGEST sources for anything describing
   * the federation's coverage.
   */
  ingestOnly?: true;
}
