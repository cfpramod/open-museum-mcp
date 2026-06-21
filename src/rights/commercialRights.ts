/**
 * Shared per-record COMMERCIAL-POD rights gate, keyed on a rights URI.
 *
 * open-museum.art sells print-on-demand reproductions, so the rights bar is:
 * the image must be openly licensed for COMMERCIAL use. This gate is reused by
 * every IIIF / Linked-Art source (Rijksmuseum, NGA, SMK, Yale, Belvedere, ...)
 * whose per-object rights are expressed as a Creative Commons / RightsStatements
 * URI.
 *
 * Two non-negotiable rules from the integration research:
 *  1. **Hard-exclude all NonCommercial (NC) and NoDerivatives (ND).** NC forbids
 *     sale; ND forbids the crop/scale a print requires.
 *  2. **"No known copyright" (rightsstatements.org NoC and NKC vocab) is a
 *     liability DISCLAIMER, not a licence grant** — review-required, never auto.
 *
 * Auto-safe allowlist: CC0, Public Domain Mark (PD-Art), CC-BY, CC-BY-SA.
 * Everything else — in-copyright, unknown, empty — is strict default deny.
 */
import type { ArtworkLicense, LicenseType } from '../types.js';
import type { LicenseDecision } from '../licenseGate.js';

function nowIso(): string {
  return new Date().toISOString();
}

function reject(reason: string): LicenseDecision {
  return { accepted: false, license: null, imageOpenAccess: false, metadataOpenAccess: false, reason };
}

function accept(
  type: LicenseType,
  rawValue: string,
  verificationSource: string,
): LicenseDecision {
  const license: ArtworkLicense = {
    type,
    rawValue,
    verificationSource,
    verifiedAt: nowIso(),
    confidence: 'high',
  };
  return { accepted: true, license, imageOpenAccess: true, metadataOpenAccess: true, reason: `accepted ${type}` };
}

/**
 * Normalize a rights URI for matching: lowercase, drop the scheme + `www.`,
 * collapse whitespace, strip a trailing slash. Keeps the path so license codes
 * (`by-nc-sa`) remain matchable.
 */
function normalize(uri: string): string {
  return uri
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Validate a rights URI for commercial-POD eligibility.
 *
 * @param rightsUri the per-object rights statement URI (CC or RightsStatements)
 * @param verificationSource provenance label recorded on the license, e.g.
 *        `"rijksmuseum.iiif.rights"`
 */
export function validateCommercialRights(
  rightsUri: string | null | undefined,
  verificationSource: string,
): LicenseDecision {
  if (typeof rightsUri !== 'string' || rightsUri.trim() === '') {
    return reject('rights URI missing — strict default deny');
  }
  const raw = rightsUri.trim();
  const u = normalize(raw);

  // RightsStatements.org is a curatorial assertion vocabulary, NOT a licence
  // grant. "No Copyright"/"No Known Copyright" shifts liability to the reuser;
  // "In Copyright" is closed. None are auto-approvable for commercial sale.
  if (u.includes('rightsstatements.org')) {
    return reject(
      `rights=${raw}: rightsstatements.org assertion is a disclaimer, not a licence grant — review required`,
    );
  }

  if (u.includes('publicdomain/zero')) return accept('CC0', raw, verificationSource);
  if (u.includes('publicdomain/mark')) return accept('PD', raw, verificationSource);

  // For CC licences the code is the path segment after "licenses/", e.g.
  // "licenses/by-nc-sa/4.0" -> "by-nc-sa". Parse the code from the segments so
  // the NC/ND substring checks are exact (and beat the bare-"by" match, since
  // "by-nc" contains "by").
  const segs = u.split('/');
  const li = segs.indexOf('licenses');
  const code = li >= 0 && segs[li + 1] ? segs[li + 1] : '';
  const parts = code.split('-'); // ["by","nc","sa"]

  if (parts.includes('nc')) {
    return reject(`rights=${raw}: NonCommercial (NC) — cannot be sold as a reproduction`);
  }
  if (parts.includes('nd')) {
    return reject(`rights=${raw}: NoDerivatives (ND) — a print crop/scale is a derivative`);
  }

  if (u.includes('creativecommons.org') && parts[0] === 'by') {
    if (parts.includes('sa')) return accept('CC-BY-SA', raw, verificationSource);
    if (parts.length === 1) return accept('CC-BY', raw, verificationSource);
  }

  return reject(`rights=${raw}: unrecognized or non-open licence — strict default deny`);
}
