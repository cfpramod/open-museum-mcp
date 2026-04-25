import type { ValidationResult } from '../types.js';

export interface Fetcher {
  code: string;
  name: string;
  search(query: string, limit: number): Promise<string[]>;
  getRaw(id: string): Promise<unknown>;
  normalize(raw: unknown): ValidationResult;
}
