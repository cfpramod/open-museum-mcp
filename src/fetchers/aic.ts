import { parseDisplayDate } from '../dateParser.js';
import { validateAicLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asOptionalString, asString } from './helpers.js';
import type { Fetcher, SearchOptions } from './types.js';

const AIC_API = 'https://api.artic.edu/api/v1';
const AIC_IIIF = 'https://www.artic.edu/iiif/2';
const AIC_PAGE = 'https://www.artic.edu/artworks';

// Fields requested from /artworks/{id}. Limiting via ?fields= shrinks the
// payload roughly 10x compared with the default response (which carries
// every relationship and provenance entry AIC has).
const AIC_FIELDS = [
  'id',
  'title',
  'is_public_domain',
  'artist_display',
  'artist_title',
  'date_display',
  'date_start',
  'date_end',
  'place_of_origin',
  'medium_display',
  'classification_title',
  'image_id',
].join(',');

function reject(id: string, reason: string, rawSnapshot: unknown): ValidationResult {
  return {
    status: 'rejected',
    rejection: { id, museumCode: 'aic', reason, rawSnapshot },
  };
}

// AIC's `artist_display` format mirrors Cleveland's: "Name (Nationality,
// birthYear–deathYear)". The structured `artist_title` field gives us the
// canonical name without the parenthetical, so we use that and only mine
// the display string for nationality and lifespan.
function looksLikeNationality(token: string): boolean {
  // Nationality words are short, alphabetic, no digits, and don't start with
  // "born" (which AIC sometimes uses for living artists, e.g.
  // "X (born 1950)"). The strict shape check here keeps year tokens and
  // birth-line tokens out of the nationality field.
  return token.length > 0 && !/\d/.test(token) && !/^born\b/i.test(token);
}

function parseArtistDisplay(display: string): { nationality?: string; lifespan?: string } {
  const parenStart = display.indexOf('(');
  if (parenStart < 0) return {};
  const parenEnd = display.lastIndexOf(')');
  const inside = parenEnd > parenStart ? display.slice(parenStart + 1, parenEnd) : '';
  const tokens = inside.split(',').map((t) => t.trim()).filter(Boolean);
  const nationality = tokens[0] && looksLikeNationality(tokens[0]) ? tokens[0] : undefined;
  const yearLine = tokens.find((t) => /^\d{1,4}/.test(t) || /^born\b/i.test(t));
  return { nationality, lifespan: yearLine || undefined };
}

export const aicFetcher: Fetcher = {
  code: 'aic',
  name: 'Art Institute of Chicago',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(`${AIC_API}/artworks/search`);
    url.searchParams.set('q', query);
    // Push the rights filter to AIC server-side via Elasticsearch term
    // query, so the gate has fewer rejections to handle. Defense in depth:
    // validateAicLicense still re-checks each fetched record.
    url.searchParams.set('query[term][is_public_domain]', 'true');
    if (options.hasImage !== false) {
      // exists query against image_id keeps records without IIIF imagery
      // out of the candidate list.
      url.searchParams.set('query[exists][field]', 'image_id');
    }
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', 'id');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`AIC search failed: ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const data = json.data ?? [];
    return data
      .map((d) => (typeof d.id === 'number' ? `aic:${d.id}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const numeric = id.replace(/^aic:/, '');
    const url = new URL(`${AIC_API}/artworks/${numeric}`);
    url.searchParams.set('fields', AIC_FIELDS);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AIC get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('aic:unknown', 'aic: response not an object', raw);
    }
    // AIC wraps single-record responses in `{"data": {...}}`. Tolerate
    // either shape (mirrors the Cleveland adapter pattern).
    const wrapped = (raw as { data?: unknown }).data;
    const inner = wrapped && typeof wrapped === 'object' ? wrapped : raw;
    const r = inner as Record<string, unknown>;

    const objectId = r.id;
    const validId =
      typeof objectId === 'number' && Number.isInteger(objectId) && objectId > 0;
    const id = validId ? `aic:${objectId}` : 'aic:unknown';

    const decision = validateAicLicense(inner);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    if (!validId) {
      return reject(id, 'aic: missing or non-integer id', raw);
    }

    const displayDate = asString(r.date_display);
    const dateStart = asFiniteNumber(r.date_start);
    const dateEnd = asFiniteNumber(r.date_end);
    // AIC ships date_start/date_end as integers. Trust them when both are
    // present; fall back to parseDisplayDate otherwise so dynasty-aware
    // parsing still helps for sparser records.
    const dateRange =
      dateStart !== null && dateEnd !== null
        ? { yearStart: dateStart, yearEnd: dateEnd }
        : parseDisplayDate(displayDate);

    const artistDisplay = asString(r.artist_display);
    const artistTitle = asString(r.artist_title);
    const attributionType = artistDisplay
      ? detectAttributionType(artistDisplay)
      : 'anonymous';
    // Prefer `artist_title` (canonical name without the parenthetical).
    // Fall back to mining `artist_display` if artist_title is missing.
    const cleanName = cleanArtistName(artistTitle || artistDisplay.split('(')[0].trim());
    const { nationality, lifespan } = parseArtistDisplay(artistDisplay);

    const region = normalizeRegion(asString(r.place_of_origin));

    const imageId = asString(r.image_id);
    // AIC publishes through IIIF Image API 2.0. 843px-wide is AIC's
    // standard public-display size; 200px-wide is the thumbnail tier.
    const fullImage = imageId ? `${AIC_IIIF}/${imageId}/full/843,/0/default.jpg` : '';
    const thumbnail = imageId ? `${AIC_IIIF}/${imageId}/full/200,/0/default.jpg` : undefined;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'aic',
        name: 'Art Institute of Chicago',
        url: 'https://www.artic.edu',
      },
      title: (asString(r.title) || '(Untitled)').trim(),
      artist: {
        name: cleanName || 'Unknown',
        nationality,
        lifespan,
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: asString(r.medium_display),
      region,
      period: null,
      imageUrls: {
        full: fullImage,
        thumbnail,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${AIC_API}/artworks/${objectId}`,
        pageUrl: `${AIC_PAGE}/${objectId}`,
      },
      description: asOptionalString(r.classification_title),
    };

    return { status: 'accepted', artwork };
  },
};
