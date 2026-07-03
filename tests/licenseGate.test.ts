import { describe, expect, it } from 'vitest';
import {
  validateAicLicense,
  validateCleveland3DLicense,
  validateClevelandLicense,
  validateGettyImageLicense,
  validateGettyLicense,
  validateLicense,
  validateMetLicense,
} from '../src/licenseGate.js';

describe('licenseGate', () => {
  describe('Met validator', () => {
    it('accepts isPublicDomain=true', () => {
      const r = validateMetLicense({ isPublicDomain: true, objectID: 1 });
      expect(r.accepted).toBe(true);
      expect(r.license?.type).toBe('CC0');
    });

    it('rejects isPublicDomain=false', () => {
      const r = validateMetLicense({ isPublicDomain: false, objectID: 1 });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('isPublicDomain=false');
    });

    it('rejects when isPublicDomain is missing (strict default)', () => {
      const r = validateMetLicense({ objectID: 1 });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('strict default');
    });

    it('rejects malformed input', () => {
      const r = validateMetLicense(null);
      expect(r.accepted).toBe(false);
    });
  });

  describe('Cleveland validator', () => {
    it('accepts share_license_status=CC0', () => {
      const r = validateClevelandLicense({ share_license_status: 'CC0' });
      expect(r.accepted).toBe(true);
      expect(r.license?.type).toBe('CC0');
    });

    it('rejects non-CC0 status', () => {
      const r = validateClevelandLicense({ share_license_status: 'Copyrighted' });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('strict default');
    });

    it('rejects missing field (strict default)', () => {
      const r = validateClevelandLicense({});
      expect(r.accepted).toBe(false);
    });
  });

  describe('Cleveland 3D validator', () => {
    it('accepts sketchfab_id + share_license_status=CC0', () => {
      const r = validateCleveland3DLicense({
        sketchfab_id: '9b2fbfe552ac4107a3623e19c1ddb4e4',
        share_license_status: 'CC0',
      });
      expect(r.accepted).toBe(true);
      expect(r.license?.type).toBe('CC0');
      expect(r.license?.verificationSource).toBe('cleveland.share_license_status+sketchfab_id');
    });

    it('rejects when no sketchfab_id is present (no 3D scan) even if the record is CC0', () => {
      const r = validateCleveland3DLicense({ share_license_status: 'CC0' });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('no sketchfab_id');
    });

    it('rejects sketchfab_id present but non-CC0 status (never inherits an open 2D verdict)', () => {
      const r = validateCleveland3DLicense({
        sketchfab_id: 'some-id',
        share_license_status: 'Copyrighted',
      });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('strict default reject');
    });

    it('rejects malformed input', () => {
      expect(validateCleveland3DLicense(null).accepted).toBe(false);
      expect(validateCleveland3DLicense('not an object').accepted).toBe(false);
    });
  });

  describe('AIC validator', () => {
    it('accepts is_public_domain=true', () => {
      const r = validateAicLicense({ is_public_domain: true });
      expect(r.accepted).toBe(true);
      expect(r.license?.type).toBe('CC0');
    });

    it('rejects is_public_domain=false', () => {
      const r = validateAicLicense({ is_public_domain: false });
      expect(r.accepted).toBe(false);
    });

    it('rejects when is_public_domain is missing (strict default)', () => {
      const r = validateAicLicense({});
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('strict default');
    });

    it('rejects malformed input', () => {
      const r = validateAicLicense(null);
      expect(r.accepted).toBe(false);
    });
  });

  describe('Getty metadata validator', () => {
    const cc0Right = (id: string) => [{ classified_as: [{ id }] }];

    it('accepts subject_to declaring CC0 (collection metadata)', () => {
      const r = validateGettyLicense({ subject_to: cc0Right('http://creativecommons.org/publicdomain/zero/1.0/') });
      expect(r.accepted).toBe(true);
      expect(r.license?.type).toBe('CC0');
      expect(r.metadataOpenAccess).toBe(true);
      // Image rights are independently verified elsewhere; never inherited here.
      expect(r.imageOpenAccess).toBe(false);
    });

    it('rejects non-CC0 subject_to (strict default)', () => {
      const r = validateGettyLicense({ subject_to: cc0Right('https://creativecommons.org/licenses/by/4.0/') });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('strict default reject');
    });

    it('rejects missing subject_to (strict default)', () => {
      const r = validateGettyLicense({});
      expect(r.accepted).toBe(false);
    });

    it('rejects malformed input', () => {
      expect(validateGettyLicense(null).accepted).toBe(false);
      expect(validateGettyLicense('not an object').accepted).toBe(false);
    });

    it('finds the CC0 marker regardless of its position within classified_as', () => {
      const r = validateGettyLicense({
        subject_to: [
          {
            classified_as: [
              { id: 'https://data.getty.edu/local/thesaurus/rights-statement' },
              { id: 'http://vocab.getty.edu/aat/300417696' },
              { id: 'http://creativecommons.org/publicdomain/zero/1.0/' },
            ],
          },
        ],
      });
      expect(r.accepted).toBe(true);
    });
  });

  describe('Getty per-image validator', () => {
    it('accepts a media entity whose subject_to declares CC0', () => {
      const r = validateGettyImageLicense({
        subject_to: [{ classified_as: [{ id: 'http://creativecommons.org/publicdomain/zero/1.0/' }] }],
      });
      expect(r.accepted).toBe(true);
      expect(r.imageOpenAccess).toBe(true);
    });

    it('rejects a media entity whose subject_to is CC-BY, not CC0 (image restricted)', () => {
      const r = validateGettyImageLicense({
        subject_to: [{ classified_as: [{ id: 'https://creativecommons.org/licenses/by/4.0/' }] }],
      });
      expect(r.accepted).toBe(false);
    });

    it('rejects malformed input', () => {
      expect(validateGettyImageLicense(null).accepted).toBe(false);
    });
  });

  describe('dispatcher', () => {
    it('rejects unknown museum code with strict default', () => {
      const r = validateLicense('mystery-museum', { rights: 'CC0' });
      expect(r.accepted).toBe(false);
      expect(r.reason).toContain('unknown museum');
    });

    it('routes to Met validator', () => {
      const r = validateLicense('met', { isPublicDomain: true, objectID: 99 });
      expect(r.accepted).toBe(true);
    });
  });
});
