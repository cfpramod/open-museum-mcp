import { parseDisplayDate } from '../dateParser.js';
import { validateWikimediaLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asString, httpGet, isValidPositiveInt, rejectFor } from './helpers.js';
import { ARTIST_NAME_MAX, DESCRIPTION_MAX, TITLE_MAX } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_PAGE = 'https://commons.wikimedia.org/wiki';

// Filename extensions we accept as "image" files. Commons hosts 3D models,
// videos, audio and other media too; v0.3 surfaces only static images so the
// `imageUrls.full` contract holds.
const IMAGE_MIME_PREFIX = 'image/';

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('wikimedia', id, reason, rawSnapshot);

// extmetadata fields are wrapped: `{value, source, hidden?}`. Pull the value
// only, default to empty string if absent or non-string.
function getExtField(ext: Record<string, unknown> | undefined, field: string): string {
  if (!ext) return '';
  const wrap = ext[field];
  if (!wrap || typeof wrap !== 'object') return '';
  return asString((wrap as { value?: unknown }).value);
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

// Wikidata Quick Statements markers that Commons concatenates into
// ObjectName / ImageDescription for structured-data fields. These never
// belong in user-facing text. Examples seen on real records:
//   "Landscape with the Fall of Icarus title QS:P1476,en:..."
//   "Water Liliestitle QS:P1476,de:..."  (no leading space)
//   "Water-Lily Pond and Weeping Willow label QS:Lfr,..."
// Strip everything from the first `(title|label) QS:` marker onward.
const QS_TRAILING_RE = /\s*(?:title|label)\s*QS:.*$/s;

function stripQsMetadata(s: string): string {
  return s.replace(QS_TRAILING_RE, '').trim();
}

// Commons surfaces multilingual ObjectName as `<Language>: <native form>`,
// often concatenated with an English transliteration:
//   "German: Seerosen Water Lilies"
//   "Japanese: 『神奈川沖浪裏』 - Kanagawa oki nami ura"
// Strip the leading language prefix. Conservative known-language list — we
// don't strip an arbitrary capitalised word followed by ":" because real
// titles like "Lions: An Allegory" exist.
const LANGUAGE_PREFIX_RE =
  /^(?:English|French|German|Spanish|Italian|Japanese|Chinese|Russian|Dutch|Latin|Portuguese|Polish|Greek|Arabic|Hebrew|Korean|Hindi|Persian|Turkish|Swedish|Norwegian|Danish|Finnish|Czech|Hungarian|Sanskrit|Tamil|Bengali):\s+/i;

function stripLanguagePrefix(s: string): string {
  return s.replace(LANGUAGE_PREFIX_RE, '').trim();
}

// Commons file-numbering convention: uploaders suffix filenames with " 02",
// " 03", " 010" etc. when posting multiple files of the same subject. The
// suffix is file-management metadata, not part of the artwork title. Strict
// pattern: zero-padded 2–3 digit trailing number (matches " 02", " 099"
// but not " 5" or " 12" — those are far less likely to be file numbers).
const FILE_NUMBER_SUFFIX_RE = /\s+0\d{1,2}$/;

function stripFileNumberSuffix(s: string): string {
  return s.replace(FILE_NUMBER_SUFFIX_RE, '').trim();
}

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

// Commons `Credit` extmetadata is the upstream-source field. It is often a
// snippet of HTML wrapping a link back to the originating museum or archive
// (e.g. `<a href="https://www.thyssen.org/...">Museo Thyssen-Bornemisza</a>`).
// Pull the first http(s) href out as the canonical originalUrl. Plain-text
// Credit values (no link) yield undefined — we don't synthesise URLs.
const CREDIT_HREF_RE = /href\s*=\s*"(https?:\/\/[^"]+)"/i;

function extractCreditUrl(credit: string): string | undefined {
  if (!credit) return undefined;
  const m = credit.match(CREDIT_HREF_RE);
  return m ? m[1] : undefined;
}

// Format a parsed year range as a human-readable display string. Single-year
// ranges collapse to "1889"; spans render as "1526–1569"; null becomes "".
function formatYearRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return '';
  if (start === end) return String(start);
  if (start !== null && end !== null) return `${start}–${end}`;
  return String(start ?? end);
}

interface CategoryEntry {
  title?: unknown;
}

// Extract clean category titles (string `title`, "Category:" prefix stripped)
// from a raw Commons categories array. Shared by the date-range and medium
// derivations so the iterate/guard/strip logic lives in one place.
function categoryTitles(categories: unknown[]): string[] {
  const titles: string[] = [];
  for (const entry of categories) {
    if (!entry || typeof entry !== 'object') continue;
    const title = (entry as CategoryEntry).title;
    if (typeof title !== 'string') continue;
    titles.push(title.replace(/^Category:/, ''));
  }
  return titles;
}

// Pick the most specific (narrowest) parseable year range from a list of
// Commons category titles. Categories like "1916 paintings" yield a single
// year (span 0); "1910s paintings" yield a decade (span 9); "16th-century
// paintings" yield a century (span 99). When multiple categories carry
// dates, the narrowest wins because it's the most informative signal.
//
// CRITICAL: only parse categories that explicitly name an art medium.
// Wikimedia categories carry many year-bearing labels unrelated to artwork
// creation: "GLAMhybrid Museum Barberini 2023" (exhibition), "October 2010
// in Munich" (photo upload), "Wildenstein 1884" (catalogue entry number).
// The art-medium keyword filter restricts parsing to categories that are
// clearly about works of art: "paintings", "drawings", "prints", etc.
const ART_MEDIUM_RE =
  /\b(paintings?|drawings?|prints?|engravings?|etchings?|woodcuts?|sculptures?|manuscripts?|illuminations?|photographs?|frescos?|frescoes|miniatures?|tapestries|tapestry|works|art|ukiyo-e|century)\b/i;

