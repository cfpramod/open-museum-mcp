import { parseDisplayDate } from '../dateParser.js';
import { validateClevelandLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
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

    const res = await httpGet(url);
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
    const attributionType = detectAttributionType(description);
    const parsed = parseCreatorDescription(description);
    const cleanName = cleanArtistName(parsed.name);

    const birth = asString(primary?.birth_year);
    const death = asString(primary?.death_year);
    const lifespan = birth || death ? `${birth}–${death}`.replace(/^–|–$/g, '') : undefined;

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
    };

    return { status: 'accepted', artwork };
  },
};
