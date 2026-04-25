import type { ArtworkLicense, LicenseType } from './types.js';

export interface LicenseDecision {
  accepted: boolean;
  license: ArtworkLicense | null;
  reason: string;
}

export type LicenseValidator = (raw: unknown) => LicenseDecision;

function nowIso(): string {
  return new Date().toISOString();
}

export const validateMetLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return { accepted: false, license: null, reason: 'met: object missing or not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const isPD = obj.isPublicDomain;
  if (isPD === true) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        verifiedAt: nowIso(),
        museumField: 'isPublicDomain',
        museumValue: 'true',
      },
      reason: 'met: isPublicDomain=true',
    };
  }
  if (isPD === false) {
    return { accepted: false, license: null, reason: 'met: isPublicDomain=false' };
  }
  return {
    accepted: false,
    license: null,
    reason: 'met: isPublicDomain field missing or non-boolean (strict default reject)',
  };
};

export const validateClevelandLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return { accepted: false, license: null, reason: 'cleveland: object missing or not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const status = obj.share_license_status;
  if (typeof status === 'string' && status.toUpperCase() === 'CC0') {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        verifiedAt: nowIso(),
        museumField: 'share_license_status',
        museumValue: status,
      },
      reason: 'cleveland: share_license_status=CC0',
    };
  }
  return {
    accepted: false,
    license: null,
    reason: `cleveland: share_license_status=${typeof status === 'string' ? status : 'missing'} (strict default reject)`,
  };
};

export const validateAicLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return { accepted: false, license: null, reason: 'aic: object missing or not an object' };
  }
  const obj = raw as Record<string, unknown>;
  const isPD = obj.is_public_domain;
  if (isPD === true) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        verifiedAt: nowIso(),
        museumField: 'is_public_domain',
        museumValue: 'true',
      },
      reason: 'aic: is_public_domain=true',
    };
  }
  return {
    accepted: false,
    license: null,
    reason: `aic: is_public_domain=${isPD} (strict default reject)`,
  };
};

const VALIDATORS: Record<string, LicenseValidator> = {
  met: validateMetLicense,
  cleveland: validateClevelandLicense,
  aic: validateAicLicense,
};

export function validateLicense(museumCode: string, raw: unknown): LicenseDecision {
  const v = VALIDATORS[museumCode];
  if (!v) {
    return {
      accepted: false,
      license: null,
      reason: `unknown museum '${museumCode}': strict default reject`,
    };
  }
  return v(raw);
}

export function expectedLicenseType(_museumCode: string): LicenseType {
  return 'CC0';
}
