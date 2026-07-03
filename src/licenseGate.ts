import { isCc0RightsUri } from './rights/commercialRights.js';
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

// Cleveland's Open Access initiative explicitly extends to 3D: their own
// published policy ("Open Access in 3-D", clevelandart.org/open-access) states
// the museum's open-access declaration covers 3D scans of public-domain works
// that THEY digitized and host on Sketchfab, not just the 2D image. Verified
// live against Sketchfab's own public API (2026-07-02): the CMA's Sketchfab
// upload for `sketchfab_id=9b2fbfe552ac4107a3623e19c1ddb4e4` independently
// reports `license.slug: 'cc0'`, corroborating Cleveland's declaration.
// `share_license_status` is Cleveland's single per-record rights field — it
// covers the whole record, 2D and 3D alike, so this validator necessarily
// reads the same field as `validateClevelandLicense`. It is kept as its own
// function (rather than reusing the 2D decision object) so the *gate* is
// structurally per-scan: if Cleveland ever introduces a distinct 3D-specific
// field, only this function needs to change, and nothing here assumes the 2D
// verdict. This does NOT extend to third-party 3D platforms (Scan the World,
// user Sketchfab uploads) — those carry independently-set licences that must
// never be inferred from a museum's 2D declaration.
export const validateCleveland3DLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('cleveland-3d: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  const sketchfabId = obj.sketchfab_id;
  if (typeof sketchfabId !== 'string' || sketchfabId.trim() === '') {
    return reject('cleveland-3d: no sketchfab_id (no 3D scan for this record)');
  }
  const status = obj.share_license_status;
  if (typeof status === 'string' && status.toUpperCase() === 'CC0') {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: status,
        verificationSource: 'cleveland.share_license_status+sketchfab_id',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'cleveland-3d: share_license_status=CC0, sketchfab_id present',
    };
  }
  return reject(
    `cleveland-3d: share_license_status=${typeof status === 'string' ? status : 'missing'} (strict default reject)`,
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
//   - 'cc0'                       → CC0 dedication
//   - 'pd', 'pd-art', 'pd-old*'   → worldwide Public Domain
//   - 'pdm', 'pdm-*'              → Creative Commons Public Domain Mark
// Everything else (CC-BY, CC-BY-SA, CC-BY-NC, GFDL, fair-use, etc.) is rejected.
// Even though CC-BY is "free", it imposes attribution that the project's
// per-museum gate model is not designed to verify or carry.
//
// On jurisdiction scope: an accepted PD record is emitted as a worldwide
// determination (`type: 'PD'`, `confidence: 'high'`, and a Clearance Manifest
// stamping the worldwide Public Domain Mark URI). So the gate must accept ONLY
// PD tokens whose claim is worldwide. Jurisdiction-scoped tokens — `pd-us`,
// `pd-1923`, `pd-usgov`, `pd-us-no-notice`, etc. — assert US-only status and are
// rejected, exactly as the Europeana gate already rejects the US-scoped `NoC-US`
// statement. This is strict-default-deny: an ambiguous (US-only) signal must not
// be promoted to a worldwide claim. A faithful-repro `pd-art` (Bridgeman v.
// Corel) and `pd-old*` (author long dead) carry worldwide force; a bare `pd` is
// only applied by Commons when the file is PD in both the US and its source
// country, so it clears the same bar.
//
// Accept set: exact worldwide tokens, plus the `pd-old`/`pdm-` worldwide
// families. Anything else under the `pd` namespace falls through to reject.
const PD_WORLDWIDE_EXACT = new Set(['pd', 'pd-art', 'pdm']);
const PD_WORLDWIDE_PREFIXES = ['pd-old', 'pdm-'];

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
  const isPd =
    PD_WORLDWIDE_EXACT.has(license) || PD_WORLDWIDE_PREFIXES.some((p) => license.startsWith(p));
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
  // Europeana's `rights` is conventionally a one-element array of URI strings,
  // but EDM consumers occasionally serialize a single value as a bare string.
  // Coerce both shapes into a uniform array before checking.
  const rightsRaw = obj.rights;
  const rightsArr = Array.isArray(rightsRaw)
    ? rightsRaw
    : typeof rightsRaw === 'string'
      ? [rightsRaw]
      : [];
  const rightsStrs = rightsArr.filter((v): v is string => typeof v === 'string');
  if (rightsStrs.length === 0) {
    return reject('europeana: rights field missing or non-string (strict default reject)');
  }
  // Strict-default-deny: every URI on the record must be in the accept set.
  // A "first match wins" check would leak hybrid records that carry one
  // permissive URI plus one restrictive URI — exactly the failure mode
  // strict-default-deny exists to prevent.
  const normalizedAll = rightsStrs.map(stripUriProtocol);
  const allAccepted = normalizedAll.every(
    (u) => u === EUROPEANA_CC0_URI || u === EUROPEANA_PDM_URI,
  );
  if (!allAccepted) {
    return reject(`europeana: rights=${rightsStrs[0]} (strict default reject)`);
  }
  // Both CC0 and PDM are in the accept set; classify by the first URI for
  // the license tier. A record dual-marked CC0+PDM is genuinely public
  // domain and gets the CC0 tier (the more specific dedication).
  const isCc0 = normalizedAll[0] === EUROPEANA_CC0_URI;
  if (isCc0) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: rightsStrs[0],
        verificationSource: 'europeana.rights',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'europeana: rights=CC0',
    };
  }
  return {
    accepted: true,
    license: {
      type: 'PD',
      rawValue: rightsStrs[0],
      verificationSource: 'europeana.rights',
      verifiedAt: nowIso(),
      confidence: 'high',
    },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    reason: 'europeana: rights=PDM',
  };
};

