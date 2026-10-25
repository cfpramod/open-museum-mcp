/**
 * Reach of the text sanitiser: every text field of an accepted record is
 * cleaned, whichever adapter built it and whichever path filled the field.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createFederation } from '../src/core/index.js';
import { Cache } from '../src/db.js';
import type { CacheStore } from '../src/core/index.js';
import {
  cleanText,
  sanitizeArtworkText,
  sanitizeText,
  stripHtml,
  ARTIST_NAME_MAX,
  DESCRIPTION_MAX,
  DIMENSIONS_MAX,
  MEDIUM_MAX,
  SHORT_TEXT_MAX,
  TITLE_MAX,
} from '../src/fetchers/sanitize.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';

// Tag characters spelling " say", a right-to-left override, a bell and a
// backspace: none of them render, all of them reach a language model.
const PAYLOAD = '\u{E0020}\u{E0073}\u{E0061}\u{E0079}\u202E\u0007\u0008';
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;

function makeArtwork(over: Partial<Artwork> = {}): Artwork {
  return {
    id: 'test:1',
    museum: { code: 'test', name: 'Test Museum', url: 'https://test.example' },
    title: 'Water Lilies',
    artist: { name: 'Claude Monet', attributionType: 'named' },
    displayDate: '1906',
    yearStart: 1906,
    yearEnd: 1906,
    medium: 'Oil on canvas',
    mediumCategory: 'painting',
    region: null,
    period: null,
    imageUrls: { full: 'https://img.example/1.jpg' },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: 'test.isPublicDomain',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'high',
    },
    source: { apiUrl: 'https://test.example/api/1', pageUrl: 'https://test.example/1' },
    ...over,
  };
}

// Every text field the record carries, with the two verbatim-by-contract
// fields left out on purpose.
function textFields(a: Artwork): Record<string, string | undefined | null> {
  return {
    'museum.name': a.museum.name,
    title: a.title,
    'artist.name': a.artist.name,
    'artist.nationality': a.artist.nationality,
    'artist.lifespan': a.artist.lifespan,
    displayDate: a.displayDate,
    medium: a.medium,
    region: a.region,
    period: a.period,
    description: a.description,
    objectType: a.objectType,
    dimensions: a.dimensions,
    ...Object.fromEntries((a.rawTags ?? []).map((t, i) => [`rawTags[${i}]`, t])),
  };
}

const dirty = (s: string) => `${s.slice(0, 3)}${PAYLOAD}${s.slice(3)}`;

function dirtyArtwork(): Artwork {
  return makeArtwork({
    museum: { code: 'test', name: dirty('Test Museum'), url: 'https://test.example' },
    title: dirty('Water Lilies'),
    artist: {
      name: dirty('Claude Monet'),
      nationality: dirty('French'),
      lifespan: dirty('1840-1926'),
      attributionType: 'named',
    },
    displayDate: dirty('1906'),
    medium: dirty('Oil on canvas'),
    region: dirty('france'),
    period: dirty('Impressionism'),
    description: dirty('Gift of a donor'),
    objectType: dirty('Painting'),
    dimensions: dirty('89.9 x 94.1 cm'),
    rawTags: [dirty('Flowers'), dirty('Water')],
  });
}

describe('cleanText', () => {
  const samples = [
    'Oil on canvas',
    ` a\u0096b\u0092c ${PAYLOAD} \t\n d `,
    '&lt;b&gt;',
    '‏‍️',
    '\u{E0100}x⁥⁪',
  ];

  it('is idempotent', () => {
    for (const s of samples) expect(cleanText(cleanText(s))).toBe(cleanText(s));
  });

  it('leaves stripHtml output unchanged, so the boundary never decodes twice', () => {
    for (const s of [...samples, '&amp;lt;i&amp;gt;', 'a&amp;#32;b', '<b>x</b>&nbsp;y']) {
      expect(cleanText(stripHtml(s))).toBe(stripHtml(s));
    }
  });

  it('decodes nothing', () => {
    expect(cleanText('&lt;b&gt; &amp; <i>')).toBe('&lt;b&gt; &amp; <i>');
  });
});

describe('sanitizeArtworkText', () => {
  it('removes invisible characters from every text field', () => {
    const out = sanitizeArtworkText(dirtyArtwork());
    for (const [field, value] of Object.entries(textFields(out))) {
      expect(typeof value === 'string' && INVISIBLE.test(value), field).toBe(false);
    }
    expect(out.title).toBe('Water Lilies');
    expect(out.medium).toBe('Oil on canvas');
    expect(out.artist.lifespan).toBe('1840-1926');
    expect(out.rawTags).toEqual(['Flowers', 'Water']);
  });

  it('leaves license.rawValue and provenance exactly as the source sent them', () => {
    const rawValue = `CC0${PAYLOAD}`;
    const raw = `Sold, Paris${PAYLOAD}`;
    const out = sanitizeArtworkText(
      makeArtwork({
        license: { ...makeArtwork().license, rawValue },
        provenance: { raw, rawFormat: 'text', entries: [{ description: raw }] },
      }),
    );
    expect(out.license.rawValue).toBe(rawValue);
    expect(out.provenance?.raw).toBe(raw);
    expect(out.provenance?.entries?.[0]?.description).toBe(raw);
  });

  it('is idempotent on its own output', () => {
    const once = sanitizeArtworkText(dirtyArtwork());
    expect(sanitizeArtworkText(once)).toEqual(once);
  });

  it('caps each field family', () => {
    const out = sanitizeArtworkText(
      makeArtwork({
        medium: 'm'.repeat(MEDIUM_MAX + 50),
        dimensions: 'd'.repeat(DIMENSIONS_MAX + 50),
        objectType: 'o'.repeat(SHORT_TEXT_MAX + 50),
        displayDate: '1'.repeat(SHORT_TEXT_MAX + 50),
        rawTags: ['t'.repeat(SHORT_TEXT_MAX + 50)],
      }),
    );
    expect(out.medium).toHaveLength(MEDIUM_MAX);
    expect(out.dimensions).toHaveLength(DIMENSIONS_MAX);
    expect(out.objectType).toHaveLength(SHORT_TEXT_MAX);
    expect(out.displayDate).toHaveLength(SHORT_TEXT_MAX);
    expect(out.rawTags?.[0]).toHaveLength(SHORT_TEXT_MAX);
  });

  it('gives a field that cleans to nothing the adapters\' fallback', () => {
    const out = sanitizeArtworkText(
      makeArtwork({
        museum: { code: 'test', name: PAYLOAD, url: 'https://test.example' },
        title: PAYLOAD,
        artist: { name: PAYLOAD, nationality: PAYLOAD, attributionType: 'named' },
        period: PAYLOAD,
        objectType: PAYLOAD,
        rawTags: [PAYLOAD, 'Water'],
      }),
    );
    expect(out.museum.name).toBe('test');
    expect(out.title).toBe('(Untitled)');
    expect(out.artist.name).toBe('Unknown');
    expect(out.artist.nationality).toBeUndefined();
    expect(out.period).toBeNull();
    expect(out.objectType).toBeUndefined();
    expect(out.rawTags).toEqual(['Water']);
  });

  it('keeps the characters scripts and emoji depend on', () => {
    const kept = 'Shahnāma ‏شاه‌نامه ❤️';
    expect(sanitizeArtworkText(makeArtwork({ medium: kept })).medium).toBe(kept);
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('caps', () => {
  const caps = { TITLE_MAX, DESCRIPTION_MAX, ARTIST_NAME_MAX, MEDIUM_MAX, DIMENSIONS_MAX, SHORT_TEXT_MAX };

  for (const [name, max] of Object.entries(caps)) {
    it(`${name}: a cut that lands after a space does not leave it`, () => {
      const out = sanitizeText(`${'a'.repeat(max - 1)} x`, max);
      expect(out).toBe('a'.repeat(max - 1));
      expect(sanitizeText(out, max)).toBe(out);
    });

    it(`${name}: a cut never splits a surrogate pair`, () => {
      const out = sanitizeText(`${'a'.repeat(max - 1)}\u{1F40E}z`, max);
      expect(LONE_SURROGATE.test(out)).toBe(false);
      expect(out).toBe('a'.repeat(max - 1));
    });
  }

  it('one pass of sanitizeArtworkText equals two when every field is cut at its cap', () => {
    const atCap = (max: number) => `${'a'.repeat(max - 1)} \u{1F40E}`;
    const once = sanitizeArtworkText(
      makeArtwork({
        title: atCap(TITLE_MAX),
        artist: { name: atCap(ARTIST_NAME_MAX), lifespan: atCap(ARTIST_NAME_MAX), attributionType: 'named' },
        medium: atCap(MEDIUM_MAX),
        description: atCap(DESCRIPTION_MAX),
        dimensions: atCap(DIMENSIONS_MAX),
        objectType: atCap(SHORT_TEXT_MAX),
        displayDate: atCap(SHORT_TEXT_MAX),
        rawTags: [atCap(SHORT_TEXT_MAX)],
      }),
    );
    expect(sanitizeArtworkText(once)).toEqual(once);
    for (const [field, value] of Object.entries(textFields(once))) {
      if (typeof value !== 'string') continue;
      expect(value.endsWith(' '), field).toBe(false);
      expect(LONE_SURROGATE.test(value), field).toBe(false);
    }
  });
});

describe('every adapter returns accepted records through accepted()', () => {
  // Only accepted() may spell the accepted status, in any quoting, so a
  // bypass cannot hide behind a different quote or a variable named status.
  const spellsAccepted = (src: string) => /(['"`])accepted\1/.test(src);

  it('the scan recognises every way of spelling the status', () => {
    for (const bypass of [
      "return { status: 'accepted', artwork };",
      'return { status: "accepted", artwork };',
      'return { status: `accepted`, artwork };',
      "const status = 'accepted' as const;\nreturn { status, artwork };",
      "return { artwork, status : 'accepted' };",
    ]) {
      expect(spellsAccepted(bypass), bypass).toBe(true);
    }
    expect(spellsAccepted('return accepted(artwork);')).toBe(false);
  });

  it('no adapter builds an accepted result itself', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'fetchers');
    const offenders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && f !== 'helpers.ts')
      .filter((f) => spellsAccepted(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('federation cache reads', () => {
  it('cleans a record cached before the sanitiser reached every field', async () => {
    const stale = dirtyArtwork();
    const store: CacheStore = {
      getObject: () => structuredClone(stale),
      upsertObject: () => {},
      getQuery: () => null,
      putQuery: () => {},
    };
    const fetcher: Fetcher = {
      code: 'test',
      name: 'Test',
      search: async () => [],
      getRaw: async () => {
        throw new Error('a cache hit must not reach the source');
      },
      normalize: () => {
        throw new Error('a cache hit must not normalize');
      },
    };
    const fed = createFederation({ fetchers: { test: fetcher }, cache: store });
    const out = await fed.getArtwork('test:1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const [field, value] of Object.entries(textFields(out.artwork))) {
      expect(typeof value === 'string' && INVISIBLE.test(value), field).toBe(false);
    }
  });
});

describe('local cache reads', () => {
  // A row written before every text field was sanitised, stored as it was.
  function withDirtyRow(fn: (cache: Cache) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'omm-reach-'));
    try {
      const cache = new Cache({ path: join(dir, 'cache.db') });
      cache.upsertObject(dirtyArtwork());
      fn(cache);
      cache.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const expectClean = (a: Artwork | null) => {
    expect(a).not.toBeNull();
    for (const [field, value] of Object.entries(textFields(a as Artwork))) {
      expect(typeof value === 'string' && INVISIBLE.test(value), field).toBe(false);
    }
  };

  it('getObject cleans the stored record', () => {
    withDirtyRow((cache) => expectClean(cache.getObject('test:1')));
  });

  it('getRandomObject cleans the stored record', () => {
    withDirtyRow((cache) => expectClean(cache.getRandomObject({})));
  });

  it('listTraditions cleans region and period tags', () => {
    withDirtyRow((cache) => {
      const { regions, periods } = cache.listTraditions();
      for (const t of [...regions, ...periods]) {
        expect(INVISIBLE.test(t.tag), t.tag).toBe(false);
        expect(INVISIBLE.test(t.label), t.label).toBe(false);
      }
      expect(regions.map((t) => t.tag)).toEqual(['france']);
      expect(periods.map((t) => t.tag)).toEqual(['impressionism']);
    });
  });

  it('counts a clean tag and a dirty tag that cleans to it together', () => {
    withDirtyRow((cache) => {
      cache.upsertObject(makeArtwork({ id: 'test:2', region: 'france' }));
      const france = cache.listTraditions().regions.find((t) => t.tag === 'france');
      expect(france?.coverage).toEqual({ test: 2 });
    });
  });

  it('does not list a tag made only of removed characters', () => {
    withDirtyRow((cache) => {
      cache.upsertObject(makeArtwork({ id: 'test:3', region: PAYLOAD, period: PAYLOAD }));
      const { regions, periods } = cache.listTraditions();
      expect(regions.map((t) => t.tag)).toEqual(['france']);
      expect(periods.map((t) => t.tag)).toEqual(['impressionism']);
    });
  });

  it('rewrites old rows when the cache opens, so a listed tag can be discovered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omm-reach-'));
    try {
      const path = join(dir, 'cache.db');
      const first = new Cache({ path });
      first.upsertObject({ ...dirtyArtwork(), period: dirty('impressionism') });
      first.close();
      // Simulate a file written before the rewrite existed.
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA user_version = 0');
      raw.close();

      const cache = new Cache({ path });
      const { regions, periods } = cache.listTraditions();
      expect(regions.map((t) => t.tag)).toEqual(['france']);
      expect(periods.map((t) => t.tag)).toEqual(['impressionism']);
      expectClean(cache.getRandomObject({ region: 'france' }));
      expectClean(cache.getRandomObject({ period: 'impressionism' }));
      expect(cache.getRandomObject({ notArtist: ['Claude Monet'] })).toBeNull();
      cache.close();

      const check = new DatabaseSync(path);
      const row = check.prepare('SELECT region, artist_name, full_record FROM objects').get() as {
        region: string;
        artist_name: string;
        full_record: string;
      };
      expect(row.region).toBe('france');
      expect(row.artist_name).toBe('Claude Monet');
      expect(INVISIBLE.test(row.full_record.replace(/\\u[0-9a-fA-F]{4}/g, (m) => JSON.parse(`"${m}"`)))).toBe(false);
      expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A file holding `count` rows stored before the rewrite existed.
  function oldCacheFile(dir: string, count: number): string {
    const path = join(dir, 'cache.db');
    const first = new Cache({ path });
    for (let i = 1; i <= count; i++) first.upsertObject({ ...dirtyArtwork(), id: `test:${i}` });
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 0');
    raw.close();
    return path;
  }

  const userVersion = (path: string): number => {
    const db = new DatabaseSync(path);
    try {
      return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  };

  // Another server on the same file: takes the write lock, says so, holds it
  // for holdMs, then commits.
  async function holdWriteLock(path: string, holdMs: number): Promise<{ released: Promise<void> }> {
    const child = spawn(
      process.execPath,
      [
        '--experimental-sqlite',
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.exec('BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));`,
        path,
        String(holdMs),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const released = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))));
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('locked')) resolve();
      });
      released.catch(reject);
    });
    return { released };
  }

  it('rewrites more rows than one batch holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omm-reach-'));
    try {
      const path = oldCacheFile(dir, 1203);
      new Cache({ path }).close();
      const check = new DatabaseSync(path);
      const rows = check.prepare('SELECT artist_name, region FROM objects').all() as Array<{
        artist_name: string;
        region: string;
      }>;
      check.close();
      expect(rows).toHaveLength(1203);
      expect(rows.filter((r) => r.artist_name !== 'Claude Monet' || r.region !== 'france')).toEqual([]);
      expect(userVersion(path)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits for another server holding the write lock, then rewrites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omm-reach-'));
    try {
      const path = oldCacheFile(dir, 3);
      const { released } = await holdWriteLock(path, 300);
      const cache = new Cache({ path });
      expectClean(cache.getObject('test:1'));
      cache.close();
      await released;
      expect(userVersion(path)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('opens and reads clean when the lock is held past the busy timeout, and rewrites at a later open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omm-reach-'));
    try {
      const path = oldCacheFile(dir, 3);
      const { released } = await holdWriteLock(path, 1500);
      const cache = new Cache({ path, busyTimeoutMs: 200 });
      expectClean(cache.getObject('test:1'));
      expectClean(cache.getRandomObject({}));
      // The filter columns keep the old text until the pass runs.
      expect(cache.getRandomObject({ region: 'france' })).toBeNull();
      cache.close();
      expect(userVersion(path)).toBe(0);
      await released;
      const later = new Cache({ path });
      expectClean(later.getRandomObject({ region: 'france' }));
      later.close();
      expect(userVersion(path)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('opens a read-only file, reads clean, and leaves the pass for later', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omm-reach-'));
    const path = oldCacheFile(dir, 3);
    try {
      chmodSync(path, 0o444);
      const cache = new Cache({ path });
      expectClean(cache.getObject('test:1'));
      cache.close();
      expect(userVersion(path)).toBe(0);
    } finally {
      chmodSync(path, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a stored record in one place only', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'db.ts'), 'utf8');
    expect(src.match(/JSON\.parse\(/g)?.length).toBe(2); // parseRecord + the query-cache id list
    expect(src).not.toMatch(/JSON\.parse\(row\.full_record/);
  });
});

// ---------------------------------------------------------------------------
// Per adapter, per field: wrap the raw value a field is read from in markup,
// an escaped ampersand and the invisible payload, and check the field comes
// out exactly as it does from the clean fixture. Markup and the reference are
// removed by the adapter's own sanitising; the payload by either.
// ---------------------------------------------------------------------------

const fixturesDir = join(import.meta.dirname, 'fixtures');
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));

const injected = (leaf: string) => `<b>${leaf.slice(0, 1)}</b>${PAYLOAD}${leaf.slice(1)}`;

interface Probe {
  fetcher: Fetcher;
  raw: () => unknown;
  // Fields that copy upstream text; each must be probed. A field read from a
  // leaf that differs from the output value (joined, reformatted) names it.
  fields: Array<string | [field: string, leaf: string]>;
}

function fieldValue(a: Artwork, field: string): string | undefined {
  return textFields(a)[field] ?? undefined;
}

// Replace every string leaf equal to `from`; returns how many were replaced.
function replaceLeaf(node: unknown, from: string, to: string): number {
  let n = 0;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (v === from) {
        node[i] = to;
        n++;
      } else n += replaceLeaf(v, from, to);
    });
  } else if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(rec)) {
      if (v === from) {
        rec[k] = to;
        n++;
      } else n += replaceLeaf(v, from, to);
    }
  }
  return n;
}

async function loadProbes(): Promise<Record<string, Probe>> {
  const { aicFetcher } = await import('../src/fetchers/aic.js');
  const { clevelandFetcher } = await import('../src/fetchers/cleveland.js');
  const { europeanaFetcher } = await import('../src/fetchers/europeana.js');
  const { gettyFetcher } = await import('../src/fetchers/getty.js');
  const { harvardFetcher } = await import('../src/fetchers/harvard.js');
  const { metFetcher } = await import('../src/fetchers/met.js');
  const { ngaFetcher } = await import('../src/fetchers/nga.js');
  const { rijksmuseumFetcher } = await import('../src/fetchers/rijksmuseum.js');
  const { smithsonianFetcher } = await import('../src/fetchers/smithsonian.js');
  const { smkFetcher } = await import('../src/fetchers/smk.js');
  const { waltersFetcher } = await import('../src/fetchers/walters.js');
  const { wellcomeFetcher } = await import('../src/fetchers/wellcome.js');
  const { wikimediaFetcher } = await import('../src/fetchers/wikimedia.js');
  const { ycbaFetcher } = await import('../src/fetchers/ycba.js');
  const ycba = fixture('ycba-accepted.json') as { record: unknown; manifest: unknown };
  return {
    aic: { fetcher: aicFetcher, raw: () => fixture('aic-accepted.json'), fields: ['title', 'displayDate', 'medium', 'objectType', 'dimensions'] },
    cleveland: { fetcher: clevelandFetcher, raw: () => fixture('cleveland-accepted.json'), fields: ['title', 'displayDate', 'medium', 'description'] },
    europeana: { fetcher: europeanaFetcher, raw: () => fixture('europeana-accepted-cc0.json'), fields: ['title', 'displayDate', 'museum.name'] },
    getty: {
      fetcher: gettyFetcher,
      raw: () => ({ object: fixture('getty-object-accepted.json'), media: fixture('getty-media-accepted.json') }),
      fields: [
        'title',
        'displayDate',
        'description',
        ['artist.nationality', 'Dutch, 1853 - 1890'],
        ['artist.lifespan', 'Dutch, 1853 - 1890'],
        ['medium', 'Oil Paint (Paint)'],
      ],
    },
    harvard: { fetcher: harvardFetcher, raw: () => fixture('harvard-accepted.json'), fields: ['title', 'displayDate', 'medium', 'period', 'description'] },
    met: {
      fetcher: metFetcher,
      // The Tang fixture is anonymous; give it an artist so those fields exist.
      raw: () => ({
        ...(fixture('met-tang-fixture.json') as object),
        artistNationality: 'Chinese',
        artistBeginDate: '1700',
        artistEndDate: '1750',
      }),
      fields: ['title', 'displayDate', 'medium', 'artist.nationality', ['artist.lifespan', '1700'], ['period', 'Tang dynasty'], 'rawTags[0]'],
    },
    nga: { fetcher: ngaFetcher, raw: () => fixture('nga-accepted.json'), fields: ['title', 'displayDate', 'medium', 'description'] },
    rijksmuseum: { fetcher: rijksmuseumFetcher, raw: () => fixture('rijksmuseum-accepted-milkmaid.json'), fields: ['title', 'artist.name', 'displayDate'] },
    smithsonian: { fetcher: smithsonianFetcher, raw: () => fixture('smithsonian-accepted.json'), fields: ['title', 'displayDate', 'medium'] },
    smk: { fetcher: smkFetcher, raw: () => fixture('smk-accepted.json'), fields: ['title', 'displayDate', 'medium', 'description'] },
    walters: {
      fetcher: waltersFetcher,
      // The fixture's period and classification are blank; fill both.
      raw: () => ({ ...(fixture('walters-accepted.json') as object), p: 'Mamluk', l: 'Manuscripts' }),
      fields: ['title', 'displayDate', 'medium', 'period', 'description'],
    },
    wellcome: { fetcher: wellcomeFetcher, raw: () => fixture('wellcome-accepted.json'), fields: ['title', 'displayDate'] },
    wikimedia: { fetcher: wikimediaFetcher, raw: () => fixture('wikimedia-accepted-cc0.json'), fields: ['title'] },
    ycba: {
      fetcher: ycbaFetcher,
      raw: () => ({
        ...structuredClone(ycba),
        manifestUrl: 'https://manifests.collections.yale.edu/v2/ycba/obj/5007',
      }),
      fields: ['title', 'displayDate', 'medium', 'objectType', 'dimensions'],
    },
  };
}

const probes = await loadProbes();

describe('every adapter is probed', () => {
  it('covers every registered source', async () => {
    const { FETCHER_REGISTRY } = await import('../src/core/index.js');
    expect(Object.keys(probes).sort()).toEqual(FETCHER_REGISTRY.map((e) => e.code).sort());
  });
});

for (const [code, probe] of Object.entries(probes)) {
  describe(`${code}: upstream text fields are sanitised`, () => {
    const base = probe.fetcher.normalize(probe.raw());
    if (base.status !== 'accepted') throw new Error(`${code} fixture is not accepted`);

    for (const spec of probe.fields) {
      const [field, leafOverride] = typeof spec === 'string' ? [spec, undefined] : spec;
      it(field, () => {
        const expected = fieldValue(base.artwork, field);
        expect(expected, `${field} is empty in the clean fixture`).toBeTruthy();
        const leaf = leafOverride ?? (expected as string);
        const raw = probe.raw();
        expect(replaceLeaf(raw, leaf, injected(leaf)), `no raw leaf equals ${JSON.stringify(leaf)}`).toBeGreaterThan(0);
        const out = probe.fetcher.normalize(raw);
        expect(out.status).toBe('accepted');
        if (out.status !== 'accepted') return;
        expect(fieldValue(out.artwork, field)).toBe(expected);
      });
    }
  });
}
