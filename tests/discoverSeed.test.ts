import { describe, expect, it } from 'vitest';
import { buildSeedQueryFromConstraints } from '../src/discoverSeed.js';

describe('buildSeedQueryFromConstraints', () => {
  it('returns null when neither region nor period is set', () => {
    // No-constraints discover_random should NOT auto-seed — that would be a
    // generic "art" search, wasteful and surprising. The handler surfaces a
    // hint instead.
    expect(buildSeedQueryFromConstraints({})).toBeNull();
  });

  it('returns the period alone when only period is set', () => {
    expect(buildSeedQueryFromConstraints({ period: 'edo' })).toBe('edo');
  });

  it('returns the region alone when only region is set', () => {
    expect(buildSeedQueryFromConstraints({ region: 'japan' })).toBe('japan');
  });

  it('returns "period region" when both are set (period first; it discriminates better)', () => {
    expect(buildSeedQueryFromConstraints({ period: 'edo', region: 'japan' })).toBe('edo japan');
  });

  it('handles multi-word period values without re-quoting', () => {
    // "tang dynasty" is a normal period tag; the seed query is just the
    // tokens joined — let upstream search engines handle it.
    expect(buildSeedQueryFromConstraints({ period: 'tang dynasty' })).toBe('tang dynasty');
  });

  it('handles multi-word region values', () => {
    expect(buildSeedQueryFromConstraints({ region: 'south asia' })).toBe('south asia');
  });
});
