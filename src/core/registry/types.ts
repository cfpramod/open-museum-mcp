/**
 * Types for the registry: an accretive, provenance-stamped enrichment layer
 * over the engine's federated corpus. See `docs/plans/catalogue-raisonne-increment-1.md`
 * for the full design (this module implements Primitives 1-4 of that doc).
 *
 * Positioning discipline: this is a growing enrichment layer, never "the
 * catalogue" or a completeness/authority claim. Every present-state surface
 * built on these types must read "N, growing," never "complete."
 */

// --- Primitive 1: Identity ---

/**
 * A work's identity is distinct from any one source's record of it.
 * Increment 1 keeps identity PER-SOURCE: `registryId` is minted once, at
 * harvest time, as the deterministic function `registryId === sourceArtworkId`
 * (e.g. "cleveland:108312"), there is exactly one `sourceRefs` entry with
 * `role: 'primary'`. Cross-source merge (a later phase, deferred behind a
 * confidence gate) is what makes `registryId` diverge from any single
 * source id and populates a second `sourceRefs` entry with `role:
 * 'corroborating'`; this shape doesn't need to change to support that.
 */
export interface WorkIdentity {
  /** Stable once minted; never reassigned. */
  registryId: string;
  sourceRefs: Array<{
    /** Museum/registry code, matches `Fetcher.code`. */
    source: string;
    /** The source-native `Artwork.id` this identity currently resolves to. */
    id: string;
    role: 'primary' | 'corroborating';
  }>;
  /**
   * Reserved for future perceptual-hash/embedding linkage (C2PA soft-binding
   * aligned; DINOHash/pHash two-tier, see the locked drive doc's "visual
   * fingerprint" section). Field reserved now, NOT computed by increment 1.
   * Always absent until the fingerprint pipeline ships; never populate with a
   * placeholder or fake value.
   */
  fingerprint?: {
    algorithm: string;
    value: string;
    computedAt: string;
  };
  createdAt: string;
}

// --- Primitive 2: Assertion + Evidence ---

export type AssertionField =
  | 'createdBy'
  | 'datedTo'
  | 'exhibitedAt'
  | 'publishedIn'
  | 'ownedBy'
  | 'licensedBy'
  | 'title'
  | 'medium'
  | 'dimensions'
  | 'provenanceEvent'
  | 'other';

export type EvidenceType =
  | 'museum-record' // the source museum's own API/metadata (the harvest baseline)
  | 'catalogue-entry' // a published catalogue raisonné entry (link/citation, never bulk-ingested)
  | 'archive-doc'
  | 'auction-lot'
  | 'artist-attestation' // self-attestation via OCM/C2PA; always PRE-canonical alone, see canonicalStatus()
  | 'estate-letter'
  | 'scholar-review';

export interface Evidence {
  type: EvidenceType;
  /** Free-text or structured citation to the underlying document/record. Never re-hosts copyrighted text. */
  citation: string;
  /** Direct link when one exists and is safe to link (respects the record's rights posture). */
  url?: string;
  retrievedAt: string;
}

export type DisputeStatus = 'undisputed' | 'disputed' | 'superseded';

/**
 * Separates WORK IDENTITY from an ASSERTION about the work. Each assertion
 * carries its own evidence and its own dispute status, so a contested
 * attribution is a first-class object, never a silently overwritten string.
 * `evidence` is intentionally required, non-optional: a bare claim with zero
 * evidence is not a well-formed assertion under this model.
 */
export interface Assertion {
  id: string;
  /** `WorkIdentity.registryId`. */
  subject: string;
  field: AssertionField;
  value: string;
  evidence: Evidence[];
  disputeStatus: DisputeStatus;
  /** Present when `disputeStatus !== 'undisputed'`: the competing assertion(s), never silently dropped. */
  supersedes?: string;
  assertedBy: {
    contributorId: string;
    /** openclearance OCM tier of WHO is asserting. See {@link ContributorCredentialTier}. */
    ocmTier: ContributorCredentialTier;
  };
  assertedAt: string;
}

