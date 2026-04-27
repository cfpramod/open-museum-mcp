import type { Artwork } from './types.js';

/**
 * Filter artworks down to those whose date range overlaps `[yearMin, yearMax]`.
 *
 * Either bound may be `undefined`; both undefined returns the input untouched.
 * Records with a null `yearStart` or `yearEnd` are excluded as soon as any
 * bound is set: a date-range query is a research constraint, and a record
 * we couldn't date can't honestly be claimed to satisfy it. (Future Wikidata
 * enrichment in v0.7 will recover dates for many of these records.)
 *
 * Overlap is inclusive on both edges: an artwork with `yearStart === yearMax`
 * or `yearEnd === yearMin` passes. BCE is encoded as negative years, so
 * cross-era windows (e.g. -100 → 100) work without special-casing.
 */
export function filterByYearRange(
  artworks: Artwork[],
  yearMin: number | undefined,
  yearMax: number | undefined,
): Artwork[] {
  if (yearMin === undefined && yearMax === undefined) return artworks;
  return artworks.filter((a) => {
    if (a.yearStart === null || a.yearEnd === null) return false;
    if (yearMin !== undefined && a.yearEnd < yearMin) return false;
    if (yearMax !== undefined && a.yearStart > yearMax) return false;
    return true;
  });
}
