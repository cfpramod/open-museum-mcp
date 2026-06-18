import { describe, expect, it } from 'vitest';
import {
  type CborValue,
  cborBytes,
  cborMap,
  decodeCanonicalCbor,
  encodeCanonicalCbor,
} from '../../src/core/clearance/cbor.js';

const bytesFromHex = (h: string): Uint8Array =>
  new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

describe('decodeCanonicalCbor — inverse of the deterministic encoder', () => {
  it.each([
    ['00', 0],
    ['1818', 24],
    ['1903e8', 1000],
    ['20', -1],
    ['3863', -100],
  ])('decodes integer %s -> %d', (h, n) => {
    expect(decodeCanonicalCbor(bytesFromHex(h)).value).toBe(n);
  });

  it('decodes text strings and byte strings', () => {
    expect(decodeCanonicalCbor(bytesFromHex('6449455446')).value).toBe('IETF');
    const decoded = decodeCanonicalCbor(bytesFromHex('4401020304')).value as Uint8Array;
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  it('decodes arrays', () => {
    expect(decodeCanonicalCbor(bytesFromHex('83010203')).value).toEqual([1, 2, 3]);
  });

  it('decodes a COSE_Sign1-shaped array: [bstr, map, bstr, bstr]', () => {
    // ["Signature1", h'a10127', h'', h'cafe'] then a separate real Sign1 below
    const enc = encodeCanonicalCbor([
      'Signature1',
      cborBytes(bytesFromHex('a10127')),
      cborBytes(new Uint8Array(0)),
      cborBytes(bytesFromHex('cafe')),
    ]);
    const arr = decodeCanonicalCbor(enc).value as CborValue[];
    expect(arr[0]).toBe('Signature1');
    expect(Array.from(arr[1] as Uint8Array)).toEqual([0xa1, 0x01, 0x27]);
    expect((arr[2] as Uint8Array).length).toBe(0);
    expect(Array.from(arr[3] as Uint8Array)).toEqual([0xca, 0xfe]);
  });

  it('round-trips arbitrary supported structures', () => {
    const value = cborMap([
      ['claim_generator', 'open-museum.art'],
      ['n', 42],
      ['neg', -7],
      ['data', cborBytes(bytesFromHex('deadbeef'))],
      ['list', [1, 'a', cborBytes(new Uint8Array([9]))]],
    ]);
    const round = decodeCanonicalCbor(encodeCanonicalCbor(value)).value;
    // maps decode to a Map keyed by the decoded key
    expect(round instanceof Map).toBe(true);
    const m = round as Map<unknown, unknown>;
    expect(m.get('claim_generator')).toBe('open-museum.art');
    expect(m.get('n')).toBe(42);
    expect(m.get('neg')).toBe(-7);
    expect(Array.from(m.get('data') as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('rejects trailing garbage (strict, fail-closed parsing)', () => {
    expect(() => decodeCanonicalCbor(bytesFromHex('0001'))).toThrow();
  });
});
