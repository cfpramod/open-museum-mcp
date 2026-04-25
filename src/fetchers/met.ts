import { parseDisplayDate } from '../dateParser.js';
import { validateMetLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import type { Artwork, ValidationResult } from '../types.js';
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
    const id = typeof objectID === 'number' ? `met:${objectID}` : 'met:unknown';

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

    const displayDate = (r.objectDate as string) || '';
    const dateRange = parseDisplayDate(displayDate);

    const artistRaw = (r.artistDisplayName as string) || '';
    const attributionType = detectAttributionType(artistRaw);
    const cleanName = cleanArtistName(artistRaw);

    const cultureOrCountry =
      (r.culture as string) || (r.country as string) || (r.classification as string) || '';
    const region = normalizeRegion(cultureOrCountry);

    const periodRaw = ((r.period as string) || (r.dynasty as string) || '').toLowerCase().trim();
    const period = periodRaw.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;

    const fullImage =
      (r.primaryImage as string) || (r.primaryImageSmall as string) || '';
    const thumbnail = (r.primaryImageSmall as string) || undefined;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'met',
        name: 'The Metropolitan Museum of Art',
        url: 'https://www.metmuseum.org',
      },
      title: ((r.title as string) || '(Untitled)').trim(),
      artist: {
        name: cleanName || 'Unknown',
        nationality: (r.artistNationality as string) || undefined,
        lifespan:
          r.artistBeginDate || r.artistEndDate
            ? `${r.artistBeginDate ?? ''}–${r.artistEndDate ?? ''}`.replace(/^–|–$/g, '')
            : undefined,
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: (r.medium as string) || '',
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
        pageUrl: (r.objectURL as string) || `https://www.metmuseum.org/art/collection/search/${objectID}`,
      },
      description: (r.objectName as string) || undefined,
      rawTags: Array.isArray(r.tags)
        ? (r.tags as Array<{ term?: string }>)
            .map((t) => t?.term)
            .filter((s): s is string => typeof s === 'string')
        : undefined,
    };

    return { status: 'accepted', artwork };
  },
};
