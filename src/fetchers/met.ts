import { parseDisplayDate } from '../dateParser.js';
import { validateMetLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asOptionalString, asString, httpGet, isValidPositiveInt, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeDescription, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1';
// Search lives under v1.1 (Elastic-backed, paginated via `offset` + `limit`). The
// v1 `/search` endpoint answered HTTP 410 from 2026-10-01 and returned every
// matching ID in one response; `/objects/{id}` is unchanged and stays on v1.
const MET_SEARCH_API = 'https://collectionapi.metmuseum.org/public/collection/v1.1/search';
// Measured against the live API (2026-10-12): a request without `limit` returns 100
// IDs, and any `limit` above 500 is clamped to 500. Page in steps no larger than
// the server's own ceiling so a request for N IDs is never silently short.
const MET_SEARCH_PAGE_SIZE = 500;
// Upper bound on pages per search, so a misbehaving upstream (an endless
// non-empty page) can never turn one call into an unbounded request loop.
const MET_SEARCH_MAX_PAGES = 10;

export const metFetcher: Fetcher = {
  code: 'met',
  name: 'The Metropolitan Museum of Art',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1) return [];

    // No `isPublicDomain=true` here. On the v1 endpoint that flag was a hard
    // pre-filter that collapsed non-matching queries onto a fixed public-domain
    // fallback set, destroying relevance ranking; v1.1 ignores it entirely (same
    // total with it true, false or absent), so sending it would only mislead.
    // Rights enforcement is not the search call's job: `normalize` runs
    // `validateMetLicense` on every fetched object (strict default deny), so a
    // non-public-domain record is rejected post-fetch regardless. Filtering in
    // search would only hide the engine's actual rights behaviour behind the
    // upstream API's quirk.
    const ids: number[] = [];
    // Offset paging over a search index can repeat an ID across a page boundary
    // when scores tie (observed live: one object at positions 1497 and 1500 of a
    // 2000-ID `flower` query), and the same shift can skip a tied ID, which the
    // adapter cannot recover. v1 returned a set, so keep that contract: dedupe,
    // preserving first-seen (relevance) order.
    const seen = new Set<number>();
    // Raw IDs consumed so far. The offset must follow what the server has sent, not
    // what survived validation, or one malformed ID would shift every later page.
    let consumed = 0;
    for (let page = 0; page < MET_SEARCH_MAX_PAGES && ids.length < limit; page++) {
      const url = new URL(MET_SEARCH_API);
      url.searchParams.set('q', query);
      if (options.hasImage !== false) {
        url.searchParams.set('hasImages', 'true');
      }
      url.searchParams.set('limit', String(Math.min(limit - ids.length, MET_SEARCH_PAGE_SIZE)));
      url.searchParams.set('offset', String(consumed));

      const res = await httpGet(url);
      if (!res.ok) throw new Error(`Met search failed: ${res.status}`);
      const json = (await res.json()) as { objectIDs?: unknown; total?: unknown };
      const rawBatch: unknown[] = Array.isArray(json.objectIDs) ? json.objectIDs : [];
      if (rawBatch.length === 0) break;
      consumed += rawBatch.length;
      for (const n of rawBatch) {
        if (isValidPositiveInt(n) && !seen.has(n)) {
          seen.add(n);
          ids.push(n);
        }
      }
      if (typeof json.total === 'number' && consumed >= json.total) break;
    }
    return ids.slice(0, limit).map((n) => `met:${n}`);
  },

  async getRaw(id: string): Promise<unknown> {
    const numeric = id.replace(/^met:/, '');
    const res = await httpGet(`${MET_API}/objects/${numeric}`);
    if (!res.ok) throw new Error(`Met get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return rejectFor('met', 'met:unknown', 'response not an object', raw);
    }
    const r = raw as Record<string, unknown>;
    const objectID = r.objectID;
    // Met IDs are always positive integers. Anything else flunks ID_REGEX
    // downstream; emit a placeholder so the rejection still carries a stable
    // (and obviously bogus) id for logs.
    const validId = isValidPositiveInt(objectID);
    const id = validId ? `met:${objectID}` : 'met:unknown';

    const decision = validateMetLicense(raw);
    if (!decision.accepted || !decision.license) {
      return rejectFor('met', id, decision.reason, raw);
    }

    if (!validId) {
      return rejectFor('met', id, 'met: missing or non-integer objectID', raw);
    }

    const displayDate = asString(r.objectDate);
    const dateRange = parseDisplayDate(displayDate);

    const artistRaw = sanitizeArtistName(asString(r.artistDisplayName));
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
      title: sanitizeTitle(asString(r.title)) || '(Untitled)',
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
      mediumCategory: normalizeMedium(asString(r.medium)),
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
      description: asOptionalString(sanitizeDescription(asString(r.objectName))),
      rawTags: Array.isArray(r.tags)
        ? (r.tags as Array<unknown>)
            .map((t) => (t && typeof t === 'object' ? (t as { term?: unknown }).term : undefined))
            .filter((s): s is string => typeof s === 'string')
        : undefined,
    };

    return { status: 'accepted', artwork };
  },
};
