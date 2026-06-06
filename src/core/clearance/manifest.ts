import { cite } from '../../cite.js';
import type {
  Artist,
  Artwork,
  ArtworkImages,
  RejectedArtwork,
  RightsConfidence,
  ValidationResult,
} from '../../types.js';
import { clearanceForLicense, type ClearanceBasis } from './licenseMap.js';

/**
 * The pure Clearance Manifest payload (JSON-LD). It never contains its own hash,
 * its signature, or any commercial data — integrity lives in the Tier-0 envelope
 * (see envelope.ts), commerce in a sibling vendor assertion that references this
 * payload by content hash. The payload is byte-identical to what the engine
 * emits and independently verifiable.
 *
 * Field names mirror the engine's canonical Artwork vocabulary wherever they map
 * (`artist`, `displayDate`, `imageUrls`, `imageOpenAccess`, `metadataOpenAccess`,
 * `museum`) so the open-museum.art data-model reconciliation is a thin mapping,
 * not a translation. JSON-LD semantics are supplied by aliasing these terms to
 * schema.org / Dublin Core IRIs in context.jsonld — the `@context` is the sole
 * normative authority; `specVersion` is human-readable convenience only.
 */
export interface ClearanceManifestPayload {
  '@context': string[];
  type: 'ClearanceManifest';
  specVersion: string;
  work: ClearanceWork;
  source: ClearanceSource;
  rights: ClearanceRights;
  clearance: ClearanceBlock;
  verification: ClearanceVerification;
  /** Omitted for rejected records, which carry no identified Artwork to cite. */
  citation?: ClearanceCitation;
}

export interface ClearanceWork {
  id: string;
  title?: string;
  artist?: Artist;
  displayDate?: string;
  yearStart?: number | null;
  yearEnd?: number | null;
  medium?: string;
}

export interface ClearanceMuseum {
  code: string;
  name?: string;
  url?: string;
}

export interface ClearanceSource {
  museum: ClearanceMuseum;
  apiUrl?: string;
  pageUrl?: string;
  originalUrl?: string;
  imageUrls?: ArtworkImages;
}

export interface ClearanceRights {
  statement: string | null;
  sourceApiValue: { field: string; value: unknown } | null;
  imageOpenAccess: boolean;
  metadataOpenAccess: boolean;
  confidence: RightsConfidence;
}

export interface ClearanceBlock {
  commercialReproduction: { permitted: boolean; basis: ClearanceBasis };
  derivatives: { permitted: boolean; basis: ClearanceBasis };
  attributionRequired: { required: boolean; basis: ClearanceBasis };
}

export interface ClearanceVerification {
  determinedBy: { actor: string; role: string };
  tool: string;
  determinedAt: string;
  ruleContext: string;
  determinationSource: { type: string; field?: string; url?: string; retrievedAt: string };
}

export interface ClearanceCitation {
  full: string;
  caption: string;
  short: string;
}

export interface BuildOptions {
  /** Engine version string for the `verification.tool` provenance field. */
  engineVersion: string;
  /**
   * Generation timestamp, used only where no determination timestamp exists in
   * the data (the deny path has no `license.verifiedAt`). Injected so manifests
   * are deterministic and reproducible as conformance fixtures.
   */
  now: string;
}

const CONTEXT: string[] = [
  'https://schema.org/',
  'http://purl.org/dc/terms/',
  'https://openclearance.org/v0.1/context.jsonld',
];
const TYPE = 'ClearanceManifest' as const;
const SPEC_VERSION = '0.1';
const TOOL_NAME = 'open-museum-mcp';

/** Split `<museum>.<field path>` on the first dot. `met.isPublicDomain` → field `isPublicDomain`. */
function apiFieldOf(verificationSource: string): string {
  const i = verificationSource.indexOf('.');
  return i < 0 ? verificationSource : verificationSource.slice(i + 1);
}

export function buildClearancePayload(
  result: ValidationResult,
  opts: BuildOptions,
): ClearanceManifestPayload {
  return result.status === 'accepted'
    ? buildAccepted(result.artwork, opts)
    : buildRejected(result.rejection, opts);
}

function buildAccepted(art: Artwork, opts: BuildOptions): ClearanceManifestPayload {
  const decision = clearanceForLicense(art.license.type);
  const field = apiFieldOf(art.license.verificationSource);

  return {
    '@context': CONTEXT,
    type: TYPE,
    specVersion: SPEC_VERSION,
    work: {
      id: art.id,
      title: art.title,
      artist: art.artist,
      displayDate: art.displayDate,
      yearStart: art.yearStart,
      yearEnd: art.yearEnd,
      medium: art.medium,
    },
    source: {
      museum: { code: art.museum.code, name: art.museum.name, url: art.museum.url },
      apiUrl: art.source.apiUrl,
      pageUrl: art.source.pageUrl,
      ...(art.source.originalUrl ? { originalUrl: art.source.originalUrl } : {}),
      imageUrls: art.imageUrls,
    },
    rights: {
      statement: decision.statement,
      sourceApiValue: { field, value: art.license.rawValue },
      imageOpenAccess: art.imageOpenAccess,
      metadataOpenAccess: art.metadataOpenAccess,
      confidence: decision.confidence,
    },
    clearance: {
      commercialReproduction: decision.commercialReproduction,
      derivatives: decision.derivatives,
      attributionRequired: decision.attributionRequired,
    },
    verification: {
      determinedBy: { actor: `museum:${art.museum.code}`, role: 'rights-source' },
      tool: `${TOOL_NAME}@${opts.engineVersion} · ${art.license.verificationSource}`,
      determinedAt: art.license.verifiedAt,
      ruleContext: `${art.license.verificationSource}='${art.license.rawValue}' ⇒ ${art.license.type}`,
      determinationSource: {
        type: 'api-field',
        field,
        url: art.source.apiUrl,
        retrievedAt: art.license.verifiedAt,
      },
    },
    citation: {
      full: cite(art, 'full'),
      caption: cite(art, 'caption'),
      short: cite(art, 'short'),
    },
  };
}

function buildRejected(rej: RejectedArtwork, opts: BuildOptions): ClearanceManifestPayload {
  // The deny determination (all-false booleans, default-deny rule, low
  // confidence) comes from the single source of truth; the rejection supplies
  // the case-specific evidence (the gate's verbatim reason) into each basis.
  const decision = clearanceForLicense('UNKNOWN');
  const basis: ClearanceBasis = {
    rule: 'default-deny',
    inputs: [{ field: 'rejection.reason', value: rej.reason }],
    summary: `rights gate rejected '${rej.id}': ${rej.reason} ⇒ default deny`,
  };

  return {
    '@context': CONTEXT,
    type: TYPE,
    specVersion: SPEC_VERSION,
    work: { id: rej.id },
    source: { museum: { code: rej.museumCode } },
    rights: {
      statement: decision.statement,
      sourceApiValue: null,
      imageOpenAccess: false,
      metadataOpenAccess: false,
      confidence: decision.confidence,
    },
    clearance: {
      commercialReproduction: { permitted: false, basis },
      derivatives: { permitted: false, basis },
      attributionRequired: { required: false, basis },
    },
    verification: {
      determinedBy: { actor: 'engine:open-museum-mcp', role: 'rights-gate' },
      tool: `${TOOL_NAME}@${opts.engineVersion} · rights-gate`,
      determinedAt: opts.now,
      ruleContext: `strict default deny: ${rej.reason}`,
      determinationSource: { type: 'rights-gate-default', retrievedAt: opts.now },
    },
  };
}
