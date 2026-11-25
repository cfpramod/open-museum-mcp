import { parseDisplayDate } from '../dateParser.js';
import { parisMuseesFreeImage, parisMuseesPageUrl, validateParisMuseesLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asFiniteNumber, asOptionalString, asString, httpGet, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeDescription, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// Paris Musées — the 14 museums of the City of Paris (Petit Palais, Carnavalet,
// Musée d'Art Moderne de Paris, Palais Galliera, the Maisons de Victor Hugo, …).
// GraphQL over Drupal at apicollections.parismusees.paris.fr. A free account
// token is required (PARISMUSEES_API_KEY), sent in an `auth-token` header; the
// endpoint rejects anonymous requests.
//
// Rights are per IMAGE, judged by validateParisMuseesLicense: a record is
// accepted only when one of its images carries `fieldImageLibre: true` AND a
// `fieldImageDroits` statement of the form "CC0 Paris Musées / <museum>", with
// an https image URL on the collections host. Records and labels are French.
//
// Quota: the public API allows 1,000 requests a day. The federation's usual
// shape (search → ids, then one getRaw per id) would spend 1 + N requests per
// search, so `search` instead makes two (one when nothing matches; each may be
// retried once on a server error, see graphql()): a full-text search for
// candidate ids, then ONE batched nodeQuery that hydrates every candidate and
// keeps only those with a free image. The hydrated records are held briefly in
// memory so the federation's per-id getRaw calls are served without another
// request. A cache miss (e.g. a direct get_artwork) costs one request.
const PM_GRAPHQL = 'https://apicollections.parismusees.paris.fr/graphql';
const PM_SITE = 'https://www.parismuseescollections.paris.fr';

/** Hydrated records are reused for this long after a search. */
const PREFETCH_TTL_MS = 10 * 60 * 1000;
/** Upper bound on held records, so a long-running host can't grow it without limit. */
const PREFETCH_MAX = 500;
/** The search index can return one artwork several times, so ask for extra. */
const OVERFETCH = 2;
const MAX_CANDIDATES = 100;

/** Transient upstream statuses retried once; anything else is final. */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RETRY_DELAY_MS = 1000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function apiKey(): string | undefined {
  return process.env.PARISMUSEES_API_KEY?.trim() || undefined;
}

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('parismusees', id, reason, rawSnapshot);

// Everything normalize reads. Search hydration and getRaw use the same
// selection, so a prefetched record and a directly fetched one are identical.
const OEUVRE_FIELDS = `
  entityId
  title
  absolutePath
  fieldCartelAuteur
  fieldCartelDatation
  fieldCartelDenominationTitre
  fieldCartelDimension
  fieldCartelMateriaux
  fieldDateProduction { startYear endYear processed }
  fieldDescription { value }
  fieldOeuvreDescriptionIcono { value }
  fieldMusee { entity { name ... on TaxonomyTermMusee { fieldMuseeTitreCourt } } }
  fieldOeuvreTypesObjet { entity { name } }
  fieldMateriauxTechnique { entity { name } }
  fieldOeuvreAuteurs { entity { fieldAuteurAuteur { entity { name } } } }
  fieldVisuels { entity { ... on MediaImage { publicUrl vignette fieldImageLibre fieldImageDroits } } }`;

// `type_contenu_chaine_s: oeuvre` leaves out the library documents and archives
// that share the index; `image_libre_bool_s: true` keeps only records with a
// free image (the index ignores a `false` value, but `true` narrows correctly).
const SEARCH_QUERY = `query Search($keys: [String]!, $limit: Int!) {
  searchAPISearch(
    index_id: "collections"
    fulltext: { keys: $keys, conjunction: "AND" }
    conditions: [
      { name: "type_contenu_chaine_s", value: "oeuvre" }
      { name: "image_libre_bool_s", value: "true" }
    ]
    range: { offset: 0, limit: $limit }
  ) { documents { ... on CollectionsDoc { nid_entier_s } } }
}`;

// The free-image condition repeats the gate's test server-side, so records
// that would be rejected never come back. The gate still decides.
const HYDRATE_QUERY = `query Hydrate($ids: [String]!, $limit: Int!) {
  nodeQuery(limit: $limit, filter: { conditions: [
    { field: "type", value: ["oeuvre"] }
    { field: "nid", value: $ids, operator: IN }
    { field: "field_visuels.entity.field_image_libre", value: ["1"] }
  ] }) { entities { ... on NodeOeuvre { ${OEUVRE_FIELDS} } } }
}`;

const GET_QUERY = `query Get($id: [String]!) {
  nodeQuery(limit: 1, filter: { conditions: [
    { field: "type", value: ["oeuvre"] }
    { field: "nid", value: $id, operator: IN }
  ] }) { entities { ... on NodeOeuvre { ${OEUVRE_FIELDS} } } }
}`;

// --- Request -------------------------------------------------------------------

// Upstream error text is kept for diagnosis, but it is the API's text, not
// ours: a misconfigured or hostile server could echo the request's token back,
// or send megabytes. The key is replaced wherever it appears (before the cut,
// so no part of it survives at the boundary) and the result is capped.
const UPSTREAM_TEXT_MAX_LENGTH = 200;

function upstreamText(text: string, key: string): string {
  const redacted = text.split(key).join('[redacted]');
  return redacted.length > UPSTREAM_TEXT_MAX_LENGTH
    ? `${redacted.slice(0, UPSTREAM_TEXT_MAX_LENGTH)}…`
    : redacted;
}

// The message of a failed request's JSON body: the GraphQL `errors` list, or a
// top-level `message`. Anything that is not JSON yields '' and the error carries
// the status alone.
function errorBodyMessage(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const { errors, message } = parsed as { errors?: unknown; message?: unknown };
  if (Array.isArray(errors)) {
    return errors
      .map((e) => (e && typeof e === 'object' ? asString((e as { message?: unknown }).message) : ''))
      .filter(Boolean)
      .join('; ');
  }
  return asString(message);
}

async function graphql(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const key = apiKey();
  if (!key) throw new Error('Paris Musées: PARISMUSEES_API_KEY not set');
  const init: RequestInit = {
    // httpGet is the shared fetch wrapper (it sets the User-Agent); it passes
    // the method, body and redirect mode straight through.
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'auth-token': key },
    body: JSON.stringify({ query, variables }),
    // The key travels in a header, and fetch would resend it to wherever a
    // redirect points. The API answers this endpoint directly, so a redirect
    // is refused rather than followed (as the Rijksmuseum fetcher does).
    redirect: 'error',
    signal,
  };
  let res = await httpGet(PM_GRAPHQL, init);
  // The server occasionally answers a valid query with a bare 5xx that succeeds
  // when repeated (seen live: one query failed twice, then the same request
  // succeeded minutes later). Retry once. Not 429: that signals a rate limit,
  // and with a daily quota a retry would only spend more of it.
  if (RETRYABLE_STATUS.has(res.status)) {
    await sleep(RETRY_DELAY_MS, signal);
    res = await httpGet(PM_GRAPHQL, init);
  }
  if (!res.ok) {
    // A failed query can carry a JSON error body; keep its message. The body is
    // decoded before redaction, since an encoder may escape a character of the
    // key (PHP writes `/` as `\/`) and the raw text would then not contain it.
    const body = await res.text().catch(() => '');
    const detail = errorBodyMessage(body);
    const safe = detail ? upstreamText(detail, key) : '';
    throw new Error(`Paris Musées request failed: ${res.status}${safe ? ` (${safe})` : ''}`);
  }
  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message?: unknown }> };
  // GraphQL reports failures with a 200 and an `errors` list.
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const message = upstreamText(json.errors.map((e) => asString(e?.message)).filter(Boolean).join('; '), key);
    throw new Error(`Paris Musées API error: ${message || 'unknown error'}`);
  }
  if (!json.data || typeof json.data !== 'object') throw new Error('Paris Musées API returned no data');
  return json.data as Record<string, unknown>;
}

