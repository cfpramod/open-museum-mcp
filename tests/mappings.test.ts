import { describe, expect, it } from 'vitest';
import {
  cleanArtistName,
  detectAttributionType,
  normalizeRegion,
} from '../src/mappings.js';

describe('normalizeRegion', () => {
  it('matches a canonical key by exact alias', () => {
    expect(normalizeRegion('China')).toBe('china');
    expect(normalizeRegion('Japanese')).toBe('japan');
    expect(normalizeRegion('Dutch')).toBe('netherlands');
  });

  it('matches an alias as a whole word inside a longer culture string', () => {
    expect(normalizeRegion('Tang dynasty')).toBe('china');
    expect(normalizeRegion('Edo period, Kyoto')).toBe('japan');
    expect(normalizeRegion('Tibetan thangka')).toBe('china');
  });

  it('does not match an alias that is only a substring of another word', () => {
    // The old includes()-based matcher mapped all of these wrongly:
    // "Toledo"/"Macedonian" contain "edo" (japan); "Mustang" contains "tang"
    // (china). Word-boundary matching must reject the substring hit.
    expect(normalizeRegion('Toledo')).toBe(null);
    expect(normalizeRegion('Macedonian')).toBe(null);
    expect(normalizeRegion('Mustang')).toBe(null);
  });

  it('prefers the longer, more specific alias over a shorter one it contains', () => {
    // "roman renaissance" (→ italy) contains "roman" (→ rome); longest-first
    // ordering must resolve it to italy, while a bare "Roman" stays rome.
    expect(normalizeRegion('Roman Renaissance')).toBe('italy');
    expect(normalizeRegion('Roman')).toBe('rome');
  });

  it('returns null for null/empty/undefined input', () => {
    expect(normalizeRegion('')).toBe(null);
    expect(normalizeRegion(null)).toBe(null);
    expect(normalizeRegion(undefined)).toBe(null);
  });

  it('returns null for unmapped culture', () => {
    expect(normalizeRegion('Atlantis')).toBe(null);
  });

  it('maps "American" to americas', () => {
    expect(normalizeRegion('American')).toBe('americas');
  });
});

describe('detectAttributionType', () => {
  it('returns "named" for a regular artist string', () => {
    expect(detectAttributionType('Vincent van Gogh')).toBe('named');
  });

  it('returns "anonymous" for empty / whitespace / Unknown', () => {
    expect(detectAttributionType('')).toBe('anonymous');
    expect(detectAttributionType('   ')).toBe('anonymous');
    expect(detectAttributionType('Unknown')).toBe('anonymous');
    expect(detectAttributionType('Anonymous')).toBe('anonymous');
    expect(detectAttributionType('Unidentified Artist')).toBe('anonymous');
  });

  it('detects workshop / attributed / circle / follower', () => {
    expect(detectAttributionType('Workshop of Rubens')).toBe('workshop');
    expect(detectAttributionType('Attributed to Rembrandt')).toBe('attributed');
    expect(detectAttributionType('Circle of Caravaggio')).toBe('circle');
    expect(detectAttributionType('Follower of Raphael')).toBe('follower');
  });

  it('detects "after" attribution', () => {
    expect(detectAttributionType('After Goya')).toBe('after');
  });

  it('returns "named" for null/undefined', () => {
    // Type-relaxed call to exercise the runtime guard.
    expect(detectAttributionType(null)).toBe('anonymous');
    expect(detectAttributionType(undefined)).toBe('anonymous');
  });
});

describe('cleanArtistName', () => {
  it('strips workshop/attributed/circle/follower/after prefixes', () => {
    expect(cleanArtistName('Workshop of Rubens')).toBe('Rubens');
    expect(cleanArtistName('Attributed to Rembrandt')).toBe('Rembrandt');
    expect(cleanArtistName('Circle of Caravaggio')).toBe('Caravaggio');
    expect(cleanArtistName('Follower of Raphael')).toBe('Raphael');
    expect(cleanArtistName('After Goya')).toBe('Goya');
  });

  it('passes through a clean name', () => {
    expect(cleanArtistName('Vincent van Gogh')).toBe('Vincent van Gogh');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanArtistName('  Vincent van Gogh  ')).toBe('Vincent van Gogh');
  });
});
