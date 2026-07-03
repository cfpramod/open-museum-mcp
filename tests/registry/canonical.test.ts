import { describe, expect, it } from 'vitest';
import { canonicalStatus, PENDING_OC_TIER } from '../../src/core/registry/index.js';
import type { Assertion } from '../../src/core/registry/index.js';

function assertion(over: Partial<Assertion> = {}): Assertion {
  return {
    id: 'a1',
    subject: 'cleveland:1',
    field: 'title',
    value: 'Test',
    evidence: [{ type: 'museum-record', citation: 'c', retrievedAt: '2026-01-01T00:00:00.000Z' }],
    disputeStatus: 'undisputed',
    assertedBy: { contributorId: 'system', ocmTier: PENDING_OC_TIER },
    assertedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('canonicalStatus', () => {
  it('is canonical when any assertion carries museum-record evidence', () => {
    expect(canonicalStatus([assertion()])).toBe('canonical');
  });

  it('is pre-canonical-pending when every assertion is self-attested only', () => {
    const selfAttested = assertion({
      evidence: [{ type: 'artist-attestation', citation: 'artist claim', retrievedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(canonicalStatus([selfAttested])).toBe('pre-canonical-pending');
  });

  it('crosses to canonical once ANY assertion (not all) gains external evidence', () => {
    const selfAttested = assertion({
      id: 'a1',
      evidence: [{ type: 'artist-attestation', citation: 'artist claim', retrievedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const counterSigned = assertion({
      id: 'a2',
      evidence: [{ type: 'scholar-review', citation: 'review', retrievedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(canonicalStatus([selfAttested, counterSigned])).toBe('canonical');
  });

  it('is pre-canonical-pending for an entry with no assertions at all', () => {
    expect(canonicalStatus([])).toBe('pre-canonical-pending');
  });
});