function entitiesOf(data: Record<string, unknown>): Record<string, unknown>[] {
  const nq = data.nodeQuery;
  const list = nq && typeof nq === 'object' ? (nq as { entities?: unknown }).entities : undefined;
  return Array.isArray(list)
    ? list.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    : [];
}

// --- Prefetch store --------------------------------------------------------------

const prefetched = new Map<string, { raw: Record<string, unknown>; at: number }>();

function remember(nid: string, raw: Record<string, unknown>): void {
  prefetched.delete(nid);
  prefetched.set(nid, { raw, at: Date.now() });
  // Map iteration is insertion order, so the first key is the oldest.
  while (prefetched.size > PREFETCH_MAX) {
    const oldest = prefetched.keys().next().value;
    if (oldest === undefined) break;
    prefetched.delete(oldest);
  }
}

function recall(nid: string): Record<string, unknown> | undefined {
  const hit = prefetched.get(nid);
  if (!hit) return undefined;
  if (Date.now() - hit.at > PREFETCH_TTL_MS) {
    prefetched.delete(nid);
    return undefined;
  }
  return hit.raw;
}

/** Test hook: empty the prefetch store. */
export function clearParisMuseesPrefetch(): void {
  prefetched.clear();
}

// --- Normalize helpers -----------------------------------------------------------

