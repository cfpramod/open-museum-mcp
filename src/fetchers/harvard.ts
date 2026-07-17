import { parseDisplayDate } from '../dateParser.js';
import { validateHarvardLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asOptionalString, asString, httpGet, pickMaxResolution, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// Harvard Art Museums — keyless-to-you-but-keyed REST API (api.harvardartmuseums.org,
// HARVARD_API_KEY). Rights are per-object via `imagepermissionlevel` (0 = open
// access); judged by validateHarvardLicense and surfaced honestly (Open Clearance:
// not over-claimed as CC0/PD). Harvard's terms forbid caching records beyond two
// weeks, so this fetcher sets `noCache` — the federation fetches it live every time
// and never writes its records to the object cache.
const HARVARD_API = 'https://api.harvardartmuseums.org';
const HARVARD_FIELDS = [
  'id',
  'title',
  'dated',
  'datebegin',
  'dateend',
  'classification',
  'medium',
  'culture',
  'period',
  'people',
  'creditline',
  'imagepermissionlevel',
  'primaryimageurl',
  'images',
  'url',
].join(',');

function harvardKey(): string | undefined {
  return process.env.HARVARD_API_KEY;
}

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('harvard', id, reason, rawSnapshot);

/** Primary maker from the `people` array (role "Artist" preferred, else first). */
function pickArtist(people: unknown): string {
  if (!Array.isArray(people)) return '';
  const entries = people.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object');
  const artist = entries.find((p) => /artist|painter|maker/i.test(asString(p.role)));
  const chosen = artist ?? entries[0];
  return chosen ? asString(chosen.displayname) || asString(chosen.name) : '';
}

/** Pixel dims of the primary image (images[0]). */
function imageDims(images: unknown): { width?: number; height?: number } {
  if (!Array.isArray(images) || !images[0] || typeof images[0] !== 'object') return {};
  const im = images[0] as Record<string, unknown>;
  const w = asFiniteNumber(im.width);
  const h = asFiniteNumber(im.height);
  return { width: w !== null && w > 0 ? w : undefined, height: h !== null && h > 0 ? h : undefined };
}

export const harvardFetcher: Fetcher = {
  code: 'harvard',
  name: 'Harvard Art Museums',
  // Harvard ToS: no caching beyond two weeks → never cache full records.
  noCache: true,

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const key = harvardKey();
    if (!key) throw new Error('HARVARD_API_KEY not set');
    const url = new URL(`${HARVARD_API}/object`);
    url.searchParams.set('apikey', key);
    url.searchParams.set('q', query);
    if (options.hasImage !== false) url.searchParams.set('hasimage', '1');
    url.searchParams.set('size', String(Math.min(limit, 100)));
    url.searchParams.set('sort', 'rank');
    url.searchParams.set('fields', 'id');

    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Harvard search failed: ${res.status}`);
    const json = (await res.json()) as { records?: Array<{ id?: unknown }> };
    return (json.records ?? [])
      .map((r) => (typeof r.id === 'number' ? `harvard:${r.id}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const key = harvardKey();
    if (!key) throw new Error('HARVARD_API_KEY not set');
    const numeric = id.replace(/^harvard:/, '');
    const url = new URL(`${HARVARD_API}/object/${numeric}`);
    url.searchParams.set('apikey', key);
    url.searchParams.set('fields', HARVARD_FIELDS);
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Harvard get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('harvard:unknown', 'harvard: response not an object', raw);
    }
    const r = raw as Record<string, unknown>;
    const objectId = asFiniteNumber(r.id);
    const id = objectId !== null && objectId > 0 ? `harvard:${objectId}` : 'harvard:unknown';

    const decision = validateHarvardLicense(raw);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }
    if (objectId === null || objectId <= 0) {
      return reject(id, 'harvard: missing or non-integer id', raw);
    }

    const imageUrl = asString(r.primaryimageurl);
    if (!imageUrl) {
      return reject(id, 'harvard: no primary image URL (reject)', raw);
    }

    const displayDate = asString(r.dated);
    const dateStart = asFiniteNumber(r.datebegin);
    const dateEnd = asFiniteNumber(r.dateend);
    const dateRange =
      dateStart !== null && dateEnd !== null && (dateStart !== 0 || dateEnd !== 0)
        ? { yearStart: dateStart, yearEnd: dateEnd }
        : parseDisplayDate(displayDate);

    const artistRaw = sanitizeArtistName(pickArtist(r.people));
    const attributionType = detectAttributionType(artistRaw);
    const cleanName = cleanArtistName(artistRaw);

    const { width, height } = imageDims(r.images);

    // Provenance: published as ONE free-text block. P-7 posture: `raw` is the
    // text VERBATIM (authoritative); `entries` is the minimal interpretation —
    // exactly one entry, same text. Absent = not published here, never a finding.
    const provText = asOptionalString(r.provenance);
    const provenance = provText
      ? { raw: provText, rawFormat: 'text' as const, entries: [{ description: provText }] }
      : undefined;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'harvard',
        name: 'Harvard Art Museums',
        url: 'https://harvardartmuseums.org',
      },
      title: sanitizeTitle(asString(r.title)) || '(Untitled)',
      artist: {
        name: cleanName || 'Unknown',
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: asString(r.medium),
      mediumCategory: normalizeMedium(asString(r.medium) || asString(r.classification)),
      region: normalizeRegion(asString(r.culture)),
      period: asOptionalString(r.period) ?? null,
      imageUrls: {
        full: imageUrl,
        thumbnail: undefined,
        width,
        height,
        maxResolution: pickMaxResolution({ width, height }),
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        // The Harvard object page — the attribution/link-back Harvard's terms ask for.
        apiUrl: `${HARVARD_API}/object/${objectId}`,
        pageUrl: asString(r.url) || `https://harvardartmuseums.org/collections/object/${objectId}`,
      },
      description: asOptionalString(r.creditline),
      ...(provenance ? { provenance } : {}),
    };

    return { status: 'accepted', artwork };
  },
};
