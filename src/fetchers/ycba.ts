import { parseDisplayDate } from '../dateParser.js';
import { firstIiif2Canvas, validateYcbaLicense, YCBA_GROUP_ID, YCBA_MANIFEST_URL_RE } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import {
  accepted,
  asFiniteNumber,
  asOptionalString,
  asString,
  derivePeriodFromYears,
  httpGet,
  rejectFor,
} from './helpers.js';
import { buildCreditLine, sanitizeArtistName, sanitizeDescription, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// The Yale Center for British Art is federated through LUX, Yale's Linked Art
// platform (lux.collections.yale.edu). LUX search is a JSON-query REST API that
// returns Linked Art object ids; each object record links its YCBA IIIF v2
// manifest, which is where YCBA publishes per-object rights. So hydration is
// two hops (record -> manifest), and the rights decision reads the manifest
// (see validateYcbaLicense). The search is scoped to YCBA's holdings with
// LUX's "curated by" clause, so other collections on the platform never
// consume the caller's overfetch window.
const LUX_ORIGIN = 'https://lux.collections.yale.edu';
const LUX_SEARCH_URL = `${LUX_ORIGIN}/api/search/item`;
const LUX_OBJECT_BASE = `${LUX_ORIGIN}/data/object/`;
const IIIF_PRESENTATION_2_CONTEXT = 'http://iiif.io/api/presentation/2/context.json';
const YALE_IMAGE_SERVICE_RE = /^https:\/\/images\.collections\.yale\.edu\/iiif\/2\/ycba:[0-9a-f-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MUSEUM = { code: 'ycba', name: 'Yale Center for British Art', url: 'https://britishart.yale.edu' } as const;

const JSON_ACCEPT = { Accept: 'application/json' };

// LUX's largest documented page; anything larger is clamped rather than sent.
const MAX_PAGE_LENGTH = 100;

/**
 * Upper bound on simultaneous requests this adapter makes to Yale (LUX records
 * and YCBA manifests together). The federation's own per-museum fan-out cap is
 * 8 and each record costs two requests here, so the adapter holds its own,
 * lower limit. LUX answers bursts with intermittent 500s.
 */
export const YCBA_MAX_CONCURRENCY = 4;

// Transient upstream statuses retried with backoff; anything else is final.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];
const REQUEST_TIMEOUT_MS = 20_000;

let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inFlight < YCBA_MAX_CONCURRENCY) {
    inFlight++;
    return;
  }
  // The releasing request hands its slot straight to us, so inFlight is unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a Yale JSON resource inside the concurrency limit, retrying transient
 * failures (network errors and RETRYABLE_STATUS) with backoff. Resolves with
 * the final status and, for a 2xx, the parsed body. `redirect` is passed
 * through to fetch. A caller's `signal` aborts the request in flight and stops
 * any further attempt; it is never retried.
 */
async function yaleGetJson(
  url: string,
  redirect: RequestInit['redirect'] = 'follow',
  signal?: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const canRetry = attempt < RETRY_DELAYS_MS.length;
    await acquireSlot();
    let outcome: { status: number; body: unknown };
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const res = await httpGet(url, {
        headers: JSON_ACCEPT,
        redirect,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      outcome = { status: res.status, body: res.ok ? await res.json() : null };
    } catch (err) {
      if (!canRetry || signal?.aborted) throw err;
      outcome = { status: 0, body: null };
    } finally {
      releaseSlot();
    }
    if (canRetry && (outcome.status === 0 || RETRYABLE_STATUS.has(outcome.status))) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    return outcome;
  }
}

/** The UUID of a LUX object URI, or undefined for anything else. */
function luxObjectUuid(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith(LUX_OBJECT_BASE)) return undefined;
  const uuid = uri.slice(LUX_OBJECT_BASE.length);
  return UUID_RE.test(uuid) ? uuid : undefined;
}

function asRecordArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [];
}

