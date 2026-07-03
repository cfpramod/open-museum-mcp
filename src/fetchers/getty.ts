import { parseDisplayDate } from '../dateParser.js';
import { validateGettyImageLicense, validateGettyLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asOptionalString, asString, derivePeriodFromYears, httpGet, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// The Getty Museum publishes its ~250k-object collection as Linked.Art
// (CIDOC-CRM) JSON-LD, not a flat REST search API — Getty's own docs state
// "we currently don't provide a way to get a list of all of the objects" and
// there is no bulk dump. So unlike the flat-JSON museums, this adapter is
// FEDERATE-via-SPARQL: `search()` queries the public SPARQL endpoint for
// candidate object IDs (bounded by the caller's overfetch window, same cost
// model as the Met's per-object fan-out), and `getRaw`/`normalize` hydrate
// each candidate via REST — never a full-collection crawl.
const OBJECT_API = 'https://data.getty.edu/museum/collection/object';
const SPARQL_ENDPOINT = 'https://data.getty.edu/museum/collection/sparql';

const JSON_ACCEPT = { Accept: 'application/json' };

function escapeSparqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** Last path segment of a Getty entity URI (its UUID). */
function idFromUri(uri: string): string {
  const segments = uri.split('/');
  return segments[segments.length - 1] ?? '';
}

// SSRF guard for the media hydration fetch below: `shows[0].id` is an
// upstream-derived URL (Getty's own object JSON tells us where to fetch the
// media entity), and this is the ONLY fetcher in the engine that follows an
// upstream-influenceable URL server-side; every peer constructs its
// hydration URL from a fixed API host + a validated numeric/UUID id. `fetch`
// on Node routes `localhost`/`169.254.169.254`/private ranges, so an
// unvalidated host here is a real SSRF surface, not a Workers-inert one.
// Positive host-allowlist (not a private-range blocklist): Getty's media
// entities live at `media.getty.edu`/`data.getty.edu`, so requiring the
// `getty.edu` apex or a subdomain of it costs zero real coverage. `endsWith`
// is anchored on the literal `.` separator, so a lookalike like
// `evil-getty.edu` or `media.getty.edu.evil.com` does not match.
const GETTY_APEX_HOST = 'getty.edu';
function isGettyMediaHost(uri: string): boolean {
  try {
    const host = new URL(uri).hostname;
    return host === GETTY_APEX_HOST || host.endsWith(`.${GETTY_APEX_HOST}`);
  } catch {
    return false;
  }
}

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('getty', id, reason, rawSnapshot);

/** Find an `identified_by`/`referred_to_by`-shaped entry's `content` by one of its `classified_as` ids. */
function findContentByClassification(entries: unknown, classificationId: string): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const classified = Array.isArray(e.classified_as) ? (e.classified_as as Array<Record<string, unknown>>) : [];
    if (classified.some((c) => c && typeof c === 'object' && c.id === classificationId)) {
      const content = asOptionalString(e.content);
      if (content) return content;
    }
  }
  return undefined;
}

// "Web Page" classification (AAT 300264578) on `subject_of` marks the entity's
// public collection-page URL — a short custom slug (e.g. `103JNH`), not the
// API's UUID, so it must be read from the record rather than constructed.
const WEB_PAGE_CLASSIFICATION = 'http://vocab.getty.edu/aat/300264578';

function findHomepageUrl(subjectOf: unknown): string {
  if (!Array.isArray(subjectOf)) return '';
  for (const entry of subjectOf) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const classified = Array.isArray(e.classified_as) ? (e.classified_as as Array<Record<string, unknown>>) : [];
    if (classified.some((c) => c && typeof c === 'object' && c.id === WEB_PAGE_CLASSIFICATION)) {
      const url = asOptionalString(e.id);
      if (url) return url;
    }
  }
  return '';
}

const PRIMARY_TITLE = 'https://data.getty.edu/local/thesaurus/object-title-primary';
const ACCESSION_NUMBER = 'http://vocab.getty.edu/aat/300312355';
const PRODUCER_NAME = 'https://data.getty.edu/local/thesaurus/producer-name';
const PRODUCER_DESCRIPTION = 'https://data.getty.edu/local/thesaurus/producer-description';
const PRODUCER_NATIONALITY_AND_DATES = 'https://data.getty.edu/local/thesaurus/nationality-and-dates';
const DISPLAY_NAME = 'http://vocab.getty.edu/aat/300458798';

/** "Dutch, 1853 - 1890" -> { nationality: "Dutch", lifespan: "1853–1890" }. Anonymous/undated inputs degrade gracefully. */
function parseNationalityAndDates(s: string | undefined): { nationality?: string; lifespan?: string } {
  if (!s) return {};
  const [first, ...rest] = s.split(',').map((p) => p.trim());
  const firstLooksLikeNationality = /[a-zA-Z]/.test(first) && !/^\d/.test(first);
  const nationality = firstLooksLikeNationality ? first : undefined;
  const datesPart = firstLooksLikeNationality ? rest.join(',').trim() : s;
  const lifespan = datesPart ? datesPart.replace(/\s*-\s*/g, '–').trim() : undefined;
  return { nationality: nationality || undefined, lifespan: lifespan || undefined };
}

function yearFromIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^(-?\d+)-/.exec(iso);
  return m ? parseInt(m[1], 10) : null;
}

function findDimensionValue(dimensions: unknown, label: string): number | undefined {
  if (!Array.isArray(dimensions)) return undefined;
  for (const d of dimensions) {
    if (!d || typeof d !== 'object') continue;
    const dim = d as Record<string, unknown>;
    const classified = Array.isArray(dim.classified_as) ? (dim.classified_as as Array<Record<string, unknown>>) : [];
    if (classified.some((c) => asString(c._label) === label)) {
      const v = asFiniteNumber(dim.value);
      if (v !== null) return v;
    }
  }
  return undefined;
}

interface GettyRaw {
  object: unknown;
  /** The primary (first `shows`) image's media entity, or null if none/unfetchable. */
  media: unknown;
}

export const gettyFetcher: Fetcher = {
  code: 'getty',
  name: 'J. Paul Getty Museum',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const term = escapeSparqlLiteral(query.toLowerCase());
    const imageClause = options.hasImage !== false ? '?obj crm:P65_shows_visual_item ?img .' : '';
    const sparql = `PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?obj WHERE {
  ?obj a crm:E22_Human-Made_Object .
  ${imageClause}
  OPTIONAL { ?obj rdfs:label ?label . }
  OPTIONAL { ?obj crm:P108i_was_produced_by ?prod . ?prod rdfs:label ?prodLabel . }
  FILTER(CONTAINS(LCASE(STR(?label)), "${term}") || CONTAINS(LCASE(STR(?prodLabel)), "${term}"))
} LIMIT ${limit}`;

    const url = new URL(SPARQL_ENDPOINT);
    url.searchParams.set('query', sparql);
    const res = await httpGet(url, { headers: { Accept: 'application/sparql-results+json' } });
    if (!res.ok) throw new Error(`Getty SPARQL search failed: ${res.status}`);
    const json = (await res.json()) as { results?: { bindings?: Array<{ obj?: { value?: string } }> } };
    const bindings = json.results?.bindings ?? [];
    return bindings
      .map((b) => b.obj?.value)
      .filter((v): v is string => typeof v === 'string')
      .map((uri) => `getty:${idFromUri(uri)}`);
  },

  async getRaw(id: string): Promise<unknown> {
    const uuid = id.replace(/^getty:/, '');
    const res = await httpGet(`${OBJECT_API}/${uuid}`, { headers: JSON_ACCEPT });
    if (!res.ok) throw new Error(`Getty get failed for ${id}: ${res.status}`);
    const object = await res.json();

    // Hydrate only the PRIMARY (first `shows`) image for rights + IIIF URLs —
    // bounding this fetcher to at most one extra HTTP round trip per record,
    // same order of magnitude as any other federated adapter's per-object cost.
    const shows = Array.isArray((object as Record<string, unknown>)?.shows)
      ? ((object as Record<string, unknown>).shows as Array<Record<string, unknown>>)
      : [];
    const firstImageUri = asOptionalString(shows[0]?.id);
    let media: unknown = null;
    if (firstImageUri && isGettyMediaHost(firstImageUri)) {
      try {
        const mediaRes = await httpGet(firstImageUri, { headers: JSON_ACCEPT });
        if (mediaRes.ok) media = await mediaRes.json();
      } catch {
        // Media hydration is best-effort: a transient failure here should not
        // fail the whole record. normalize() treats a missing/unfetchable
        // media entity the same as "no verified open image" — imageOpenAccess
        // stays false rather than being wrongly claimed true.
      }
    }

    const raw: GettyRaw = { object, media };
    return raw;
  },

  normalize(raw: unknown): ValidationResult {
    const combined = raw as Partial<GettyRaw> | null;
    if (!combined || typeof combined !== 'object' || !combined.object) {
      return reject('getty:unknown', 'getty: response not an object', raw);
    }
    const r = combined.object as Record<string, unknown>;

    const idUri = asString(r.id);
    const uuid = idUri ? idFromUri(idUri) : '';
    const id = uuid ? `getty:${uuid}` : 'getty:unknown';

    const decision = validateGettyLicense(r);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }
    if (!uuid) {
      return reject(id, 'getty: missing object id', raw);
    }

    const primaryTitle =
      findContentByClassification(r.identified_by, PRIMARY_TITLE) ??
      asString(r._label).replace(/\s*\([^)]*\)\s*$/, '').trim();
    const title = sanitizeTitle(primaryTitle) || '(Untitled)';
    const accessionNumber = findContentByClassification(r.identified_by, ACCESSION_NUMBER);

    const producedBy = r.produced_by as Record<string, unknown> | undefined;
    const producerRefs = Array.isArray(producedBy?.referred_to_by) ? producedBy?.referred_to_by : [];
    const producerName = findContentByClassification(producerRefs, PRODUCER_NAME);
    const producerDescription = findContentByClassification(producerRefs, PRODUCER_DESCRIPTION) ?? '';
    const nationalityAndDatesRaw = findContentByClassification(producerRefs, PRODUCER_NATIONALITY_AND_DATES);
    const attributionSource = producerDescription || producerName || '';
    const attributionType = detectAttributionType(attributionSource);
    const cleanName = cleanArtistName(sanitizeArtistName(producerName || attributionSource));
    const { nationality, lifespan } = parseNationalityAndDates(nationalityAndDatesRaw);
    const region = normalizeRegion(nationality);

    const timespan = producedBy?.timespan as Record<string, unknown> | undefined;
    const displayDate = findContentByClassification(timespan?.identified_by, DISPLAY_NAME) ?? '';
    const beginYear = yearFromIso(asOptionalString(timespan?.begin_of_the_begin));
    const endYear = yearFromIso(asOptionalString(timespan?.end_of_the_end));
    const dateRange =
      beginYear !== null && endYear !== null ? { yearStart: beginYear, yearEnd: endYear } : parseDisplayDate(displayDate);

    const madeOf = Array.isArray(r.made_of) ? (r.made_of as Array<Record<string, unknown>>) : [];
    // Strip Getty's AAT categorical suffix ("Oil Paint (Paint)", "Canvas
    // (Textile Material)") before joining — left in, "Textile Material" is
    // itself a Tier-1 keyword in normalizeMedium and, being longer than
    // "oil", would wrongly win a painting on canvas as a textile.
    const materialLabels = madeOf
      .map((m) => asString(m._label).replace(/\s*\([^)]*\)\s*$/, '').trim())
      .filter(Boolean);
    const classifiedAs = Array.isArray(r.classified_as) ? (r.classified_as as Array<Record<string, unknown>>) : [];
    // "Artwork" and "Object Record Structure: Whole" are boilerplate classifications
    // present on every object; skip them when looking for a medium/type label.
    const BOILERPLATE = new Set(['Artwork', 'Object Record Structure: Whole']);
    const classificationLabel = classifiedAs.map((c) => asString(c._label)).find((l) => l && !BOILERPLATE.has(l));
    const medium = materialLabels.length > 0 ? materialLabels.join(', ') : classificationLabel ?? '';
    const mediumCategory = normalizeMedium(medium || classificationLabel);

    // Image rights are verified independently of the object's metadata rights
    // (see validateGettyImageLicense) — never inherited from `decision` above.
    const media = combined.media;
    const imageDecision = media ? validateGettyImageLicense(media) : null;
    const imageAccepted = imageDecision?.accepted ?? false;

    let fullImage = '';
    let thumbnail: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    if (imageAccepted && media && typeof media === 'object') {
      const m = media as Record<string, unknown>;
      const digitallyShownBy = Array.isArray(m.digitally_shown_by)
        ? (m.digitally_shown_by as Array<Record<string, unknown>>)
        : [];
      const digitalObj = digitallyShownBy[0];
      const accessPoints =
        digitalObj && Array.isArray(digitalObj.access_point)
          ? (digitalObj.access_point as Array<Record<string, unknown>>)
          : [];
      const fullRes = accessPoints.find((a) => asString(a._label).toLowerCase().includes('full-resolution'));
      const thumb = accessPoints.find((a) => asString(a._label).toLowerCase().includes('thumbnail'));
      fullImage = asString(fullRes?.id);
      thumbnail = asOptionalString(thumb?.id);
      width = findDimensionValue(digitalObj?.dimension, 'Width');
      height = findDimensionValue(digitalObj?.dimension, 'Height');
    }

    const artwork: Artwork = {
      id,
      museum: {
        code: 'getty',
        name: 'J. Paul Getty Museum',
        url: 'https://www.getty.edu',
      },
      title,
      artist: {
        name: cleanName || 'Unknown',
        nationality,
        lifespan,
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium,
      mediumCategory,
      region,
      period: derivePeriodFromYears(dateRange.yearStart, dateRange.yearEnd),
      imageUrls: {
        full: fullImage,
        thumbnail,
        width,
        height,
        maxResolution: width && height ? { width, height } : undefined,
      },
      imageOpenAccess: imageAccepted,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${OBJECT_API}/${uuid}`,
        pageUrl: findHomepageUrl(r.subject_of),
      },
      description: accessionNumber,
    };

    return { status: 'accepted', artwork };
  },
};
