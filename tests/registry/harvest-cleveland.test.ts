import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enumerateClevelandIds,
  harvestClevelandBatch,
  runClevelandHarvest,
  stampClevelandEntry,
} from '../../src/core/registry/index.js';
import { clevelandFetcher } from '../../src/fetchers/cleveland.js';
import { memoryRegistryStore } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf-8'));
}

const ACCEPTED_ID = 135299; // tests/fixtures/cleveland-accepted.json
const REJECTED_ID = 990001; // tests/fixtures/cleveland-rejected-restricted.json

/** Routes global fetch by URL shape: enumeration (skip/limit/fields=id) vs a single-object getRaw call. */
function mockClevelandFetch(pages: Record<number, number[]>) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('fields=id')) {
      const skipMatch = /skip=(\d+)/.exec(url);
      const skip = skipMatch ? Number(skipMatch[1]) : 0;
      const ids = pages[skip] ?? [];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    if (url.includes(`/artworks/${ACCEPTED_ID}`)) {
      return new Response(JSON.stringify(fixture('cleveland-accepted.json')), { status: 200 });
    }
    if (url.includes(`/artworks/${REJECTED_ID}`)) {
      return new Response(JSON.stringify(fixture('cleveland-rejected-restricted.json')), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe('enumerateClevelandIds', () => {
  afterEach(() => vi.restoreAllMocks());

  it('paginates via skip/limit and signals exhaustion with a short page', async () => {
    mockClevelandFetch({ 0: [ACCEPTED_ID, REJECTED_ID] });
    const { ids, nextSkip } = await enumerateClevelandIds(0, 2);
    expect(ids).toEqual(['cleveland:135299', 'cleveland:990001']);
    // A full page (2 == limit) implies more may follow.
    expect(nextSkip).toBe(2);
  });

  it('returns nextSkip null when the page is shorter than the requested limit', async () => {
    mockClevelandFetch({ 0: [ACCEPTED_ID] });
    const { ids, nextSkip } = await enumerateClevelandIds(0, 5);
    expect(ids).toEqual(['cleveland:135299']);
    expect(nextSkip).toBeNull();
  });
});

describe('stampClevelandEntry', () => {
  it('mints registryId as the source Artwork.id and derives a baseline assertion set', () => {
    const result = clevelandFetcher.normalize(fixture('cleveland-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const entry = stampClevelandEntry(result.artwork, '2026-07-02T00:00:00.000Z');
    expect(entry.identity.registryId).toBe('cleveland:135299');
    expect(entry.identity.sourceRefs).toEqual([{ source: 'cleveland', id: 'cleveland:135299', role: 'primary' }]);
    expect(entry.identity.fingerprint).toBeUndefined(); // reserved, never computed by increment 1

    const fields = entry.assertions.map((a) => a.field);
    expect(fields).toContain('title');
    expect(fields).toContain('createdBy'); // van Gogh, named attribution
    expect(fields).toContain('datedTo');
    for (const a of entry.assertions) {
      expect(a.evidence).toHaveLength(1);
      expect(a.evidence[0].type).toBe('museum-record');
      expect(a.disputeStatus).toBe('undisputed');
    }

    expect(entry.rightsPosture.posture).toBe('can_store_and_republish');
    expect(entry.trust).toEqual({ contributorCredentialTier: 0, evidenceGrade: 'source-linked' });
    expect(entry.canonicalStatus).toBe('canonical'); // museum-record evidence is external
  });

  it('omits the createdBy assertion for an anonymous/unknown attribution', () => {
    const result = clevelandFetcher.normalize(fixture('cleveland-accepted.json'));
    if (result.status !== 'accepted') throw new Error('fixture must be accepted');
    result.artwork.artist = { name: 'Unknown', attributionType: 'anonymous' };

    const entry = stampClevelandEntry(result.artwork, '2026-07-02T00:00:00.000Z');
    expect(entry.assertions.map((a) => a.field)).not.toContain('createdBy');
  });
});

describe('harvestClevelandBatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hydrates via the unmodified clevelandFetcher, stores accepted records, counts rejections', async () => {
    mockClevelandFetch({ 0: [ACCEPTED_ID, REJECTED_ID] });
    const { store, entries } = memoryRegistryStore();

    const result = await harvestClevelandBatch(0, store, { batchSize: 2, clock: () => '2026-07-02T00:00:00.000Z' });

    expect(result).toEqual({ processed: 2, stored: 1, rejected: 1, nextSkip: 2 });
    expect(entries.has('cleveland:135299')).toBe(true);
    expect(entries.has('cleveland:990001')).toBe(false); // rights-gate rejection: never stored
  });
});

describe('runClevelandHarvest', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resumes from a persisted checkpoint and stops when enumeration is exhausted', async () => {
    mockClevelandFetch({ 0: [ACCEPTED_ID], 1: [] });
    const { store, entries } = memoryRegistryStore();
    const checkpoints = { value: null as string | null };
    const checkpointStore = {
      getCheckpoint: () => checkpoints.value,
      setCheckpoint: (skip: string) => {
        checkpoints.value = skip;
      },
    };

    const result = await runClevelandHarvest(store, checkpointStore, {
      batchSize: 1,
      clock: () => '2026-07-02T00:00:00.000Z',
    });

    expect(result).toEqual({ batches: 2, totalStored: 1, totalRejected: 0 });
    expect(entries.has('cleveland:135299')).toBe(true);
    expect(checkpoints.value).toBe('1'); // last completed page's nextSkip, persisted for resume
  });

  it('starts from a non-zero checkpoint instead of re-walking from the beginning', async () => {
    mockClevelandFetch({ 5: [] });
    const { store } = memoryRegistryStore();
    const checkpointStore = {
      getCheckpoint: () => '5',
      setCheckpoint: () => {},
    };

    const result = await runClevelandHarvest(store, checkpointStore, { batchSize: 1 });
    expect(result).toEqual({ batches: 1, totalStored: 0, totalRejected: 0 });
  });

  it('honors maxBatches as a dry-run/test hook', async () => {
    mockClevelandFetch({ 0: [ACCEPTED_ID], 1: [ACCEPTED_ID] });
    const { store } = memoryRegistryStore();
    const checkpoints = { value: null as string | null };
    const checkpointStore = {
      getCheckpoint: () => checkpoints.value,
      setCheckpoint: (skip: string) => {
        checkpoints.value = skip;
      },
    };

    const result = await runClevelandHarvest(store, checkpointStore, { batchSize: 1, maxBatches: 1 });
    expect(result.batches).toBe(1);
  });
});
