import type { Federation, Freshness } from './core/index.js';
import type { Cache, DiscoverFilter } from './db.js';
import type { Artwork } from './types.js';

/** The most random picks one `discover_random` call will try before it gives up. */
const MAX_PICK_ATTEMPTS = 5;

/**
 * Pick one cached work at random and serve it the way `get_artwork` would.
 *
 * The random pick reads the cache by SQL, which knows nothing of an adapter's version or of the rights bound, so
 * the pick itself is never served. Its id goes through `federation.getArtwork`, the one read path that applies
 * both: a work stored under an older adapter version, or whose rights check is past the bound, is re-verified live
 * through the rights gate first; one the gate now rejects is skipped and another is tried; one that could not be
 * re-verified is served with `freshness.rightsStale` set. Returns null when no pick could be served.
 */
export async function pickDiscoverable(opts: {
  cache: Cache;
  federation: Federation;
  lookup: DiscoverFilter;
  maxAttempts?: number;
}): Promise<{ artwork: Artwork; freshness: Freshness } | null> {
  const attempts = opts.maxAttempts ?? MAX_PICK_ATTEMPTS;
  const skipped: string[] = [];
  for (let i = 0; i < attempts; i += 1) {
    const picked = opts.cache.getRandomObject({ ...opts.lookup, notIds: skipped });
    if (!picked) return null;
    const out = await opts.federation.getArtwork(picked.id);
    if (out.ok) return { artwork: out.artwork, freshness: out.freshness };
    skipped.push(picked.id);
  }
  return null;
}
