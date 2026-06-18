/**
 * Tier-1 delegated-attestor envelope/format library — KEYLESS.
 *
 * This is the engine half of the openclearance COA honesty chain (build contract
 * `om-c-tier1-attestor-build-contract-2026-06-18`, OM-CR lock-verified + C1/C2).
 * It builds the Tier-1 envelope structure, the C2PA claim/assertions (image
 * hard-binding + a clearance assertion carrying the EXACT payload bytes), and all
 * hashes, and it verifies signed envelopes with PUBLIC KEYS ONLY. It never sees a
 * private key, never signs, never hosts a secret.
 *
 * The seam with the OMA signing service is the signature operation, and only that:
 *   prepareTier1(payloadString, imageBytes) -> Tier1SigningRequest   (this lib)
 *   sign(Tier1SigningRequest)               -> Tier1Envelope          (OMA service)
 * The lib emits `claimToBeSigned` (canonical C2PA claim bytes); the service signs
 * them VERBATIM inside the pinned COSE Sig_structure (see c2paClaim.ts) and
 * assembles/embeds the manifest store. No re-canonicalization (contract C2).
 */
import {
  CLEARANCE_ASSERTION_LABEL,
  buildC2paClaim,
  coseSigStructure,
  decodeCoseSign1,
  hardBindingAssertionBytes,
} from './c2paClaim.js';
import { asBufferSource } from './cbor.js';

const PAYLOAD_TYPE = 'application/clearance-manifest+json' as const;
const DEFAULT_CLAIM_GENERATOR = 'open-museum.art';

/** The keyless signing request the lib emits; only its COSE signature needs a key. */
export interface Tier1SigningRequest {
  payloadType: typeof PAYLOAD_TYPE;
  /** The EXACT UTF-8 JSON string of the v0.1 payload — byte-identical across tiers. */
  payload: string;
  /** Inner integrity over the payload bytes — tier-stable (identical to Tier-0). */
  integrity: { alg: 'sha-256'; hash: string };
  /** The image asset the C2PA manifest hard-binds to (OMA's delivered rendition). */
  boundAsset: { assetType: 'image'; alg: 'sha-256'; hash: string };
  c2pa: {
    claimGenerator: string;
    clearanceAssertionLabel: typeof CLEARANCE_ASSERTION_LABEL;
    /** base64 of the deterministic C2PA hard-binding (`c2pa.hash.data`) assertion bytes. */
    hardBindingAssertion: string;
    /** base64 of the canonical C2PA claim bytes the service signs verbatim. */
    claimToBeSigned: string;
  };
}

