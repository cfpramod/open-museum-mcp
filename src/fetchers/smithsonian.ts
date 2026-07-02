import { parseDisplayDate } from '../dateParser.js';
import { validateSmithsonianLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ArtworkMaster, ValidationResult } from '../types.js';
import {
  asFiniteNumber,
  asOptionalString,
  asString,
  httpGet,
  pickMaxResolution,
  rejectFor,
} from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// Smithsonian Open Access (EDAN) API. ~3–4M CC0 objects across the
// Institution's units (SAAM, NMAH, NPG, CHNDM, NMAI, …). Search returns full
// records; we extract the stable `id` and re-fetch each via /content/{id} so
// the federation's single per-id cache + rights-gate path is reused unchanged.
const SI_API = 'https://api.si.edu/openaccess/api/v1.0';
const SI_SITE = 'https://www.si.edu';

// EDAN's `rows` is capped at 1000 per request; we never request near that.
const SI_MAX_ROWS = 1000;

// Maker labels in `content.freetext.name[]` that denote the CREATOR of the
// work. EDAN also carries non-maker name labels (notably "Sitter" on portraits,
// plus "Subject", "Donor", "Owner") which must NOT be surfaced as the artist.
const MAKER_LABELS = new Set(['artist', 'maker', 'author', 'creator', 'manufacturer', 'designer']);

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('smithsonian', id, reason, rawSnapshot);

// Smithsonian Open Access spans ALL units — including Libraries (bibliographic
// "Books" records) and Natural History (specimens) — not just art museums. An
// `online_media_type:"Images"` search still surfaces book covers and specimen
// photos. Curation runs in TWO complementary passes (a record is art if EITHER
// fires):
//
// 1. UNIT pass — the record's `unitCode` names a dedicated art/design museum.
//    Everything those units image is art by definition, so this recovers forms
//    the keyword list can't (an FSG handscroll, an NMAfA reliquary). It is the
//    bigger non-Western win: the Asian-Art (NMAA/FSG), African-Art (NMAfA),
//    American-Art (SAAM), Portrait (NPG), Hirshhorn (HMSG) and Cooper Hewitt
//    (CHNDM) units carry the Islamic/Indian/Chinese/African/Korean depth.
//    Deliberately EXCLUDES the natural-history specimen depts (NMNHENTO beetles,
//    NMNHMINSCI minerals, NMNHBOTANY/PALEO) and the mixed-history units (NMAH,
//    NMAAHC) and anthropology (NMNHANTHRO, NMAI) — those fall to pass 2 so a
//    trophy / machine / ecofact / human-remains record is NOT swept in on unit
//    alone.
//
// 2. OBJECT-TYPE pass — `indexedStructured.object_type` (controlled vocabulary)
//    names an art form on the allowlist. This is how the mixed-history and
//    anthropology units contribute (a netsuke / mask / celadon bowl from
//    NMNHANTHRO) without admitting the non-art around it. Matched as a substring
//    of the lowercased value, so "Decorative Arts-Jewelry" and "Bowls (vessels)"
//    both hit. A record with no recognized art object_type AND a non-art unit is
//    rejected (precision over recall — better to drop an edge object than admit a
//    book or a beetle).

// Dedicated art/design museum unit codes — pass 1. (FSG = legacy Freer–Sackler
// code; NMAA = its current "National Museum of Asian Art" code. Both kept so
// older and newer records resolve.)
const ART_UNIT_CODES = new Set(['NMAA', 'FSG', 'NMAfA', 'SAAM', 'NPG', 'HMSG', 'CHNDM']);

