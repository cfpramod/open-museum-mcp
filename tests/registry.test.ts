import { describe, expect, it } from 'vitest';
import { FETCHER_REGISTRY } from '../src/fetchers/registry.js';

describe('FETCHER_REGISTRY (engine coverage metadata)', () => {
  it('lists every fetcher the engine ships, code-unique', () => {
    expect(FETCHER_REGISTRY.length).toBe(13);
    const codes = FETCHER_REGISTRY.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('marks exactly the 3 key-gated sources, matching server.ts registration', () => {
    const keyGated = FETCHER_REGISTRY.filter((e) => e.requiresApiKey).map((e) => e.code).sort();
    expect(keyGated).toEqual(['europeana', 'harvard', 'smithsonian']);
    expect(FETCHER_REGISTRY.find((e) => e.code === 'europeana')?.requiresApiKey).toBe(
      'EUROPEANA_API_KEY',
    );
    expect(FETCHER_REGISTRY.find((e) => e.code === 'smithsonian')?.requiresApiKey).toBe(
      'SMITHSONIAN_API_KEY',
    );
    expect(FETCHER_REGISTRY.find((e) => e.code === 'harvard')?.requiresApiKey).toBe(
      'HARVARD_API_KEY',
    );
  });

  it('marks exactly the 2 ingest-only sources (no live query API)', () => {
    const ingestOnly = FETCHER_REGISTRY.filter((e) => e.ingestOnly).map((e) => e.code).sort();
    expect(ingestOnly).toEqual(['nga', 'walters']);
  });

  it('matches the fleet-confirmed ground truth: 10 always-available (no key) + 3 key-gated', () => {
    const alwaysAvailable = FETCHER_REGISTRY.filter((e) => !e.requiresApiKey);
    expect(alwaysAvailable.length).toBe(10);
  });

  it('leaves the other 8 sources always-federated, with neither flag set', () => {
    const alwaysLive = FETCHER_REGISTRY.filter((e) => !e.requiresApiKey && !e.ingestOnly);
    expect(alwaysLive.length).toBe(8);
  });

  it('carries a non-empty display name for every source', () => {
    for (const entry of FETCHER_REGISTRY) {
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  it('is importable from /core', async () => {
    const core = await import('../src/core/index.js');
    expect(core.FETCHER_REGISTRY.length).toBe(13);
  });

  it('closes the /core export gap: getty/smk/wellcome/harvard/nga are on the public surface', async () => {
    const core = await import('../src/core/index.js');
    expect(core.gettyFetcher.code).toBe('getty');
    expect(core.smkFetcher.code).toBe('smk');
    expect(core.wellcomeFetcher.code).toBe('wellcome');
    expect(core.harvardFetcher.code).toBe('harvard');
    expect(core.ngaFetcher.code).toBe('nga');
  });
});

// Compile-time regression guard: the registry export must stay on /core's
// public surface (mirrors the ObjectProvenance guard on cleveland.test.ts) —
// this line fails tsc if the export is ever dropped.
import type { FetcherRegistryEntry as CoreFetcherRegistryEntry } from '../src/core/index.js';
const registrySurfaceCheck: (e: CoreFetcherRegistryEntry) => string = (e) => e.code;
void registrySurfaceCheck;
