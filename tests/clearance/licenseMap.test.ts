import { describe, expect, it } from 'vitest';
import { clearanceForLicense } from '../../src/core/clearance/licenseMap.js';

describe('clearanceForLicense', () => {
  it('CC0 ⇒ all permitted, no attribution, high confidence, CC0 statement', () => {
    const c = clearanceForLicense('CC0');
    expect(c.commercialReproduction.permitted).toBe(true);
    expect(c.derivatives.permitted).toBe(true);
    expect(c.attributionRequired.required).toBe(false);
    expect(c.confidence).toBe('high');
    expect(c.statement).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
  });

  it('CC0 basis carries registered per-facet rule ids, license.type input, and a summary', () => {
    const c = clearanceForLicense('CC0');
    expect(c.commercialReproduction.basis.rule).toBe('cc0-grants-commercial');
    expect(c.derivatives.basis.rule).toBe('cc0-grants-derivatives');
    expect(c.attributionRequired.basis.rule).toBe('cc0-waives-attribution');
    for (const b of [
      c.commercialReproduction.basis,
      c.derivatives.basis,
      c.attributionRequired.basis,
    ]) {
      expect(b.inputs).toEqual([{ field: 'license.type', value: 'CC0' }]);
      expect(b.summary.length).toBeGreaterThan(0);
    }
  });

  it('PD ⇒ commercial + derivatives permitted, no attribution, NoC-US statement + pd-* rules', () => {
    const c = clearanceForLicense('PD');
    expect(c.commercialReproduction.permitted).toBe(true);
    expect(c.derivatives.permitted).toBe(true);
    expect(c.attributionRequired.required).toBe(false);
    expect(c.confidence).toBe('high');
    expect(c.statement).toBe('http://rightsstatements.org/vocab/NoC-US/1.0/');
    expect(c.commercialReproduction.basis.rule).toBe('pd-grants-commercial');
    expect(c.derivatives.basis.rule).toBe('pd-grants-derivatives');
    expect(c.attributionRequired.basis.rule).toBe('pd-waives-attribution');
    expect(c.commercialReproduction.basis.inputs).toEqual([{ field: 'license.type', value: 'PD' }]);
  });

  it('fail-closed: every non-permissive type ⇒ all false, default-deny, low confidence, null statement', () => {
    for (const t of ['CC-BY', 'CC-BY-SA', 'OTHER', 'UNKNOWN'] as const) {
      const c = clearanceForLicense(t);
      expect(c.commercialReproduction.permitted).toBe(false);
      expect(c.derivatives.permitted).toBe(false);
      expect(c.attributionRequired.required).toBe(false);
      expect(c.confidence).toBe('low');
      expect(c.statement).toBeNull();
      expect(c.commercialReproduction.basis.rule).toBe('default-deny');
      expect(c.derivatives.basis.rule).toBe('default-deny');
      expect(c.attributionRequired.basis.rule).toBe('default-deny');
      // the failing value is carried verbatim in the basis inputs (forensic trail)
      expect(c.commercialReproduction.basis.inputs).toEqual([{ field: 'license.type', value: t }]);
      expect(c.commercialReproduction.basis.summary).toContain('default deny');
    }
  });
});