/** True when any `classified_as` entry (or its `equivalent`) has the given AAT id. */
function hasAat(entry: Record<string, unknown>, aatId: string): boolean {
  return asRecordArray(entry.classified_as).some(
    (c) => c.id === aatId || asRecordArray(c.equivalent).some((e) => e.id === aatId),
  );
}

function findContentByAat(entries: unknown, aatId: string): string | undefined {
  for (const e of asRecordArray(entries)) {
    if (hasAat(e, aatId)) {
      const content = asOptionalString(e.content);
      if (content) return content;
    }
  }
  return undefined;
}

const AAT_PRIMARY_NAME = 'http://vocab.getty.edu/aat/300404670';
const AAT_ACCESSION_NUMBER = 'http://vocab.getty.edu/aat/300312355';
const AAT_MATERIAL_STATEMENT = 'http://vocab.getty.edu/aat/300435429';
const AAT_DIMENSION_STATEMENT = 'http://vocab.getty.edu/aat/300435430';
const AAT_CREDIT_LINE = 'http://vocab.getty.edu/aat/300435418';
const AAT_WEB_PAGE = 'http://vocab.getty.edu/aat/300264578';
const AAT_TYPE_OF_WORK = 'http://vocab.getty.edu/aat/300435443';

/** The IIIF v2 manifest URL a LUX record links in `subject_of`, if any. */
function findManifestUrl(record: Record<string, unknown>): string | undefined {
  for (const subject of asRecordArray(record.subject_of)) {
    for (const carrier of asRecordArray(subject.digitally_carried_by)) {
      if (!asRecordArray(carrier.conforms_to).some((c) => c.id === IIIF_PRESENTATION_2_CONTEXT)) continue;
      const url = asOptionalString(asRecordArray(carrier.access_point)[0]?.id);
      if (url) return url;
    }
  }
  return undefined;
}

/** YCBA's own collection page for the object (the "Web Page" access point). */
function findPageUrl(record: Record<string, unknown>): string {
  for (const subject of asRecordArray(record.subject_of)) {
    for (const carrier of asRecordArray(subject.digitally_carried_by)) {
      if (!hasAat(carrier, AAT_WEB_PAGE)) continue;
      const url = asOptionalString(asRecordArray(carrier.access_point)[0]?.id);
      if (url && url.startsWith('https://')) return url;
    }
  }
  return '';
}

/**
 * Producer names and their role labels ("Primary Artist", "Artist, attributed
 * to", ...), from both the production and any production parts.
 */
function findProducers(producedBy: Record<string, unknown> | undefined): Array<{ name: string; role: string }> {
  if (!producedBy) return [];
  const out: Array<{ name: string; role: string }> = [];
  for (const activity of [producedBy, ...asRecordArray(producedBy.part)]) {
    const role = asRecordArray(activity.classified_as)
      .map((c) => asString(c._label))
      .join(' ');
    for (const agent of asRecordArray(activity.carried_out_by)) {
      const name = asString(agent._label).trim();
      if (name) out.push({ name, role });
    }
  }
  return out;
}

function yearFromIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^(-?\d+)-/.exec(iso);
  return m ? parseInt(m[1], 10) : null;
}

/** The painting image of a IIIF v2 canvas: its image resource and IIIF service id. */
function findPaintingImage(
  canvas: Record<string, unknown> | undefined,
): { full: string; service: string; width?: number; height?: number } | undefined {
  if (!canvas) return undefined;
  const annotation = asRecordArray(canvas.images).find((a) => a.motivation === 'sc:painting');
  const resource = annotation?.resource;
  if (!resource || typeof resource !== 'object') return undefined;
  const r = resource as Record<string, unknown>;
  const service = r.service && typeof r.service === 'object' ? (r.service as Record<string, unknown>) : undefined;
  const serviceId = asString(service?.['@id']);
  if (!YALE_IMAGE_SERVICE_RE.test(serviceId)) return undefined;
  const width = asFiniteNumber(r.width) ?? asFiniteNumber(canvas.width) ?? undefined;
  const height = asFiniteNumber(r.height) ?? asFiniteNumber(canvas.height) ?? undefined;
  return { full: `${serviceId}/full/full/0/default.jpg`, service: serviceId, width, height };
}

