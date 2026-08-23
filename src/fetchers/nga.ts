import { parseDisplayDate } from '../dateParser.js';
import { validateNgaLicense } from '../licenseGate.js';
import { cleanArtistName, detectAttributionType, normalizeRegion } from '../mappings.js';
import { normalizeMedium } from '../medium.js';
import type { Artwork, ValidationResult } from '../types.js';
import { asOptionalString, pickMaxResolution, rejectFor } from './helpers.js';
import { sanitizeArtistName, sanitizeTitle } from './sanitize.js';
import type { Fetcher, SearchOptions } from './types.js';

// National Gallery of Art (Washington) — INGEST. NGA has no live query API; its
// collection is published as CC0 CSVs (github.com/NationalGalleryOfArt/opendata).
// A build-time script (scripts/build-nga-index.ts) joins objects ⨝ open-access
// images and writes the GZIPPED bundle src/data/nga.json.gz (~3.6MB; 63k works)
// that ships in the package — so it works offline with no key. The adapter
// decompresses + indexes the bundle on first use; search/getRaw run in-memory.
const IIIF_BASE = 'https://api.nga.gov/iiif';
const NGA_PAGE = 'https://www.nga.gov/collection/art-object-page';

interface NgaRecord {
  i: string; // objectid
  t: string; // title
  d: string; // displaydate
  a: number | null; // beginyear
  b: number | null; // endyear
  m: string; // medium
  c: string; // attribution (artist)
  l: string; // classification
  g: string; // IIIF image uuid
  w: number; // image width
  h: number; // image height
  o: number; // open-access flag (1)
}

export interface NgaBundle {
  meta: Record<string, unknown>;
  objects: NgaRecord[];
}

/**
 * Supplies the bundle to a fetcher instance. The default loader reads +
 * gunzips the package-shipped `nga.json.gz` via dynamically-imported
 * `node:fs`/`node:url`/`node:zlib` (so this module stays Workers-safe to
 * import); a Workers host injects its own loader instead — e.g. a
 * bundler-imported asset — mirroring the Walters `WaltersBundleLoader`
 * pattern. Sync or async both work.
 */
export type NgaBundleLoader = () => NgaBundle | Promise<NgaBundle>;

interface LoadedIndex {
  byId: Map<string, NgaRecord>;
  records: NgaRecord[];
  blobs: string[];
}

/**
 * Default loader: decompress + read the package-shipped gzipped bundle from
 * disk. `node:fs`/`node:url`/`node:zlib` are imported DYNAMICALLY here — never
 * statically at module top — so importing this module (and therefore `/core`)
 * stays safe in a Workers bundle; only actually CALLING the default loader
 * requires Node.
 */
async function defaultBundleLoader(): Promise<NgaBundle> {
  let readFileSync: (typeof import('node:fs'))['readFileSync'];
  let fileURLToPath: (typeof import('node:url'))['fileURLToPath'];
  let gunzipSync: (typeof import('node:zlib'))['gunzipSync'];
  try {
    ({ readFileSync } = await import('node:fs'));
    ({ fileURLToPath } = await import('node:url'));
    ({ gunzipSync } = await import('node:zlib'));
  } catch {
    throw new Error(
      'nga: the default bundle loader needs Node (node:fs/node:zlib). In a Workers ' +
        'runtime, construct the fetcher with createNgaFetcher(loadBundle) and inject ' +
        'the decompressed nga.json bundle yourself.',
    );
  }
  const bundlePath = fileURLToPath(new URL('../data/nga.json.gz', import.meta.url));
  return JSON.parse(gunzipSync(readFileSync(bundlePath)).toString('utf-8')) as NgaBundle;
}

const reject = (id: string, reason: string, rawSnapshot: unknown): ValidationResult =>
  rejectFor('nga', id, reason, rawSnapshot);

/**
 * Build an NGA fetcher over an injectable bundle source. Each instance lazily
 * loads + indexes the bundle ONCE on first use and caches it for the
 * instance's lifetime. The default instance below uses the Node fs+zlib
 * loader; Workers hosts inject their own.
 */