function named(v: unknown): string {
  const entity = v && typeof v === 'object' ? (v as { entity?: unknown }).entity : undefined;
  return entity && typeof entity === 'object' ? asString((entity as { name?: unknown }).name).trim() : '';
}

function namesOf(list: unknown): string[] {
  return Array.isArray(list) ? list.map(named).filter(Boolean) : [];
}

function textValue(v: unknown): string {
  return v && typeof v === 'object' ? asString((v as { value?: unknown }).value) : '';
}

/** "Monet, Claude" -> "Claude Monet"; anything more complicated is left alone. */
function personName(raw: string): string {
  const m = raw.trim().match(/^([^,()]+), ([^,()]+)$/);
  return m ? `${m[2]} ${m[1]}` : raw.trim();
}

function artistOf(r: Record<string, unknown>): string {
  const label = asString(r.fieldCartelAuteur).trim();
  if (label) return label;
  const authors = Array.isArray(r.fieldOeuvreAuteurs) ? r.fieldOeuvreAuteurs : [];
  const names = authors
    .map((a) => {
      const entity = a && typeof a === 'object' ? (a as { entity?: unknown }).entity : undefined;
      return entity && typeof entity === 'object'
        ? personName(named((entity as { fieldAuteurAuteur?: unknown }).fieldAuteurAuteur))
        : '';
    })
    .filter(Boolean);
  return [...new Set(names)].join('; ');
}

// --- Fetcher ---------------------------------------------------------------------

