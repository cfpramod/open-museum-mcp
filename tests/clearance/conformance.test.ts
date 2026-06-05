import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { buildClearancePayload } from '../../src/core/clearance/manifest.js';
import type { Artwork, ValidationResult } from '../../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, '../../spec/clearance/v0.1');
const readJson = (rel: string) => JSON.parse(readFileSync(join(specDir, rel), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(readJson('clearance-manifest.schema.json'));

const OPTS = { engineVersion: '0.7.0', now: '2026-06-05T00:00:00.000Z' };

function cc0Met(): Artwork {
  return {
    id: 'met:436535',
    museum: {
      code: 'met',
      name: 'The Metropolitan Museum of Art',
      url: 'https://www.metmuseum.org',
    },
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
  };
}

const accepted: ValidationResult = { status: 'accepted', artwork: cc0Met() };
const denied: ValidationResult = {
  status: 'rejected',
  rejection: {
    id: 'xyz:1',
    museumCode: 'xyz',
    reason: "rights_status='Educational Use Only' (strict default reject)",
    rawSnapshot: null,
  },
};

describe('Clearance Manifest conformance (ajv Draft 2020-12)', () => {
  it('a freshly-built accepted CC0 payload validates', () => {
    const ok = validate(buildClearancePayload(accepted, OPTS));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('a freshly-built deny payload validates (a deny is a valid manifest)', () => {
    const ok = validate(buildClearancePayload(denied, OPTS));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('an unrecognised basis.rule stays structurally valid (advisory, not a reject)', () => {
    const p = buildClearancePayload(accepted, OPTS);
    p.clearance.commercialReproduction.basis.rule = 'some-unknown-future-rule';
    expect(validate(p)).toBe(true);
  });

  it('rejects a payload missing a required block', () => {
    const p = buildClearancePayload(accepted, OPTS) as Record<string, unknown>;
    delete p.clearance;
    expect(validate(p)).toBe(false);
  });

  it('rejects a bad confidence enum', () => {
    const p = buildClearancePayload(accepted, OPTS);
    (p.rights as { confidence: string }).confidence = 'pretty-sure';
    expect(validate(p)).toBe(false);
  });

  it('rejects a malformed basis.rule (not bare kebab-case)', () => {
    const p = buildClearancePayload(accepted, OPTS);
    p.clearance.derivatives.basis.rule = 'Not Kebab Case';
    expect(validate(p)).toBe(false);
  });

  it('rejects an @context missing the openclearance authority IRI', () => {
    const p = buildClearancePayload(accepted, OPTS);
    p['@context'] = ['https://schema.org/'];
    expect(validate(p)).toBe(false);
  });

  it('the committed example manifests validate', () => {
    for (const f of ['examples/cc0-accepted.json', 'examples/deny-unrecognized.json']) {
      const ok = validate(readJson(f));
      expect({ file: f, errors: validate.errors ?? [] }).toEqual({ file: f, errors: [] });
      expect(ok).toBe(true);
    }
  });

  it('the advisory-entry schema accepts an unrecognised_rule advisory', () => {
    const validateAdv = ajv.compile(readJson('advisory-entry.schema.json'));
    const adv = {
      code: 'unrecognised_rule',
      severity: 'advisory',
      message: "rule 'some-unknown-future-rule' is not in the v0.1 baseline",
      path: 'clearance.commercialReproduction.basis.rule',
      rule: 'some-unknown-future-rule',
    };
    expect(validateAdv(adv)).toBe(true);
  });
});
