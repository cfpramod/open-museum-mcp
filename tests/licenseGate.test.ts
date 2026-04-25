import { describe, expect, it } from 'vitest';
import {
  validateAicLicense,
  validateClevelandLicense,
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