function pickBestRangeFromCategories(categories: unknown[]): {
  yearStart: number | null;
  yearEnd: number | null;
} | null {
  let best: { yearStart: number; yearEnd: number } | null = null;
  let bestSpan = Infinity;
  for (const cleaned of categoryTitles(categories)) {
    if (!ART_MEDIUM_RE.test(cleaned)) continue;
    const parsed = parseDisplayDate(cleaned);
    if (parsed.yearStart === null || parsed.yearEnd === null) continue;
    const span = parsed.yearEnd - parsed.yearStart;
    if (span < bestSpan) {
      best = { yearStart: parsed.yearStart, yearEnd: parsed.yearEnd };
      bestSpan = span;
    }
  }
  return best;
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

    const res = await httpGet(url);
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
    // Fetch imageinfo + categories. Categories provide a curatorial
    // year-signal for records whose description and title don't carry
    // creation dates ("1910s paintings by Claude Monet" etc).
    url.searchParams.set('prop', 'imageinfo|categories');
    url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
    url.searchParams.set(
      'iiextmetadatafilter',
      'License|LicenseShortName|LicenseUrl|UsageTerms|Artist|ObjectName|DateTime|Credit|ImageDescription',
    );
    url.searchParams.set('clshow', '!hidden');
    url.searchParams.set('cllimit', '30');
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');

    const res = await httpGet(url);
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
    const validId = isValidPositiveInt(pageId);
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

    const objectName = stripQsMetadata(stripHtml(getExtField(ext, 'ObjectName')));
    const fileTitle = asString(page.title)
      .replace(/^File:/, '')
      .replace(/\.[^.]+$/, '');
    // Polish: drop multilingual `<Lang>:` prefix and Commons file-numbering
    // suffix (" 02"). Apply to both ObjectName and fileTitle paths since
    // either can carry the conventions in the wild.
    const cleanObjectName = stripFileNumberSuffix(stripLanguagePrefix(objectName));
    const cleanFileTitle = stripFileNumberSuffix(fileTitle);
    const rawTitle = (cleanObjectName || cleanFileTitle).trim();
    const title = (rawTitle || '(Untitled)').slice(0, TITLE_MAX);

    const artistRaw = stripHtml(getExtField(ext, 'Artist')).slice(0, ARTIST_NAME_MAX);
    const attributionType = detectAttributionType(artistRaw);
    const cleanName = cleanArtistName(artistRaw);

    const description = stripQsMetadata(stripHtml(getExtField(ext, 'ImageDescription'))).slice(0, DESCRIPTION_MAX);
    // Commons has no structured creation-date field. DateTime extmetadata is
    // upload time, not artwork time. Source order, most-trustworthy first:
    //   1. ImageDescription prose ("c. 1560s." → {1560, 1569})
    //   2. ObjectName ("Water Lilies (1916)" → {1916, 1916})
    //   3. Art-medium-tagged categories ("1910s paintings by Claude Monet")
    //
    // fileTitle is deliberately NOT a date source: filenames frequently
    // encode inventory numbers ("BM 1906.1220.0.533") that look like years
    // but mark museum acquisition events, not creation dates. The Artist
    // field is excluded for the same reason — its years are the artist's
    // lifespan, which is wider than (and not equal to) the artwork date.
    const fromDesc = parseDisplayDate(description);
    let dateRange: { yearStart: number | null; yearEnd: number | null } = fromDesc;
    if (dateRange.yearStart === null && dateRange.yearEnd === null) {
      const fromObject = parseDisplayDate(cleanObjectName);
      if (fromObject.yearStart !== null || fromObject.yearEnd !== null) {
        dateRange = fromObject;
      }
    }
    if (dateRange.yearStart === null && dateRange.yearEnd === null) {
      const cats = Array.isArray(page.categories) ? page.categories : [];
      const fromCats = pickBestRangeFromCategories(cats);
      if (fromCats) dateRange = fromCats;
    }

    const fullImage = asString(info.url);
    const pageUrl = asString(info.descriptionurl) || `${COMMONS_PAGE}/?curid=${pageId}`;
    const width = asFiniteNumber(info.width) ?? undefined;
    const height = asFiniteNumber(info.height) ?? undefined;
    const byteSize = asFiniteNumber(info.size) ?? undefined;
    // Credit field is HTML; pull out the first http(s) href as the upstream
    // pointer. Important: don't strip HTML before extracting — stripHtml
    // would discard the `<a href>` we need.
    const creditRaw = getExtField(ext, 'Credit');
    const originalUrl = extractCreditUrl(creditRaw);

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
      // Commons has no reliable structured medium field. The curated art-medium
      // categories ("16th-century oil paintings") are the only trustworthy
      // signal — the artwork title is deliberately excluded (a work titled "The
      // Sculptor" is not a sculpture). normalizeMedium keyword-gates the joined
      // category titles, so non-medium categories simply don't match.
      mediumCategory: normalizeMedium(
        categoryTitles(Array.isArray(page.categories) ? page.categories : []).join(' '),
      ),
      // Region and period are not in Commons' structured metadata. Wikidata
      // enrichment (planned for v0.7) will fill these via SPARQL on the
      // file's depicted-work QID.
      region: null,
      period: null,
      imageUrls: {
        full: fullImage,
        thumbnail: undefined,
        width,
        height,
        byteSize,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${COMMONS_API}?action=query&pageids=${pageId}&prop=imageinfo&format=json`,
        pageUrl,
        originalUrl,
      },
      description: description || undefined,
    };

    return { status: 'accepted', artwork };
  },
};
