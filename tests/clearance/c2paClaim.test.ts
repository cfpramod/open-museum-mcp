import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COSE_PROTECTED_EDDSA,
  buildC2paClaim,
  coseSigStructure,
  hardBindingAssertionBytes,
} from '../../src/core/clearance/c2paClaim.js';

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const eqBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
/** naive subsequence search to assert a hash actually rides inside the claim bytes */
const contains = (hay: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

const payload = enc('{"type":"ClearanceManifest","work":{"id":"met:1"}}');
const imageHash = sha256(enc('fake-image-bytes'));
const claimGenerator = 'open-museum.art';
const input = { payloadBytes: payload, imageHash, claimGenerator };

describe('buildC2paClaim — deterministic, key-independent C2PA claim (claimToBeSigned)', () => {
  it('is byte-for-byte deterministic for identical inputs', async () => {
    expect(eqBytes(await buildC2paClaim(input), await buildC2paClaim(input))).toBe(true);
  });

  it('binds the EXACT payload bytes: the clearance-assertion hash = sha256(payload) rides in the claim', async () => {
    const claim = await buildC2paClaim(input);
    expect(contains(claim, sha256(payload))).toBe(true);
  });

  it('hard-binds the image transitively: the claim references the hard-binding assertion by its hash', async () => {
    // The claim does NOT carry the raw image hash; it carries the hash of the
    // hard-binding ASSERTION, which in turn carries the image hash. Binding is
    // claim -> sha256(hardBindingAssertion) -> assertion{ hash: sha256(image) }.
    const claim = await buildC2paClaim(input);
    const hardBindingHash = sha256(hardBindingAssertionBytes(imageHash));
    expect(contains(claim, hardBindingHash)).toBe(true);
    // and the raw image hash is NOT directly in the claim (it lives in the assertion)
    expect(contains(claim, imageHash)).toBe(false);
  });

  it('changes when the payload changes (tamper-evident foundation)', async () => {
    const other = await buildC2paClaim({ ...input, payloadBytes: enc('{"type":"ClearanceManifest"}') });
    expect(eqBytes(await buildC2paClaim(input), other)).toBe(false);
  });

  it('changes when the bound image changes', async () => {
    const other = await buildC2paClaim({ ...input, imageHash: sha256(enc('different-image')) });
    expect(eqBytes(await buildC2paClaim(input), other)).toBe(false);
  });
});

describe('hardBindingAssertionBytes — reconstructable from the boundAsset hash alone', () => {
  it('is deterministic and carries the image hash', () => {
    const a = hardBindingAssertionBytes(imageHash);
    expect(eqBytes(a, hardBindingAssertionBytes(imageHash))).toBe(true);
    expect(contains(a, imageHash)).toBe(true);
  });
});

describe('coseSigStructure — the pinned Ed25519 to-be-signed input', () => {
  it('uses the EdDSA protected header {1:-8} = a10127', () => {
    expect(
      Array.from(COSE_PROTECTED_EDDSA)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    ).toBe('a10127');
  });

  it('is a 4-element COSE Sig_structure: ["Signature1", bstr(protected), bstr(""), bstr(claim)]', async () => {
    const claim = await buildC2paClaim(input);
    const sig = coseSigStructure(claim);
    // CBOR array of 4: 0x84 ; then text "Signature1" (0x6a 53 69 67 ...)
    expect(sig[0]).toBe(0x84);
    expect(sig[1]).toBe(0x6a); // text string length 10
    expect(new TextDecoder().decode(sig.slice(2, 12))).toBe('Signature1');
    // the protected header rides bstr-wrapped (0x43 = bstr len 3, then a10127)
    expect(contains(sig, new Uint8Array([0x43, 0xa1, 0x01, 0x27]))).toBe(true);
    // the claim bytes ride verbatim inside the structure (the COSE payload)
    expect(contains(sig, claim)).toBe(true);
  });

  it('is deterministic', async () => {
    const claim = await buildC2paClaim(input);
    expect(eqBytes(coseSigStructure(claim), coseSigStructure(claim))).toBe(true);
  });
});
