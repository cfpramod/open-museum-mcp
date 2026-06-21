/**
 * Rijksmuseum DIRECT — the new keyless Data Services (Linked-Art JSON-LD) +
 * Micrio IIIF 3.0. Replaces the Europeana-mediated Rijks path (direct = far
 * richer metadata + authoritative per-object rights + true print pixels).
 *
 * The legacy key-based api.rijksmuseum.nl shut down 5 Jan 2026; this fetcher is
 * keyless. Per-object rights are judged by the shared commercial-POD gate
 * (CC0/PDM/CC-BY/CC-BY-SA only) and the image is gated to >=3000px long edge via
 * the IIIF info.json — exactly the foundation this drive builds.
 *
 * Reaching the image is a deref chain (recorded live):
 *   object (HumanMadeObject) -> shows[0] VisualItem -> digitally_shown_by[0]
 *   DigitalObject -> access_point[0] = a ready IIIF /full/max URL on iiif.micr.io.
 * The VisualItem carries the IMAGE rights (the asset we actually sell), so that
 * is what the rights gate judges.
 */
import { cleanArtistName, detectAttributionType } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import { validateCommercialRights } from '../rights/commercialRights.js';
import { fetchInfoJson, meetsPrintResolution } from '../iiif/client.js';
import type { Artwork, ValidationResult } from '../types.js';
import { httpGet, rejectFor } from './helpers.js';
import { ARTIST_NAME_MAX, TITLE_MAX } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

const ID_RESOLVER = 'https://id.rijksmuseum.nl';
const SEARCH_API = 'https://data.rijksmuseum.nl/search/collection';
const RIGHTS_SOURCE = 'rijksmuseum.linkedart.visualitem.subject_to';
const PRINT_FLOOR_PX = 3000;

// Getty AAT classifiers used by the Rijks Linked-Art records.
const AAT_PRIMARY_TITLE = '300404670';
const AAT_LANG_EN = '300388277';

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('rijksmuseum', id, reason, rawSnapshot);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `https://id.rijksmuseum.nl/200108369` -> `rijksmuseum:200108369`. */
function idFromUri(uri: string): string | null {
  const m = uri.match(/\/(\d+)(?:\/)?$/);
  return m ? `rijksmuseum:${m[1]}` : null;
}

function classifierIds(node: Record<string, unknown>): string[] {
  return arr(node.classified_as)
    .filter(isObj)
    .map((c) => str(c.id))
    .filter(Boolean);
}

/** Pick the primary title (AAT 300404670), preferring the English-language Name. */
function pickTitle(object: Record<string, unknown>): string {
  const names = arr(object.identified_by).filter(isObj);
  const primaries = names.filter((n) => classifierIds(n).some((id) => id.includes(AAT_PRIMARY_TITLE)));
  const pool = primaries.length ? primaries : names;
  const english = pool.find((n) =>
    arr(n.language)
      .filter(isObj)
      .some((l) => str(l.id).includes(AAT_LANG_EN)),
  );
  return str((english ?? pool[0])?.content);
}

