import { describe, expect, it } from 'vitest';
import { coerceFiniteNumber, pickMaxResolution } from '../../src/fetchers/helpers.js';

describe('coerceFiniteNumber', () => {
  it('passes finite numbers through', () => {
    expect(coerceFiniteNumber(11966)).toBe(11966);
    expect(coerceFiniteNumber(0)).toBe(0);
    expect(coerceFiniteNumber(-5)).toBe(-5);
  });

  it('parses numeric strings (Cleveland publishes dims as strings)', () => {
    expect(coerceFiniteNumber('11966')).toBe(11966);
    expect(coerceFiniteNumber('  7990  ')).toBe(7990);
  });

  it('returns null for non-finite, empty, or non-numeric values', () => {
    expect(coerceFiniteNumber('')).toBeNull();
    expect(coerceFiniteNumber('   ')).toBeNull();
    expect(coerceFiniteNumber('abc')).toBeNull();
    expect(coerceFiniteNumber(NaN)).toBeNull();
    expect(coerceFiniteNumber(Infinity)).toBeNull();
    expect(coerceFiniteNumber(null)).toBeNull();
    expect(coerceFiniteNumber(undefined)).toBeNull();
    expect(coerceFiniteNumber({})).toBeNull();
  });
});

describe('pickMaxResolution', () => {
  it('picks the candidate with the largest pixel AREA (portrait master beats wide derivative)', () => {
    // A 3400×2270 wide derivative vs an 11966×7990 master — master wins by area.
    expect(
      pickMaxResolution({ width: 3400, height: 2270 }, { width: 11966, height: 7990 }),
    ).toEqual({ width: 11966, height: 7990 });
  });

  it('ignores candidates missing either dimension', () => {
    expect(
      pickMaxResolution({ width: 2900 }, { width: 2900, height: 4362 }),
    ).toEqual({ width: 2900, height: 4362 });
  });

  it('ignores zero/negative/undefined candidates and returns undefined when none qualify', () => {
    expect(pickMaxResolution(undefined, { width: 0, height: 100 }, { width: -1, height: -1 })).toBeUndefined();
    expect(pickMaxResolution()).toBeUndefined();
    expect(pickMaxResolution(undefined)).toBeUndefined();
  });

  it('handles a single valid candidate (the common max-already case)', () => {
    expect(pickMaxResolution({ width: 4649, height: 5177 })).toEqual({ width: 4649, height: 5177 });
  });
});
