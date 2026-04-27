import type { ArtworkLicense } from './types.js';

export interface LicenseDecision {
  accepted: boolean;
  license: ArtworkLicense | null;
  imageOpenAccess: boolean;
  metadataOpenAccess: boolean;
  reason: string;
}

export type LicenseValidator = (raw: unknown) => LicenseDecision;

function nowIso(): string {
  return new Date().toISOString();
}

function reject(reason: string): LicenseDecision {
  return {
    accepted: false,
    license: null,
    imageOpenAccess: false,
    metadataOpenAccess: false,
    reason,
  };
}

// The Met's `isPublicDomain` boolean is the museum's per-object marker for
// images released under CC0. We accept it as sufficient for both
// imageOpenAccess and metadataOpenAccess because that is what the Met itself
// publishes. This is not an independent rights audit — third-party content,
// model releases, or culturally sensitive material may carry obligations the
// museum's representation does not surface. See README "Disclaimer".
export const validateMetLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('met: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  const isPD = obj.isPublicDomain;
  if (isPD === true) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: 'true',
        verificationSource: 'met.isPublicDomain',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'met: isPublicDomain=true',
    };
  }
  if (isPD === false) {
    return reject('met: isPublicDomain=false');
  }
  return reject('met: isPublicDomain field missing or non-boolean (strict default reject)');
};

export const validateClevelandLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('cleveland: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  const status = obj.share_license_status;
  if (typeof status === 'string' && status.toUpperCase() === 'CC0') {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: status,
        verificationSource: 'cleveland.share_license_status',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'cleveland: share_license_status=CC0',
    };
  }
  return reject(
    `cleveland: share_license_status=${typeof status === 'string' ? status : 'missing'} (strict default reject)`,
  );
};

// The Art Institute of Chicago's API returns is_public_domain as a per-object
// boolean. AIC's documentation explicitly notes that the API's CC0 framing
// covers the catalog data, while image reuse rights are described separately
// in their image licensing materials. The per-object boolean does mark images
// they release under CC0, so we accept it for imageOpenAccess — but the
// distinction matters: AIC's docs caution that even CC0-marked content may
// involve third-party permissions or culturally sensitive material. We
// surface this caveat in the README "Disclaimer" rather than downgrading
// confidence here, because the museum's own representation is unambiguous.
export const validateAicLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('aic: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  const isPD = obj.is_public_domain;
  if (isPD === true) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: 'true',
        verificationSource: 'aic.is_public_domain',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'aic: is_public_domain=true',
    };
  }
  return reject(`aic: is_public_domain=${isPD} (strict default reject)`);
};

// Wikimedia Commons is a federation, not a single museum: rights are per-file,
// not per-source. The MediaWiki API surfaces a machine-readable License token
// in `imageinfo[0].extmetadata.License.value`. We accept the strict open-access
// subset only:
//   - 'cc0'           → CC0 dedication
//   - 'pd', 'pd-*'    → Public Domain (PD-Art, PD-old, PD-US, PD-self, etc.)
//   - 'pdm', 'pdm-*'  → Creative Commons Public Domain Mark
// Everything else (CC-BY, CC-BY-SA, CC-BY-NC, GFDL, fair-use, etc.) is rejected.
// Even though CC-BY is "free", it imposes attribution that the project's
// per-museum gate model is not designed to verify or carry.
//
// Note on "PD-Art": Wikimedia Commons applies this template to faithful
// photographs of 2D public-domain works (per Bridgeman v. Corel). The license
// gate trusts Commons' editorial decision to apply that template; we do not
// independently re-evaluate the underlying work's status.
const PD_PREFIXES = ['pd', 'pdm'];

export const validateWikimediaLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('wikimedia: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  const ext = obj.extmetadata;
  if (!ext || typeof ext !== 'object') {
    return reject('wikimedia: extmetadata missing (strict default reject)');
  }
  const licenseField = (ext as Record<string, unknown>).License;
  const licenseValue =
    licenseField && typeof licenseField === 'object'
      ? (licenseField as { value?: unknown }).value
      : undefined;
  const license = typeof licenseValue === 'string' ? licenseValue.toLowerCase() : '';

  if (license === 'cc0') {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: license,
        verificationSource: 'wikimedia.extmetadata.License',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'wikimedia: License=cc0',
    };
  }
  const isPd = PD_PREFIXES.some((p) => license === p || license.startsWith(`${p}-`));
  if (isPd) {
    return {
      accepted: true,
      license: {
        type: 'PD',
        rawValue: license,
        verificationSource: 'wikimedia.extmetadata.License',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: `wikimedia: License=${license}`,
    };
  }
  return reject(`wikimedia: License=${license || 'missing'} (strict default reject)`);
};

// Europeana is a federation aggregating tens of millions of records from
// European institutions. Rights are per-record, expressed as a URI from a
// fixed vocabulary (Europeana Rights Statements). Live spike confirmed:
//   - 7.9M records under CC0 globally
//   - Switzerland: 11K CC0 / 81K CC-BY-SA / 25K InC / etc.
// We accept ONLY the unambiguous public-domain URIs:
//   - http://creativecommons.org/publicdomain/zero/1.0/   (CC0)
//   - http://creativecommons.org/publicdomain/mark/1.0/   (Public Domain Mark)
// Everything else (CC-BY, CC-BY-SA, CC-BY-NC, NoC-*, InC) is rejected on the
// same strict-default-deny grounds as the Wikimedia gate. The two protocols
// (http / https) are treated equivalently — the URI is a vocabulary key,
// not a fetchable resource.
const EUROPEANA_CC0_URI = 'creativecommons.org/publicdomain/zero/1.0/';
const EUROPEANA_PDM_URI = 'creativecommons.org/publicdomain/mark/1.0/';

function stripUriProtocol(s: string): string {
  return s.replace(/^https?:\/\//, '').toLowerCase();
}

export const validateEuropeanaLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('europeana: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  // Europeana returns `rights` as an array of URI strings on each item.
  const rightsArr = Array.isArray(obj.rights) ? obj.rights : [];
  const first = rightsArr.find((v) => typeof v === 'string') as string | undefined;
  if (!first) {
    return reject('europeana: rights field missing or non-string (strict default reject)');
  }
  const normalized = stripUriProtocol(first);
  if (normalized === EUROPEANA_CC0_URI) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: first,
        verificationSource: 'europeana.rights',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'europeana: rights=CC0',
    };
  }
  if (normalized === EUROPEANA_PDM_URI) {
    return {
      accepted: true,
      license: {
        type: 'PD',
        rawValue: first,
        verificationSource: 'europeana.rights',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'europeana: rights=PDM',
    };
  }
  return reject(`europeana: rights=${first} (strict default reject)`);
};

const VALIDATORS: Record<string, LicenseValidator> = {
  met: validateMetLicense,
  cleveland: validateClevelandLicense,
  aic: validateAicLicense,
  wikimedia: validateWikimediaLicense,
  europeana: validateEuropeanaLicense,
};

export function validateLicense(museumCode: string, raw: unknown): LicenseDecision {
  const v = VALIDATORS[museumCode];
  if (!v) {
    return reject(`unknown museum '${museumCode}': strict default reject`);
  }
  return v(raw);
}
