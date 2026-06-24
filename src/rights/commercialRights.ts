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

/** True when `host` is exactly `domain` or a subdomain of it (NOT a substring). */
function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Parse a rights URI into its exact hostname + lowercased, non-empty path
 * segments. Returns null when the value is not a parseable absolute URL. This is
 * the security boundary: matching the HOSTNAME (not a substring of the whole
 * string) is what stops `creativecommons.org.evil.com` / `evil.com/?x=creativecommons.org`
 * from spoofing the gate.
 */
function parseRights(uri: string): { host: string; segments: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(uri.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  const segments = parsed.pathname
    .toLowerCase()
    .split('/')
    .filter((s) => s.length > 0);
  return { host, segments };
}

/**
 * Validate a rights URI for commercial-POD eligibility.
 *
 * Hostname is matched EXACTLY (creativecommons.org / rightsstatements.org, or a
 * subdomain), never as a substring — the licence path is only trusted once the
 * host is proven, so a forged host cannot smuggle an allowlisted path through.
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
  const parsed = parseRights(raw);
  if (!parsed) {
    return reject(`rights=${raw}: not a parseable rights URL — strict default deny`);
  }
  const { host, segments } = parsed;

  // RightsStatements.org is a curatorial assertion vocabulary, NOT a licence
  // grant. "No Copyright"/"No Known Copyright" shifts liability to the reuser;
  // "In Copyright" is closed. None are auto-approvable for commercial sale.
  if (hostIs(host, 'rightsstatements.org')) {
    return reject(
      `rights=${raw}: rightsstatements.org assertion is a disclaimer, not a licence grant — review required`,
    );
  }

  // Only Creative Commons URIs can be accepted (CC0/PDM/BY/BY-SA all live here).
  if (!hostIs(host, 'creativecommons.org')) {
    return reject(`rights=${raw}: unrecognized rights host '${host}' — strict default deny`);
  }

  // Path segments are now trusted (host proven). publicdomain/{zero,mark}.
  if (segments[0] === 'publicdomain') {
    if (segments[1] === 'zero') return accept('CC0', raw, verificationSource);
    if (segments[1] === 'mark') return accept('PD', raw, verificationSource);
    return reject(`rights=${raw}: unrecognized public-domain tool — strict default deny`);
  }

  // licenses/<code>/<version>, code e.g. "by", "by-sa", "by-nc-sa".
  if (segments[0] === 'licenses') {
    const parts = (segments[1] ?? '').split('-'); // ["by","nc","sa"]
    if (parts.includes('nc')) {
      return reject(`rights=${raw}: NonCommercial (NC) — cannot be sold as a reproduction`);
    }
    if (parts.includes('nd')) {
      return reject(`rights=${raw}: NoDerivatives (ND) — a print crop/scale is a derivative`);
    }
    if (parts[0] === 'by') {
      if (parts.includes('sa')) return accept('CC-BY-SA', raw, verificationSource);
      if (parts.length === 1) return accept('CC-BY', raw, verificationSource);
    }
  }

  return reject(`rights=${raw}: unrecognized or non-open licence — strict default deny`);
}

/**
 * True when a URI's HOSTNAME is a recognized rights vocabulary host
 * (creativecommons.org / rightsstatements.org or a subdomain). Used to pick the
 * rights classifier out of a record's metadata without substring spoofing.
 */
/**
 * True when `uri` is a CreativeCommons CC0 dedication (`/publicdomain/zero/...`),
 * matched on the EXACT hostname + path segments via {@link parseRights} — never a
 * substring of the URL. Used to tier a known-public-domain record as CC0 vs the
 * Public Domain Mark without a spoofable `includes()`/regex check on the URL.
 */
export function isCc0RightsUri(uri: string | null | undefined): boolean {
  if (typeof uri !== 'string' || uri.trim() === '') return false;
  const parsed = parseRights(uri);
  return (
    parsed !== null &&
    hostIs(parsed.host, 'creativecommons.org') &&
    parsed.segments[0] === 'publicdomain' &&
    parsed.segments[1] === 'zero'
  );
}

export function isRightsUri(uri: string): boolean {
  const parsed = parseRights(uri);
  return parsed !== null && (hostIs(parsed.host, 'creativecommons.org') || hostIs(parsed.host, 'rightsstatements.org'));
}
