import { parseDisplayDate } from '../dateParser.js';
import { validateCleveland3DLicense, validateClevelandLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, AttributionType, Model3D, ValidationResult } from '../types.js';
import {
  asFiniteNumber,
  asOptionalString,
  asString,
  coerceFiniteNumber,
  httpGet,
  isValidPositiveInt,
  pickMaxResolution,
  rejectFor,
} from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

const CLEVELAND_API = 'https://openaccess-api.clevelandart.org/api';

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('cleveland', id, reason, rawSnapshot);

// Cleveland's creator description format is "Name (Nationality, birthYear–deathYear)"
// e.g. "Vincent van Gogh (Dutch, 1853–1890)". The structured fields
// (birth_year, death_year) supply the lifespan, so we only mine the
// description for name + nationality.
function parseCreatorDescription(description: string): { name: string; nationality?: string } {
  const parenStart = description.indexOf('(');
  if (parenStart < 0) return { name: description.trim() };

  const name = description.slice(0, parenStart).trim();
  const parenEnd = description.lastIndexOf(')');
  const inside = parenEnd > parenStart ? description.slice(parenStart + 1, parenEnd) : '';
  const firstToken = inside.split(',')[0].trim();
  // If the first token looks like a year, the description omitted nationality
  // ("Anonymous (1850)") and we should not surface it.
  const looksLikeYear = /^\d{2,4}$/.test(firstToken);
  return looksLikeYear || !firstToken ? { name } : { name, nationality: firstToken };
}

// Cleveland publishes the attribution qualifier in its own field, creators[].qualifier, not in the description.
// Qualifiers with an exact controlled type map to it.
const EXACT_QUALIFIERS: Readonly<Record<string, AttributionType>> = {
  'attributed to': 'attributed',
  'circle of': 'circle',
  'workshop of': 'workshop',
  'studio of': 'workshop',
  'follower of': 'follower',
  after: 'after',
};
// Qualifiers that still name the maker outright.
const NAMING_QUALIFIERS: ReadonlySet<string> = new Set(['firm of']);

/**
 * The attribution type for a creator, from its published qualifier first and its description otherwise.
 * A qualifier that copies another maker's design is 'after'. Any other qualifier ("possibly by", "probably by", "style of", or a wording not seen before) is a hedged
 * attribution with no exact controlled type, so it goes to 'attributed' and never to 'named'. 'attributed'
 * is a stronger claim than "possibly"; the verbatim `attributionQualifier` is what keeps a printed credit
 * exact. When the controlled vocabulary gains a 'possibly' type, remap "possibly by" here.
 */
function attributionFor(qualifier: string, description: string): AttributionType {
  const q = qualifier.toLowerCase();
  if (!q) return detectAttributionType(description);
  if (NAMING_QUALIFIERS.has(q)) return 'named';
  const exact = EXACT_QUALIFIERS[q];
  if (exact) return exact;
  // "after a design by", "cast after a model by", "possibly after": the work follows another maker's design,
  // which 'attributed' would misstate as probably by that maker.
  if (/\bafter\b/.test(q)) return 'after';
  return 'attributed';
}

/**
 * The founding year of an institution, read only from the museum's own "est. YYYY" marker in the creator
 * description ("Gobelins Manufactory (France, Paris, est. 1662)"). No name list or other heuristic: a creator
 * counts as an institution only when the museum says it was established.
 */
function foundingYearOf(description: string): string | undefined {
  return /\(([^)]*)\)/.exec(description)?.[1].match(/\best\.\s*(\d{3,4})\b/)?.[1];
}

/**
 * "1853–1890", "b. 1738" or "d. 1799": a one-sided span is marked so a single year is not read as a date.
 * An institution is dated by its founding ("est. 1662") and never by a death year: the museum gives Gobelins
 * Manufactory a death_year of 1799, and "d. 1799" would tell a reader that a still-operating manufactory closed.
 */
function lifespanOf(birth: string, death: string, founded?: string): string | undefined {
  if (founded) return `est. ${founded}`;
  if (birth && death) return `${birth}–${death}`;
  if (birth) return `b. ${birth}`;
  if (death) return `d. ${death}`;
  return undefined;
}

