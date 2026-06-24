import { parseDisplayDate } from '../dateParser.js';
import { fetchInfoJson, fullImageUrl } from '../iiif/client.js';
import { validateWellcomeLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asString, httpGet, pickMaxResolution, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// Wellcome Collection — keyless Catalogue API (api.wellcomecollection.org) over a
// large open-access corpus. Wellcome is a medical-history LIBRARY: its records are
// dominated by Books and Archives, so two filters isolate the art: `workType=k`
// (Pictures — its visual-art umbrella) and an `iiif-image` location licensed CC0 or
// Public Domain Mark. Rights are per-location and judged by validateWellcomeLicense;
// images come through the shared IIIF client (dims from info.json).
const WELLCOME_API = 'https://api.wellcomecollection.org/catalogue/v2/works';
const WELLCOME_SITE = 'https://wellcomecollection.org/works';
// Wellcome's "Pictures" format id — its umbrella for visual works (paintings,
// drawings, prints, engravings, photographs). The art subset of an otherwise
// library-heavy catalogue.
const WORKTYPE_PICTURES = 'k';
// workType LABELS accepted by the curation re-check in normalize (defense in depth
// for a direct get_artwork that bypasses the server-side workType filter).
const ART_WORKTYPES = new Set(['pictures', 'paintings', 'drawings', 'prints', 'photographs']);
const WELLCOME_INCLUDES = 'items,production,contributors';

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('wellcome', id, reason, rawSnapshot);

interface ResolvedImage {
  fullUrl: string;
  width?: number;
  height?: number;
}

/** The `iiif-image` location's info.json URL, or '' when absent. */
function iiifImageInfoUrl(work: Record<string, unknown>): string {
  const items = Array.isArray(work.items) ? work.items : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const locations = Array.isArray((it as Record<string, unknown>).locations)
      ? ((it as Record<string, unknown>).locations as unknown[])
      : [];
    for (const loc of locations) {
      if (!loc || typeof loc !== 'object') continue;
      const l = loc as Record<string, unknown>;
      const type = l.locationType && typeof l.locationType === 'object'
        ? (l.locationType as Record<string, unknown>).id
        : undefined;
      if (type === 'iiif-image') return asString(l.url);
    }
  }
  return '';
}

function firstContributor(work: Record<string, unknown>): string {
  const contributors = Array.isArray(work.contributors) ? work.contributors : [];
  for (const c of contributors) {
    if (!c || typeof c !== 'object') continue;
    const agent = (c as Record<string, unknown>).agent;
    const label = agent && typeof agent === 'object' ? asString((agent as Record<string, unknown>).label) : '';
    if (label) return label;
  }
  return '';
}

/** First production date label (e.g. "1931", "31 March 1931"). */
function productionDate(work: Record<string, unknown>): string {
  const production = Array.isArray(work.production) ? work.production : [];
  for (const p of production) {
    if (!p || typeof p !== 'object') continue;
    const dates = Array.isArray((p as Record<string, unknown>).dates) ? ((p as Record<string, unknown>).dates as unknown[]) : [];
    for (const d of dates) {
      if (d && typeof d === 'object') {
        const label = asString((d as Record<string, unknown>).label);
        if (label) return label;
      }
    }
  }
  return '';
}

function workTypeLabel(work: Record<string, unknown>): string {
  const wt = work.workType;
  return wt && typeof wt === 'object' ? asString((wt as Record<string, unknown>).label) : '';
}

