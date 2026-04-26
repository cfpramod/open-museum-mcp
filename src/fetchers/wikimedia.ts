import { parseDisplayDate } from '../dateParser.js';
import { validateWikimediaLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asString } from './helpers.js';
import type { Fetcher, SearchOptions } from './types.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_PAGE = 'https://commons.wikimedia.org/wiki';

// Filename extensions we accept as "image" files. Commons hosts 3D models,
// videos, audio and other media too; v0.3 surfaces only static images so the
// `imageUrls.full` contract holds.
const IMAGE_MIME_PREFIX = 'image/';

function reject(id: string, reason: string, rawSnapshot: unknown): ValidationResult {
  return {
    status: 'rejected',
    rejection: { id, museumCode: 'wikimedia', reason, rawSnapshot },
  };
}

// extmetadata fields are wrapped: `{value, source, hidden?}`. Pull the value
// only, default to empty string if absent or non-string.
function getExtField(ext: Record<string, unknown> | undefined, field: string): string {
  if (!ext) return '';
  const wrap = ext[field];
  if (!wrap || typeof wrap !== 'object') return '';
  const v = (wrap as { value?: unknown }).value;
  return typeof v === 'string' ? v : '';
}

// Common HTML entities seen in Commons text fields. Numeric escapes
// (`&#39;`, `&#x2014;`) are handled by separate regex passes below.
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

// Commons text fields are HTML-laden. Strip tags, decode entities, collapse
// whitespace. Order matters: strip tags first so entity decoding doesn't
// reintroduce angle brackets that we then have to re-strip.
function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// Format a parsed year range as a human-readable display string. Single-year
// ranges collapse to "1889"; spans render as "1526–1569"; null becomes "".
function formatYearRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return '';
  if (start === end) return String(start);
  if (start !== null && end !== null) return `${start}–${end}`;
  return String(start ?? end);
}

// Parse the inner page object out of a MediaWiki API query response.
// formatversion=2 returns pages as an array; formatversion=1 keys by pageid.
// Tolerate both shapes plus a direct page object (test fixture convenience).
function unwrapPage(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const query = raw.query;
  if (query && typeof query === 'object') {
    const pages = (query as Record<string, unknown>).pages;
    if (Array.isArray(pages) && pages.length > 0 && typeof pages[0] === 'object' && pages[0]) {
      return pages[0] as Record<string, unknown>;
    }
    if (pages && typeof pages === 'object' && !Array.isArray(pages)) {
      const keys = Object.keys(pages);
      if (keys.length > 0) {
        const first = (pages as Record<string, unknown>)[keys[0]];
        if (first && typeof first === 'object') return first as Record<string, unknown>;
      }
    }
  }
  // Direct page object passthrough.
  if (typeof raw.pageid !== 'undefined') return raw;
  return undefined;
}

export const wikimediaFetcher: Fetcher = {
  code: 'wikimedia',
  name: 'Wikimedia Commons',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(COMMONS_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srnamespace', '6'); // File namespace
    url.searchParams.set('srlimit', String(limit));
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wikimedia search failed: ${res.status}`);
    const json = (await res.json()) as { query?: { search?: Array<{ pageid?: unknown }> } };
    const results = json.query?.search ?? [];
    return results
      .map((r) => (typeof r.pageid === 'number' ? `wikimedia:${r.pageid}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const numeric = id.replace(/^wikimedia:/, '');
    const url = new URL(COMMONS_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('pageids', numeric);
    url.searchParams.set('prop', 'imageinfo');
    url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
    url.searchParams.set(
      'iiextmetadatafilter',
      'License|LicenseShortName|LicenseUrl|UsageTerms|Artist|ObjectName|DateTime|Credit|ImageDescription',
    );
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Wikimedia get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('wikimedia:unknown', 'wikimedia: response not an object', raw);
    }
    const page = unwrapPage(raw as Record<string, unknown>);
    if (!page) {
      return reject('wikimedia:unknown', 'wikimedia: page not found in response', raw);
    }

    const pageId = page.pageid;
    const validId = typeof pageId === 'number' && Number.isInteger(pageId) && pageId > 0;
    const id = validId ? `wikimedia:${pageId}` : 'wikimedia:unknown';

    const imageinfo = Array.isArray(page.imageinfo) ? page.imageinfo : [];
    const info =
      imageinfo[0] && typeof imageinfo[0] === 'object'
        ? (imageinfo[0] as Record<string, unknown>)
        : undefined;
    if (!info) {
      return reject(id, 'wikimedia: imageinfo missing — file deleted, missing, or non-image', raw);
    }

    const decision = validateWikimediaLicense(info);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    if (!validId) {
      return reject(id, 'wikimedia: missing or non-integer pageid', raw);
    }

    // Strict default: require a present, image-typed MIME field. A missing
    // MIME is rejected on the same grounds as a non-image one — without a
    // declared type we can't honestly promise `imageUrls.full` is an image.
    const mime = asString(info.mime);
    if (!mime || !mime.startsWith(IMAGE_MIME_PREFIX)) {
      return reject(id, `wikimedia: non-image or missing mime type (${mime || 'missing'})`, raw);
    }

    const ext =
      info.extmetadata && typeof info.extmetadata === 'object'
        ? (info.extmetadata as Record<string, unknown>)
        : undefined;

    const objectName = stripHtml(getExtField(ext, 'ObjectName'));
    const fileTitle = asString(page.title)
      .replace(/^File:/, '')
      .replace(/\.[^.]+$/, '');
    const title = (objectName || fileTitle).trim() || '(Untitled)';

    const artistRaw = stripHtml(getExtField(ext, 'Artist'));
    const attributionType = detectAttributionType(artistRaw);
    const cleanName = cleanArtistName(artistRaw);

    const description = stripHtml(getExtField(ext, 'ImageDescription'));
    // Commons does not surface a structured creation-date field. The DateTime
    // extmetadata is the upload timestamp, not the artwork's date. Parse the
    // ImageDescription only — the Artist field often carries the artist's
    // lifespan ("(1526–1569)"), which is NOT the artwork's date and would
    // mislead readers if surfaced as `yearStart`/`yearEnd`.
    const dateRange = parseDisplayDate(description);

    const fullImage = asString(info.url);
    const pageUrl = asString(info.descriptionurl) || `${COMMONS_PAGE}/?curid=${pageId}`;

    const artwork: Artwork = {
      id,
      museum: {
        code: 'wikimedia',
        name: 'Wikimedia Commons',
        url: 'https://commons.wikimedia.org',
      },
      title,
      artist: {
        name: cleanName || 'Unknown',
        nationality: undefined,
        lifespan: undefined,
        attributionType,
      },
      // displayDate carries the artwork's date string. Commons records don't
      // have a structured date field, so we render the parsed year range
      // back to a string ("1560–1569"). Empty when no date was parseable —
      // honest about absence rather than dumping the description prose.
      displayDate: formatYearRange(dateRange.yearStart, dateRange.yearEnd),
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: '',
      // Region and period are not in Commons' structured metadata. Wikidata
      // enrichment (planned for v0.7) will fill these via SPARQL on the
      // file's depicted-work QID.
      region: null,
      period: null,
      imageUrls: {
        full: fullImage,
        thumbnail: undefined,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${COMMONS_API}?action=query&pageids=${pageId}&prop=imageinfo&format=json`,
        pageUrl,
      },
      description: description || undefined,
    };

    return { status: 'accepted', artwork };
  },
};
