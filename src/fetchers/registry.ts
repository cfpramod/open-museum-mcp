import { aicFetcher } from './aic.js';
import { clevelandFetcher } from './cleveland.js';
import { europeanaFetcher } from './europeana.js';
import { gettyFetcher } from './getty.js';
import { harvardFetcher } from './harvard.js';
import { metFetcher } from './met.js';
import { ngaFetcher } from './nga.js';
import { rijksmuseumFetcher } from './rijksmuseum.js';
import { smithsonianFetcher } from './smithsonian.js';
import { smkFetcher } from './smk.js';
import type { Fetcher } from './types.js';
import { waltersFetcher } from './walters.js';
import { wellcomeFetcher } from './wellcome.js';
import { wikimediaFetcher } from './wikimedia.js';

/**
 * Static, per-source metadata a host needs to DESCRIBE the federation's
 * coverage (e.g. a `/museums` page) without querying it — code, display name,
 * whether a key is required to enable it, and whether it federates a live API
 * or serves an ingested snapshot.
 */
export interface FetcherRegistryEntry {
  code: string;
  name: string;
  requiresApiKey?: string;
  ingestOnly?: true;
}

// Every fetcher the engine ships, regardless of whether a given host's env
// currently has the keys to REGISTER the key-gated ones. Import the live
// instances (not hand-typed literals) so an added/renamed/removed source can't
// silently drift from this list — the class of bug this registry exists to end.
const ALL_FETCHERS: readonly Fetcher[] = [
  metFetcher,
  clevelandFetcher,
  aicFetcher,
  wikimediaFetcher,
  rijksmuseumFetcher,
  waltersFetcher,
  smkFetcher,
  wellcomeFetcher,
  ngaFetcher,
  gettyFetcher,
  europeanaFetcher,
  smithsonianFetcher,
  harvardFetcher,
];

/**
 * Every source the engine knows how to fetch, in registration order. A host
 * still decides which to actually REGISTER (e.g. a key-gated source only once
 * its key is present) — this list describes engine capability, not any one
 * deployment's current live set.
 */
export const FETCHER_REGISTRY: readonly FetcherRegistryEntry[] = ALL_FETCHERS.map(
  ({ code, name, requiresApiKey, ingestOnly }) => ({ code, name, requiresApiKey, ingestOnly }),
);