const ART_OBJECT_TYPE_KEYWORDS = [
  // Western fine + decorative art (original list).
  'painting',
  'drawing',
  'print',
  'sculpture',
  'photograph',
  'decorative art',
  'textile',
  'ceramic',
  'jewel',
  'costume',
  'furniture',
  'glass',
  'watercolor',
  'etching',
  'engraving',
  'lithograph',
  'poster',
  'miniature',
  'medal',
  'collage',
  'mosaic',
  'tapestry',
  'enamel',
  'metalwork',
  'works on paper',
  'work on paper',
  // Non-Western art forms that EDAN records as the object's FORM, not a Western
  // classification — these were the bulk of the dropped non-Western art (netsuke,
  // masks, celadon vessels, Japanese lacquerware, Islamic/Mughal manuscripts).
  'mask',
  'netsuke',
  'carving',
  'manuscript',
  'koran',
  'quran',
  'calligraphy',
  'scroll',
  'woodblock',
  'woodcut',
  'inro',
  'okimono',
  'kimono',
  'robe',
  'lacquer',
  'amulet',
  'pendant',
  'figurine',
  'statuette',
  'relief',
  'censer',
  'incense',
  'carpet',
  'embroidery',
  // Decorative-arts vessel/container forms (ceramics, metalwork, lacquer) whose
  // object_type is the form, not the material — Korean celadon, Chinese bronze,
  // Japanese tea wares. (Collision-prone short forms — bowl/urn/rug/icon/screen —
  // live in ART_OBJECT_TYPE_PATTERNS instead, word-anchored.)
  'vessel',
  'vase',
  'jar',
  'bottle',
  'ewer',
  'flask',
  'dish',
  'plate',
  'cup',
  'teapot',
  'basket',
];

// Word-anchored art forms. These collide badly as bare substrings — `box` is
// inside "boxing gloves", `rug` inside "Drugs"/"crude drug" (NMAH materia
// medica), `bowl` inside "Bowling", `urn` inside "Return", `icon` inside
// "Silicon", `screen` inside "Touchscreen", `fan` inside "infant" — so they're
// matched on WORD BOUNDARIES instead. Recovers Japanese lacquer boxes, hand fans,
// Korean celadon bowls, funerary urns, religious icons, folding screens and rugs
// without admitting NMAH sports/electronics/pharmaceutical objects. Patterns are
// anchored + linear (no backtracking) and run only over short controlled-vocab
// values.
const ART_OBJECT_TYPE_PATTERNS = [
  /\bbox(es)?\b/i,
  /\bfan(s)?\b/i,
  /\brug(s)?\b/i,
  /\bbowl(s)?\b/i,
  /\burn(s)?\b/i,
  /\bicon(s)?\b/i,
  /\bscreen(s)?\b/i,
];

/** True when the record's unit is a dedicated art/design museum (curation pass 1). */
function isArtUnit(unitCode: string): boolean {
  return ART_UNIT_CODES.has(unitCode);
}

/** True when any object_type value names an art form on the allowlist (curation pass 2). */
function isArtObjectType(objectTypes: string[]): boolean {
  for (const t of objectTypes) {
    const lower = t.toLowerCase();
    if (ART_OBJECT_TYPE_KEYWORDS.some((k) => lower.includes(k))) return true;
    if (ART_OBJECT_TYPE_PATTERNS.some((re) => re.test(t))) return true;
  }
  return false;
}

/** Collect object_type signals from indexedStructured (primary) + freetext (fallback). */
function objectTypeSignals(content: Record<string, unknown>): string[] {
  const out: string[] = [];
  const indexed = content.indexedStructured;
  if (indexed && typeof indexed === 'object') {
    const ot = (indexed as Record<string, unknown>).object_type;
    if (Array.isArray(ot)) for (const v of ot) if (typeof v === 'string') out.push(v);
  }
  for (const e of freetextEntries(content, 'objectType')) {
    if (typeof e.content === 'string') out.push(e.content);
  }
  return out;
}

interface FreetextEntry {
  label?: unknown;
  content?: unknown;
}

/** Read `content.freetext.<key>` as an array of {label, content} entries. */
function freetextEntries(content: Record<string, unknown>, key: string): FreetextEntry[] {
  const freetext = content.freetext;
  if (!freetext || typeof freetext !== 'object') return [];
  const arr = (freetext as Record<string, unknown>)[key];
  return Array.isArray(arr) ? (arr as FreetextEntry[]) : [];
}

/** Content of the first freetext entry whose label (case-insensitive) is in `labels`, else "". */
function pickByLabel(entries: FreetextEntry[], labels: Set<string>): string {
  for (const e of entries) {
    const label = typeof e.label === 'string' ? e.label.toLowerCase() : '';
    if (labels.has(label)) return asString(e.content);
  }
  return '';
}

/** First freetext entry's content regardless of label (used for single-purpose arrays). */
function firstContent(entries: FreetextEntry[]): string {
  for (const e of entries) {
    const c = asString(e.content);
    if (c) return c;
  }
  return '';
}

