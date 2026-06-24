import { parseDisplayDate } from '../dateParser.js';
import { validateSmkLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asOptionalString, asString, httpGet, pickMaxResolution, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// SMK — Statens Museum for Kunst (National Gallery of Denmark). Keyless REST API
// (api.smk.dk) over ~89k works; ~39k are public-domain + image-bearing, served as
// IIIF JP2 masters with a full-resolution `image_native` JPEG (print-grade — most
// are well above 3000px). Rights are a per-object `public_domain` boolean + a
// `rights` PD/CC0 URI, judged by validateSmkLicense.
const SMK_API = 'https://api.smk.dk/api/v1/art';

// Only the fields the adapter reads — keeps the (otherwise large) records small.
const SMK_FIELDS = [
  'object_number',
  'titles',
  'public_domain',
  'rights',
  'has_image',
  'image_native',
  'image_width',
  'image_height',
  'production_date',
  'artist',
  'techniques',
  'object_names',
  'object_url',
  'frontend_url',
].join(',');

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('smk', id, reason, rawSnapshot);

/** Pick a title: prefer an English title, else the first present. */
function pickTitle(titles: unknown): string {
  if (!Array.isArray(titles)) return '';
  const entries = titles.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object');
  const english = entries.find((t) => /english|engelsk/i.test(asString(t.language)));
  const chosen = english ?? entries[0];
  return chosen ? asString(chosen.title) : '';
}

/** Extract a signed year from an SMK ISO date string (handles BCE leading '-'). */
function isoYear(v: unknown): number | null {
  const s = asString(v);
  const m = s.match(/^(-?\d{1,6})-/);
  return m ? Number(m[1]) : null;
}

export const smkFetcher: Fetcher = {
  code: 'smk',
  name: 'Statens Museum for Kunst (National Gallery of Denmark)',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(`${SMK_API}/search/`);
    url.searchParams.set('keys', query || '*');
    // Push rights + image filters server-side (defense in depth: validateSmkLicense
    // re-checks public_domain on every fetched record).
    const filters = ['[public_domain:true]'];
    if (options.hasImage !== false) filters.push('[has_image:true]');
    url.searchParams.set('filters', filters.join(','));
    url.searchParams.set('offset', '0');
    url.searchParams.set('rows', String(limit));
    url.searchParams.set('fields', 'object_number');

    const res = await httpGet(url);
    if (!res.ok) throw new Error(`SMK search failed: ${res.status}`);
    const json = (await res.json()) as { items?: Array<{ object_number?: unknown }> };
    const items = json.items ?? [];
    return items
      .map((it) => (typeof it.object_number === 'string' && it.object_number.length > 0
        ? `smk:${it.object_number}`
        : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const objectNumber = id.replace(/^smk:/, '');
    const url = new URL(`${SMK_API}/`);
    url.searchParams.set('object_number', objectNumber);
    url.searchParams.set('fields', SMK_FIELDS);
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`SMK get failed for ${id}: ${res.status}`);
    const json = (await res.json()) as { items?: unknown[] };
    return Array.isArray(json.items) && json.items[0] ? json.items[0] : null;
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('smk:unknown', 'smk: record not an object', raw);
    }
    const r = raw as Record<string, unknown>;
    const objectNumber = asString(r.object_number);
    const id = objectNumber ? `smk:${objectNumber}` : 'smk:unknown';

    const decision = validateSmkLicense(raw);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }
    if (!objectNumber) {
      return reject(id, 'smk: missing object_number', raw);
    }

    // Dates: SMK ships production_date[] with ISO start/end + a display `period`.
    const prod = Array.isArray(r.production_date) && r.production_date[0] && typeof r.production_date[0] === 'object'
      ? (r.production_date[0] as Record<string, unknown>)
      : undefined;
    const displayDate = prod ? asString(prod.period) : '';
    const yStart = prod ? isoYear(prod.start) : null;
    const yEnd = prod ? isoYear(prod.end) : null;
    const dateRange = yStart !== null || yEnd !== null
      ? { yearStart: yStart, yearEnd: yEnd ?? yStart }
      : parseDisplayDate(displayDate);

    // Artist: SMK `artist` is an array of names.
    const artists = Array.isArray(r.artist) ? r.artist : [];
    const primaryName = sanitizeArtistName(asString(artists[0]));
    const attributionType = detectAttributionType(primaryName);
    const cleanName = cleanArtistName(primaryName);

    const techniques = Array.isArray(r.techniques) ? (r.techniques as unknown[]).map(asString).filter(Boolean) : [];
    const medium = techniques.join(', ');

    const objectNames = Array.isArray(r.object_names) ? r.object_names : [];
    const firstObjectName = objectNames[0] && typeof objectNames[0] === 'object'
      ? asString((objectNames[0] as Record<string, unknown>).name)
      : '';

    const width = asFiniteNumber(r.image_width) ?? undefined;
    const height = asFiniteNumber(r.image_height) ?? undefined;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'smk',
        name: 'Statens Museum for Kunst (National Gallery of Denmark)',
        url: 'https://www.smk.dk',
      },
      title: sanitizeTitle(pickTitle(r.titles)) || '(Untitled)',
      artist: {
        name: cleanName || 'Unknown',
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium,
      mediumCategory: normalizeMedium(medium || firstObjectName),
      region: null,
      period: null,
      imageUrls: {
        // `image_native` is the full-resolution JPEG derivative (print-grade), so
        // it is both the displayable image and the maximum SMK offers.
        full: asString(r.image_native),
        thumbnail: undefined,
        width,
        height,
        maxResolution: pickMaxResolution({ width, height }),
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${SMK_API}/?object_number=${encodeURIComponent(objectNumber)}`,
        pageUrl: asString(r.frontend_url) || asString(r.object_url),
      },
      description: asOptionalString(firstObjectName),
    };

    return { status: 'accepted', artwork };
  },
};
