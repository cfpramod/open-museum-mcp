import { parseDisplayDate } from '../dateParser.js';
import { validateSmithsonianLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asOptionalString, asString, httpGet, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// Smithsonian Open Access (EDAN) API. ~3–4M CC0 objects across the
// Institution's units (SAAM, NMAH, NPG, CHNDM, NMAI, …). Search returns full
// records; we extract the stable `id` and re-fetch each via /content/{id} so
// the federation's single per-id cache + rights-gate path is reused unchanged.
const SI_API = 'https://api.si.edu/openaccess/api/v1.0';
const SI_SITE = 'https://www.si.edu';

// EDAN's `rows` is capped at 1000 per request; we never request near that.
const SI_MAX_ROWS = 1000;

// Maker labels in `content.freetext.name[]` that denote the CREATOR of the
// work. EDAN also carries non-maker name labels (notably "Sitter" on portraits,
// plus "Subject", "Donor", "Owner") which must NOT be surfaced as the artist.
const MAKER_LABELS = new Set(['artist', 'maker', 'author', 'creator', 'manufacturer', 'designer']);

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('smithsonian', id, reason, rawSnapshot);

interface FreetextEntry {
  label?: unknown;
  content?: unknown;
}

/** Read `content.freetext.<key>` as an array of {label, content} entries. */
function freetextEntries(content: Record<string, unknown>, key: string): FreetextEntry[] {
  const freetext = content.freetext;
  if (!freetext || typeof freetext !== 'object') return [];
  const arr = (freetext as Record<string, unknown>)[key];
  return Array.isArray(arr) ? (arr as FreetextEntry[]) : [];
}

/** First freetext entry whose label (case-insensitive) is in `labels`, else the first entry. */
function pickByLabel(entries: FreetextEntry[], labels: Set<string>): string {
  for (const e of entries) {
    const label = typeof e.label === 'string' ? e.label.toLowerCase() : '';
    if (labels.has(label)) return asString(e.content);
  }
  return '';
}

/** First freetext entry's content regardless of label (used for single-purpose arrays). */
function firstContent(entries: FreetextEntry[]): string {
  for (const e of entries) {
    const c = asString(e.content);
    if (c) return c;
  }
  return '';
}

interface SiMedia {
  type?: unknown;
  content?: unknown;
  thumbnail?: unknown;
  usage?: { access?: unknown };
  resources?: unknown;
}

/**
 * Select the primary image media from `online_media.media[]`. Returns the
 * delivery URL + thumbnail + (when published) pixel dimensions, but ONLY when
 * the chosen media's own `usage.access` is CC0 — a metadata-CC0 record whose
 * image carries usage conditions surfaces no image (imageOpenAccess=false).
 */
function pickImage(
  content: Record<string, unknown>,
  imageOpenAccess: boolean,
): { full: string; thumbnail?: string; width?: number; height?: number } {
  if (!imageOpenAccess) return { full: '' };
  const dnr = content.descriptiveNonRepeating;
  const om =
    dnr && typeof dnr === 'object'
      ? (dnr as Record<string, unknown>).online_media
      : undefined;
  const mediaArr =
    om && typeof om === 'object' && Array.isArray((om as { media?: unknown }).media)
      ? ((om as { media: SiMedia[] }).media)
      : [];
  // The validator derived imageOpenAccess from this SAME selection (first
  // Images-type media, falling back to the first) — keep the two in lockstep so
  // the rights flag always describes the asset we actually surface.
  const media = mediaArr.find((m) => asString(m.type).toLowerCase() === 'images') ?? mediaArr[0];
  if (!media) return { full: '' };

  const full = asString(media.content);
  const thumbnail = asOptionalString(media.thumbnail);

  // Mine published pixel dimensions from the high-res rendition for the
  // additive imageUrls.width/height fields (DX). Prefer JPEG over TIFF.
  let width: number | undefined;
  let height: number | undefined;
  const resources = Array.isArray(media.resources)
    ? (media.resources as Array<Record<string, unknown>>)
    : [];
  const jpeg = resources.find((r) => /jpeg|jpg/i.test(asString(r.label)));
  const tiff = resources.find((r) => /tiff|tif/i.test(asString(r.label)));
  const dims = jpeg ?? tiff;
  if (dims) {
    const w = asFiniteNumber(dims.width);
    const h = asFiniteNumber(dims.height);
    if (w !== null && w > 0) width = w;
    if (h !== null && h > 0) height = h;
  }

  return { full, thumbnail, width, height };
}

function apiKey(): string {
  const key = process.env.SI_API_KEY;
  if (!key) {
    throw new Error(
      'SI_API_KEY not set: the Smithsonian Open Access source requires an api.data.gov key. ' +
        'Set it in ~/.open-museum-mcp/.env or your shell.',
    );
  }
  return key;
}

export const smithsonianFetcher: Fetcher = {
  code: 'smithsonian',
  name: 'Smithsonian Institution',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(`${SI_API}/search`);
    // Bias toward records that actually carry an image when has_image is set.
    // EDAN supports field filters inside `q`; the strict rights gate in
    // normalize re-validates CC0 on every fetched record regardless (defense in
    // depth — the search filter is a hint, not a guarantee).
    const q =
      options.hasImage !== false ? `${query} AND online_media_type:"Images"` : query;
    url.searchParams.set('q', q);
    url.searchParams.set('rows', String(Math.min(limit, SI_MAX_ROWS)));
    url.searchParams.set('start', '0');
    url.searchParams.set('api_key', apiKey());

    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Smithsonian search failed: ${res.status}`);
    const json = (await res.json()) as {
      response?: { rows?: Array<{ id?: unknown }> };
    };
    const rows = json.response?.rows ?? [];
    return rows
      .map((r) => (typeof r.id === 'string' && r.id.length > 0 ? `smithsonian:${r.id}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const objectId = id.replace(/^smithsonian:/, '');
    const url = new URL(`${SI_API}/content/${encodeURIComponent(objectId)}`);
    url.searchParams.set('api_key', apiKey());
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Smithsonian get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('smithsonian:unknown', 'smithsonian: response not an object', raw);
    }
    // The /content endpoint wraps the record in `{response: {...}}`; search rows
    // are bare records. Tolerate either so fixtures and live callers both work.
    const wrapped = (raw as { response?: unknown }).response;
    const record = (
      wrapped && typeof wrapped === 'object' ? wrapped : raw
    ) as Record<string, unknown>;

    const objectId = record.id;
    const validId = typeof objectId === 'string' && objectId.length > 0;
    const id = validId ? `smithsonian:${objectId}` : 'smithsonian:unknown';

    const decision = validateSmithsonianLicense(record);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    if (!validId) {
      return reject(id, 'smithsonian: missing or non-string id', raw);
    }

    const content =
      record.content && typeof record.content === 'object'
        ? (record.content as Record<string, unknown>)
        : {};
    const dnr =
      content.descriptiveNonRepeating && typeof content.descriptiveNonRepeating === 'object'
        ? (content.descriptiveNonRepeating as Record<string, unknown>)
        : {};
    const indexed =
      content.indexedStructured && typeof content.indexedStructured === 'object'
        ? (content.indexedStructured as Record<string, unknown>)
        : {};

    // Title: prefer the structured dnr.title.content, fall back to the
    // top-level mirror, then to a placeholder.
    const titleObj =
      dnr.title && typeof dnr.title === 'object' ? (dnr.title as { content?: unknown }) : {};
    const rawTitle = asString(titleObj.content) || asString(record.title);
    const title = sanitizeTitle(rawTitle) || '(Untitled)';

    // Artist: the maker-labelled freetext name, never a Sitter/Subject.
    const makerName = sanitizeArtistName(pickByLabel(freetextEntries(content, 'name'), MAKER_LABELS));
    const attributionType = detectAttributionType(makerName);
    const cleanName = cleanArtistName(makerName);

    const displayDate = pickByLabel(
      freetextEntries(content, 'date'),
      new Set(['date']),
    );
    const dateRange = parseDisplayDate(displayDate);

    const medium = pickByLabel(freetextEntries(content, 'physicalDescription'), new Set(['medium']));

    // Region: prefer the indexed culture vocabulary, then place; both are
    // string arrays. Fall back to the freetext place display string.
    const culture = Array.isArray(indexed.culture) ? asString((indexed.culture as unknown[])[0]) : '';
    const place = Array.isArray(indexed.place) ? asString((indexed.place as unknown[])[0]) : '';
    const region =
      normalizeRegion(culture) ??
      normalizeRegion(place) ??
      normalizeRegion(firstContent(freetextEntries(content, 'place')));

    const image = pickImage(content, decision.imageOpenAccess);

    // Museum: surface the contributing unit's full name (e.g. "Smithsonian
    // American Art Museum") for accurate citation, keeping the federation code
    // 'smithsonian'. data_source is the unit's display name.
    const unitName = sanitizeArtistName(asString(dnr.data_source)) || 'Smithsonian Institution';
    const recordLink = asString(dnr.record_link) || asString(dnr.guid);

    const artwork: Artwork = {
      id,
      museum: {
        code: 'smithsonian',
        name: unitName,
        url: SI_SITE,
      },
      title,
      artist: {
        name: cleanName || 'Unknown',
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium,
      mediumCategory: normalizeMedium(medium),
      region,
      period: null,
      imageUrls: {
        full: image.full,
        thumbnail: image.thumbnail,
        width: image.width,
        height: image.height,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${SI_API}/content/${objectId}`,
        pageUrl: recordLink,
      },
      description: asOptionalString(
        sanitizeTitle(pickByLabel(freetextEntries(content, 'objectType'), new Set(['type']))),
      ),
    };

    return { status: 'accepted', artwork };
  },
};