export const parismuseesFetcher: Fetcher = {
  code: 'parismusees',
  name: 'Paris Musées',
  requiresApiKey: 'PARISMUSEES_API_KEY',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    const keys = query.split(/\s+/).filter(Boolean);
    if (keys.length === 0) return [];

    // `hasImage` needs no handling: the gate accepts only records with a free
    // image, so this source only ever returns records with one.
    const searchData = await graphql(
      SEARCH_QUERY,
      { keys, limit: Math.min(limit * OVERFETCH, MAX_CANDIDATES) },
      options.signal,
    );
    const ssa = searchData.searchAPISearch;
    const docs = ssa && typeof ssa === 'object' ? (ssa as { documents?: unknown }).documents : undefined;
    const ranked: string[] = [];
    for (const d of Array.isArray(docs) ? docs : []) {
      const nid = d && typeof d === 'object' ? (d as { nid_entier_s?: unknown }).nid_entier_s : undefined;
      // Node ids are positive whole numbers; anything else (1.5, 1e21) would
      // turn into an id string the server never issued.
      if (typeof nid === 'number' && Number.isSafeInteger(nid) && nid > 0 && !ranked.includes(String(nid))) {
        ranked.push(String(nid));
      }
    }
    if (ranked.length === 0) return [];

    const hydrated = entitiesOf(
      await graphql(HYDRATE_QUERY, { ids: ranked, limit: ranked.length }, options.signal),
    );
    // Only records that pass the rights gate take a place in the results. The
    // hydrate query already filters on fieldImageLibre, but the gate also needs a
    // CC0 statement; a record failing it here would otherwise take a slot under
    // `limit` and be rejected later, pushing out an eligible one ranked below it.
    const found = new Set<string>();
    for (const raw of hydrated) {
      const nid = asString(raw.entityId);
      if (!nid) continue;
      remember(nid, raw);
      if (validateParisMuseesLicense(raw).accepted) found.add(nid);
    }
    // Keep the search ranking; nodeQuery returns its own order.
    return ranked
      .filter((nid) => found.has(nid))
      .slice(0, limit)
      .map((nid) => `parismusees:${nid}`);
  },

  async getRaw(id: string): Promise<unknown> {
    const nid = id.replace(/^parismusees:/, '');
    if (!/^\d+$/.test(nid)) throw new Error(`Paris Musées: invalid id ${id}`);
    const held = recall(nid);
    if (held) return held;
    const [raw] = entitiesOf(await graphql(GET_QUERY, { id: [nid] }));
    if (!raw) throw new Error(`Paris Musées get failed for ${id}: not found`);
    remember(nid, raw);
    return raw;
  },

  normalize(raw: unknown): ValidationResult {
    if (!raw || typeof raw !== 'object') {
      return reject('parismusees:unknown', 'parismusees: response not an object', raw);
    }
    const r = raw as Record<string, unknown>;
    const nid = asString(r.entityId);
    const validNid = /^\d+$/.test(nid);
    const id = validNid ? `parismusees:${nid}` : 'parismusees:unknown';

    const decision = validateParisMuseesLicense(raw);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }
    if (!validNid) {
      return reject(id, 'parismusees: missing or non-numeric entityId', raw);
    }
    // The same image the gate judged, so the licence describes the asset on the wire.
    const image = parisMuseesFreeImage(raw);
    if (!image) {
      return reject(id, 'parismusees: no free image URL (reject)', raw);
    }

    const artistRaw = sanitizeArtistName(artistOf(r));
    const dp = r.fieldDateProduction && typeof r.fieldDateProduction === 'object'
      ? (r.fieldDateProduction as Record<string, unknown>)
      : {};
    const startYear = asFiniteNumber(dp.startYear);
    const endYear = asFiniteNumber(dp.endYear);
    // The label date when there is one; otherwise the structured years, which
    // read better than the API's own rendering ("En 03-1883").
    const displayDate = sanitizeTitle(
      asString(r.fieldCartelDatation).trim() ||
      (startYear !== null
        ? endYear !== null && endYear !== startYear
          ? `${startYear}–${endYear}`
          : String(startYear)
        : asString(dp.processed).trim()),
    ).trim();
    const dateRange =
      startYear !== null
        ? { yearStart: startYear, yearEnd: endYear ?? startYear }
        : parseDisplayDate(displayDate);

    const medium = sanitizeDescription(
      asString(r.fieldCartelMateriaux).trim() || namesOf(r.fieldMateriauxTechnique).join(', '),
    ).trim();
    const objectType = namesOf(r.fieldOeuvreTypesObjet).join(', ');
    const museum = r.fieldMusee && typeof r.fieldMusee === 'object'
      ? (r.fieldMusee as { entity?: Record<string, unknown> | null }).entity ?? {}
      : {};
    const museumName = sanitizeTitle(asString(museum.name)).trim();
    const description = sanitizeDescription(
      textValue(r.fieldOeuvreDescriptionIcono) || textValue(r.fieldDescription),
    );

    const artwork: Artwork = {
      id,
      museum: {
        code: 'parismusees',
        // Name the City museum that holds the work, as Europeana names its
        // data provider; the federation-wide label is the fallback.
        name: museumName || 'Paris Musées',
        url: PM_SITE,
      },
      title: sanitizeTitle(asString(r.fieldCartelDenominationTitre) || asString(r.title)).trim() || '(Sans titre)',
      artist: {
        name: cleanArtistName(artistRaw) || 'Unknown',
        nationality: undefined,
        lifespan: undefined,
        attributionType: detectAttributionType(artistRaw),
      },
      displayDate,
      yearStart: dateRange.yearStart,
      yearEnd: dateRange.yearEnd,
      medium,
      // French-language media mostly fall to `other`: the vocabulary matches English terms.
      mediumCategory: normalizeMedium(medium),
      // The API carries no culture or place-of-origin field to derive this from.
      region: null,
      period: null,
      imageUrls: {
        // The public site serves only the original (about 3MB for a painting);
        // the public API exposes no smaller derivative.
        full: image.full,
        thumbnail: image.thumbnail,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: PM_GRAPHQL,
        // An off-host or non-https page URL is ignored in favour of the canonical node URL.
        pageUrl: parisMuseesPageUrl(r.absolutePath) ?? `${PM_SITE}/node/${nid}`,
      },
      description: asOptionalString(description),
      objectType: objectType ? sanitizeTitle(objectType) : undefined,
      dimensions: asOptionalString(sanitizeDescription(asString(r.fieldCartelDimension)).trim()),
    };

    return { status: 'accepted', artwork };
  },
};