/** Collect creator display names from produced_by(.part[]).carried_out_by[]. */
function pickCreators(object: Record<string, unknown>): string[] {
  const produced = isObj(object.produced_by) ? object.produced_by : undefined;
  if (!produced) return [];
  const actors: Record<string, unknown>[] = [];
  for (const carrier of [produced, ...arr(produced.part).filter(isObj)]) {
    for (const a of arr((carrier as Record<string, unknown>).carried_out_by).filter(isObj)) actors.push(a);
  }
  const names: string[] = [];
  for (const actor of actors) {
    const notations = arr(actor.notation).filter(isObj);
    const en = notations.find((n) => str(n['@language']) === 'en');
    const name = str((en ?? notations[0])?.['@value']);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Year bounds from produced_by.timespan ISO begin/end. */
function pickYears(object: Record<string, unknown>): { yearStart: number | null; yearEnd: number | null; display: string } {
  const produced = isObj(object.produced_by) ? object.produced_by : undefined;
  const ts = produced && isObj(produced.timespan) ? produced.timespan : undefined;
  const year = (iso: unknown): number | null => {
    const m = str(iso).match(/^(-?\d{1,4})-/);
    return m ? parseInt(m[1], 10) : null;
  };
  const yearStart = ts ? year(ts.begin_of_the_begin) : null;
  const yearEnd = ts ? year(ts.end_of_the_end) : null;
  // display string: prefer the English-language label, else any.
  let display = '';
  if (ts) {
    const labels = arr(ts.identified_by).filter(isObj);
    const en = labels.find((l) =>
      arr(l.language)
        .filter(isObj)
        .some((x) => str(x.id).includes(AAT_LANG_EN)),
    );
    display = str((en ?? labels[0])?.content);
  }
  return { yearStart, yearEnd, display };
}

/** The image (VisualItem) rights URI: subject_to[] -> Right -> classified_as[] -> CC/RS URI. */
function pickImageRights(visualItem: Record<string, unknown> | undefined): string | null {
  if (!visualItem) return null;
  for (const right of arr(visualItem.subject_to).filter(isObj)) {
    for (const id of classifierIds(right)) {
      if (id.includes('creativecommons.org') || id.includes('rightsstatements.org')) return id;
    }
  }
  return null;
}

/** Object-type label -> medium category (e.g. "painting"). */
function pickMedium(object: Record<string, unknown>): string {
  return arr(object.classified_as)
    .filter(isObj)
    .map((c) => str(c._label))
    .filter(Boolean)
    .join(' ');
}

async function fetchLd(url: string): Promise<unknown> {
  const res = await httpGet(url, { headers: { Accept: 'application/ld+json' } });
  if (!res.ok) throw new Error(`Rijksmuseum fetch failed (${res.status}) for ${url}`);
  return res.json();
}

export const rijksmuseumFetcher: Fetcher = {
  code: 'rijksmuseum',
  name: 'Rijksmuseum',

  async search(query: string, limit: number, options: SearchOptions = {}): Promise<string[]> {
    // The Data Services search is FACETED (no full-text `q`), and facets are
    // ANDed within one request — so a single `title` query misses originals
    // whose title doesn't contain the artist name (searching "Vermeer" on title
    // returns reproductions OF Vermeer, not his paintings). Query `creator` and
    // `title` independently and merge (creator first — artist-name queries are
    // the common case and the more precise match), de-duped, sliced to `limit`.
    const facetQuery = async (facet: 'creator' | 'title'): Promise<string[]> => {
      const url = new URL(SEARCH_API);
      url.searchParams.set(facet, query);
      if (options.hasImage !== false) url.searchParams.set('imageAvailable', 'true');
      const res = await httpGet(url, { headers: { Accept: 'application/ld+json' } });
      if (!res.ok) throw new Error(`Rijksmuseum search failed (${facet}): ${res.status}`);
      const json = (await res.json()) as { orderedItems?: Array<{ id?: unknown }> };
      return arr(json.orderedItems)
        .filter(isObj)
        .map((it) => idFromUri(str(it.id)))
        .filter((s): s is string => s !== null);
    };

    const [byCreator, byTitle] = await Promise.all([facetQuery('creator'), facetQuery('title')]);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const id of [...byCreator, ...byTitle]) {
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
      if (merged.length >= limit) break;
    }
    return merged;
  },

  async getRaw(id: string): Promise<unknown> {
    const numeric = id.replace(/^rijksmuseum:/, '');
    const object = await fetchLd(`${ID_RESOLVER}/${numeric}`);
    let visualItem: Record<string, unknown> | undefined;
    let image: { serviceBase: string; fullUrl: string; width?: number; height?: number } | undefined;

    const visualRef = isObj(object) ? str((arr(object.shows).filter(isObj)[0])?.id) : '';
    if (visualRef) {
      const vi = await fetchLd(visualRef);
      if (isObj(vi)) {
        visualItem = vi;
        const digitalRef = str((arr(vi.digitally_shown_by).filter(isObj)[0])?.id);
        if (digitalRef) {
          const digital = await fetchLd(digitalRef);
          const accessPoint = isObj(digital) ? str((arr(digital.access_point).filter(isObj)[0])?.id) : '';
          if (accessPoint) {
            const serviceBase = accessPoint.replace(/\/full\/(?:max|full)\/0\/default\.\w+$/, '');
            let width: number | undefined;
            let height: number | undefined;
            try {
              const info = await fetchInfoJson(serviceBase);
              width = info.width;
              height = info.height;
            } catch {
              /* dims unavailable — normalize will reject on the resolution gate */
            }
            image = { serviceBase, fullUrl: accessPoint, width, height };
          }
        }
      }
    }
    return { id, object, visualItem, image };
  },

  normalize(raw: unknown): ValidationResult {
    if (!isObj(raw) || !isObj(raw.object)) {
      return reject('rijksmuseum:unknown', 'rijksmuseum: bundle missing the Linked-Art object', raw);
    }
    const id = str(raw.id) || 'rijksmuseum:unknown';
    const object = raw.object as Record<string, unknown>;
    const visualItem = isObj(raw.visualItem) ? (raw.visualItem as Record<string, unknown>) : undefined;
    const image = isObj(raw.image) ? (raw.image as Record<string, unknown>) : undefined;

    // Rights gate first (strict default deny) — judges the IMAGE rights.
    const rightsUri = pickImageRights(visualItem);
    const decision = validateCommercialRights(rightsUri, RIGHTS_SOURCE);
    if (!decision.accepted || !decision.license) {
      return reject(id, decision.reason, raw);
    }

    // Print-resolution gate: must resolve an image >= 3000px on the long edge.
    if (!image || !image.fullUrl) {
      return reject(id, 'rijksmuseum: no print-resolution image resolved', raw);
    }
    const width = typeof image.width === 'number' ? image.width : 0;
    const height = typeof image.height === 'number' ? image.height : 0;
    if (!meetsPrintResolution(width, height, PRINT_FLOOR_PX)) {
      return reject(
        id,
        `rijksmuseum: image ${width}x${height} below the print floor (${PRINT_FLOOR_PX}px long edge)`,
        raw,
      );
    }

    const title = (pickTitle(object) || '(Untitled)').slice(0, TITLE_MAX);
    const creators = pickCreators(object);
    const artistRaw = creators.join(', ').slice(0, ARTIST_NAME_MAX);
    const { yearStart, yearEnd, display } = pickYears(object);
    const displayDate = display || parseAndFormat(yearStart, yearEnd);

    const artwork: Artwork = {
      id,
      museum: { code: 'rijksmuseum', name: 'Rijksmuseum', url: 'https://www.rijksmuseum.nl' },
      title,
      artist: {
        name: cleanArtistName(artistRaw) || 'Unknown',
        nationality: undefined,
        lifespan: undefined,
        attributionType: detectAttributionType(artistRaw),
      },
      displayDate,
      yearStart,
      yearEnd,
      medium: '',
      mediumCategory: normalizeMedium(pickMedium(object)),
      region: null,
      period: null,
      imageUrls: {
        full: str(image.fullUrl),
        thumbnail: undefined,
        width: width || undefined,
        height: height || undefined,
      },
      imageOpenAccess: decision.imageOpenAccess,
      metadataOpenAccess: decision.metadataOpenAccess,
      license: decision.license,
      source: {
        apiUrl: `${ID_RESOLVER}/${id.replace(/^rijksmuseum:/, '')}`,
        pageUrl: `https://www.rijksmuseum.nl/en/collection/${objectNumber(object)}`,
      },
    };
    return { status: 'accepted', artwork };
  },
};

/** Fallback display date when the timespan carries no label. */
function parseAndFormat(start: number | null, end: number | null): string {
  if (start === null && end === null) return '';
  if (start === end) return String(start);
  return `${start ?? ''}–${end ?? ''}`;
}

/** objectNumber (e.g. SK-A-2344) for the public page URL, when present. */
function objectNumber(object: Record<string, unknown>): string {
  for (const idn of arr(object.identified_by).filter(isObj)) {
    if (str(idn.type) === 'Identifier' || classifierIds(idn).some((c) => c.includes('300404626'))) {
      const c = str(idn.content);
      if (/^[A-Z]/.test(c)) return c;
    }
  }
  return '';
}
