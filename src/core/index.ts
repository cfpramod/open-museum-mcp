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