/**
 * Smithsonian `freetext.name` content ranges from a bare "Gilbert Stuart" to a
 * verbose, comma-delimited attribution that bundles nationality + biography +
 * lifespan into one string, e.g.
 *   "Vincent Van Gogh, The Netherlands, active in France, 1853 – 1890".
 * Taking it verbatim leaves that whole string in `artist.name`. Split on the
 * first comma for the name, then mine the trailing segments for a birth–death
 * lifespan and a nationality (skipping role phrases like "active in France").
 * A name with no comma is returned unchanged.
 */
function parseSmithsonianName(raw: string): {
  name: string;
  nationality?: string;
  lifespan?: string;
} {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { name: raw.trim() };

  const name = parts[0];
  let nationality: string | undefined;
  let lifespan: string | undefined;
  for (const seg of parts.slice(1)) {
    const yr = seg.match(/(\d{3,4})\s*[–-]\s*(\d{3,4})/);
    if (yr && !lifespan) {
      lifespan = `${yr[1]}–${yr[2]}`;
      continue;
    }
    // Skip role/activity phrases ("active in France", "born ...") and any
    // year-bearing segment; the first plain segment is the nationality/place.
    if (!nationality && !/\d/.test(seg) && !/^(active|born|died|fl\.?)\b/i.test(seg)) {
      nationality = seg;
    }
  }
  return { name, nationality, lifespan };
}

interface SiMedia {
  type?: unknown;
  content?: unknown;
  thumbnail?: unknown;
  usage?: { access?: unknown };
  resources?: unknown;
}

interface PickedImage {
  full: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  master?: ArtworkMaster;
  maxResolution?: { width: number; height: number };
}

/** Pixel dims of a resource entry, or undefined when not both published. */
function resourceDims(r: Record<string, unknown> | undefined): { width?: number; height?: number } {
  if (!r) return {};
  const w = asFiniteNumber(r.width);
  const h = asFiniteNumber(r.height);
  return { width: w !== null && w > 0 ? w : undefined, height: h !== null && h > 0 ? h : undefined };
}

/**
 * Select the primary image media from `online_media.media[]`. Returns the
 * displayable URL + thumbnail + (when published) pixel dimensions, but ONLY when
 * the chosen media's own `usage.access` is CC0 — a metadata-CC0 record whose
 * image carries usage conditions surfaces no image (imageOpenAccess=false).
 *
 * IMAGE-RESOLUTION FIX: `media.content` points at `ids.si.edu/.../deliveryService`,
 * which caps the long edge at ~2000px (verified live: a 2900×4362 master serves as
 * 1330×2000 from deliveryService). The `resources[]` array already carries a
 * "High-resolution JPEG" entry with the FULL pixels and a direct `download?id=…jpg`
 * URL (the same image, browser-displayable). Prefer that resource URL + its dims;
 * fall back to deliveryService only when no hi-res resource is published. (SI's
 * IIIF endpoint 400s on `/full/max/` for these ids, so we use the published
 * resource rather than an info.json round-trip — no extra request, true max.)
 */
function pickImage(
  content: Record<string, unknown>,
  imageOpenAccess: boolean,
): PickedImage {
  if (!imageOpenAccess) return { full: '' };
  const dnr = content.descriptiveNonRepeating;
  const om =
    dnr && typeof dnr === 'object'
      ? (dnr as Record<string, unknown>).online_media
      : undefined;
  const mediaArr =
    om && typeof om === 'object' && Array.isArray((om as { media?: unknown }).media)
      ? ((om as { media: SiMedia[] }).media)
      : [];
  // The validator derived imageOpenAccess from this SAME selection (first
  // Images-type media, falling back to the first) — keep the two in lockstep so
  // the rights flag always describes the asset we actually surface.
  const media = mediaArr.find((m) => asString(m.type).toLowerCase() === 'images') ?? mediaArr[0];
  if (!media) return { full: '' };

  const thumbnail = asOptionalString(media.thumbnail);
  const resources = Array.isArray(media.resources)
    ? (media.resources as Array<Record<string, unknown>>)
    : [];
  const jpeg = resources.find((r) => /jpeg|jpg/i.test(asString(r.label)));
  const tiff = resources.find((r) => /tiff|tif/i.test(asString(r.label)));
  const jpegDims = resourceDims(jpeg);
  const tiffDims = resourceDims(tiff);

  // Displayable `full`: the hi-res JPEG resource (true max, renders in <img>),
  // falling back to the capped deliveryService URL only when no hi-res JPEG URL.
  const jpegUrl = asString(jpeg?.url);
  const full = jpegUrl || asString(media.content);
  const usingHiRes = Boolean(jpegUrl);
  const width = usingHiRes ? jpegDims.width : undefined;
  const height = usingHiRes ? jpegDims.height : undefined;

  // Archival master: a TIFF resource, when published and strictly larger than the
  // displayable JPEG. Non-<img>-renderable, so flagged with `format`.
  const tiffUrl = asString(tiff?.url);
  const tiffArea = (tiffDims.width ?? 0) * (tiffDims.height ?? 0);
  const jpegArea = (jpegDims.width ?? 0) * (jpegDims.height ?? 0);
  const master: ArtworkMaster | undefined =
    tiffUrl && tiffArea > jpegArea
      ? { url: tiffUrl, width: tiffDims.width, height: tiffDims.height, format: 'image/tiff' }
      : undefined;

  const maxResolution = pickMaxResolution(jpegDims, tiffDims);

  return { full, thumbnail, width, height, master, maxResolution };
}

