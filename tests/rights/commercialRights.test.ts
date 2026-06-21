import { describe, expect, it } from 'vitest';
import { validateCommercialRights } from '../../src/rights/commercialRights.js';

const SRC = 'rijksmuseum.iiif.rights';

describe('validateCommercialRights — commercial-POD rights gate (CC0/PDM/CC-BY/CC-BY-SA allow; NC/ND/unknown deny)', () => {
  it('accepts CC0 with high confidence', () => {
    const d = validateCommercialRights('https://creativecommons.org/publicdomain/zero/1.0/', SRC);
    expect(d.accepted).toBe(true);
    expect(d.license?.type).toBe('CC0');
    expect(d.license?.confidence).toBe('high');
    expect(d.imageOpenAccess).toBe(true);
    expect(d.metadataOpenAccess).toBe(true);
    expect(d.license?.verificationSource).toBe(SRC);
  });

  it('accepts the Public Domain Mark (PD-Art) as PD', () => {
    const d = validateCommercialRights('http://creativecommons.org/publicdomain/mark/1.0/', SRC);
    expect(d.accepted).toBe(true);
    expect(d.license?.type).toBe('PD');
  });

  it('accepts CC-BY (any version)', () => {
    for (const u of [
      'https://creativecommons.org/licenses/by/4.0/',
      'https://creativecommons.org/licenses/by/3.0/',
      'https://creativecommons.org/licenses/by/2.0/',
    ]) {
      const d = validateCommercialRights(u, SRC);
      expect(d.accepted, u).toBe(true);
      expect(d.license?.type, u).toBe('CC-BY');
    }
  });

  it('accepts CC-BY-SA (ShareAlike does not block commercial sale)', () => {
    const d = validateCommercialRights('https://creativecommons.org/licenses/by-sa/4.0/', SRC);
    expect(d.accepted).toBe(true);
    expect(d.license?.type).toBe('CC-BY-SA');
  });

  it('REJECTS every NonCommercial variant', () => {
    for (const u of [
      'https://creativecommons.org/licenses/by-nc/4.0/',
      'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    ]) {
      const d = validateCommercialRights(u, SRC);
      expect(d.accepted, u).toBe(false);
      expect(d.reason, u).toMatch(/non-?commercial|nc/i);
    }
  });

  it('REJECTS every NoDerivatives variant', () => {
    for (const u of [
      'https://creativecommons.org/licenses/by-nd/4.0/',
      'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    ]) {
      const d = validateCommercialRights(u, SRC);
      expect(d.accepted, u).toBe(false);
      expect(d.reason, u).toMatch(/no.?deriv|nd|nc/i);
    }
  });

  it('REJECTS rightsstatements.org "No Copyright"/"No Known Copyright" (disclaimer, not a grant — review required)', () => {
    for (const u of [
      'http://rightsstatements.org/vocab/NoC-US/1.0/',
      'http://rightsstatements.org/vocab/NoC-NC/1.0/',
      'http://rightsstatements.org/vocab/NKC/1.0/',
    ]) {
      const d = validateCommercialRights(u, SRC);
      expect(d.accepted, u).toBe(false);
      expect(d.reason, u).toMatch(/review|known copyright|disclaimer|not a grant/i);
    }
  });

  it('REJECTS in-copyright rights statements', () => {
    const d = validateCommercialRights('http://rightsstatements.org/vocab/InC/1.0/', SRC);
    expect(d.accepted).toBe(false);
  });

  it('REJECTS missing/empty/unrecognized rights (strict default deny)', () => {
    for (const u of [null, undefined, '', '   ', 'all rights reserved', 'https://example.org/license']) {
      const d = validateCommercialRights(u as string, SRC);
      expect(d.accepted, String(u)).toBe(false);
    }
  });

  it('tolerates surrounding whitespace, uppercase scheme/host and a trailing slash', () => {
    expect(validateCommercialRights('  HTTPS://CreativeCommons.ORG/licenses/BY/4.0  ', SRC).accepted).toBe(true);
    expect(validateCommercialRights('https://creativecommons.org/publicdomain/zero/1.0', SRC).license?.type).toBe('CC0');
  });

  it('rejects scheme-less rights values (an absolute http(s) URL is required for a safe hostname check)', () => {
    expect(validateCommercialRights('creativecommons.org/publicdomain/zero/1.0', SRC).accepted).toBe(false);
  });

  it('does not misclassify by-nc as by (NC check precedes the bare-BY match)', () => {
    // "by-nc" contains "by" — the NC guard must win.
    expect(validateCommercialRights('https://creativecommons.org/licenses/by-nc/4.0/', SRC).accepted).toBe(false);
  });

  it('REJECTS host-spoofed licence URLs (exact hostname, not substring — CodeQL incomplete-URL-sanitization)', () => {
    for (const u of [
      'https://creativecommons.org.evil.com/publicdomain/zero/1.0/',
      'https://creativecommons.org.evil.com/licenses/by/4.0/',
      'https://evil.com/?x=creativecommons.org/licenses/by/4.0',
      'https://evil.com/creativecommons.org/licenses/by/4.0/',
      'https://creativecommons.org.attacker.io/licenses/by-sa/4.0/',
      'https://notcreativecommons.org/licenses/by/4.0/',
      'https://creativecommons.org@evil.com/licenses/by/4.0/',
    ]) {
      expect(validateCommercialRights(u, SRC).accepted, u).toBe(false);
    }
  });

  it('accepts the genuine host with a path-only subdomain still rejected unless the path is a real licence', () => {
    // wiki.creativecommons.org is a real subdomain but /faq is not a licence path
    expect(validateCommercialRights('https://wiki.creativecommons.org/faq', SRC).accepted).toBe(false);
    // the canonical host + path still works
    expect(validateCommercialRights('https://creativecommons.org/licenses/by/4.0/', SRC).accepted).toBe(true);
  });

  it('rejects unparseable rights values without throwing', () => {
    expect(validateCommercialRights('not a url', SRC).accepted).toBe(false);
    expect(validateCommercialRights('http://', SRC).accepted).toBe(false);
  });
});
