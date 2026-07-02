import type { Assertion, CanonicalStatus } from './types.js';

/**
 * A record crosses into the canonical layer as soon as ANY assertion carries
 * evidence beyond a bare self-attestation, the three canonical entry routes
 * (museum-backed open record / CR-backed with verifiable bibliographic
 * provenance / multi-source corroborated) are all forms of external evidence.
 * A record whose assertions are ALL `artist-attestation`-only stays
 * pre-canonical-pending: visible as a claim, never surfaced as canonical,
 * until an external counter-signature (a museum/gallery attestation) arrives.
 */
export function canonicalStatus(assertions: Assertion[]): CanonicalStatus {
  const hasExternalEvidence = assertions.some((a) =>
    a.evidence.some((e) => e.type !== 'artist-attestation'),
  );
  return hasExternalEvidence ? 'canonical' : 'pre-canonical-pending';
}