// Canonical env var is SMITHSONIAN_API_KEY (matches the EUROPEANA_API_KEY
// convention); SI_API_KEY is accepted as a backward-compatible alias.
export function smithsonianApiKey(): string | undefined {
  return process.env.SMITHSONIAN_API_KEY || process.env.SI_API_KEY;
}

function apiKey(): string {
  const key = smithsonianApiKey();
  if (!key) {
    throw new Error(
      'SMITHSONIAN_API_KEY not set: the Smithsonian Open Access source requires an api.data.gov key. ' +
        'Set SMITHSONIAN_API_KEY (or the SI_API_KEY alias) in ~/.open-museum-mcp/.env or your shell.',
    );
  }
  return key;
}

export const smithsonianFetcher: Fetcher = {
  code: 'smithsonian',
  name: 'Smithsonian Institution',
  hotlinkRestricted: true,

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const url = new URL(`${SI_API}/search`);
    // Restrict to records that carry an online image when has_image is set. This
    // is load-bearing, NOT a removable hint: without it, EDAN search is dominated
    // by Smithsonian LIBRARIES bibliographic records — live, "vincent van gogh"
    // returns 189 matches of which 100% of the top page are `SIL` books, and only
    // ~1 is an actual artwork with an image. The filter is what separates "a van
    // Gogh" from "books about van Gogh". The strict CC0 gate + the non-art
    // object_type gate in normalize still re-validate every fetched record.
    const q =
      options.hasImage !== false ? `${query} AND online_media_type:"Images"` : query;
    url.searchParams.set('q', q);
    url.searchParams.set('rows', String(Math.min(limit, SI_MAX_ROWS)));
    url.searchParams.set('start', '0');
    url.searchParams.set('api_key', apiKey());

    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Smithsonian search failed: ${res.status}`);
    const json = (await res.json()) as {
      response?: { rows?: Array<{ id?: unknown }> };
    };
    const rows = json.response?.rows ?? [];
    return rows
      .map((r) => (typeof r.id === 'string' && r.id.length > 0 ? `smithsonian:${r.id}` : null))
      .filter((s): s is string => s !== null)
      .slice(0, limit);
  },

  async getRaw(id: string): Promise<unknown> {
    const objectId = id.replace(/^smithsonian:/, '');
    const url = new URL(`${SI_API}/content/${encodeURIComponent(objectId)}`);
    url.searchParams.set('api_key', apiKey());
    const res = await httpGet(url);
    if (!res.ok) throw new Error(`Smithsonian get failed for ${id}: ${res.status}`);
    return res.json();
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('smithsonian:unknown', 'smithsonian: response not an object', raw);
    }
    // The /content endpoint wraps the record in `{response: {...}}`; search rows
    // are bare records. Tolerate either so fixtures and live callers both work.
    const wrapped = (raw as { response?: unknown }).response;
    const record = (
      wrapped && typeof wrapped === 'object' ? wrapped : raw
    ) as Record<string, unknown>;

    const objectId = record.id;
    const validId = typeof objectId === 'string' && objectId.length > 0;
    const id = validId ? `smithsonian:${objectId}` : 'smithsonian:unknown';

    const decision = validateSmithsonianLicense(record);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    if (!validId) {
      return reject(id, 'smithsonian: missing or non-string id', raw);
    }

    const content =
      record.content && typeof record.content === 'object'
        ? (record.content as Record<string, unknown>)
        : {};
    const dnr =
      content.descriptiveNonRepeating && typeof content.descriptiveNonRepeating === 'object'
        ? (content.descriptiveNonRepeating as Record<string, unknown>)
        : {};
    const indexed =
      content.indexedStructured && typeof content.indexedStructured === 'object'
        ? (content.indexedStructured as Record<string, unknown>)
        : {};

    // Non-art curation gate (runs AFTER the rights gate — rights is the hard
    // boundary; this is a relevance gate that keeps the federated ART result set
    // free of Smithsonian Libraries book records and Natural History specimens).
    // A record is art if EITHER its unit is a dedicated art museum (pass 1) OR an
    // object_type names an art form (pass 2). See the constants block above.
    const unitCode = asString(record.unitCode);
    const objectTypes = objectTypeSignals(content);
    if (!isArtUnit(unitCode) && !isArtObjectType(objectTypes)) {
      return reject(
        id,
        `smithsonian: non-art unit=${unitCode || 'none'} object_type=${objectTypes.length ? objectTypes.join('/') : 'none'} (curation reject)`,
        raw,
      );
    }

    // Title: prefer the structured dnr.title.content, fall back to the
    // top-level mirror, then to a placeholder.
    const titleObj =
      dnr.title && typeof dnr.title === 'object' ? (dnr.title as { content?: unknown }) : {};
    const rawTitle = asString(titleObj.content) || asString(record.title);
    const title = sanitizeTitle(rawTitle) || '(Untitled)';

    // Artist: the maker-labelled freetext name, never a Sitter/Subject. The
    // verbose Smithsonian attribution string is split into name/nationality/
    // lifespan before cleaning. Attribution type is detected on the raw string
    // so prefixes like "after"/"attributed to" are still caught.
    const makerName = sanitizeArtistName(pickByLabel(freetextEntries(content, 'name'), MAKER_LABELS));
    const attributionType = detectAttributionType(makerName);
    const parsedName = parseSmithsonianName(makerName);
    const cleanName = cleanArtistName(parsedName.name);

    const displayDate = pickByLabel(
      freetextEntries(content, 'date'),
      new Set(['date']),
    );
    const dateRange = parseDisplayDate(displayDate);

    const medium = pickByLabel(freetextEntries(content, 'physicalDescription'), new Set(['medium']));

    // Region: prefer the indexed culture vocabulary, then place; both are
    // string arrays. Fall back to the freetext place display string.
    const culture = Array.isArray(indexed.culture) ? asString((indexed.culture as unknown[])[0]) : '';
    const place = Array.isArray(indexed.place) ? asString((indexed.place as unknown[])[0]) : '';
    const region =
      normalizeRegion(culture) ??
      normalizeRegion(place) ??
      normalizeRegion(firstContent(freetextEntries(content, 'place')));

    const image = pickImage(content, decision.imageOpenAccess);

    // Museum: surface the contributing unit's full name (e.g. "Smithsonian
    // American Art Museum") for accurate citation, keeping the federation code
    // 'smithsonian'. data_source is the unit's display name.
    const unitName = sanitizeArtistName(asString(dnr.data_source)) || 'Smithsonian Institution';
    const recordLink = asString(dnr.record_link) || asString(dnr.guid);

    const artwork: Artwork = {
      id,
      museum: {
        code: 'smithsonian',
        name: unitName,
        url: SI_SITE,
      },
      title,
      artist: {
        name: cleanName || 'Unknown',
        nationality: parsedName.nationality,
        lifespan: parsedName.lifespan,
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium,
      mediumCategory: normalizeMedium(medium),
      region,
      period: null,
      imageUrls: {
        full: image.full,
        thumbnail: image.thumbnail,
        width: image.width,
        height: image.height,
        master: image.master,
        maxResolution: image.maxResolution,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${SI_API}/content/${objectId}`,
        pageUrl: recordLink,
      },
      description: asOptionalString(
        sanitizeTitle(pickByLabel(freetextEntries(content, 'objectType'), new Set(['type']))),
      ),
    };

    return { status: 'accepted', artwork };
  },
};
