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
}
