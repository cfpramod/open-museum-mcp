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

// Text clean-up on upstream strings. Each of these replaces a regular
// expression that took quadratic time on a long run of whitespace (a `\s*` or
// `\s+` that the engine retries from every position in the run). They give the
// same output as the expression named in their comment, in linear time;
// tests/linearText.test.ts checks both properties. `trim`, `trimStart` and
// `trimEnd` remove exactly the characters `\s` matches.

/**
 * Removes a trailing parenthetical holding no `)`, with the whitespace around
 * it: `Canvas (Textile Material)` -> `Canvas`. Same as
 * `s.replace(/\s*\([^)]*\)\s*$/, '')`.
 */
export function stripTrailingParenthetical(s: string): string {
  const t = s.trimEnd();
  const close = t.length - 1;
  if (close < 0 || t[close] !== ')') return s;
  // The parenthetical cannot contain `)`, so it opens after the previous one.
  const segmentStart = close === 0 ? 0 : t.lastIndexOf(')', close - 1) + 1;
  const open = t.indexOf('(', segmentStart);
  if (open < 0 || open >= close) return s;
  return t.slice(0, open).trimEnd();
}

/**
 * Replaces each hyphen, with any whitespace around it, by an en dash:
 * `1606 - 1669` -> `1606–1669`. Same as `s.replace(/\s*-\s*\/g, '–')`.
 */
export function dashBetweenHyphenParts(s: string): string {
  const parts = s.split('-');
  const last = parts.length - 1;
  return parts
    .map((p, i) => {
      const left = i > 0 ? p.trimStart() : p;
      return i < last ? left.trimEnd() : left;
    })
    .join('–');
}

/**
 * Removes a whitespace-led, zero-padded trailing number of two or three digits
 * (` 02`, ` 099`), with the whole whitespace run before it. Same as
 * `s.replace(/\s+0\d{1,2}$/, '')`.
 */
export function stripTrailingFileNumber(s: string): string {
  // One whitespace character is enough to anchor the match, and each attempt
  // is bounded, so this pattern runs in linear time.
  const m = /\s0\d{1,2}$/.exec(s);
  return m ? s.slice(0, m.index).trimEnd() : s;
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

const ORDINAL_SUFFIX: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
/** Century label for a CE year (1601 -> "17th century"). */
function centuryLabel(year: number): string {
  const c = Math.floor((year - 1) / 100) + 1;
  const suffix = c % 100 >= 11 && c % 100 <= 13 ? 'th' : (ORDINAL_SUFFIX[c % 10] ?? 'th');
  return `${c}${suffix} century`;
}

/**
 * Derive a period facet from parsed year bounds, for sources whose API
 * carries no named-period vocabulary of its own (Rijksmuseum, Getty) — a
 * single-century span is still a useful tradition tag, and the date parser
 * already gives the years. Null for BCE, missing, or century-crossing spans
 * (where no single century is meaningful).
 */
export function derivePeriodFromYears(yearStart: number | null, yearEnd: number | null): string | null {
  if (yearStart === null || yearEnd === null || yearStart <= 0 || yearEnd <= 0) return null;
  const cStart = Math.floor((yearStart - 1) / 100) + 1;
  const cEnd = Math.floor((yearEnd - 1) / 100) + 1;
  return cStart === cEnd ? centuryLabel(yearStart) : null;
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