// The Smithsonian Open Access API expresses rights in EDAN's two-value
// controlled vocabulary (`access` ∈ {"CC0", "Usage conditions apply"}), and
// it does so at TWO independent levels:
//   - object metadata: content.descriptiveNonRepeating.metadata_usage.access
//   - per-media image:  content.descriptiveNonRepeating.online_media.media[].usage.access
// The two can diverge — a record's catalog metadata may be CC0 while a
// specific image carries usage conditions — so we keep imageOpenAccess and
// metadataOpenAccess distinct (per the project's two-tier rights model).
//
// Strict-default-deny spine: a record is ACCEPTED only when the object-level
// metadata_usage.access is exactly "CC0". imageOpenAccess is set independently
// from the FIRST image media's usage.access — so a metadata-CC0 record whose
// image is not CC0 is accepted as open metadata with imageOpenAccess=false, and
// the fetcher then declines to surface the restricted image URL. Missing,
// null, or "Usage conditions apply" at the metadata level rejects outright.
function smithsonianAccess(obj: Record<string, unknown>): {
  metadata: string | undefined;
  firstMediaCc0: boolean;
} {
  const content = obj.content;
  const dnr =
    content && typeof content === 'object'
      ? (content as Record<string, unknown>).descriptiveNonRepeating
      : undefined;
  const dnrObj = dnr && typeof dnr === 'object' ? (dnr as Record<string, unknown>) : {};

  const mu = dnrObj.metadata_usage;
  const metaAccess =
    mu && typeof mu === 'object' ? (mu as { access?: unknown }).access : undefined;
  const metadata = typeof metaAccess === 'string' ? metaAccess : undefined;

  const om = dnrObj.online_media;
  const mediaArr =
    om && typeof om === 'object' && Array.isArray((om as { media?: unknown }).media)
      ? ((om as { media: unknown[] }).media)
      : [];
  // Select the SAME primary media the fetcher's pickImage() will surface — the
  // first Images-type entry, falling back to the first entry — so imageOpenAccess
  // describes exactly the asset that ends up on the wire, not a different one.
  const isImagesType = (m: unknown): boolean =>
    !!m &&
    typeof m === 'object' &&
    typeof (m as { type?: unknown }).type === 'string' &&
    ((m as { type: string }).type).toLowerCase() === 'images';
  const primaryMedia = mediaArr.find(isImagesType) ?? mediaArr[0];
  const mediaUsage =
    primaryMedia && typeof primaryMedia === 'object'
      ? (primaryMedia as { usage?: unknown }).usage
      : undefined;
  const mediaAccess =
    mediaUsage && typeof mediaUsage === 'object'
      ? (mediaUsage as { access?: unknown }).access
      : undefined;
  const firstMediaCc0 = typeof mediaAccess === 'string' && mediaAccess.toUpperCase() === 'CC0';

  return { metadata, firstMediaCc0 };
}

