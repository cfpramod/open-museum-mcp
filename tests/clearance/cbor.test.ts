import { describe, expect, it } from 'vitest';
import { encodeCanonicalCbor, cborBytes, cborMap } from '../../src/core/clearance/cbor.js';

/** hex helper for readable known-answer assertions */
const hex = (u: Uint8Array): string =>
  Array.from(u)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('encodeCanonicalCbor — RFC 8949 deterministic encoding (known-answer vectors)', () => {
  // Vectors straight from RFC 8949 Appendix A. The whole Tier-1 seam rests on
  // these bytes being reproducible, so they are pinned as known-answers.
  it.each([
    [0, '00'],
    [1, '01'],
    [10, '0a'],
    [23, '17'],
    [24, '1818'],
    [100, '1864'],
    [1000, '1903e8'],
    [-1, '20'],
    [-10, '29'],
    [-100, '3863'],
  ])('encodes integer %d as %s', (n, expected) => {
    expect(hex(encodeCanonicalCbor(n))).toBe(expected);
  });

  it.each([
    ['', '60'],
    ['a', '6161'],
    ['IETF', '6449455446'],
  ])('encodes text string %j as %s', (s, expected) => {
    expect(hex(encodeCanonicalCbor(s))).toBe(expected);
  });

  it('encodes byte strings (major type 2)', () => {
    expect(hex(encodeCanonicalCbor(cborBytes(new Uint8Array([]))))).toBe('40');
    expect(hex(encodeCanonicalCbor(cborBytes(new Uint8Array([1, 2, 3, 4]))))).toBe('4401020304');
  });

  it('encodes arrays', () => {
    expect(hex(encodeCanonicalCbor([]))).toBe('80');
    expect(hex(encodeCanonicalCbor([1, 2, 3]))).toBe('83010203');
  });

  it('encodes maps with deterministic (bytewise) key ordering', () => {
    expect(hex(encodeCanonicalCbor(cborMap([])))).toBe('a0');
    // {1:2, 3:4}
    expect(hex(encodeCanonicalCbor(cborMap([[1, 2], [3, 4]])))).toBe('a201020304');
    // {"a":1, "b":[2,3]}
    expect(
      hex(encodeCanonicalCbor(cborMap([['a', 1], ['b', [2, 3]]]))),
    ).toBe('a26161016162820203');
  });

  it('sorts map keys by encoded bytes regardless of insertion order (RFC 8949 §4.2.1)', () => {
    // shorter key encodings sort before longer ones: "a" (0x6161) < "aa" (0x626161)
    const out = hex(encodeCanonicalCbor(cborMap([['aa', 2], ['a', 1]])));
    const inOrder = hex(encodeCanonicalCbor(cborMap([['a', 1], ['aa', 2]])));
    expect(out).toBe(inOrder);
    // and numeric keys (1 byte) sort before the 2-byte text key
    expect(hex(encodeCanonicalCbor(cborMap([['z', 9], [1, 8]])))).toBe(
      hex(encodeCanonicalCbor(cborMap([[1, 8], ['z', 9]]))),
    );
  });

  it('rejects non-integer numbers (no floats in the deterministic profile)', () => {
    expect(() => encodeCanonicalCbor(1.5)).toThrow(/integer/i);
  });
});
