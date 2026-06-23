/**
 * Shared coercion helpers for fetcher.normalize implementations.
 *
 * Each museum API ships fields that may be missing, null, or the wrong type.
 * House style (per CONTRIBUTING.md) is to type uncertain shapes as `unknown`
 * and narrow with explicit checks rather than casting with `as`. These
 * helpers express the most-common narrowings once.
 */

import type { ValidationResult } from '../types.js';

/**
 * Descriptive User-Agent for all outbound museum-API requests.
 *
 * Wikimedia's User-Agent policy MANDATES a descriptive UA with a contact URL;
 * requests without one are answered with HTTP 403 — and that block bites hardest
 * from shared datacenter IPs (e.g. a Cloudflare Worker), where an empty/default
 * UA looks like an anonymous bot. AIC and Cleveland are likewise unreliable from
 * those IP ranges without a UA. Sending a stable, contactable identifier is the
 * polite-and-required fix. See https://meta.wikimedia.org/wiki/User-Agent_policy
 */
export const USER_AGENT =
  'open-museum-mcp (+https://open-museum.art; +https://github.com/cfpramod/open-museum-mcp)';

/**
 * `fetch` wrapper that attaches the descriptive {@link USER_AGENT} to every
 * outbound museum-API request, while letting any caller-supplied header win.
 *
 * It deliberately calls the GLOBAL `fetch` (not a captured reference) so test
 * suites that stub `globalThis.fetch` still intercept these requests.
 */
export function httpGet(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  // Caller-supplied headers win: only set our UA if none was provided.
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', USER_AGENT);
  }
  return fetch(url, { ...init, headers });
}

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
 * Coerce a number OR a numeric string to a finite number, else null. Cleveland
 * publishes image `width`/`height`/`filesize` as strings ("11966"); this accepts
 * both shapes without the caller string-juggling at every field.
 */
export function coerceFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pick the TRUE-maximum pixel dimensions from a set of candidate image variants
 * (displayable derivative, archival master, mirror impressions). Ranks by pixel
 * AREA so a portrait master out-scores a wider-but-shorter derivative. Candidates
 * missing either dimension are ignored; returns `undefined` when none qualify, so
 * `imageUrls.maxResolution` stays absent rather than carrying a half-known size.
 */
export function pickMaxResolution(
  ...candidates: Array<{ width?: number; height?: number } | undefined>
): { width: number; height: number } | undefined {
  let best: { width: number; height: number } | undefined;
  let bestArea = 0;
  for (const c of candidates) {
    if (!c) continue;
    const w = asFiniteNumber(c.width);
    const h = asFiniteNumber(c.height);
    if (w === null || h === null || w <= 0 || h <= 0) continue;
    const area = w * h;
    if (area > bestArea) {
      bestArea = area;
      best = { width: w, height: h };
    }
  }
  return best;
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
