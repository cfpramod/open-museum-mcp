import { describe, expect, it } from 'vitest';
import {
  proposeWriteBack,
  validateWriteBackRequest,
  type RegistryEntry,
  type WriteBackRequest,
} from '../../src/core/registry/index.js';
import { memoryRegistryStore } from './helpers.js';

function baseEntry(registryId: string): RegistryEntry {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    identity: { registryId, sourceRefs: [{ source: 'cleveland', id: registryId, role: 'primary' }], createdAt: now },
    assertions: [
      {
        id: `${registryId}:1`,
        subject: registryId,
        field: 'title',
        value: 'Test Work',
        evidence: [{ type: 'museum-record', citation: 'c', retrievedAt: now }],
        disputeStatus: 'undisputed',
        assertedBy: { contributorId: 'system:cleveland-harvest', ocmTier: 0 },
        assertedAt: now,
      },
    ],
    rightsPosture: { posture: 'can_store_and_republish', basis: 'CC0', determinedAt: now },
    trust: { contributorCredentialTier: 0, evidenceGrade: 'source-linked' },
    canonicalStatus: 'canonical',
    createdAt: now,
    updatedAt: now,
  };
}

function validRequest(over: Partial<WriteBackRequest> = {}): WriteBackRequest {
  return {
    subject: 'cleveland:1',
    assertion: {
      field: 'exhibitedAt',
      value: 'Musée d’Orsay, 2019',
      evidence: [{ type: 'catalogue-entry', citation: 'Exhibition catalogue p.42', retrievedAt: '2026-07-02T00:00:00.000Z' }],
      disputeStatus: 'undisputed',
      assertedBy: { contributorId: 'om-ed', ocmTier: 3 },
    },
    ...over,
  };
}

describe('validateWriteBackRequest', () => {
  it('accepts a well-formed request', () => {
    expect(validateWriteBackRequest(validRequest())).toBeNull();
  });

  it('rejects a missing subject', () => {
    const reason = validateWriteBackRequest(validRequest({ subject: '' }));
    expect(reason).toContain('subject');
  });

  it('rejects an assertion with zero evidence entries (never a bare value)', () => {
    const req = validRequest();
    req.assertion.evidence = [];
    expect(validateWriteBackRequest(req)).toContain('evidence');
  });

  it('rejects a blank assertion value', () => {
    const req = validRequest();
    req.assertion.value = '   ';
    expect(validateWriteBackRequest(req)).toContain('value');
  });
});

describe('proposeWriteBack', () => {
  it('mints an id + timestamp and appends the assertion via the store, applied for a trusted caller', async () => {
    const { store, entries } = memoryRegistryStore();
    entries.set('cleveland:1', baseEntry('cleveland:1'));

    const out = await proposeWriteBack(store, validRequest(), {
      clock: () => '2026-07-02T12:00:00.000Z',
      idGen: () => 'fixed-id',
    });

    expect(out).toEqual({ ok: true, assertionId: 'fixed-id', status: 'applied' });
    const entry = entries.get('cleveland:1');
    expect(entry?.assertions).toHaveLength(2);
    const appended = entry?.assertions[1];
    expect(appended).toMatchObject({
      id: 'fixed-id',
      subject: 'cleveland:1',
      field: 'exhibitedAt',
      assertedAt: '2026-07-02T12:00:00.000Z',
    });
    // full evidence carried through, never stripped
    expect(appended?.evidence).toHaveLength(1);
  });

  it('returns ok:false without touching the store when the request is invalid', async () => {
    const { store, entries } = memoryRegistryStore();
    entries.set('cleveland:1', baseEntry('cleveland:1'));

    const bad = validRequest();
    bad.assertion.evidence = [];
    const out = await proposeWriteBack(store, bad);

    expect(out.ok).toBe(false);
    expect(entries.get('cleveland:1')?.assertions).toHaveLength(1); // unchanged
  });
});
