import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allSourcesFailed, createFederation, SearchParamsSchema, type CacheStore, type SourceStatus } from '../src/core/index.js';
import type { Fetcher, SearchOptions } from '../src/fetchers/types.js';
import { aicFetcher } from '../src/fetchers/aic.js';
import { clevelandFetcher } from '../src/fetchers/cleveland.js';
import { europeanaFetcher } from '../src/fetchers/europeana.js';
import { gettyFetcher } from '../src/fetchers/getty.js';
import { harvardFetcher } from '../src/fetchers/harvard.js';
import { metFetcher } from '../src/fetchers/met.js';
import { FETCHER_REGISTRY } from '../src/fetchers/registry.js';
import { rijksmuseumFetcher } from '../src/fetchers/rijksmuseum.js';
import { smithsonianFetcher } from '../src/fetchers/smithsonian.js';
import { smkFetcher } from '../src/fetchers/smk.js';
import { wellcomeFetcher } from '../src/fetchers/wellcome.js';
import { wikimediaFetcher } from '../src/fetchers/wikimedia.js';
import { ycbaFetcher } from '../src/fetchers/ycba.js';
import type { Artwork } from '../src/types.js';

function makeArtwork(id: string): Artwork {
  const code = id.slice(0, id.indexOf(':'));
  return {
    id,
    museum: { code, name: code.toUpperCase(), url: `https://${code}.example` },
    title: `Work ${id}`,
    artist: { name: 'Anon', attributionType: 'named' },
    displayDate: '1700',
    yearStart: 1700,
    yearEnd: 1700,
    medium: 'oil',
    mediumCategory: 'painting',
    region: null,
    period: null,
    imageUrls: { full: `https://img.example/${id}.jpg` },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: `${code}.test`,
      verifiedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'high',
    },
    source: { apiUrl: `https://${code}.example/api/${id}`, pageUrl: `https://${code}.example/${id}` },
  };
}

function memoryCache() {
  const queries = new Map<string, string[]>();
  const objects = new Map<string, Artwork>();
  const store: CacheStore = {
    getObject: (id) => objects.get(id) ?? null,
    upsertObject: (a) => {
      objects.set(a.id, a);
    },
    getQuery: (k) => queries.get(k) ?? null,
    putQuery: (k, ids) => {
      queries.set(k, ids);
    },
  };
  return { store, queries };
}

type SearchImpl = (query: string, limit: number, options?: SearchOptions) => Promise<string[]>;

function source(code: string, search: SearchImpl): Fetcher {
  return {
    code,
    name: code,
    search,
    async getRaw(id: string) {
      return { id };
    },
    normalize(raw: unknown) {
      return { status: 'accepted', artwork: makeArtwork((raw as { id: string }).id) };
    },
  } as Fetcher;
}

const answers = (code: string, ids: string[]) => source(code, async () => ids);
/** Never settles and never looks at the signal: the worst-behaved host fetcher. */
const hangsIgnoringSignal = (code: string) => source(code, () => new Promise<string[]>(() => undefined));
/** Hangs, but rejects the way fetch does when its signal aborts. */
function hangsHonouringSignal(code: string, seen: { signal?: AbortSignal }) {
  return source(
    code,
    (_q, _l, options) =>
      new Promise<string[]>((_resolve, reject) => {
        seen.signal = options?.signal;
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
      }),
  );
}

const params = (over: Record<string, unknown> = {}) => SearchParamsSchema.parse({ query: 'horse', ...over });

function build(fetchers: Fetcher[], extra: { sourceTimeoutMs?: number; onSourceFailure?: (s: SourceStatus) => void } = {}) {
  const cache = memoryCache();
  const federation = createFederation({
    fetchers: Object.fromEntries(fetchers.map((f) => [f.code, f])),
    cache: cache.store,
    ...extra,
  });
  return { federation, cache };
}

