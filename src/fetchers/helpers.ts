/**
 * Shared coercion helpers for fetcher.normalize implementations.
 *
 * Each museum API ships fields that may be missing, null, or the wrong type.
 * House style (per CONTRIBUTING.md) is to type uncertain shapes as `unknown`
 * and narrow with explicit checks rather than casting with `as`. These
 * helpers express the most-common narrowings once.
 */

/** Returns the string value, or "" for any non-string input. */
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Returns the trimmed-truthy string, or undefined for missing/empty/non-string. */
export function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Returns finite number, or null for NaN/Infinity/non-number. */
export function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