export const validateSmithsonianLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('smithsonian: object missing or not an object');
  }
  const { metadata, firstMediaCc0 } = smithsonianAccess(raw as Record<string, unknown>);
  if (typeof metadata === 'string' && metadata.toUpperCase() === 'CC0') {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: metadata,
        verificationSource: 'smithsonian.metadata_usage.access',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      // Metadata is CC0; the image is open only if its own media usage is CC0.
      imageOpenAccess: firstMediaCc0,
      metadataOpenAccess: true,
      reason: 'smithsonian: metadata_usage.access=CC0',
    };
  }
  return reject(
    `smithsonian: metadata_usage.access=${metadata ?? 'missing'} (strict default reject)`,
  );
};

// Walters Art Museum — the engine's first INGEST source. Unlike the live APIs,
// the static CSV dump carries NO per-object rights field; the museum instead
// declares the WHOLE released dataset CC0 (rights policy + repo README). We take
// that as the affirmative grant but still apply a strict per-record gate as
// defense in depth: a record is accepted only when its latest date is BEFORE the
// copyright cutoff (1928) AND it carries an image. The build-time ingest already
// excludes the 1928+/loaned/copyright-flagged tail, so this re-check is belt-and-
// suspenders — but it means a malformed or out-of-policy record can never reach
// the wire even if the bundle were tampered with. See README "Verification".
const WALTERS_COPYRIGHT_CUTOFF_YEAR = 1928;
export const validateWaltersLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('walters: record missing or not an object');
  }
  const rec = raw as Record<string, unknown>;
  const endYear = typeof rec.b === 'number' && Number.isFinite(rec.b) ? rec.b : null;
  const image = typeof rec.g === 'string' ? rec.g.trim() : '';
  if (endYear === null) {
    return reject('walters: no resolvable end-year — cannot confirm public domain (strict default reject)');
  }
  if (endYear >= WALTERS_COPYRIGHT_CUTOFF_YEAR) {
    return reject(`walters: end-year ${endYear} >= ${WALTERS_COPYRIGHT_CUTOFF_YEAR} — possible live copyright (reject)`);
  }
  if (!image) {
    return reject('walters: no image — out of the image-bearing CC0 subset (reject)');
  }
  return {
    accepted: true,
    license: {
      type: 'CC0',
      rawValue: 'CC0',
      verificationSource: 'walters.dataset_cc0',
      verifiedAt: nowIso(),
      confidence: 'high',
    },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    reason: `walters: CC0 dataset, pre-${WALTERS_COPYRIGHT_CUTOFF_YEAR} image-bearing record`,
  };
};

// SMK (Statens Museum for Kunst — National Gallery of Denmark) marks open records
// with a `public_domain` boolean plus a `rights` URI. We accept ONLY when the
// boolean is exactly true (Met-style per-object marker), and read the rights URI
// to tier the license: a CC0 dedication vs the Public Domain Mark. Anything else
// — false, missing, or a non-boolean — is a strict reject.
export const validateSmkLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('smk: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.public_domain !== true) {
    return reject(`smk: public_domain=${String(obj.public_domain)} (strict default reject)`);
  }
  const rightsUri = typeof obj.rights === 'string' ? obj.rights : '';
  // Tier CC0 vs PD Mark by PARSING the rights URL (exact host + path segments),
  // never a substring/regex on the URL — the rights gate is a security boundary
  // (a host like `creativecommons.org.evil.com` must not be trusted). Reuses the
  // audited parser shared with the commercial-POD gate.
  const isCc0 = isCc0RightsUri(rightsUri);
  return {
    accepted: true,
    license: {
      type: isCc0 ? 'CC0' : 'PD',
      rawValue: rightsUri || 'public_domain=true',
      verificationSource: 'smk.public_domain',
      verifiedAt: nowIso(),
      confidence: 'high',
    },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    reason: `smk: public_domain=true${rightsUri ? ` (${isCc0 ? 'CC0' : 'PDM'})` : ''}`,
  };
};

