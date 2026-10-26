import { parseDisplayDate } from '../dateParser.js';
import { validateSmkLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import {
  accepted,
  asFiniteNumber,
  asOptionalString,
  asString,
  httpGet,
  pickMaxResolution,
  rejectFor,
} from './helpers.js';
import { SHORT_TEXT_MAX, buildCreditLine, sanitizeArtistName, sanitizeText, sanitizeTitle } from './sanitize.js';
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
  'dimensions',
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

// SMK publishes `dimensions` only as structured {part, type, unit, value}
// entries (Danish names by default, English type and unit names with lang=en),
// so the size is composed here in one fixed format. Its `notes` text is not
// used: in the 2026-10-26 census of the 39,517 public-domain image records it
// disagreed with the values on 4,398 of 49,074 entries it could be checked on.
// Parts are SMK's cataloguing terms: blad (sheet), plade (plate), billed
// (image), montering (mount), netto (net: the work itself) and brutto (gross:
// with whatever frame, base or mount it has). SMK does not say which of these a
// gross size includes, and records casts and drawings with a gross size only,
// so brutto is written "Overall" and netto "Object", never "Framed". A part
// with an unknown name, a measurement it cannot read, two values for one
// measurement or two units is dropped whole, never written in part.
// A size with no part is written only when no other size in the record names
// one.
// Maps, not object literals: a plain object would read inherited keys such as
// "constructor" or "__proto__" as SMK terms.
const SMK_DIMENSION_PARTS = new Map<string, string>([
  ['bladmaal', 'Sheet'],
  ['plademaal', 'Plate'],
  ['billedmaal', 'Image'],
  ['monteringsmaal', 'Mount'],
  ['netto', 'Object'],
  ['nettomaal', 'Object'],
  ['brutto', 'Overall'],
  ['bruttomaal', 'Overall'],
]);
const SMK_DIMENSION_TYPES = new Map<string, 'height' | 'width' | 'depth' | 'diameter'>([
  ['højde', 'height'],
  ['height', 'height'],
  ['bredde', 'width'],
  ['width', 'width'],
  ['dybde', 'depth'],
  ['depth', 'depth'],
  ['diameter', 'diameter'],
]);
// A weight is not a size: skipped without affecting the rest of its part.
const SMK_IGNORED_TYPES = new Set(['vægt', 'weight']);
const SMK_DIMENSION_UNITS = new Map<string, 'mm' | 'cm'>([
  ['millimeter', 'mm'],
  ['milimeter', 'mm'],
  ['mm', 'mm'],
  ['centimeter', 'cm'],
  ['cm', 'cm'],
]);
const SMK_DIMENSION_VALUE = /^\d{1,6}(\.\d{1,4})?$/;
const SMK_DIMENSION_ORDER = ['height', 'width', 'depth', 'diameter'] as const;

interface SmkDimensionPart {
  label: string | undefined;
  readable: boolean;
  measures: Array<{ type: (typeof SMK_DIMENSION_ORDER)[number]; unit: 'mm' | 'cm'; value: string }>;
}

/**
 * Compose SMK's structured measurements into one string: each part in the
 * order the record first gives it, "Label: H x W [x D] unit", parts joined by
 * "; ". A part without both height and width, or with a diameter, labels each
 * measurement instead ("Sheet: diameter 265 mm"). Undefined when no part is
 * readable.
 */
function composeSmkDimensions(dimensions: unknown): string | undefined {
  if (!Array.isArray(dimensions)) return undefined;
  const parts = new Map<string, SmkDimensionPart>();
  let namesPart = false;
  for (const entry of dimensions) {
    if (!entry || typeof entry !== 'object') continue;
    const d = entry as Record<string, unknown>;
    let key: string;
    let label: string | undefined;
    if (d.part === undefined || d.part === null) {
      key = '';
    } else {
      label = typeof d.part === 'string'
        ? SMK_DIMENSION_PARTS.get(d.part.toLowerCase().replace(/å/g, 'aa'))
        : undefined;
      key = label ?? `?${String(d.part)}`;
    }
    let part = parts.get(key);
    if (!part) {
      part = { label, readable: key === '' || label !== undefined, measures: [] };
      parts.set(key, part);
    }
    const typeName = typeof d.type === 'string' ? d.type.toLowerCase() : '';
    if (SMK_IGNORED_TYPES.has(typeName)) continue;
    if (key !== '') namesPart = true;
    const type = SMK_DIMENSION_TYPES.get(typeName);
    const unit = typeof d.unit === 'string' ? SMK_DIMENSION_UNITS.get(d.unit.toLowerCase()) : undefined;
    const value = typeof d.value === 'string' && SMK_DIMENSION_VALUE.test(d.value) && Number(d.value) > 0
      ? d.value
      : undefined;
    if (type === undefined || unit === undefined || value === undefined) {
      part.readable = false;
      continue;
    }
    part.measures.push({ type, unit, value });
  }

  const written: string[] = [];
  for (const [key, part] of parts) {
    if (!part.readable || part.measures.length === 0) continue;
    // Beside a named part, a size with no part could measure anything
    // (KMS317 gives a net size and then one with no part), so it is not
    // written rather than guessed at.
    if (key === '' && namesPart) continue;
    const units = new Set(part.measures.map((x) => x.unit));
    const byType = new Map(part.measures.map((x) => [x.type, x.value]));
    if (units.size !== 1 || byType.size !== part.measures.length) continue;
    const unit = part.measures[0].unit;
    const present = SMK_DIMENSION_ORDER.filter((t) => byType.has(t));
    const size = byType.has('height') && byType.has('width') && !byType.has('diameter')
      ? `${present.map((t) => byType.get(t)).join(' x ')} ${unit}`
      : present.map((t) => `${t} ${byType.get(t)} ${unit}`).join(', ');
    written.push(part.label ? `${part.label}: ${size}` : size);
  }
  return written.length > 0 ? written.join('; ') : undefined;
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

    const res = await httpGet(url, { signal: options.signal });
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
    const displayDate = prod ? sanitizeText(asString(prod.period), SHORT_TEXT_MAX) : '';
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

    const techniques = Array.isArray(r.techniques) ? (r.techniques as unknown[]).map((t) => sanitizeText(asString(t), SHORT_TEXT_MAX)).filter(Boolean) : [];
    const medium = techniques.join(', ');

    const objectNames = Array.isArray(r.object_names) ? r.object_names : [];
    const firstObjectName = objectNames[0] && typeof objectNames[0] === 'object'
      ? sanitizeText(asString((objectNames[0] as Record<string, unknown>).name), SHORT_TEXT_MAX)
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
      dimensions: composeSmkDimensions(r.dimensions),
      // SMK publishes no credit line.
      creditLine: buildCreditLine('Statens Museum for Kunst (National Gallery of Denmark)', undefined, objectNumber),
    };

    return accepted(artwork);
  },
};
