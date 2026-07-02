import type { Awaitable } from '../cache.js';
import type { Assertion, RegistryEntry } from './types.js';

/**
 * The store contract the registry (enrichment) layer depends on. Mirrors
 * `CacheStore`'s injection pattern deliberately: `/core` carries no storage of
 * its own, OMA supplies the concrete (D1/R2/PG) implementation, and this
 * interface is what makes that swap possible without touching engine code.
 *
 * [DECISION-NEEDED -> OMA]: this is the CONTRACT the future store must
 * satisfy, not an implementation, the concrete store (schema, backing
 * technology) is OMA's build, sequenced after the go-live wave.
 */
export interface RegistryStore {
  getEntry(registryId: string): Awaitable<RegistryEntry | null>;
  /** Harvest-path write: insert or fully replace an entry, keyed by `identity.registryId`. */
  upsertEntry(entry: RegistryEntry): Awaitable<void>;
  /**
   * Write-back-path write: append one already-assembled, already-validated
   * assertion. Increment 1 treats every caller as internal/trusted, so a
   * conforming implementation always applies immediately (`status:
   * 'applied'`). The openclearance Tier-2 external-write gate is this SAME
   * method, wired later by OM-C, a credential check inside the
   * implementation that routes untrusted/low-tier callers to `'pending'`
   * (the pre-canonical queue) instead, not a new method or a seam redesign.
   */
  proposeAssertion(req: {
    subject: string;
    assertion: Assertion;
  }): Awaitable<{ status: 'applied' | 'pending' }>;
  /** Present-state counts only. Never described as complete, growing, not exhaustive. */
  getStats(): Awaitable<{ entryCount: number; withEnrichmentCount: number }>;
}
