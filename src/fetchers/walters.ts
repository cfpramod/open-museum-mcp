import { parseDisplayDate } from '../dateParser.js';
import { validateWaltersLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asOptionalString, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// Walters Art Museum — the engine's FIRST ingest source. The Walters v1 REST API
// closed in 2023; the collection is published only as static CSV files. A
// build-time script (`scripts/build-walters-index.ts`) fetches + rights-gates +
// trims those CSVs into the committed `src/data/walters.json` bundle that ships in
// the package, so this adapter needs no network at all — search/getRaw run against
// the in-memory bundle. See CONTRIBUTING / the script header for the rights model.
const IMAGE_BASE = 'https://art.thewalters.org/images/raw';
const PURL_BASE = 'https://purl.thewalters.org/art';

/** One bundled object (compact keys to keep the shipped JSON small). */
export interface WaltersRecord {
  i: string; // ObjectID
  n: string; // ObjectNumber (accession)
  t: string; // Title
  d: string; // DateText (display date)
  a: number | null; // DateBeginYear
  b: number | null; // DateEndYear
  m: string; // Medium
  c: string; // Culture
  l: string; // Classification
  p: string; // Period
  y: string; // Dynasty
  k: string; // Keywords
  r: string; // Creator names, pipe-joined
  g: string; // primary image filename
}

export interface WaltersBundle {
  meta: Record<string, unknown>;
  objects: WaltersRecord[];
}

/**
 * Supplies the bundle to a fetcher instance. The default loader reads the
 * package-shipped `walters.json` via `node:fs` (lazily imported, so this module
 * stays Workers-safe to import); a Workers host injects its own loader instead —
 * e.g. a bundler-imported JSON asset — mirroring the `CacheStore` injection
 * pattern. Sync or async both work.
 */
export type WaltersBundleLoader = () => WaltersBundle | Promise<WaltersBundle>;

interface LoadedIndex {
  byId: Map<string, WaltersRecord>;
  /** Parallel arrays: record + its normalized searchable blob. */
  records: WaltersRecord[];
  blobs: string[];
}

/**
 * Normalize text for matching: lowercase, DROP apostrophes (so the museum's
 * "Qur'an" matches a "quran" query), and reduce every other non-alphanumeric run
 * to a single space. Used identically on the indexed blob and the query so the
 * two are always compared in the same shape.
 */
function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Default loader: read the package-shipped bundle from disk. Bundle path is
 * resolved relative to this module (dist/fetchers -> dist/data after build; the
 * build step copies src/data/walters.json into dist/data). `node:fs`/`node:url`
 * are imported DYNAMICALLY here — never statically at module top — so importing
 * this module (and therefore `/core`) stays safe in a Workers bundle; only
 * actually CALLING the default loader requires Node. The ~5MB JSON is read with
 * native readFileSync + JSON.parse — NOT a bundler-transformed JSON import,
 * which is pathologically slow on a file this size.
 */
async function defaultBundleLoader(): Promise<WaltersBundle> {
  let readFileSync: (typeof import('node:fs'))['readFileSync'];
  let fileURLToPath: (typeof import('node:url'))['fileURLToPath'];
  try {
    ({ readFileSync } = await import('node:fs'));
    ({ fileURLToPath } = await import('node:url'));
  } catch {
    throw new Error(
      'walters: the default bundle loader needs Node (node:fs). In a Workers ' +
        'runtime, construct the fetcher with createWaltersFetcher(loadBundle) and ' +
        'inject the walters.json bundle yourself.',
    );
  }
  const bundlePath = fileURLToPath(new URL('../data/walters.json', import.meta.url));
  return JSON.parse(readFileSync(bundlePath, 'utf-8')) as WaltersBundle;
}

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('walters', id, reason, rawSnapshot);

/**
 * Build a Walters fetcher over an injectable bundle source. Each instance lazily
 * loads + indexes the bundle ONCE on first use (processes that never query
 * Walters pay nothing) and caches it for the instance's lifetime. The default
 * instance below uses the Node fs loader; Workers hosts inject their own.
 */
export function createWaltersFetcher(
  loadBundle: WaltersBundleLoader = defaultBundleLoader,
): Fetcher {
  let indexPromise: Promise<LoadedIndex> | null = null;

  async function loadIndex(): Promise<LoadedIndex> {
    if (!indexPromise) {
      indexPromise = (async () => {
        const bundle = await loadBundle();
        const objects = bundle.objects ?? [];
        const byId = new Map<string, WaltersRecord>();
        const blobs: string[] = [];
        for (const r of objects) {
          byId.set(r.i, r);
          blobs.push(
            normalizeText(`${r.t} ${r.c} ${r.l} ${r.m} ${r.p} ${r.y} ${r.k} ${r.r} ${r.d}`),
          );
        }
        return { byId, records: objects, blobs };
      })();
    }
    return indexPromise;
  }

  return {
    code: 'walters',
    name: 'Walters Art Museum',
    hotlinkRestricted: true,

    // Local keyword search over the bundled index (no live API exists). OR-ranked:
    // a record qualifies if it matches ANY query token, and is ranked first by how
    // MANY distinct query tokens it matches, then by total occurrences. This gives a
    // federated source the right recall — "Persian manuscript" surfaces Persian works
    // and manuscripts even though the museum codes no single record as both (Persian
    // mss are catalogued "Iranian"/"Islamic"). Matching is punctuation-normalized so
    // "Quran" finds the museum's "Qur'an". `hasImage` is always satisfied — the
    // bundle only contains image-bearing records.
    async search(query: string, limit: number, _options: SearchOptions = {}): Promise<string[]> {
      const tokens = [...new Set(normalizeText(query).split(' ').filter(Boolean))];
      if (tokens.length === 0) return [];
      const { records, blobs } = await loadIndex();
      const scored: Array<{ id: string; distinct: number; hits: number }> = [];
      for (let idx = 0; idx < records.length; idx++) {
        const blob = blobs[idx];
        let distinct = 0;
        let hits = 0;
        for (const tok of tokens) {
          const n = blob.split(tok).length - 1;
          if (n > 0) {
            distinct++;
            hits += n;
          }
        }
        if (distinct > 0) scored.push({ id: records[idx].i, distinct, hits });
      }
      // Distinct-token coverage dominates; total occurrences break ties.
      scored.sort((a, b) => b.distinct - a.distinct || b.hits - a.hits);
      return scored.slice(0, limit).map((s) => `walters:${s.id}`);
    },

    async getRaw(id: string): Promise<unknown> {
      const numeric = id.replace(/^walters:/, '');
      const { byId } = await loadIndex();
      return byId.get(numeric) ?? null;
    },

    normalize(raw: unknown): ValidationResult {
      if (!raw || typeof raw !== 'object') {
        return reject('walters:unknown', 'walters: record not an object', raw);
      }
      const r = raw as WaltersRecord;
      const objectId = typeof r.i === 'string' && r.i.length > 0 ? r.i : '';
      const id = objectId ? `walters:${objectId}` : 'walters:unknown';

      const decision = validateWaltersLicense(raw);
      if (!decision.accepted || !decision.license) {
        return reject(id, decision.reason, raw);
      }
      if (!objectId) {
        return reject(id, 'walters: missing ObjectID', raw);
      }

      // Dates: trust the bundled integer years; fall back to parsing the display
      // string (dynasty-aware) when a bound is absent.
      const displayDate = typeof r.d === 'string' ? r.d : '';
      const dateRange =
        typeof r.a === 'number' && typeof r.b === 'number'
          ? { yearStart: r.a, yearEnd: r.b }
          : parseDisplayDate(displayDate);

      // Artist: the primary (first) creator name; pipe-joined extras are dropped to
      // a single attributed maker, matching the other adapters' single-artist shape.
      // Walters catalogs anonymous works with the CULTURE as the creator ("Egyptian",
      // "Persian", "Turkish"). A single-word creator that resolves to a region is a
      // culture label, not a person — treat it as anonymous rather than surfacing a
      // demonym as a named artist.
      const primaryRaw = ((typeof r.r === 'string' ? r.r : '').split('|')[0] ?? '').trim();
      const isCultureLabel =
        primaryRaw !== '' && !/\s/.test(primaryRaw) && normalizeRegion(primaryRaw) !== null;
      const primaryName = isCultureLabel ? '' : sanitizeArtistName(primaryRaw);
      const attributionType = primaryName ? detectAttributionType(primaryName) : 'anonymous';
      const cleanName = primaryName ? cleanArtistName(primaryName) : '';

      const image = typeof r.g === 'string' ? r.g : '';

      const artwork: Artwork = {
        id,
        museum: {
          code: 'walters',
          name: 'Walters Art Museum',
          url: 'https://thewalters.org',
        },
        title: sanitizeTitle(typeof r.t === 'string' ? r.t : '') || '(Untitled)',
        artist: {
          name: cleanName || 'Unknown',
          attributionType,
        },
        displayDate,
        yearStart: dateRange.yearStart,
        yearEnd: dateRange.yearEnd,
        medium: typeof r.m === 'string' ? r.m : '',
        mediumCategory: normalizeMedium(typeof r.m === 'string' ? r.m : ''),
        region: normalizeRegion(typeof r.c === 'string' ? r.c : ''),
        period: asOptionalString(r.p) ?? null,
        imageUrls: {
          full: `${IMAGE_BASE}/${image}`,
          thumbnail: undefined,
        },
        imageOpenAccess: decision.imageOpenAccess,
        metadataOpenAccess: decision.metadataOpenAccess,
        license: decision.license,
        source: {
          apiUrl: 'https://github.com/WaltersArtMuseum/api-thewalters-org',
          pageUrl: `${PURL_BASE}/${r.n}`,
        },
        description: asOptionalString(r.l),
      };

      return { status: 'accepted', artwork };
    },
  };
}

/** The default Walters fetcher: package-shipped bundle via the Node fs loader. */
export const waltersFetcher: Fetcher = createWaltersFetcher();
