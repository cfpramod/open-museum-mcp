import { parseDisplayDate } from '../dateParser.js';
import { validateEuropeanaLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { isNonArtEuropeana } from './curation.js';
import { asOptionalString, asString, httpGet } from './helpers.js';
import { sanitizeArtistName, sanitizeDescription, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

const EUROPEANA_API = 'https://api.europeana.eu/record/v2';
const EUROPEANA_PAGE = 'https://www.europeana.eu/en/item';

// Europeana item IDs are hierarchical: a numeric dataset prefix plus a
// per-item slug (`9200338/BibliographicResource_3000093834108`). We carry
// the full path as the suffix of the project's `museum:id` convention.
function reject(id: string, reason: string, rawSnapshot: unknown): ValidationResult {
  return {
    status: 'rejected',
    rejection: { id, museumCode: 'europeana', reason, rawSnapshot },
  };
}

// Europeana's API key is required and per-user; we read it lazily so the
// fetcher module loads cleanly even when the key isn't set (server.ts
// decides whether to register the fetcher based on key presence).
function apiKey(): string {
  return process.env.EUROPEANA_API_KEY ?? '';
}

// Strip the leading slash on Europeana IDs returned by the search API.
// Example: `/9200338/Bibliographic...` → `9200338/Bibliographic...`.
function normalizeEuropeanaId(raw: string): string {
  return raw.replace(/^\/+/, '');
}

// Europeana lang-aware fields look like `{ "def": ["..."], "en": ["..."] }`.
// Prefer English when available, fall back to first non-empty value.
function pickLangAware(obj: unknown, langPreference: string[] = ['en', 'def']): string {
  if (!obj || typeof obj !== 'object') return '';
  const map = obj as Record<string, unknown>;
  for (const lang of langPreference) {
    const arr = map[lang];
    if (Array.isArray(arr)) {
      const v = arr.find((x) => typeof x === 'string' && x.length > 0);
      if (typeof v === 'string') return v;
    }
  }
  // Last-ditch: first string value found in any language slot.
  for (const arr of Object.values(map)) {
    if (Array.isArray(arr)) {
      const v = arr.find((x) => typeof x === 'string' && x.length > 0);
      if (typeof v === 'string') return v;
    }
  }
  return '';
}

// Europeana flat array helpers — many fields are returned as arrays even when
// they carry exactly one value. Numeric values (e.g. `year: [1642]` instead
// of `["1642"]`) are stringified so downstream parsers see a consistent
// shape regardless of upstream serialization quirks.
function firstString(v: unknown): string {
  const arr = Array.isArray(v) ? v : [v];
  for (const x of arr) {
    if (typeof x === 'string' && x.length > 0) return x;
    if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  }
  return '';
}

function parseRecord(raw: Record<string, unknown>): {
  id: string;
  title: string;
  artist: string;
  displayDate: string;
  dataProvider: string;
  country: string;
  edmIsShownAt: string;
  edmIsShownBy: string;
  edmPreview: string;
  rights: unknown;
  description: string;
  medium: string;
} {
  const id = normalizeEuropeanaId(asString(raw.id));
  const title = sanitizeTitle(
    pickLangAware(raw.dcTitleLangAware) ||
    firstString(raw.title) ||
    firstString(raw.dcTitle),
  );
  const artist = sanitizeArtistName(
    pickLangAware(raw.dcCreatorLangAware) ||
    firstString(raw.dcCreator),
  );
  const displayDate =
    firstString(raw.year) ||
    firstString(raw.edmTimespanLabel) ||
    firstString(raw.dcDate);
  const dataProvider = firstString(raw.dataProvider);
  const country = firstString(raw.country);
  const edmIsShownAt = firstString(raw.edmIsShownAt);
  const edmIsShownBy = firstString(raw.edmIsShownBy);
  const edmPreview = firstString(raw.edmPreview);
  const description = sanitizeDescription(
    pickLangAware(raw.dcDescriptionLangAware) ||
    firstString(raw.dcDescription),
  );
  // Medium signal: EDM type/medium/format fields. dcFormat is sometimes a MIME
  // type ("image/jpeg") — harmless, as normalizeMedium keyword-gates the text.
  const medium = [
    pickLangAware(raw.dcTypeLangAware),
    firstString(raw.dcType),
    firstString(raw.dctermsMedium),
    firstString(raw.dcFormat),
  ]
    .filter((s) => s)
    .join(' ');
  return {
    id,
    title,
    artist,
    displayDate,
    dataProvider,
    country,
    edmIsShownAt,
    edmIsShownBy,
    edmPreview,
    rights: raw.rights,
    description,
    medium,
  };
}

export const europeanaFetcher: Fetcher = {
  code: 'europeana',
  name: 'Europeana',
  requiresApiKey: 'EUROPEANA_API_KEY',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const key = apiKey();
    if (!key) throw new Error('Europeana: EUROPEANA_API_KEY not set');
    const url = new URL(`${EUROPEANA_API}/search.json`);
    url.searchParams.set('wskey', key);
    url.searchParams.set('query', query);
    // `reusability=open` is Europeana's umbrella for CC0 / PDM / CC-BY /
    // CC-BY-SA. Our gate then drops the obligation-bearing licenses, so
    // the remaining set is strictly CC0 + PDM.
    url.searchParams.set('reusability', 'open');
    if (options.hasImage !== false) {
      // `qf=TYPE:IMAGE` keeps text/sound/video out of the candidate list.
      url.searchParams.append('qf', 'TYPE:IMAGE');
    }
    url.searchParams.set('rows', String(limit));
    // profile=standard returns the description fields (dcDescription /
    // dcDescriptionLangAware) and other EDM properties cite needs.
    // Bandwidth cost is small relative to the gate-rejection ratio.
    url.searchParams.set('profile', 'standard');

    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Europeana search failed: ${res.status}`);
    const json = (await res.json()) as { items?: Array<{ id?: unknown }> };
    const items = json.items ?? [];
    return items
      .map((it) => (typeof it.id === 'string' ? `europeana:${normalizeEuropeanaId(it.id)}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const key = apiKey();
    if (!key) throw new Error('Europeana: EUROPEANA_API_KEY not set');
    const path = id.replace(/^europeana:/, '');
    // Use the search-by-id form rather than the per-record endpoint so the
    // response shape matches the search hits we already know how to parse.
    // `query=europeana_id:"/<id>"` uniquely targets one record.
    const url = new URL(`${EUROPEANA_API}/search.json`);
    url.searchParams.set('wskey', key);
    url.searchParams.set('query', `europeana_id:"/${path}"`);
    url.searchParams.set('rows', '1');
    // profile=standard returns the description fields (dcDescription /
    // dcDescriptionLangAware) and other EDM properties cite needs.
    // Bandwidth cost is small relative to the gate-rejection ratio.
    url.searchParams.set('profile', 'standard');
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Europeana get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('europeana:unknown', 'europeana: response not an object', raw);
    }
    const wrap = raw as Record<string, unknown>;
    // The search response wraps the record in `items: [...]`. The fixture
    // shape and a direct record are both tolerated.
    const items = Array.isArray(wrap.items) ? wrap.items : null;
    const record =
      items && items.length > 0 && typeof items[0] === 'object' && items[0]
        ? (items[0] as Record<string, unknown>)
        : (wrap as Record<string, unknown>);

    const parsed = parseRecord(record);
    const id = parsed.id ? `europeana:${parsed.id}` : 'europeana:unknown';

    const decision = validateEuropeanaLicense(record);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }
    if (!parsed.id) {
      return reject(id, 'europeana: missing or non-string id', raw);
    }

    // Curation gate (rights already passed): Europeana federates many archives,
    // so a non-art TYPE (Text, Sound, Map, specimen, ...) can slip through
    // TYPE:IMAGE. Reject on the explicit type/medium signal only — never on the
    // title, so genuine art photographs are not mis-rejected. (Documentary-photo
    // keyword-noise is a ranking concern, not a non-art gate; see curation.ts.)
    const nonArt = isNonArtEuropeana({ medium: parsed.medium, title: parsed.title });
    if (nonArt) {
      return reject(id, `europeana: non-art type "${nonArt}" (curation reject)`, raw);
    }

    const dateRange = parseDisplayDate(parsed.displayDate);
    const attributionType = detectAttributionType(parsed.artist);
    const cleanName = cleanArtistName(parsed.artist);
    const region = normalizeRegion(parsed.country);

    const fullImage = parsed.edmIsShownBy || parsed.edmPreview;
    const thumbnail = asOptionalString(parsed.edmPreview);

    const artwork: Artwork = {
      id,
      museum: {
        code: 'europeana',
        name: parsed.dataProvider || 'Europeana',
        url: 'https://www.europeana.eu',
      },
      title: (parsed.title || '(Untitled)').trim(),
      artist: {
        name: cleanName || 'Unknown',
        nationality: undefined,
        lifespan: undefined,
        attributionType,
      },
      displayDate: parsed.displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium: '',
      mediumCategory: normalizeMedium(parsed.medium),
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
        // The page URL is the canonical viewer; the API URL points back to
        // the search-by-id form so a re-fetch reproduces this record.
        apiUrl: `${EUROPEANA_API}/search.json?query=europeana_id:%22/${parsed.id}%22`,
        pageUrl: `${EUROPEANA_PAGE}/${parsed.id}`,
        originalUrl: parsed.edmIsShownAt || undefined,
      },
      description: asOptionalString(parsed.description),
    };

    return { status: 'accepted', artwork };
  },
};