// Wellcome Collection expresses rights PER LOCATION: a work has multiple
// `items[].locations[]`, and the digital IMAGE we surface is the `iiif-image`
// location, which carries its OWN `license` ({id: 'cc0' | 'pdm' | 'cc-by' | …}).
// We judge that specific location's licence (not the work, not a physical copy):
// accept only `cc0` (CC0) or `pdm` (Public Domain Mark). `cc-by` and everything
// else are rejected — the engine's gate does not yet carry attribution. A missing
// image location or unrecognised licence is a strict reject.
function wellcomeImageLicenseId(work: Record<string, unknown>): string | null {
  const items = Array.isArray(work.items) ? work.items : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const locations = Array.isArray((it as Record<string, unknown>).locations)
      ? ((it as Record<string, unknown>).locations as unknown[])
      : [];
    for (const loc of locations) {
      if (!loc || typeof loc !== 'object') continue;
      const l = loc as Record<string, unknown>;
      const type =
        l.locationType && typeof l.locationType === 'object'
          ? (l.locationType as Record<string, unknown>).id
          : undefined;
      if (type !== 'iiif-image') continue;
      const lic = l.license && typeof l.license === 'object' ? (l.license as Record<string, unknown>).id : undefined;
      return typeof lic === 'string' ? lic : null;
    }
  }
  return null;
}

export const validateWellcomeLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('wellcome: object missing or not an object');
  }
  const licId = wellcomeImageLicenseId(raw as Record<string, unknown>);
  if (licId === 'cc0' || licId === 'pdm') {
    return {
      accepted: true,
      license: {
        type: licId === 'cc0' ? 'CC0' : 'PD',
        rawValue: licId,
        verificationSource: 'wellcome.iiif-image.license',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: `wellcome: iiif-image license=${licId}`,
    };
  }
  return reject(`wellcome: iiif-image license=${licId ?? 'none'} (need cc0/pdm; strict default reject)`);
};

// National Gallery of Art (Washington) — INGEST. The committed bundle holds only
// records whose primary image is flagged `openaccess=1` in NGA's CSV dump, which
// is NGA's CC0 open-access programme (images of works it has released for any use).
// We bake that flag onto each bundled record as `o:1`; the validator re-checks it
// (defense in depth) and requires an image — a record without both is rejected.
export const validateNgaLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('nga: record missing or not an object');
  }
  const rec = raw as Record<string, unknown>;
  if (rec.o !== 1) {
    return reject(`nga: open-access flag o=${String(rec.o)} (need 1; strict default reject)`);
  }
  if (typeof rec.g !== 'string' || rec.g.trim() === '') {
    return reject('nga: no IIIF image (reject)');
  }
  return {
    accepted: true,
    license: {
      type: 'CC0',
      rawValue: 'openaccess',
      verificationSource: 'nga.published_images.openaccess',
      verifiedAt: nowIso(),
      confidence: 'high',
    },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    reason: 'nga: open-access (CC0) image-bearing record',
  };
};

// Harvard Art Museums exposes an `imagepermissionlevel` per object:
//   0 = the image may be used freely (Harvard's open-access tier — public-domain
//       works and works Harvard has cleared for open use),
//   1 = display-only / restricted, 2 = private.
// Harvard does NOT publish a CC0/PD declaration, so — per the Open Clearance model
// (surface the rights faithfully; if it's open-access, use it) — we accept level 0
// as OPEN ACCESS and surface it honestly as `OTHER` (not over-claimed as CC0/PD),
// with the source + the per-object permission recorded. Levels 1/2 are rejected.
export const validateHarvardLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('harvard: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.imagepermissionlevel === 0) {
    return {
      accepted: true,
      license: {
        type: 'OTHER',
        rawValue: 'imagepermissionlevel=0 (open access, Harvard Art Museums)',
        verificationSource: 'harvard.imagepermissionlevel',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'harvard: imagepermissionlevel=0 (open access)',
    };
  }
  return reject(`harvard: imagepermissionlevel=${String(obj.imagepermissionlevel)} (need 0/open access; reject)`);
};

