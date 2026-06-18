import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { wrapTier0 } from '../../src/core/clearance/envelope.js';
import { buildC2paClaim, hardBindingAssertionBytes } from '../../src/core/clearance/c2paClaim.js';
import { prepareTier1 } from '../../src/core/clearance/tier1.js';

const sha256hex = (b: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof b === 'string' ? new TextEncoder().encode(b) : b)
    .digest('hex');
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

// a realistic byte-exact payload string (as the engine would emit it)
const payloadObj = { type: 'ClearanceManifest', work: { id: 'met:1' }, verification: { determinedBy: { actor: 'museum:met', role: 'rights-source' } } };
const payload = JSON.stringify(payloadObj);
const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]); // pretend JPEG

describe('prepareTier1 — keyless Tier-1 signing request (the frozen seam)', () => {
  it('preserves the payload string byte-for-byte', async () => {
    const req = await prepareTier1(payload, imageBytes);
    expect(req.payload).toBe(payload);
    expect(req.payloadType).toBe('application/clearance-manifest+json');
  });

  it('integrity is the tier-stable sha-256 of the payload bytes (identical to Tier-0)', async () => {
    const req = await prepareTier1(payload, imageBytes);
    expect(req.integrity).toEqual({ alg: 'sha-256', hash: sha256hex(payload) });
    // tier-stability: the same hash a Tier-0 envelope of the same payload carries
    const tier0 = await wrapTier0(payloadObj);
    expect(req.integrity.hash).toBe(tier0.integrity.hash);
  });

  it('boundAsset is the sha-256 hard-binding to the delivered image bytes', async () => {
    const req = await prepareTier1(payload, imageBytes);
    expect(req.boundAsset).toEqual({
      assetType: 'image',
      alg: 'sha-256',
      hash: sha256hex(imageBytes),
    });
  });

  it('emits claimToBeSigned = the canonical C2PA claim bytes, plus the hard-binding assertion', async () => {
    const req = await prepareTier1(payload, imageBytes);
    expect(req.c2pa.clearanceAssertionLabel).toBe('org.openclearance.clearance-manifest');

    const expectedClaim = await buildC2paClaim({
      payloadBytes: new TextEncoder().encode(payload),
      imageHash: new Uint8Array(createHash('sha256').update(imageBytes).digest()),
      claimGenerator: req.c2pa.claimGenerator,
    });
    expect(req.c2pa.claimToBeSigned).toBe(b64(expectedClaim));
    expect(req.c2pa.hardBindingAssertion).toBe(
      b64(hardBindingAssertionBytes(new Uint8Array(createHash('sha256').update(imageBytes).digest()))),
    );
  });

  it('defaults the claim generator to open-museum.art and honors an override', async () => {
    expect((await prepareTier1(payload, imageBytes)).c2pa.claimGenerator).toBe('open-museum.art');
    expect((await prepareTier1(payload, imageBytes, { claimGenerator: 'example.org' })).c2pa.claimGenerator).toBe(
      'example.org',
    );
  });

  it('is deterministic (no randomness) — equal inputs give equal requests', async () => {
    expect(await prepareTier1(payload, imageBytes)).toEqual(await prepareTier1(payload, imageBytes));
  });

  it('holds NOTHING secret: the request is pure construction (no signature, no key field)', async () => {
    const req = await prepareTier1(payload, imageBytes);
    const json = JSON.stringify(req).toLowerCase();
    expect(json).not.toContain('privatekey');
    expect(json).not.toContain('signature');
    expect(req.c2pa.signature).toBeUndefined();
  });
});