// --- Primitive 3: Rights posture ---

/**
 * What the REGISTRY ITSELF (the enrichment record, not the museum's image) is
 * allowed to do with a piece of evidence or a linked record. Distinct from
 * (and does not duplicate) `Artwork.license` / the Clearance Manifest rights
 * block, which governs the 2D image pixels.
 */
export type RightsPosture =
  | 'can_store_and_republish' // CC0/PD museum metadata, e.g. the Cleveland harvest baseline
  | 'can_store_metadata_only' // open metadata, no republishing of any linked media/text
  | 'can_link_only' // restricted platforms (e.g. IFAR): cite/deep-link, never bulk-ingest
  | 'requires_partner_agreement';

export interface RightsPostureRecord {
  posture: RightsPosture;
  /** Human-readable rule, mirrors `ClearanceBasis.summary` style. */
  basis: string;
  determinedAt: string;
}

// --- Primitive 4: Trust ---

/**
 * (a) WHO is asserting, external, owned by openclearance. VALUE SPACE IS
 * OM-C-OWNED-PENDING (OM-CR CHANGES, 2026-07-03): openclearance's shipped
 * `VerificationState` is a 3-valued enum (per OM-C's W-6 roadmap work);
 * credential-tier semantics here MUST adopt OM-C's ruling verbatim once it
 * lands, never diverge from it with an independently invented range. Until
 * then this is an OPAQUE STRING placeholder: never parsed, ordered, or
 * compared numerically anywhere in this repo. The one sentinel this repo
 * mints pre-ruling is {@link PENDING_OC_TIER}; every other value is reserved
 * for OM-C's future ruling to define.
 */
export type ContributorCredentialTier = string;

/**
 * Sentinel for "no credential-tier ruling has landed yet." The ONLY
 * `ContributorCredentialTier` value this repo mints until OM-C's Tier-2/
 * credential semantics are ruled (see {@link ContributorCredentialTier}).
 * Increment 1's system harvest and every current write-back caller stamp
 * this value; it carries no ordering or comparison meaning beyond "not yet
 * rated," and must never be branched on as if it were a real tier.
 */
export const PENDING_OC_TIER: ContributorCredentialTier = 'pending-oc-ruling';

/**
 * (b) HOW WELL-EVIDENCED the record is. A grade, never a numeric confidence
 * score: a single number launders uncertainty; the assertion/evidence/dispute
 * structure is what carries trust legibly.
 */
export type EvidenceGrade = 'claim' | 'source-linked' | 'attested' | 'corroborated' | 'cr-grade';

/**
 * Two SEPARATE axes, never conflated. `contributorCredentialTier` and
 * `evidenceGrade` answer different questions (who vouches vs. how
 * well-evidenced) and must not be collapsed into one score.
 */
export interface TrustState {
  contributorCredentialTier: ContributorCredentialTier;
  evidenceGrade: EvidenceGrade;
}

/**
 * Only externally evidenced records enter the canonical layer. Self-attested
 * material (an `artist-attestation` evidence entry with no external
 * counter-signature) sits in a separate pre-canonical PENDING layer: visible
 * as a claim, never surfaced as a canonical registry entry.
 */
export type CanonicalStatus = 'canonical' | 'pre-canonical-pending';

// --- Registry entry (the four primitives, composed) ---

export interface RegistryEntry {
  identity: WorkIdentity;
  assertions: Assertion[];
  rightsPosture: RightsPostureRecord;
  trust: TrustState;
  canonicalStatus: CanonicalStatus;
  createdAt: string;
  updatedAt: string;
}

// --- MCP-facing summary (attached to `Artwork.enrichment`) ---

/**
 * Provenance-enrichment summary surfaced on `get_artwork`. Present-state
 * only, never a completeness claim: absence means "no registry entry yet,"
 * not "unimportant work."
 */
export interface ArtworkEnrichment {
  registryId: string;
  canonicalStatus: CanonicalStatus;
  evidenceGrade: EvidenceGrade;
  assertionCount: number;
}
