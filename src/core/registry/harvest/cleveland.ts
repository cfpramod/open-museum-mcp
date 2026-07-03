import { clevelandFetcher } from '../../../fetchers/cleveland.js';
import { httpGet } from '../../../fetchers/helpers.js';
import type { Artwork } from '../../../types.js';
import type { Awaitable } from '../../cache.js';
import { canonicalStatus } from '../canonical.js';
import { PENDING_OC_TIER } from '../types.js';
import type { Assertion, AssertionField, Evidence, RegistryEntry, WorkIdentity } from '../types.js';
import type { RegistryStore } from '../store.js';

const CLEVELAND_API = 'https://openaccess-api.clevelandart.org/api';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;

/**
 * Persisted cursor for a resumable harvest. OMA implements the concrete
 * storage (a single row/key is enough, this is not per-object state); the
 * engine only defines the shape it needs to resume correctly after a crash
 * or deploy instead of re-walking the whole catalogue.
 */
export interface HarvestCheckpointStore {
  /** Last `skip` offset successfully completed, as a string, or null before the first run. */
  getCheckpoint(): Awaitable<string | null>;
  setCheckpoint(skip: string): Awaitable<void>;
}

export interface HarvestOptions {
  batchSize?: number;
  concurrency?: number;
  /** Injectable for deterministic tests; defaults to `new Date().toISOString()`. */
  clock?: () => string;
  /** Stop after this many batches, a test/dry-run hook. Undefined runs to completion. */
  maxBatches?: number;
}

export interface HarvestBatchResult {
  processed: number;
  stored: number;
  rejected: number;
  /** Next `skip` offset to resume from, or null once enumeration is exhausted. */
  nextSkip: number | null;
}

export interface HarvestRunResult {
  batches: number;
  totalStored: number;
  totalRejected: number;
}

/**
 * One page of Cleveland's open-access catalogue, oldest-id-first for
 * deterministic resumability. Enumeration is a thin pagination wrapper
 * around the SAME `/api/artworks/` endpoint `clevelandFetcher.search`
 * already calls, no `q` param, so it walks the full `cc0=1&has_image=1`
 * set instead of a keyword query.
 */