export const clevelandFetcher: Fetcher = {
  code: 'cleveland',
  name: 'Cleveland Museum of Art',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(`${CLEVELAND_API}/artworks/`);
    url.searchParams.set('q', query);
    // Push the rights filter to the museum so the gate has fewer rejections to
    // handle. Cleveland's `cc0=1` is server-side defense in depth alongside
    // the per-record validateClevelandLicense check on every fetched object.
    url.searchParams.set('cc0', '1');
    if (options.hasImage !== false) {
      url.searchParams.set('has_image', '1');
    }
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', 'id');

    const res = await httpGet(url, { signal: options.signal });
    if (!res.ok) throw new Error(`Cleveland search failed: ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const data = json.data ?? [];
    return data
      .map((d) => (typeof d.id === 'number' ? `cleveland:${d.id}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const numeric = id.replace(/^cleveland:/, '');
    const res = await httpGet(`${CLEVELAND_API}/artworks/${numeric}`);
    if (!res.ok) throw new Error(`Cleveland get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('cleveland:unknown', 'cleveland: response not an object', raw);
    }
    // Cleveland wraps single-record responses in `{"data": {...}}`. Tolerate
    // either shape so fixtures and direct-record callers both work.
    const wrapped = (raw as { data?: unknown }).data;
    const inner = wrapped && typeof wrapped === 'object' ? wrapped : raw;
    const r = inner as Record<string, unknown>;

    const objectId = r.id;
    const validId = isValidPositiveInt(objectId);
    const id = validId ? `cleveland:${objectId}` : 'cleveland:unknown';

    const decision = validateClevelandLicense(inner);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    if (!validId) {
      return reject(id, 'cleveland: missing or non-integer id', raw);
    }

    const displayDate = asString(r.creation_date);
    const earliest = asFiniteNumber(r.creation_date_earliest);
    const latest = asFiniteNumber(r.creation_date_latest);
    // Cleveland publishes earliest/latest year fields directly. Trust those
    // when both are present; otherwise fall through to parseDisplayDate. We
    // prefer the display-date parser over a single available bound because
    // the displayDate string usually carries a richer signal — "1850s"
    // parses to {1850, 1859}, more informative than an isolated
    // creation_date_earliest=1850 with creation_date_latest missing.
    const dateRange =
      earliest !== null && latest !== null
        ? { yearStart: earliest, yearEnd: latest }
        : parseDisplayDate(displayDate);

    const creators = Array.isArray(r.creators)
      ? (r.creators as Array<Record<string, unknown>>)
      : [];
    const primary = creators[0];
    const description = sanitizeArtistName(asString(primary?.description));
    const qualifier = sanitizeArtistName(asString(primary?.qualifier)).trim();
    const attributionType = attributionFor(qualifier, description);
    const parsed = parseCreatorDescription(description);
    const cleanName = cleanArtistName(parsed.name);

    const birth = asString(primary?.birth_year);
    const death = asString(primary?.death_year);
    const lifespan = lifespanOf(birth, death, foundingYearOf(description));

    const cultureArr = Array.isArray(r.culture) ? (r.culture as unknown[]) : [];
    const cultureStr = asString(cultureArr[0]);
    const region = normalizeRegion(cultureStr);

    const images = (r.images && typeof r.images === 'object' ? r.images : {}) as Record<string, unknown>;
    const printVariant = images.print as Record<string, unknown> | undefined;
    const webVariant = images.web as Record<string, unknown> | undefined;
    const fullVariant = images.full as Record<string, unknown> | undefined;
    // Displayable image: prefer the `print` JPEG (~3400px, renders in <img>),
    // fall back to `web`. We deliberately do NOT put the `full` asset here —
    // it's a multi-hundred-MB TIFF that no browser renders.
    const displayVariant = asString(printVariant?.url) ? printVariant : webVariant;
    const fullImage = asString(displayVariant?.url);
    const thumbnail = asOptionalString(webVariant?.url);
    const displayWidth = coerceFiniteNumber(displayVariant?.width) ?? undefined;
    const displayHeight = coerceFiniteNumber(displayVariant?.height) ?? undefined;
    const displayBytes = coerceFiniteNumber(displayVariant?.filesize) ?? undefined;

    // Archival master: the `_full.tif` (e.g. 11966×7990, orders of magnitude
    // larger than `print`). Surfaced as `master` so print/POD consumers can reach
    // the true maximum, while `full` stays browser-safe. TIFF is flagged via
    // `format` so consumers know it needs conversion before an <img>.
    const masterUrl = asString(fullVariant?.url);
    const masterWidth = coerceFiniteNumber(fullVariant?.width) ?? undefined;
    const masterHeight = coerceFiniteNumber(fullVariant?.height) ?? undefined;
    const master = masterUrl
      ? {
          url: masterUrl,
          width: masterWidth,
          height: masterHeight,
          format: /\.tif{1,2}$/i.test(masterUrl) ? 'image/tiff' : undefined,
          byteSize: coerceFiniteNumber(fullVariant?.filesize) ?? undefined,
        }
      : undefined;

    const maxResolution = pickMaxResolution(
      { width: masterWidth, height: masterHeight },
      { width: displayWidth, height: displayHeight },
    );

    // Cleveland's Open Access initiative extends to 3D scans they digitized
    // and host on Sketchfab (see validateCleveland3DLicense). Gated per-scan,
    // independent of the 2D imageOpenAccess/metadataOpenAccess above — never
    // inherited. Absent (not an empty array) when no scan exists or the gate
    // rejects it, matching every other optional Artwork field's convention.
    // Provenance: Cleveland publishes a STRUCTURED custody record (ordered
    // steps with description/date/citations/footnotes). Carried under the
    // openclearance P-7 posture: `raw` = the source array EXACTLY as received,
    // JSON-serialized (nothing dropped — citations/footnotes/sortorder all
    // survive inside it, and it is authoritative); `entries` = the minimal
    // interpretation, one entry per published step in museum order, wording
    // verbatim. No step is merged, dropped, or synthesized; the museum's own
    // gap language ("?–1963") rides inside the verbatim text. Absent field =
    // "not published here", never a finding.
    const provRaw = Array.isArray(r.provenance) ? (r.provenance as unknown[]) : [];
    const provSteps = provRaw.filter(
      (p): p is Record<string, unknown> => !!p && typeof p === 'object',
    );
    const provEntries = [...provSteps]
      .sort((a, b) => (coerceFiniteNumber(a.sortorder) ?? 0) - (coerceFiniteNumber(b.sortorder) ?? 0))
      .flatMap((p) => {
        const description = asString(p.description);
        const date = asOptionalString(p.date);
        if (!description && !date) return []; // a fully empty step carries nothing to surface; it still survives in `raw`
        return [{ description, ...(date ? { date } : {}) }];
      });
    const provenance =
      provSteps.length > 0
        ? {
            raw: JSON.stringify(r.provenance),
            rawFormat: 'structured-json' as const,
            ...(provEntries.length > 0 ? { entries: provEntries } : {}),
          }
        : undefined;

    const sketchfabUrl = asOptionalString(r.sketchfab_url);
    let models3d: Model3D[] | undefined;
    const model3dDecision = validateCleveland3DLicense(inner);
    if (model3dDecision.accepted && model3dDecision.license && sketchfabUrl) {
      models3d = [
        {
          url: sketchfabUrl,
          source: 'sketchfab',
          licence: model3dDecision.license,
        },
      ];
    }

    const artwork: Artwork = {
      id,
      museum: {
        code: 'cleveland',
        name: 'Cleveland Museum of Art',
        url: 'https://www.clevelandart.org',
      },
      title: sanitizeTitle(asString(r.title)) || '(Untitled)',
      artist: {
        name: cleanName || 'Unknown',
        nationality: parsed.nationality,
        lifespan,
        attributionType,
        ...(qualifier ? { attributionQualifier: qualifier } : {}),
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: asString(r.technique),
      mediumCategory: normalizeMedium(asString(r.technique)),
      region,
      period: null,
      imageUrls: {
        full: fullImage,
        thumbnail,
        width: displayWidth,
        height: displayHeight,
        byteSize: displayBytes,
        master,
        maxResolution,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${CLEVELAND_API}/artworks/${objectId}`,
        pageUrl: asString(r.url),
      },
      description: asOptionalString(r.accession_number),
      ...(models3d ? { models3d } : {}),
      ...(provenance ? { provenance } : {}),
    };

    return { status: 'accepted', artwork };
  },
};