export function createNgaFetcher(loadBundle: NgaBundleLoader = defaultBundleLoader): Fetcher {
  let indexPromise: Promise<LoadedIndex> | null = null;

  async function loadIndex(): Promise<LoadedIndex> {
    if (!indexPromise) {
      indexPromise = (async () => {
        const bundle = await loadBundle();
        const objects = bundle.objects ?? [];
        const byId = new Map<string, NgaRecord>();
        const blobs: string[] = [];
        for (const r of objects) {
          byId.set(r.i, r);
          blobs.push(`${r.t} ${r.c} ${r.l} ${r.m} ${r.d}`.toLowerCase());
        }
        return { byId, records: objects, blobs };
      })();
    }
    return indexPromise;
  }

  return {
    code: 'nga',
    name: 'National Gallery of Art',
    ingestOnly: true,

    // Local keyword search over the bundled index (no live API). AND semantics
    // ranked by total token hits. `hasImage` is always satisfied (bundle is
    // image-bearing only).
    async search(query: string, limit: number, _options: SearchOptions = {}): Promise<string[]> {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const { records, blobs } = await loadIndex();
      const scored: Array<{ id: string; score: number }> = [];
      for (let idx = 0; idx < records.length; idx++) {
        const blob = blobs[idx];
        let score = 0;
        let matchedAll = true;
        for (const tok of tokens) {
          const hits = blob.split(tok).length - 1;
          if (hits === 0) { matchedAll = false; break; }
          score += hits;
        }
        if (matchedAll) scored.push({ id: records[idx].i, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((s) => `nga:${s.id}`);
    },

    async getRaw(id: string): Promise<unknown> {
      const numeric = id.replace(/^nga:/, '');
      const { byId } = await loadIndex();
      return byId.get(numeric) ?? null;
    },

    normalize(raw: unknown): ValidationResult {
      if (!raw || typeof raw !== 'object') {
        return reject('nga:unknown', 'nga: record not an object', raw);
      }
      const r = raw as NgaRecord;
      const objectId = typeof r.i === 'string' && r.i.length > 0 ? r.i : '';
      const id = objectId ? `nga:${objectId}` : 'nga:unknown';

      const decision = validateNgaLicense(raw);
      if (!decision.accepted || !decision.license) {
        return reject(id, decision.reason, raw);
      }
      if (!objectId) {
        return reject(id, 'nga: missing objectid', raw);
      }

      const displayDate = typeof r.d === 'string' ? r.d : '';
      const dateRange =
        typeof r.a === 'number' && typeof r.b === 'number'
          ? { yearStart: r.a, yearEnd: r.b }
          : parseDisplayDate(displayDate);

      const artistRaw = sanitizeArtistName(typeof r.c === 'string' ? r.c : '');
      const attributionType = detectAttributionType(artistRaw);
      const cleanName = cleanArtistName(artistRaw);

      const width = typeof r.w === 'number' && r.w > 0 ? r.w : undefined;
      const height = typeof r.h === 'number' && r.h > 0 ? r.h : undefined;

      const artwork: Artwork = {
        id,
        museum: {
          code: 'nga',
          name: 'National Gallery of Art',
          url: 'https://www.nga.gov',
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
        // NGA records no structured culture/place in the dump; region stays null
        // unless the attribution carries one (rare). Honest absence over a guess.
        region: normalizeRegion(typeof r.c === 'string' ? r.c : ''),
        period: null,
        imageUrls: {
          // NGA IIIF Image API: full-resolution request off the service base.
          full: `${IIIF_BASE}/${r.g}/full/full/0/default.jpg`,
          thumbnail: `${IIIF_BASE}/${r.g}/full/!200,200/0/default.jpg`,
          width,
          height,
          maxResolution: pickMaxResolution({ width, height }),
        },
        imageOpenAccess: decision.imageOpenAccess,
        metadataOpenAccess: decision.metadataOpenAccess,
        license: decision.license,
        source: {
          apiUrl: 'https://github.com/NationalGalleryOfArt/opendata',
          pageUrl: `${NGA_PAGE}.${objectId}.html`,
        },
        description: asOptionalString(r.l),
      };

      return { status: 'accepted', artwork };
    },
  };
}

/** The default NGA fetcher: package-shipped gzipped bundle via the Node fs+zlib loader. */
export const ngaFetcher: Fetcher = createNgaFetcher();
