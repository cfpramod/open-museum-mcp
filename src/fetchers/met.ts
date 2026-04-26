import { parseDisplayDate } from '../dateParser.js';
import { validateMetLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asOptionalString, asString } from './helpers.js';
import type { Fetcher, SearchOptions } from './types.js';

const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1';

export const metFetcher: Fetcher = {
  code: 'met',
  name: 'The Metropolitan Museum of Art',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(`${MET_API}/search`);
    url.searchParams.set('q', query);
    if (options.hasImage !== false) {
      url.searchParams.set('hasImages', 'true');
    }
    url.searchParams.set('isPublicDomain', 'true');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Met search failed: ${res.status}`);
    const json = (await res.json()) as { objectIDs?: number[] | null; total?: number };
    const ids = json.objectIDs ?? [];
    return ids.slice(0, limit).map((n) => `met:${n}`);
  },

  async getRaw(id: string): Promise<unknown> {
    const numeric = id.replace(/^met:/, '');
    const res = await fetch(`${MET_API}/objects/${numeric}`);
    if (!res.ok) throw new Error(`Met get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'rejected',
        rejection: {
          id: 'met:unknown',
          museumCode: 'met',
          reason: 'response not an object',
          rawSnapshot: raw,
        },
      };
    }
    const r = raw as Record<string, unknown>;
    const objectID = r.objectID;
    // Met IDs are always positive integers. Anything else flunks ID_REGEX
    // downstream; emit a placeholder so the rejection still carries a stable
    // (and obviously bogus) id for logs.
    const validId = typeof objectID === 'number' && Number.isInteger(objectID) && objectID > 0;
    const id = validId ? `met:${objectID}` : 'met:unknown';

    const decision = validateMetLicense(raw);
    if (!decision.accepted || !decision.license) {
      return {
        status: 'rejected',
        rejection: {
          id,
          museumCode: 'met',
          reason: decision.reason,
          rawSnapshot: raw,
        },
      };
    }

    if (!validId) {
      return {
        status: 'rejected',
        rejection: {
          id,
          museumCode: 'met',
          reason: 'met: missing or non-integer objectID',
          rawSnapshot: raw,
        },
      };
    }

    const displayDate = asString(r.objectDate);
    const dateRange = parseDisplayDate(displayDate);

    const artistRaw = asString(r.artistDisplayName);
    const attributionType = detectAttributionType(artistRaw);
    const cleanName = cleanArtistName(artistRaw);

    const cultureOrCountry =
      asString(r.culture) || asString(r.country) || asString(r.classification);
    const region = normalizeRegion(cultureOrCountry);

    const periodRaw = (asString(r.period) || asString(r.dynasty)).toLowerCase().trim();
    const period = periodRaw.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;

    const fullImage = asString(r.primaryImage) || asString(r.primaryImageSmall);
    const thumbnail = asOptionalString(r.primaryImageSmall);

    const beginDate = asString(r.artistBeginDate);
    const endDate = asString(r.artistEndDate);
    const lifespan = beginDate || endDate ? `${beginDate}–${endDate}`.replace(/^–|–$/g, '') : undefined;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'met',
        name: 'The Metropolitan Museum of Art',
        url: 'https://www.metmuseum.org',
      },
      title: (asString(r.title) || '(Untitled)').trim(),
      artist: {
        name: cleanName || 'Unknown',
        nationality: asOptionalString(r.artistNationality),
        lifespan,
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: asString(r.medium),
      region,
      period,
      imageUrls: {
        full: fullImage,
        thumbnail,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${MET_API}/objects/${objectID}`,
        pageUrl: asString(r.objectURL) || `https://www.metmuseum.org/art/collection/search/${objectID}`,
      },
      description: asOptionalString(r.objectName),
      rawTags: Array.isArray(r.tags)
        ? (r.tags as Array<unknown>)
            .map((t) => (t && typeof t === 'object' ? (t as { term?: unknown }).term : undefined))
            .filter((s): s is string => typeof s === 'string')
        : undefined,
    };

    return { status: 'accepted', artwork };
  },
};