// The Getty Museum's Linked.Art API declares CC0 rights TWICE, independently,
// at two different levels — and they can diverge:
//   1. Collection METADATA (title, artist, date, etc.) is blanket-CC0 across
//      the whole dataset per Getty's published policy, but we still verify it
//      per-record from the object's own top-level `subject_to` block rather
//      than assuming the blanket declaration holds for every record.
//   2. Each IMAGE is independently rights-checked via its own media entity's
//      `subject_to` (Getty's Open Content Program covers ~91k of the ~168k
//      objects' images; the rest remain under copyright even though the
//      metadata about them is open). This is the genuine two-tier case
//      documented in CLAUDE.md: express it as `imageOpenAccess: false` +
//      `metadataOpenAccess: true` rather than collapsing or rejecting outright.
// `classified_as` is an array (not a fixed index) on both blocks, so the CC0
// marker is found by scanning it, never assumed to be at position 0 — Getty's
// own docs example and a live media-entity fetch (2026-07-02) both show CC0
// at different array positions depending on the block.
const CC0_URI = 'http://creativecommons.org/publicdomain/zero/1.0/';

function hasClassification(subjectTo: unknown, targetId: string): boolean {
  if (!Array.isArray(subjectTo)) return false;
  for (const right of subjectTo) {
    if (!right || typeof right !== 'object') continue;
    const classified = (right as Record<string, unknown>).classified_as;
    if (!Array.isArray(classified)) continue;
    for (const c of classified) {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).id === targetId) return true;
    }
  }
  return false;
}

// Gates the OBJECT record: is this record's collection metadata verified CC0?
// Registered in VALIDATORS for the standard per-museum dispatch. Does not (and
// cannot, from this record alone) determine image rights — see
// `validateGettyImageLicense`, called separately by the Getty fetcher per
// image, once it has fetched that image's own media entity.
export const validateGettyLicense: LicenseValidator = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return reject('getty: object missing or not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (hasClassification(obj.subject_to, CC0_URI)) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: CC0_URI,
        verificationSource: 'getty.subject_to (Collection Metadata)',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      // Image rights are independently verified by validateGettyImageLicense;
      // never inferred from the metadata verdict.
      imageOpenAccess: false,
      metadataOpenAccess: true,
      reason: 'getty: collection-metadata licensing declares CC0',
    };
  }
  return reject('getty: collection-metadata licensing is not CC0 (strict default reject)');
};

// Gates a single IMAGE (a Getty `media/image/<uuid>` entity), independently of
// the object's metadata rights. Never inherits `validateGettyLicense`'s
// verdict — see the two-tier comment above.
export const validateGettyImageLicense: LicenseValidator = (mediaRaw) => {
  if (!mediaRaw || typeof mediaRaw !== 'object') {
    return reject('getty-image: object missing or not an object');
  }
  const obj = mediaRaw as Record<string, unknown>;
  if (hasClassification(obj.subject_to, CC0_URI)) {
    return {
      accepted: true,
      license: {
        type: 'CC0',
        rawValue: CC0_URI,
        verificationSource: 'getty.media.subject_to',
        verifiedAt: nowIso(),
        confidence: 'high',
      },
      imageOpenAccess: true,
      metadataOpenAccess: true,
      reason: 'getty-image: subject_to declares CC0 (Open Content Program)',
    };
  }
  return reject('getty-image: subject_to is not CC0 (image restricted; strict default reject)');
};

const VALIDATORS: Record<string, LicenseValidator> = {
  met: validateMetLicense,
  cleveland: validateClevelandLicense,
  aic: validateAicLicense,
  wikimedia: validateWikimediaLicense,
  europeana: validateEuropeanaLicense,
  smithsonian: validateSmithsonianLicense,
  walters: validateWaltersLicense,
  smk: validateSmkLicense,
  wellcome: validateWellcomeLicense,
  nga: validateNgaLicense,
  harvard: validateHarvardLicense,
  getty: validateGettyLicense,
};

export function validateLicense(museumCode: string, raw: unknown): LicenseDecision {
  const v = VALIDATORS[museumCode];
  if (!v) {
    return reject(`unknown museum '${museumCode}': strict default reject`);
  }
  return v(raw);
}
