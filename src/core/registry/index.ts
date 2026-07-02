/**
 * The registry: an accretive, provenance-stamped enrichment layer over the
 * engine's federated corpus. See `docs/plans/catalogue-raisonne-increment-1.md`
 * for the full design. Increment 1 only: Cleveland harvest, write-back seam,
 * MCP read shape (`Federation.getArtwork`'s `enrichment` attach + `registryStats`).
 *
 * Positioning discipline: never "the catalogue," never a completeness claim.
 */
export type {
  WorkIdentity,
  AssertionField,
  EvidenceType,
  Evidence,
  DisputeStatus,
  Assertion,
  RightsPosture,
  RightsPostureRecord,
  ContributorCredentialTier,
  EvidenceGrade,
  TrustState,
  CanonicalStatus,
  RegistryEntry,
  ArtworkEnrichment,
} from './types.js';
export { PENDING_OC_TIER } from './types.js';
export { canonicalStatus } from './canonical.js';
export type { RegistryStore } from './store.js';
export {
  proposeWriteBack,
  validateWriteBackRequest,
  type WriteBackRequest,
  type WriteBackOptions,
  type WriteBackOutcome,
} from './writeBack.js';
export {
  enumerateClevelandIds,
  stampClevelandEntry,
  harvestClevelandBatch,
  runClevelandHarvest,
  type HarvestCheckpointStore,
  type HarvestOptions,
  type HarvestBatchResult,
  type HarvestRunResult,
} from './harvest/cleveland.js';
