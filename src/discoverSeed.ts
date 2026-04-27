/**
 * Cold-start helper for `discover_random`. When the cache has no records
 * matching the user's constraints, the handler auto-seeds via
 * `search_artworks` first — but only when the constraints carry enough
 * signal to build a meaningful query. A bare `discover_random({})` call
 * with no constraints would auto-seed against something generic ("art"),
 * which is wasteful and surprising; in that case the handler returns a
 * hint instead.
 *
 * Period is preferred over region when both are present (period queries
 * tend to be more discriminating: "edo" returns ~all Edo material;
 * "japan" returns more than just Edo). When both are present we include
 * both — Met / Cleveland / AIC search engines handle multi-token queries
 * sensibly enough that the conjunction is useful.
 */
export function buildSeedQueryFromConstraints(input: {
  region?: string;
  period?: string;
}): string | null {
  const parts: string[] = [];
  if (input.period) parts.push(input.period);
  if (input.region) parts.push(input.region);
  return parts.length > 0 ? parts.join(' ') : null;
}