export async function enumerateClevelandIds(
  skip: number,
  limit: number,
): Promise<{ ids: string[]; nextSkip: number | null }> {
  const url = new URL(`${CLEVELAND_API}/artworks/`);
  url.searchParams.set('cc0', '1');
  url.searchParams.set('has_image', '1');
  url.searchParams.set('skip', String(skip));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', 'id');

  const res = await httpGet(url);
  if (!res.ok) throw new Error(`Cleveland enumerate failed: ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
  const data = json.data ?? [];
  const ids = data
    .map((d) => (typeof d.id === 'number' ? `cleveland:${d.id}` : null))
    .filter((s): s is string => s !== null);

  // A short page (fewer ids than requested) means enumeration is exhausted.
  return { ids, nextSkip: ids.length < limit ? null : skip + limit };
}

/**
 * Wrap a rights-gate-accepted Cleveland `Artwork` as an increment-1 registry
 * entry. Increment 1 mints `registryId` as the deterministic function
 * `registryId === art.id` (see {@link WorkIdentity}), no separate lookup
 * needed since every entry is per-source. The baseline assertion SET is
 * derived from fields the fetcher already normalized (title, attributed
 * creator, display date), each citing the single museum-record evidence
 * entry, this is the "museum's own metadata is evidence-grade
 * source-linked, not automatically cr-grade" baseline the design doc
 * describes; write-back assertions with stronger evidence supersede it later.
 */
export function stampClevelandEntry(art: Artwork, now: string): RegistryEntry {
  const identity: WorkIdentity = {
    registryId: art.id,
    sourceRefs: [{ source: art.museum.code, id: art.id, role: 'primary' }],
    createdAt: now,
  };

  const baseEvidence: Evidence = {
    type: 'museum-record',
    citation: `${art.museum.name} open-access record ${art.id}`,
    url: art.source.apiUrl,
    retrievedAt: now,
  };

  const assertions: Assertion[] = [];
  let n = 0;
  const push = (field: AssertionField, value: string) => {
    n++;
    assertions.push({
      id: `${art.id}:${n}`,
      subject: art.id,
      field,
      value,
      evidence: [baseEvidence],
      disputeStatus: 'undisputed',
      assertedBy: { contributorId: 'system:cleveland-harvest', ocmTier: PENDING_OC_TIER },
      assertedAt: now,
    });
  };

  push('title', art.title);
  // 'Unknown' is the fetcher's own fallback for a missing creator name (see
  // cleveland.ts normalize()), not a real attribution to stamp as an assertion.
  if (art.artist.attributionType !== 'anonymous' && art.artist.name && art.artist.name !== 'Unknown') {
    push('createdBy', art.artist.name);
  }
  if (art.displayDate) push('datedTo', art.displayDate);

  return {
    identity,
    assertions,
    rightsPosture: {
      posture: 'can_store_and_republish',
      basis: 'Cleveland Museum of Art Open Access: metadata is CC0.',
      determinedAt: now,
    },
    trust: { contributorCredentialTier: PENDING_OC_TIER, evidenceGrade: 'source-linked' },
    canonicalStatus: canonicalStatus(assertions),
    createdAt: now,
    updatedAt: now,
  };
}

async function withConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Enumerate + hydrate + gate + stamp + write ONE page. Hydration reuses
 * `clevelandFetcher.getRaw`/`normalize` UNMODIFIED, the engine already knows
 * how to read a Cleveland record and gate its rights; this function's only
 * new responsibility is enumeration and the registry-entry stamp. A
 * rights-gate rejection is logged as a count, never stored (same
 * strict-default-deny discipline as the live federation path).
 */
export async function harvestClevelandBatch(
  skip: number,
  store: RegistryStore,
  opts: HarvestOptions = {},
): Promise<HarvestBatchResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const clock = opts.clock ?? (() => new Date().toISOString());

  const { ids, nextSkip } = await enumerateClevelandIds(skip, batchSize);

  let stored = 0;
  let rejected = 0;

  await withConcurrency(ids, concurrency, async (id) => {
    const raw = await clevelandFetcher.getRaw(id);
    const result = clevelandFetcher.normalize(raw);
    if (result.status === 'rejected') {
      rejected++;
      return;
    }
    await store.upsertEntry(stampClevelandEntry(result.artwork, clock()));
    stored++;
  });

  return { processed: ids.length, stored, rejected, nextSkip };
}

/**
 * Drives the full resumable harvest against an injected checkpoint store,
 * batch by batch, until enumeration is exhausted (or `maxBatches` is hit, a
 * test/dry-run hook). The checkpoint is persisted after every batch so a
 * crash or deploy resumes from the next unprocessed page, never re-walking
 * already-harvested records. `upsertEntry` is idempotent (keyed by
 * `identity.registryId`), so a re-run after a crash never double-inserts.
 * OMA supplies both `store` and `checkpoints`; this function contains no
 * storage of its own, bounded concurrency here is a stopgap for the
 * per-museum circuit breaker the engine's E2 resilience drive is landing;
 * this harvest job should sit behind that same fetch path once it ships.
 */
export async function runClevelandHarvest(
  store: RegistryStore,
  checkpoints: HarvestCheckpointStore,
  opts: HarvestOptions = {},
): Promise<HarvestRunResult> {
  let skip = Number((await checkpoints.getCheckpoint()) ?? '0');
  let batches = 0;
  let totalStored = 0;
  let totalRejected = 0;

  while (opts.maxBatches === undefined || batches < opts.maxBatches) {
    const result = await harvestClevelandBatch(skip, store, opts);
    totalStored += result.stored;
    totalRejected += result.rejected;
    batches++;

    if (result.nextSkip === null) break;
    skip = result.nextSkip;
    await checkpoints.setCheckpoint(String(skip));
  }

  return { batches, totalStored, totalRejected };
}
