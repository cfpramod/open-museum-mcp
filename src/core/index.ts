/**
 * Public entry point for the federation engine — the shared core behind both
 * the MCP server and any HTTP/edge front door. It carries no transport and no
 * storage: callers inject a {@link CacheStore} and a set of {@link Fetcher}s,
 * and get back a {@link Federation} whose every result has already passed the
 * per-museum rights gate. Deliberately free of `node:sqlite` and the MCP SDK
 * so it runs unchanged on a Cloudflare Workers runtime.
 */
export {
  createFederation,
  SearchParamsSchema,
  ID_REGEX,
  UnknownMuseumError,
  type Federation,
  type FederationOptions,
  type SearchParams,
  type SearchResult,
  type FacetResult,
  type FacetCount,
  type FetchOutcome,
  type CiteOutcome,
} from './federation.js';

export type { CacheStore, Awaitable } from './cache.js';

// Clearance Manifest — the portable, fail-closed rights-clearance artifact and
// its Tier-0 integrity envelope, emitted by Federation.clearanceManifest.
export { wrapTier0, type Tier0Envelope } from './clearance/envelope.js';
export {
  buildClearancePayload,
  type ClearanceManifestPayload,
  type ClearanceWork,
  type ClearanceSource,
  type ClearanceMuseum,
  type ClearanceRights,
  type ClearanceBlock,
  type ClearanceVerification,
  type ClearanceCitation,
  type BuildOptions,
} from './clearance/manifest.js';
export { clearanceForLicense, type ClearanceDecision, type ClearanceBasis } from './clearance/licenseMap.js';

// The registry: an accretive, provenance-stamped enrichment layer over the
// federated corpus (increment 1: Cleveland harvest + write-back seam + the
// `Federation.getArtwork`/`registryStats` read surface). See
// `docs/plans/catalogue-raisonne-increment-1.md`. Never "the catalogue," never
// a completeness claim; present-state only, everywhere this is surfaced.
export {
  canonicalStatus,
  PENDING_OC_TIER,
  proposeWriteBack,
  validateWriteBackRequest,
  enumerateClevelandIds,
  stampClevelandEntry,
  harvestClevelandBatch,
  runClevelandHarvest,
  type WorkIdentity,
  type AssertionField,
  type EvidenceType,
  type Evidence,
  type DisputeStatus,
  type Assertion,
  type RightsPosture,
  type RightsPostureRecord,
  type ContributorCredentialTier,
  type EvidenceGrade,
  type TrustState,
  type CanonicalStatus,
  type RegistryEntry,
  type ArtworkEnrichment,
  type RegistryStore,
  type WriteBackRequest,
  type WriteBackOptions,
  type WriteBackOutcome,
  type HarvestCheckpointStore,
  type HarvestOptions,
  type HarvestBatchResult,
  type HarvestRunResult,
} from './registry/index.js';

// Tier-1 delegated-attestor envelope/format library — KEYLESS. `prepareTier1`
// emits a keyless signing request (the only thing the OMA service signs);
// `verifyTier1` is the fail-closed, public-key-only verifier. The COSE primitives
// are exported so the signing service reuses the EXACT pinned to-be-signed bytes
// (contract C2 — no re-canonicalization).
export {
  prepareTier1,
  verifyTier1,
  type Tier1SigningRequest,
  type PrepareTier1Options,
  type Tier1Envelope,
  type VerificationState,
  type VerificationResult,
  type VerifyTier1Options,
} from './clearance/tier1.js';
export {
  COSE_PROTECTED_EDDSA,
  CLEARANCE_ASSERTION_LABEL,
  HARD_BINDING_ASSERTION_LABEL,
  coseSigStructure,
  assembleCoseSign1,
  decodeCoseSign1,
  hardBindingAssertionBytes,
} from './clearance/c2paClaim.js';

// Pure helpers a front door commonly needs alongside the federation.
export { cite, type CiteStyle } from '../cite.js';
export type { Artwork, ArtworkImages, ArtworkSource, ArtworkLicense, ValidationResult } from '../types.js';
export type { Fetcher, SearchOptions } from '../fetchers/types.js';

// Medium controlled vocabulary — front doors (MCP tool schema, web facet UI)
// need the value set; the normalizer is exposed for any host-side reclassifying.
export { MEDIUM_CATEGORIES, normalizeMedium, type MediumCategory } from '../medium.js';

// Colour — the Workers-safe READ side only (math + types). Extraction lives in
// the Node-only color/extract.ts and is deliberately NOT exported here, so the
// core stays free of `sharp`. The web app uses these to render swatches and to
// run colour search/ranking over precomputed colour.
export {
  COLOR_FAMILIES,
  COLOR_FAMILY_NAMES,
  ciede2000,
  hexToLab,
  hexToRgb,
  rgbToHex,
  rgbToLab,
  nearestColorFamily,
  quantizeColors,
  type ColorFamily,
  type ColorData,
  type PaletteEntry,
  type Rgb,
  type Lab,
} from '../color/colorMath.js';

// Built-in museum fetchers, so a host can assemble its own registry (and
// decide which to enable based on available API keys).
export { metFetcher } from '../fetchers/met.js';
export { clevelandFetcher } from '../fetchers/cleveland.js';
export { aicFetcher } from '../fetchers/aic.js';
export { wikimediaFetcher } from '../fetchers/wikimedia.js';
export { europeanaFetcher } from '../fetchers/europeana.js';
export { smithsonianFetcher } from '../fetchers/smithsonian.js';
export { rijksmuseumFetcher } from '../fetchers/rijksmuseum.js';

// Coverage foundation: the reusable IIIF client + the shared commercial-POD
// rights gate (CC0/PDM/CC-BY/CC-BY-SA allow; NC/ND/unknown deny; >=3000px floor).
export {
  parseManifest,
  parseInfoJson,
  fullImageUrl,
  meetsPrintResolution,
  fetchManifest,
  fetchInfoJson,
  type IiifManifestParsed,
  type IiifInfo,
  type IiifImageRef,
  type IiifApiVersion,
} from '../iiif/client.js';
export { validateCommercialRights } from '../rights/commercialRights.js';
