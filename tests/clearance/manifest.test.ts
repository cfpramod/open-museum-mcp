import { describe, expect, it } from 'vitest';
import { buildClearancePayload } from '../../src/core/clearance/manifest.js';
import type { Artwork } from '../../src/types.js';

const NOW = '2026-06-05T12:00:00.000Z';
const OPTS = { engineVersion: '0.7.0', now: NOW };

function cc0Met(over: Partial<Artwork> = {}): Artwork {
  return {
    id: 'met:436535',
    museum: { code: 'met', name: 'The Metropolitan Museum of Art', url: 'https://www.metmuseum.org' },
    title: 'Wheat Field with Cypresses',
    artist: {
      name: 'Vincent van Gogh',
      nationality: 'Dutch',
      lifespan: '1853–1890',
      attributionType: 'named',
    },
    displayDate: '1889',
    yearStart: 1889,
    yearEnd: 1889,
    medium: 'Oil on canvas',
    region: 'Europe',
    period: null,
    imageUrls: {
      full: 'https://images.metmuseum.org/CRDImages/ep/original/436535.jpg',
      thumbnail: 'https://images.metmuseum.org/CRDImages/ep/web-large/436535.jpg',
    },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: 'met.isPublicDomain',
      verifiedAt: '2026-01-02T03:04:05.000Z',
      confidence: 'high',
    },
    source: {
      apiUrl: 'https://collectionapi.metmuseum.org/public/collection/v1/objects/436535',
      pageUrl: 'https://www.metmuseum.org/art/collection/search/436535',
    },
    ...over,
  };
}

describe('buildClearancePayload — accepted CC0', () => {
  const p = buildClearancePayload({ status: 'accepted', artwork: cc0Met() }, OPTS);

  it('carries the JSON-LD envelope constants (schema.org with trailing slash)', () => {
    expect(p.type).toBe('ClearanceManifest');
    expect(p.specVersion).toBe('0.1');
    expect(p['@context']).toContain('https://schema.org/');
    expect(p['@context']).toContain('http://purl.org/dc/terms/');
    expect(p['@context']).toContain('https://openclearance.org/v0.1/context.jsonld');
  });

  it('mirrors engine Artwork vocabulary in work + source', () => {
    expect(p.work.id).toBe('met:436535');
    expect(p.work.title).toBe('Wheat Field with Cypresses');
    expect(p.work.artist?.name).toBe('Vincent van Gogh');
    expect(p.work.displayDate).toBe('1889');
    expect(p.work.yearStart).toBe(1889);
    expect(p.work.medium).toBe('Oil on canvas');
    expect(p.source.museum).toEqual({
      code: 'met',
      name: 'The Metropolitan Museum of Art',
      url: 'https://www.metmuseum.org',
    });
    expect(p.source.apiUrl).toContain('collectionapi.metmuseum.org');
    expect(p.source.imageUrls?.full).toContain('images.metmuseum.org');
  });

  it('permits all uses with high confidence and the CC0 statement', () => {
    expect(p.clearance.commercialReproduction.permitted).toBe(true);
    expect(p.clearance.derivatives.permitted).toBe(true);
    expect(p.clearance.attributionRequired.required).toBe(false);
    expect(p.clearance.commercialReproduction.basis.rule).toBe('cc0-grants-commercial');
    expect(p.rights.statement).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(p.rights.confidence).toBe('high');
  });

  it('binds the raw API value to its field name (forensic link)', () => {
    expect(p.rights.sourceApiValue).toEqual({ field: 'isPublicDomain', value: 'true' });
    expect(p.rights.imageOpenAccess).toBe(true);
    expect(p.rights.metadataOpenAccess).toBe(true);
  });

  it('records the determination as an auditable event sourced to the museum', () => {
    expect(p.verification.determinedBy).toEqual({ actor: 'museum:met', role: 'rights-source' });
    expect(p.verification.tool).toBe('open-museum-mcp@0.7.0 · met.isPublicDomain');
    // determinedAt is the engine verification time, deterministic (not build time)
    expect(p.verification.determinedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(p.verification.determinationSource).toMatchObject({
      type: 'api-field',
      field: 'isPublicDomain',
      retrievedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(p.verification.ruleContext).toContain('CC0');
  });

  it('emits all three citation styles', () => {
    expect(p.citation?.full.length).toBeGreaterThan(0);
    expect(p.citation?.caption.length).toBeGreaterThan(0);
    expect(p.citation?.short.length).toBeGreaterThan(0);
  });

  it('never embeds its own hash (payload purity)', () => {
    expect(p).not.toHaveProperty('integrity');
    expect(p).not.toHaveProperty('hash');
  });
});

describe('buildClearancePayload — rejected / deny', () => {
  const p = buildClearancePayload(
    {
      status: 'rejected',
      rejection: {
        id: 'xyz:1',
        museumCode: 'xyz',
        reason: "rights_status='Educational Only' (strict default reject)",
        rawSnapshot: { rights_status: 'Educational Only' },
      },
    },
    OPTS,
  );

  it('is a definitive deny, not an error — all clearance false, low confidence, null statement', () => {
    expect(p.type).toBe('ClearanceManifest');
    expect(p.clearance.commercialReproduction.permitted).toBe(false);
    expect(p.clearance.derivatives.permitted).toBe(false);
    expect(p.clearance.attributionRequired.required).toBe(false);
    expect(p.rights.statement).toBeNull();
    expect(p.rights.confidence).toBe('low');
    expect(p.rights.sourceApiValue).toBeNull();
    expect(p.rights.imageOpenAccess).toBe(false);
    expect(p.rights.metadataOpenAccess).toBe(false);
  });

  it('carries the gate reason verbatim in the basis (default-deny rule)', () => {
    const b = p.clearance.commercialReproduction.basis;
    expect(b.rule).toBe('default-deny');
    expect(b.summary).toContain('default deny');
    expect(b.summary).toContain('Educational Only');
    expect(b.inputs).toContainEqual({
      field: 'rejection.reason',
      value: "rights_status='Educational Only' (strict default reject)",
    });
  });

  it('attributes the deny to the engine rights-gate, not the museum', () => {
    expect(p.verification.determinedBy).toEqual({
      actor: 'engine:open-museum-mcp',
      role: 'rights-gate',
    });
    expect(p.verification.determinedAt).toBe(NOW);
    expect(p.work.id).toBe('xyz:1');
    expect(p.source.museum.code).toBe('xyz');
  });

  it('omits citation for an unidentified rejected record', () => {
    expect(p.citation).toBeUndefined();
  });
});
