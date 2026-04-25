import type { ArtworkLicense, LicenseType } from './types.js';

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

const VALIDATORS: Record<string, LicenseValidator> = {
  met: validateMetLicense,
  cleveland: validateClevelandLicense,
  aic: validateAicLicense,
};

export function validateLicense(museumCode: string, raw: unknown): LicenseDecision {
  const v = VALIDATORS[museumCode];
  if (!v) {
    return reject(`unknown museum '${museumCode}': strict default reject`);
  }
  return v(raw);
}

export function expectedLicenseType(_museumCode: string): LicenseType {
  return 'CC0';
}
