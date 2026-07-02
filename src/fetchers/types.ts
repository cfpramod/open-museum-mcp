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
   * (or serve a bot-challenge page) from server / cloud / CLI environments and are
   * only reliably loadable in a browser. The federation sets
   * `imageUrls.hotlinkRestricted = true` centrally on every record from this
   * fetcher — no per-record logic needed in adapters. Adding a new blocking source
   * is a one-line change here; no normalize changes required.
   *
   * Confirmed blocking sources: AIC (Cloudflare WAF on iiif/2),
   * Walters (art.thewalters.org), Smithsonian (ids.si.edu).
   */
  hotlinkRestricted?: true;
}