interface YcbaRaw {
  record: unknown;
  /** The record's YCBA IIIF v2 manifest, or null if absent, off-allowlist, or unfetchable. */
  manifest: unknown;
  manifestUrl: string | null;
}

interface YcbaNotFound {
  notFound: true;
  id: string;
}

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('ycba', id, reason, rawSnapshot);

export const ycbaFetcher: Fetcher = {
  code: MUSEUM.code,
  name: MUSEUM.name,

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    // The query is built as data and serialised once, so a search term can
    // never alter the query's structure.
    const clauses: Array<Record<string, unknown>> = [{ text: query, _lang: 'en' }];
    if (options.hasImage !== false) clauses.push({ hasDigitalImage: 1 });
    clauses.push({ memberOf: { curatedBy: { OR: [{ memberOf: { id: YCBA_GROUP_ID } }, { id: YCBA_GROUP_ID }] } } });

    const url = new URL(LUX_SEARCH_URL);
    url.searchParams.set('q', JSON.stringify({ AND: clauses }));
    url.searchParams.set('page', '1');
    url.searchParams.set('pageLength', String(Math.max(1, Math.min(limit, MAX_PAGE_LENGTH))));

    const { status, body } = await yaleGetJson(url.toString(), 'follow', options.signal);
    if (status < 200 || status >= 300) throw new Error(`YCBA (LUX) search failed: ${status}`);
    const items = body && typeof body === 'object' ? (body as Record<string, unknown>).orderedItems : undefined;
    return asRecordArray(items)
      .map((item) => luxObjectUuid(item.id))
      .filter((uuid): uuid is string => uuid !== undefined)
      .map((uuid) => `ycba:${uuid}`);
  },

  async getRaw(id: string): Promise<unknown> {
    const uuid = id.replace(/^ycba:/, '');
    if (!UUID_RE.test(uuid)) throw new Error(`ycba: invalid id ${id}`);

    const recordRes = await yaleGetJson(`${LUX_OBJECT_BASE}${uuid}`);
    // An id from the search index whose record has since gone is dropped by
    // the gate, not thrown, so one stale index entry never fails a search.
    if (recordRes.status === 404 || recordRes.status === 410) {
      const gone: YcbaNotFound = { notFound: true, id };
      return gone;
    }
    if (recordRes.status < 200 || recordRes.status >= 300) {
      throw new Error(`YCBA (LUX) get failed for ${id}: ${recordRes.status}`);
    }
    const record = recordRes.body;

    // SSRF guard: the manifest URL comes from the upstream record, so it is
    // fetched only when it is exactly a YCBA manifest URL on Yale's manifest
    // host (https, fixed path, numeric id). Anything else is never requested,
    // and a redirect is refused rather than followed, so the host check holds
    // for the address actually fetched.
    const manifestUrl =
      record && typeof record === 'object' ? findManifestUrl(record as Record<string, unknown>) : undefined;
    let manifest: unknown = null;
    if (manifestUrl && YCBA_MANIFEST_URL_RE.test(manifestUrl)) {
      try {
        const res = await yaleGetJson(manifestUrl, 'error');
        if (res.status >= 200 && res.status < 300) manifest = res.body;
      } catch {
        // An unreadable manifest is the same as no rights signal: the gate
        // fails closed on manifest === null.
      }
    }

    const raw: YcbaRaw = { record, manifest, manifestUrl: manifestUrl ?? null };
    return raw;
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('ycba:unknown', 'ycba: response not an object', raw);
    }
    const combined = raw as Partial<YcbaRaw> & Partial<YcbaNotFound>;
    if (combined.notFound === true) {
      return reject(asString(combined.id) || 'ycba:unknown', 'ycba: LUX record not found (dropped)', raw);
    }
    if (!combined.record || typeof combined.record !== 'object') {
      return reject('ycba:unknown', 'ycba: LUX record missing or not an object', raw);
    }
    const r = combined.record as Record<string, unknown>;
    const uuid = luxObjectUuid(r.id);
    const id = uuid ? `ycba:${uuid}` : 'ycba:unknown';
    if (!uuid) {
      return reject(id, 'ycba: record id is not a LUX object URI', raw);
    }

    const decision = validateYcbaLicense(raw);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    // The gate verified the rights of this exact canvas; the emitted image is
    // taken from the same canvas, and only from Yale's own image server.
    const image = findPaintingImage(firstIiif2Canvas(combined.manifest as Record<string, unknown>));
    if (!image) {
      return reject(id, 'ycba: painting canvas has no image on the Yale image server', raw);
    }

    const title = sanitizeTitle(findContentByAat(r.identified_by, AAT_PRIMARY_NAME) ?? asString(r._label)) || '(Untitled)';

    const producedBy = r.produced_by && typeof r.produced_by === 'object' ? (r.produced_by as Record<string, unknown>) : undefined;
    const producers = findProducers(producedBy);
    const artistSource = producers.map((p) => `${p.role} ${p.name}`).join('; ');
    const artistName = cleanArtistName(sanitizeArtistName(producers.map((p) => p.name).join(', ')));
    const attributionType = producers.length > 0 ? detectAttributionType(artistSource) : 'anonymous';

    const timespan =
      producedBy?.timespan && typeof producedBy.timespan === 'object'
        ? (producedBy.timespan as Record<string, unknown>)
        : undefined;
    const displayDate = sanitizeTitle(asString(asRecordArray(timespan?.identified_by)[0]?.content));
    const beginYear = yearFromIso(asOptionalString(timespan?.begin_of_the_begin));
    const endYear = yearFromIso(asOptionalString(timespan?.end_of_the_end));
    const dateRange =
      beginYear !== null && endYear !== null ? { yearStart: beginYear, yearEnd: endYear } : parseDisplayDate(displayDate);

    const materialStatement = findContentByAat(r.referred_to_by, AAT_MATERIAL_STATEMENT);
    const materials = asRecordArray(r.made_of)
      .map((m) => asString(m._label))
      .filter(Boolean)
      .join(', ');
    const medium = sanitizeDescription(materialStatement ?? materials);
    const objectType = asRecordArray(r.classified_as)
      .filter((c) => hasAat(c, AAT_TYPE_OF_WORK))
      .map((c) => asString(c._label))
      .find(Boolean);
    const dimensions = findContentByAat(r.referred_to_by, AAT_DIMENSION_STATEMENT);
    const accessionNumber = findContentByAat(r.identified_by, AAT_ACCESSION_NUMBER);

    const artwork: Artwork = {
      id,
      museum: { ...MUSEUM },
      title,
      artist: {
        name: artistName || 'Unknown',
        attributionType,
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium,
      mediumCategory: normalizeMedium(medium || objectType),
      // LUX object records name the artist but not their nationality, and the
      // collection's focus is not a per-object fact, so no region is inferred.
      region: null,
      period: derivePeriodFromYears(dateRange.yearStart, dateRange.yearEnd),
      imageUrls: {
        full: image.full,
        large: `${image.service}/full/!1200,1200/0/default.jpg`,
        thumbnail: `${image.service}/full/!400,400/0/default.jpg`,
        width: image.width,
        height: image.height,
        maxResolution: image.width && image.height ? { width: image.width, height: image.height } : undefined,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${LUX_OBJECT_BASE}${uuid}`,
        pageUrl: findPageUrl(r),
      },
      description: accessionNumber ? sanitizeTitle(accessionNumber) : undefined,
      objectType: objectType ? sanitizeTitle(objectType) : undefined,
      dimensions: dimensions ? sanitizeDescription(dimensions) : undefined,
      creditLine: buildCreditLine(MUSEUM.name, findContentByAat(r.referred_to_by, AAT_CREDIT_LINE), accessionNumber),
    };

    return accepted(artwork);
  },
};
