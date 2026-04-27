/**
 * Shared coercion helpers for fetcher.normalize implementations.
 *
 * Each museum API ships fields that may be missing, null, or the wrong type.
 * House style (per CONTRIBUTING.md) is to type uncertain shapes as `unknown`
 * and narrow with explicit checks rather than casting with `as`. These
 * helpers express the most-common narrowings once.
 */

import type { ValidationResult } from '../types.js';

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

/**
 * True when `v` is a valid museum-side artwork ID: a positive integer.
 * Every adapter's `normalize()` makes this exact check before assembling
 * an `<museum>:<id>` string, so it lives here once.
 */
export function isValidPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Build a rejection `ValidationResult` with consistent shape across
 * fetchers. Replaces three identical 6-line factories that used to live
 * in cleveland / aic / wikimedia, plus inline rejection blocks in met.
 */
export function rejectFor(
  museumCode: string,
  id: string,
  reason: string,
  rawSnapshot: unknown,
): ValidationResult {
  return {
    status: 'rejected',
    rejection: { id, museumCode, reason, rawSnapshot },
  };
}
