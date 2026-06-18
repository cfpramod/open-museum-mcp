import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { assembleCoseSign1, coseSigStructure } from '../../src/core/clearance/c2paClaim.js';
import { prepareTier1, verifyTier1, type Tier1Envelope } from '../../src/core/clearance/tier1.js';

const subtle = webcrypto.subtle;
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A byte-exact v0.1 payload whose determination is by museum:met.
const payloadObj = {
  type: 'ClearanceManifest',
  work: { id: 'met:1' },
  verification: { determinedBy: { actor: 'museum:met', role: 'rights-source' } },
};
const payload = JSON.stringify(payloadObj);
const imageBytes = enc('delivered-print-ready-image-bytes');

const ATTESTOR_DID = 'did:web:open-museum.art';
const ACTOR = 'museum:met';

let keyPair: webcrypto.CryptoKeyPair;
let attestorPubRaw: Uint8Array;

/**
 * Simulate the OMA signing service (OM-A scope): sign the lib's `claimToBeSigned`
 * VERBATIM inside the pinned COSE Sig_structure, then assemble a Tier-1 envelope.
 * Returns the envelope plus a resolver that maps the attestor DID to the public key.
 */
async function signAsService(
  req: Awaited<ReturnType<typeof prepareTier1>>,
  opts: { attestorDid?: string; actor?: string; signingKey?: webcrypto.CryptoKey; tamperSig?: boolean } = {},
): Promise<{ envelope: Tier1Envelope; resolveSigner: (did: string) => Promise<Uint8Array | null> }> {
  const claimBytes = fromB64(req.c2pa.claimToBeSigned);
  const sigStructure = coseSigStructure(claimBytes);
  const sig = new Uint8Array(
    await subtle.sign('Ed25519', opts.signingKey ?? keyPair.privateKey, sigStructure),
  );
  if (opts.tamperSig) sig[0] ^= 0xff;
  const coseSign1 = assembleCoseSign1(claimBytes, sig);

  const envelope: Tier1Envelope = {
    tier: 1,
    payloadType: 'application/clearance-manifest+json',
    payload: req.payload,
    integrity: req.integrity,
    attestation: {
      attestor: { did: opts.attestorDid ?? ATTESTOR_DID, role: 'delegated-attestor' },
      actor: opts.actor ?? ACTOR,
      boundAsset: { ...req.boundAsset, binding: 'c2pa-hard-binding' },
      c2pa: {
        claimGenerator: req.c2pa.claimGenerator,
        clearanceAssertionLabel: req.c2pa.clearanceAssertionLabel,
        manifest: { format: 'detached', value: b64(coseSign1) },
        signature: { alg: 'ed25519' },
        identityBinding: { method: 'cawg-identity-assertion' },
      },
    },
  };
  return { envelope, resolveSigner: async (did) => (did === (opts.attestorDid ?? ATTESTOR_DID) ? attestorPubRaw : null) };
}

beforeAll(async () => {
  keyPair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  attestorPubRaw = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
});

describe('verifyTier1 — fail-closed delegated-attestor verifier', () => {
  it('ATTESTED_DELEGATE when sig is valid, signer resolves to attestor.did, and attestor != actor', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req);
    const result = await verifyTier1(envelope, { resolveSigner, assetBytes: imageBytes });
    expect(result.state).toBe('ATTESTED_DELEGATE');
  });

  it('REJECTED on integrity mismatch (payload tampered after hashing)', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req);
    envelope.payload = JSON.stringify({ ...payloadObj, work: { id: 'met:999' } }); // swap payload, keep old hash
    const result = await verifyTier1(envelope, { resolveSigner });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/integrity/i);
  });

  it('REJECTED on a tampered signature (never demoted to UNVERIFIED_SIGNAL)', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req, { tamperSig: true });
    const result = await verifyTier1(envelope, { resolveSigner });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/signature/i);
  });

  it('REJECTED when the signer does not resolve to attestor.did (wrong key)', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const otherKey = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const { envelope } = await signAsService(req, { signingKey: otherKey.privateKey });
    // resolver returns the LEGITIMATE attestor key, but the envelope was signed by another key
    const result = await verifyTier1(envelope, { resolveSigner: async (d) => (d === ATTESTOR_DID ? attestorPubRaw : null) });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/signature/i);
  });

  it('REJECTED when the attestor DID cannot be resolved at all', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope } = await signAsService(req);
    const result = await verifyTier1(envelope, { resolveSigner: async () => null });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/resolve|signer|did/i);
  });

  it('REJECTED (C1) when attestation.actor != payload.verification.determinedBy.actor', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req, { actor: 'museum:aic' }); // payload says museum:met
    const result = await verifyTier1(envelope, { resolveSigner });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/actor/i);
  });

  it('REJECTED when attestor.did == actor (not a genuine delegate)', async () => {
    // payload actor and attestor both did:web:open-museum.art -> no delegation separation
    const selfPayload = JSON.stringify({
      type: 'ClearanceManifest',
      work: { id: 'met:1' },
      verification: { determinedBy: { actor: ATTESTOR_DID, role: 'self' } },
    });
    const req = await prepareTier1(selfPayload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req, { actor: ATTESTOR_DID });
    const result = await verifyTier1(envelope, { resolveSigner });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/delegate|actor/i);
  });

  it('REJECTED when bound-asset bytes do not match boundAsset.hash', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req);
    const result = await verifyTier1(envelope, { resolveSigner, assetBytes: enc('a different image') });
    expect(result.state).toBe('REJECTED');
    expect(result.reason).toMatch(/asset|bound/i);
  });

  it('REJECTED on a non-Tier-1 envelope (fail-closed on shape)', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const { envelope, resolveSigner } = await signAsService(req);
    const broken = { ...envelope, tier: 0 } as unknown as Tier1Envelope;
    const result = await verifyTier1(broken, { resolveSigner });
    expect(result.state).toBe('REJECTED');
  });

  it('REJECTED when the COSE claim payload does not match the envelope-reconstructed claim', async () => {
    // sign a DIFFERENT claim (different image) but present the original envelope fields
    const req = await prepareTier1(payload, imageBytes);
    const otherReq = await prepareTier1(payload, enc('a totally different image'));
    const { envelope } = await signAsService(otherReq); // COSE binds the other image's claim
    envelope.payload = req.payload;
    envelope.integrity = req.integrity;
    envelope.attestation.boundAsset = { ...req.boundAsset, binding: 'c2pa-hard-binding' };
    const result = await verifyTier1(envelope, { resolveSigner: async (d) => (d === ATTESTOR_DID ? attestorPubRaw : null) });
    expect(result.state).toBe('REJECTED');
  });
});
