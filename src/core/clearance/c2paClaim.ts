/**
 * Keyless construction of the Tier-1 C2PA claim and its COSE_Sign1 to-be-signed
 * input. This is the deterministic half of the attestor seam: the lib emits the
 * claim bytes (`claimToBeSigned`); the OMA signing service signs them by wrapping
 * them in the pinned COSE Sig_structure below — VERBATIM, no re-canonicalization
 * (contract C2). Nothing here needs a private key.
 *
 * Seam realization (the precise byte boundary OM-A must mirror):
 *  - `claimToBeSigned` = the canonical CBOR bytes of the C2PA claim (the COSE
 *    payload). The lib is the sole authority on these bytes.
 *  - The signing service constructs COSE_Sign1 with the FIXED protected header
 *    `{1:-8}` (alg = EdDSA, CBOR `a10127`), an EMPTY external_aad, and these claim
 *    bytes used verbatim as the payload; it signs the resulting Sig_structure with
 *    Ed25519 and wraps. There is zero canonicalization freedom — every byte of the
 *    signed input is pinned by `coseSigStructure()` here.
 *
 * Claim minimality: the claim contains ONLY fields a verifier can reconstruct from
 * the locked Tier-1 envelope (the exact payload bytes, the bound-asset hash, the
 * claim generator) plus fixed constants. Descriptive, non-security-bearing metadata
 * (e.g. `dc:format`) is deliberately NOT in the signed claim — the binding to the
 * asset is by content hash (the hard-binding assertion), not by MIME label. This is
 * what lets `verifyTier1` recompute `claimToBeSigned` byte-for-byte from the
 * envelope alone.
 */
import {
  type CborValue,
  type DecodedCbor,
  asBufferSource,
  cborBytes,
  cborMap,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
} from './cbor.js';

const SHA256_LABEL = 'sha256';

/** Label of the C2PA assertion whose data is the exact clearance payload bytes. */
export const CLEARANCE_ASSERTION_LABEL = 'org.openclearance.clearance-manifest';
/** Label of the C2PA hard-binding (content-hash) assertion. */
export const HARD_BINDING_ASSERTION_LABEL = 'c2pa.hash.data';

/** JUMBF self-reference URI for an assertion of the given label. */
function assertionUri(label: string): string {
  return `self#jumbf=c2pa.assertions/${label}`;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return new Uint8Array(digest);
}

/**
 * The C2PA hard-binding (`c2pa.hash.data`) assertion, reduced to its
 * deterministic, key-independent essence: the SHA-256 of the bound asset bytes
 * with no exclusions. Reconstructable by a verifier from the envelope's
 * `boundAsset.hash` alone.
 */
export function hardBindingAssertionBytes(imageHash: Uint8Array): Uint8Array {
  const assertion: CborValue = cborMap([
    ['alg', SHA256_LABEL],
    ['exclusions', []],
    ['hash', cborBytes(imageHash)],
  ]);
  return encodeCanonicalCbor(assertion);
}

/** A C2PA `hashed_uri`: a reference to an assertion bound by the hash of its bytes. */
function hashedUri(label: string, assertionHash: Uint8Array): CborValue {
  return cborMap([
    ['url', assertionUri(label)],
    ['alg', SHA256_LABEL],
    ['hash', cborBytes(assertionHash)],
  ]);
}

/**
 * Deterministic instance identifier, derived from the payload digest so the claim
 * is a pure function of its inputs (no randomness — the lib, the service, and the
 * verifier must all reproduce the same bytes).
 */
function instanceId(payloadHash: Uint8Array): string {
  const hex = Array.from(payloadHash.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `xmp:iid:${hex}`;
}

export interface ClaimInput {
  /** The EXACT UTF-8 bytes of the v0.1 clearance payload. */
  payloadBytes: Uint8Array;
  /** SHA-256 of the delivered/print-ready image asset bytes (the hard-binding target). */
  imageHash: Uint8Array;
  /** C2PA claim generator string, e.g. "open-museum.art". */
  claimGenerator: string;
}

/**
 * Build the canonical C2PA claim bytes = `claimToBeSigned`. Pure + deterministic
 * in its inputs; async only because it hashes the two assertions the claim
 * references by hash.
 */
export async function buildC2paClaim(input: ClaimInput): Promise<Uint8Array> {
  const payloadHash = await sha256(input.payloadBytes);
  const hardBinding = hardBindingAssertionBytes(input.imageHash);
  const hardBindingHash = await sha256(hardBinding);

  const claim: CborValue = cborMap([
    ['claim_generator', input.claimGenerator],
    ['instanceID', instanceId(payloadHash)],
    ['alg', SHA256_LABEL],
    [
      'assertions',
      [
        // clearance assertion data == the EXACT payload bytes, bound by their hash
        hashedUri(CLEARANCE_ASSERTION_LABEL, payloadHash),
        // hard-binding to the image asset
        hashedUri(HARD_BINDING_ASSERTION_LABEL, hardBindingHash),
      ],
    ],
    ['signature', 'self#jumbf=c2pa.signature'],
  ]);
  return encodeCanonicalCbor(claim);
}

/** COSE protected header for EdDSA: `{1: -8}` (alg label 1 → EdDSA -8). */
export const COSE_PROTECTED_EDDSA = encodeCanonicalCbor(cborMap([[1, -8]]));

/**
 * The COSE_Sign1 Sig_structure — the exact Ed25519 to-be-signed input:
 *   ["Signature1", bstr(protected-header), bstr(external_aad=""), bstr(payload=claim)]
 * The signing service must sign THESE bytes; the verifier reconstructs and checks
 * the same. external_aad is empty.
 */
export function coseSigStructure(claimBytes: Uint8Array): Uint8Array {
  const structure: CborValue = [
    'Signature1',
    cborBytes(COSE_PROTECTED_EDDSA),
    cborBytes(new Uint8Array(0)),
    cborBytes(claimBytes),
  ];
  return encodeCanonicalCbor(structure);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Assemble a COSE_Sign1 structure (RFC 8152): `[protected, {}, payload, signature]`
 * with the pinned EdDSA protected header and an empty unprotected map. Pure +
 * keyless — the signing service calls this AFTER producing `signature` over
 * `coseSigStructure(claimBytes)`. The claim payload rides verbatim.
 */
export function assembleCoseSign1(claimBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  const sign1: CborValue = [
    cborBytes(COSE_PROTECTED_EDDSA),
    cborMap([]),
    cborBytes(claimBytes),
    cborBytes(signature),
  ];
  return encodeCanonicalCbor(sign1);
}

/**
 * Decode a COSE_Sign1, returning the claim payload + raw signature. Strict and
 * fail-closed: throws unless the structure is a 4-element array carrying the
 * pinned EdDSA protected header, a byte-string payload, and a byte-string
 * signature. Used by the verifier to extract what it needs from the manifest store.
 */
export function decodeCoseSign1(bytes: Uint8Array): { claim: Uint8Array; signature: Uint8Array } {
  const { value } = decodeCanonicalCbor(bytes);
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('cose: not a 4-element COSE_Sign1 array');
  }
  const [protectedHeader, , payload, signature] = value as DecodedCbor[];
  if (!(protectedHeader instanceof Uint8Array) || !bytesEqual(protectedHeader, COSE_PROTECTED_EDDSA)) {
    throw new Error('cose: protected header is not the pinned EdDSA header');
  }
  if (!(payload instanceof Uint8Array)) throw new Error('cose: payload is not a byte string');
  if (!(signature instanceof Uint8Array)) throw new Error('cose: signature is not a byte string');
  return { claim: payload, signature };
}
