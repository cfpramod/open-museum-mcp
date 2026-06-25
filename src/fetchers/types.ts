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
}