export const wellcomeFetcher: Fetcher = {
  code: 'wellcome',
  name: 'Wellcome Collection',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(WELLCOME_API);
    url.searchParams.set('query', query);
    // Server-side curation + rights pre-filter: Pictures only, image licensed
    // CC0/PDM. normalize re-validates both (defense in depth).
    url.searchParams.set('workType', WORKTYPE_PICTURES);
    if (options.hasImage !== false) url.searchParams.set('items.locations.license', 'cc0,pdm');
    url.searchParams.set('pageSize', String(Math.min(limit, 100)));

    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Wellcome search failed: ${res.status}`);
    const json = (await res.json()) as { results?: Array<{ id?: unknown }> };
    return (json.results ?? [])
      .map((w) => (typeof w.id === 'string' && w.id.length > 0 ? `wellcome:${w.id}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const workId = id.replace(/^wellcome:/, '');
    const url = new URL(`${WELLCOME_API}/${encodeURIComponent(workId)}`);
    url.searchParams.set('include', WELLCOME_INCLUDES);
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Wellcome get failed for ${id}: ${res.status}`);
    const work = (await res.json()) as Record<string, unknown>;

    // Resolve the IIIF image: strip `/info.json` to the service base, fetch dims,
    // and build the full-resolution request via the shared IIIF client.
    let image: ResolvedImage | undefined;
    const infoUrl = iiifImageInfoUrl(work);
    if (infoUrl) {
      const serviceBase = infoUrl.replace(/\/info\.json$/, '');
      try {
        const info = await fetchInfoJson(serviceBase);
        image = { fullUrl: fullImageUrl(serviceBase, info.apiVersion), width: info.width, height: info.height };
      } catch {
        // info.json unavailable — still surface a v2 full request (dims unknown).
        image = { fullUrl: fullImageUrl(serviceBase, 2) };
      }
    }
    return { work, image };
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object' || !('work' in (raw as object))) {
      return reject('wellcome:unknown', 'wellcome: bundle missing the work', raw);
    }
    const bundle = raw as { work?: unknown; image?: unknown };
    if (!bundle.work || typeof bundle.work !== 'object') {
      return reject('wellcome:unknown', 'wellcome: work not an object', raw);
    }
    const work = bundle.work as Record<string, unknown>;
    const workId = asString(work.id);
    const id = workId ? `wellcome:${workId}` : 'wellcome:unknown';

    // Rights gate (the iiif-image location's CC0/PDM licence).
    const decision = validateWellcomeLicense(work);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }
    if (!workId) {
      return reject(id, 'wellcome: missing work id', raw);
    }

    // Curation: Wellcome is a library — keep only visual-art workTypes (the
    // server-side `workType=k` filter already does this for search; this re-check
    // covers a direct get_artwork).
    const wtLabel = workTypeLabel(work);
    if (!ART_WORKTYPES.has(wtLabel.toLowerCase())) {
      return reject(id, `wellcome: non-art workType=${wtLabel || 'none'} (curation reject)`, raw);
    }

    const image = bundle.image && typeof bundle.image === 'object' ? (bundle.image as ResolvedImage) : undefined;
    if (!image || !image.fullUrl) {
      return reject(id, 'wellcome: no IIIF image resolved', raw);
    }

    const displayDate = productionDate(work);
    const dateRange = parseDisplayDate(displayDate);

    const contributor = sanitizeArtistName(firstContributor(work));
    const attributionType = detectAttributionType(contributor);
    const cleanName = cleanArtistName(contributor);

    const width = typeof image.width === 'number' ? image.width : undefined;
    const height = typeof image.height === 'number' ? image.height : undefined;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'wellcome',
        name: 'Wellcome Collection',
        url: 'https://wellcomecollection.org',
      },
      title: sanitizeTitle(asString(work.title)) || '(Untitled)',
      artist: {
        name: cleanName || 'Unknown',
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: '',
      mediumCategory: normalizeMedium(wtLabel),
      region: null,
      period: null,
      imageUrls: {
        full: image.fullUrl,
        thumbnail: undefined,
        width,
        height,
        maxResolution: pickMaxResolution({ width, height }),
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${WELLCOME_API}/${workId}`,
        pageUrl: `${WELLCOME_SITE}/${workId}`,
      },
      description: undefined,
    };

    return { status: 'accepted', artwork };
  },
};
