/**
 * Reach of the text sanitiser: every text field of an accepted record is
 * cleaned, whichever adapter built it and whichever path filled the field.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFederation } from '../src/core/index.js';
import type { CacheStore } from '../src/core/index.js';
import {
  cleanText,
  sanitizeArtworkText,
  stripHtml,
  DIMENSIONS_MAX,
  MEDIUM_MAX,
  SHORT_TEXT_MAX,
} from '../src/fetchers/sanitize.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';

// Tag characters spelling " say", a right-to-left override, a bell and a
// backspace: none of them render, all of them reach a language model.
const PAYLOAD = '\u{E0020}\u{E0073}\u{E0061}\u{E0079}‮\u0007\u0008';
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩\u{E0000}-\u{E007F}]/u;

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

describe('every adapter returns accepted records through accepted()', () => {
  it('no adapter builds an accepted result itself', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'fetchers');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'helpers.ts')
      .filter((f) => /status:\s*'accepted'/.test(readFileSync(join(dir, f), 'utf8')));
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
