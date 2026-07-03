import type { Assertion, RegistryEntry, RegistryStore } from '../../src/core/registry/index.js';

/**
 * In-memory `RegistryStore` test double, mirroring the `memoryCache()` /
 * `CacheStore` fake pattern in `tests/federation.test.ts`. Not shipped code:
 * the real store is OMA's build.
 */
export function memoryRegistryStore() {
  const entries = new Map<string, RegistryEntry>();

  const store: RegistryStore = {
    getEntry: (id) => entries.get(id) ?? null,
    upsertEntry: (entry) => {
      entries.set(entry.identity.registryId, entry);
    },
    proposeAssertion: (req: { subject: string; assertion: Assertion }) => {
      const existing = entries.get(req.subject);
      if (!existing) throw new Error(`memoryRegistryStore: no entry for subject ${req.subject}`);
      existing.assertions.push(req.assertion);
      existing.updatedAt = req.assertion.assertedAt;
      return { status: 'applied' as const };
    },
    getStats: () => ({
      entryCount: entries.size,
      withEnrichmentCount: [...entries.values()].filter((e) => e.assertions.length > 1).length,
    }),
  };

  return { store, entries };
}