export interface PrepareTier1Options {
  /** C2PA claim generator string (default "open-museum.art"). */
  claimGenerator?: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

/**
 * Construct a keyless Tier-1 signing request from the exact payload STRING (the
 * byte-exact v0.1 manifest, as the engine emits it) and the delivered image
 * bytes. Pure + deterministic — no key, no randomness, no I/O.
 *
 * The payload is taken as a STRING, never re-serialized: byte-exact integrity is
 * impossible over a re-parsed object, and the clearance assertion must carry the
 * producer's exact bytes (contract §2). Callers holding an object should serialize
 * it once and pass that string (the same string they hash for Tier-0).
 */
export async function prepareTier1(
  payload: string,
  imageBytes: Uint8Array,
  opts: PrepareTier1Options = {},
): Promise<Tier1SigningRequest> {
  const claimGenerator = opts.claimGenerator ?? DEFAULT_CLAIM_GENERATOR;
  const payloadBytes = new TextEncoder().encode(payload);
  const imageDigest = await crypto.subtle.digest('SHA-256', asBufferSource(imageBytes));
  const imageHash = new Uint8Array(imageDigest);

  const claim = await buildC2paClaim({ payloadBytes, imageHash, claimGenerator });

  return {
    payloadType: PAYLOAD_TYPE,
    payload,
    integrity: { alg: 'sha-256', hash: await sha256Hex(payloadBytes) },
    boundAsset: { assetType: 'image', alg: 'sha-256', hash: await sha256Hex(imageBytes) },
    c2pa: {
      claimGenerator,
      clearanceAssertionLabel: CLEARANCE_ASSERTION_LABEL,
      hardBindingAssertion: b64(hardBindingAssertionBytes(imageHash)),
      claimToBeSigned: b64(claim),
    },
  };
}

// ----------------------------------------------------------------------------
// Verification — KEYLESS, fail-closed (contract §4 + OM-CR C1)
// ----------------------------------------------------------------------------

/**
 * The completed Tier-1 envelope (the OMA service's output; verifier's input).
 * Mirrors `tier1-envelope.schema.json` v0.2. The verification STATE is never a
 * field here — it is derived by `verifyTier1`.
 */
export interface Tier1Envelope {
  tier: 1;
  payloadType: typeof PAYLOAD_TYPE;
  payload: string;
  integrity: { alg: 'sha-256'; hash: string };
  attestation: {
    attestor: { did: string; role: 'delegated-attestor' };
    actor: string;
    boundAsset: {
      assetType: 'image';
      alg: 'sha-256';
      hash: string;
      binding: 'c2pa-hard-binding';
      locator?: string;
    };
    c2pa: {
      claimGenerator: string;
      clearanceAssertionLabel: typeof CLEARANCE_ASSERTION_LABEL;
      manifest: { format: 'embedded' | 'detached'; value?: string; url?: string };
      signature: { alg: 'ed25519' };
      identityBinding: { method: 'cawg-identity-assertion' };
    };
  };
}

/**
 * Output of verification. Tier-1 yields `ATTESTED_DELEGATE` or `REJECTED`; the
 * other states are reserved for sibling tiers (`ATTESTED_DIRECT` = Tier-2 self
 * signing; `UNVERIFIED_SIGNAL` = Tier-0). A broken Tier-1 is REJECTED, NEVER
 * silently demoted to `UNVERIFIED_SIGNAL`.
 */
export type VerificationState =
  | 'ATTESTED_DELEGATE'
  | 'ATTESTED_DIRECT'
  | 'UNVERIFIED_SIGNAL'
  | 'REJECTED';

export interface VerificationResult {
  state: VerificationState;
  /** Present on REJECTED — a short machine-stable reason for diagnostics. */
  reason?: string;
}

export interface VerifyTier1Options {
  /**
   * Resolve the attestor DID to its raw 32-byte Ed25519 public key (e.g. from the
   * DID document at `/.well-known/did.json`). Return null if it cannot be resolved.
   * Injected so the lib stays keyless + does no network I/O itself.
   */
  resolveSigner: (did: string) => Promise<Uint8Array | null> | Uint8Array | null;
  /**
   * OPTIONAL: the delivered image bytes. When provided, the verifier checks
   * `SHA-256(assetBytes) === boundAsset.hash` (external hard-binding proof). When
   * omitted, the binding is still enforced INTRINSICALLY: the signature is
   * verified over a claim reconstructed from `boundAsset.hash`, so a valid
   * signature proves the attestor signed THIS bound hash.
   */
  assetBytes?: Uint8Array;
  /**
   * OPTIONAL: the COSE_Sign1 manifest-store bytes, when the envelope uses
   * `manifest.format='embedded'`/`url` and the caller has fetched/extracted the
   * store (the keyless lib does no network I/O). For `manifest.format='detached'`
   * with a `value`, this is read from the envelope automatically.
   */
  coseSign1?: Uint8Array;
}

const reject = (reason: string): VerificationResult => ({ state: 'REJECTED', reason });

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function structurallyTier1(e: Tier1Envelope): boolean {
  return (
    !!e &&
    e.tier === 1 &&
    e.payloadType === PAYLOAD_TYPE &&
    typeof e.payload === 'string' &&
    !!e.integrity &&
    e.integrity.alg === 'sha-256' &&
    /^[0-9a-f]{64}$/.test(e.integrity.hash ?? '') &&
    !!e.attestation &&
    !!e.attestation.attestor &&
    typeof e.attestation.attestor.did === 'string' &&
    e.attestation.attestor.role === 'delegated-attestor' &&
    typeof e.attestation.actor === 'string' &&
    !!e.attestation.boundAsset &&
    /^[0-9a-f]{64}$/.test(e.attestation.boundAsset.hash ?? '') &&
    !!e.attestation.c2pa
  );
}

/** Extract the v0.1 payload's determining actor, or null if it cannot be read. */
function payloadActor(payload: string): string | null {
  try {
    const obj = JSON.parse(payload) as { verification?: { determinedBy?: { actor?: unknown } } };
    const actor = obj?.verification?.determinedBy?.actor;
    return typeof actor === 'string' ? actor : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Tier-1 delegated-attestor envelope. FAIL-CLOSED: any failed check
 * returns `REJECTED` (never a silent downgrade). Returns `ATTESTED_DELEGATE` iff
 * ALL hold: integrity matches the payload bytes; the envelope's `actor` equals the
 * payload's `verification.determinedBy.actor` (C1); the attestor is a genuine
 * delegate (`attestor.did !== actor`); the attestor DID resolves to a public key;
 * the COSE_Sign1 signature validates over the claim reconstructed from the
 * envelope; and (when asset bytes are supplied) the bound asset matches.
 */
export async function verifyTier1(
  envelope: Tier1Envelope,
  opts: VerifyTier1Options,
): Promise<VerificationResult> {
  // 0. Shape — fail-closed on anything that is not a well-formed Tier-1 envelope.
  if (!structurallyTier1(envelope)) return reject('not a well-formed Tier-1 envelope');
  const { attestation } = envelope;
  const payloadBytes = new TextEncoder().encode(envelope.payload);

  // 1. Inner integrity over the exact payload bytes (tier-stable).
  if ((await sha256HexBytes(payloadBytes)) !== envelope.integrity.hash) {
    return reject('integrity hash does not match payload bytes');
  }

  // 2. C1 — the attested actor must be the actor the determination names.
  const determinedActor = payloadActor(envelope.payload);
  if (determinedActor === null) return reject('payload verification.determinedBy.actor not readable');
  if (determinedActor !== attestation.actor) {
    return reject('actor mismatch: attestation.actor != payload determinedBy.actor');
  }

  // 3. Genuine delegation — the attestor must not be the actor.
  if (attestation.attestor.did === attestation.actor) {
    return reject('attestor.did == actor: not a delegated attestation');
  }

  // 4. Resolve the attestor's public key (keyless — injected resolver).
  const pubRaw = await opts.resolveSigner(attestation.attestor.did);
  if (!pubRaw) return reject('attestor DID did not resolve to a signer key');

  // 5. Obtain the COSE_Sign1 (detached value in-envelope, else caller-provided).
  const manifestValue = attestation.c2pa.manifest?.value;
  const coseBytes = opts.coseSign1 ?? (manifestValue ? new Uint8Array(Buffer.from(manifestValue, 'base64')) : null);
  if (!coseBytes) return reject('no COSE_Sign1 manifest store available to verify');

  let claim: Uint8Array;
  let signature: Uint8Array;
  try {
    ({ claim, signature } = decodeCoseSign1(coseBytes));
  } catch (e) {
    return reject(`malformed COSE_Sign1: ${(e as Error).message}`);
  }

  // 6. Reconstruct the expected claim from the envelope and confirm the signed
  //    claim matches it (defense in depth — the signature must cover OUR claim).
  const expectedClaim = await buildC2paClaim({
    payloadBytes,
    imageHash: hexToBytes(attestation.boundAsset.hash),
    claimGenerator: attestation.c2pa.claimGenerator,
  });
  if (!bytesEqual(claim, expectedClaim)) {
    return reject('signed claim does not match the envelope-reconstructed claim');
  }

  // 7. Verify the Ed25519 signature over the pinned Sig_structure.
  let signatureValid = false;
  try {
    const key = await crypto.subtle.importKey('raw', asBufferSource(pubRaw), { name: 'Ed25519' }, false, ['verify']);
    signatureValid = await crypto.subtle.verify(
      'Ed25519',
      key,
      asBufferSource(signature),
      asBufferSource(coseSigStructure(expectedClaim)),
    );
  } catch {
    return reject('signer key could not be imported for verification');
  }
  if (!signatureValid) return reject('COSE_Sign1 signature is invalid for the attestor key');

  // 8. Optional external hard-binding proof against the delivered asset bytes.
  if (opts.assetBytes) {
    if ((await sha256HexBytes(opts.assetBytes)) !== attestation.boundAsset.hash) {
      return reject('bound asset bytes do not match boundAsset.hash');
    }
  }

  return { state: 'ATTESTED_DELEGATE' };
}