describe('per-source search timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a hung source reports timeout while the others answer', async () => {
    const onSourceFailure = vi.fn();
    const { federation } = build([hangsIgnoringSignal('met'), answers('aic', ['aic:2'])], { sourceTimeoutMs: 1000, onSourceFailure });
    const pending = federation.search(params());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.results.map((r) => r.id)).toEqual(['aic:2']);
    const met = result.sources.find((s) => s.museum === 'met');
    expect(met?.status).toBe('timeout');
    expect(met?.error).toContain('1000ms');
    expect(result.sources.find((s) => s.museum === 'aic')?.status).toBe('ok');
    expect(onSourceFailure).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying request, not just the wait', async () => {
    const seen: { signal?: AbortSignal } = {};
    const { federation } = build([hangsHonouringSignal('met', seen), answers('aic', ['aic:2'])], { sourceTimeoutMs: 500 });
    const pending = federation.search(params());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.signal).toBeDefined();
    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(seen.signal?.aborted).toBe(true);
  });

  it('the bound is configurable: slow but inside the bound succeeds, outside it times out', async () => {
    const slow = (code: string, ms: number, ids: string[]) =>
      source(code, () => new Promise<string[]>((resolve) => setTimeout(() => resolve(ids), ms)));

    const wide = build([slow('met', 800, ['met:1'])], { sourceTimeoutMs: 1000 });
    const wideP = wide.federation.search(params());
    await vi.advanceTimersByTimeAsync(800);
    expect((await wideP).sources[0]).toMatchObject({ museum: 'met', status: 'ok' });

    const narrow = build([slow('met', 800, ['met:1'])], { sourceTimeoutMs: 500 });
    const narrowP = narrow.federation.search(params());
    await vi.advanceTimersByTimeAsync(500);
    expect((await narrowP).sources[0]).toMatchObject({ museum: 'met', status: 'timeout' });
  });

  it('defaults to 15 seconds', async () => {
    const { federation } = build([hangsIgnoringSignal('met'), answers('aic', ['aic:2'])]);
    let settled = false;
    const pending = federation.search(params()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.sources.find((s) => s.museum === 'met')?.status).toBe('timeout');
  });

  it('does not cache a result that contains a timeout', async () => {
    const { federation, cache } = build([hangsIgnoringSignal('met'), answers('aic', ['aic:2'])], { sourceTimeoutMs: 100 });
    const pending = federation.search(params());
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(cache.queries.size).toBe(0);
  });

  it('every source timing out is a total failure', async () => {
    const { federation } = build([hangsIgnoringSignal('met'), hangsIgnoringSignal('aic')], { sourceTimeoutMs: 100 });
    const pending = federation.search(params());
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.count).toBe(0);
    expect(result.sources.map((s) => s.status)).toEqual(['timeout', 'timeout']);
    expect(allSourcesFailed(result.sources)).toBe(true);
  });

  it('facets are bounded the same way', async () => {
    const { federation } = build([hangsIgnoringSignal('met'), answers('aic', ['aic:2'])], { sourceTimeoutMs: 100 });
    const pending = federation.facets(params());
    await vi.advanceTimersByTimeAsync(100);
    const facets = await pending;
    expect(facets.sources.find((s) => s.museum === 'met')?.status).toBe('timeout');
    expect(facets.medium).toEqual([{ value: 'painting', count: 1 }]);
  });

  it('leaves no timer running once every source has answered', async () => {
    const { federation } = build([answers('met', ['met:1']), answers('aic', ['aic:2'])], { sourceTimeoutMs: 60_000 });
    await federation.search(params());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a source that fails fast keeps its own error, not a timeout', async () => {
    const { federation } = build(
      [source('met', async () => { throw new Error('Met search failed: 410'); }), answers('aic', ['aic:2'])],
      { sourceTimeoutMs: 1000 },
    );
    const result = await federation.search(params());
    expect(result.sources.find((s) => s.museum === 'met')).toMatchObject({ status: 'error', error: 'Met search failed: 410' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unusable bound (%s)', (bad) => {
    expect(() => build([answers('met', [])], { sourceTimeoutMs: bad })).toThrow(RangeError);
  });

  it.each([2 ** 31, 2 ** 31 + 1, 1e12, Number.MAX_VALUE])(
    'a bound above the largest timer delay (%s) does not fire at once',
    async (huge) => {
      const { federation } = build([hangsIgnoringSignal('met'), answers('aic', ['aic:2'])], { sourceTimeoutMs: huge });
      let settled = false;
      const pending = federation.search(params()).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      const result = await pending;
      expect(result.sources.find((s) => s.museum === 'met')?.status).toBe('timeout');
      expect(result.sources.find((s) => s.museum === 'aic')?.status).toBe('ok');
    },
  );

  it('the largest timer delay itself is accepted unchanged', async () => {
    const { federation } = build([hangsIgnoringSignal('met'), answers('aic', ['aic:2'])], { sourceTimeoutMs: 2 ** 31 - 1 });
    const pending = federation.search(params());
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    const result = await pending;
    expect(result.sources.find((s) => s.museum === 'met')?.status).toBe('timeout');
  });
});

describe('every live fetcher forwards the abort signal to its search request', () => {
  const live: Array<[string, Fetcher]> = [
    ['aic', aicFetcher],
    ['cleveland', clevelandFetcher],
    ['europeana', europeanaFetcher],
    ['getty', gettyFetcher],
    ['harvard', harvardFetcher],
    ['met', metFetcher],
    ['rijksmuseum', rijksmuseumFetcher],
    ['smithsonian', smithsonianFetcher],
    ['smk', smkFetcher],
    ['wellcome', wellcomeFetcher],
    ['wikimedia', wikimediaFetcher],
    ['ycba', ycbaFetcher],
  ];

  it('covers every source that searches live', () => {
    const expected = FETCHER_REGISTRY.filter((f) => !f.ingestOnly).map((f) => f.code);
    expect(live.map(([code]) => code).sort()).toEqual(expected.sort());
  });

  beforeEach(() => {
    vi.stubEnv('EUROPEANA_API_KEY', 'test-key');
    vi.stubEnv('HARVARD_API_KEY', 'test-key');
    vi.stubEnv('SMITHSONIAN_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(live)('%s', async (_code, fetcher) => {
    const signals: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const controller = new AbortController();
    // The response shape is not a real search answer, so the adapter may throw
    // while parsing it; only the request it made matters here.
    await fetcher.search('horse', 5, { hasImage: true, signal: controller.signal }).catch(() => undefined);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) expect(s?.aborted).toBe(false);
    controller.abort();
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
  });
});
