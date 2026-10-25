import { describe, expect, it, vi } from 'vitest';
import { createFederation, SearchParamsSchema, type CacheStore, type SourceStatus } from '../src/core/index.js';
import { classifyFailure, sanitizeSourceError } from '../src/core/sourceStatus.js';
import { totalFailureResult } from '../src/totalFailure.js';
import type { Fetcher } from '../src/fetchers/types.js';
import type { Artwork } from '../src/types.js';
import { BOUNDED_CEILING, growthRatioOf } from './helpers/growth.js';

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

/** A source that answers with `ids`, or throws `failWith` from search. */
function source(code: string, opts: { ids?: string[]; failWith?: unknown } = {}): Fetcher {
  return {
    code,
    name: code,
    async search() {
      if (opts.failWith !== undefined) throw opts.failWith;
      return opts.ids ?? [];
    },
    async getRaw(id: string) {
      return { id };
    },
    normalize(raw: unknown) {
      const id = (raw as { id: string }).id;
      return { status: 'accepted', artwork: makeArtwork(id) };
    },
  } as Fetcher;
}

function build(fetchers: Fetcher[], extra: { onSourceFailure?: (s: SourceStatus) => void } = {}) {
  const cache = memoryCache();
  const federation = createFederation({
    fetchers: Object.fromEntries(fetchers.map((f) => [f.code, f])),
    cache: cache.store,
    ...extra,
  });
  return { federation, cache };
}

const params = (over: Record<string, unknown> = {}) => SearchParamsSchema.parse({ query: 'horse', ...over });

describe('search reports each source instead of dropping its error', () => {
  it('lists every queried source as ok with a timing when all answer', async () => {
    const { federation } = build([source('met', { ids: ['met:1'] }), source('aic', { ids: ['aic:2'] })]);
    const result = await federation.search(params());
    expect(result.count).toBe(2);
    expect(result.sources.map((s) => [s.museum, s.status])).toEqual([
      ['met', 'ok'],
      ['aic', 'ok'],
    ]);
    expect(result.sources.every((s) => typeof s.ms === 'number' && s.error === undefined)).toBe(true);
  });

  it('keeps a throwing source out of the results but names it, with its message', async () => {
    const { federation } = build([
      source('met', { failWith: new Error('Met search failed: 410') }),
      source('aic', { ids: ['aic:2'] }),
    ]);
    const result = await federation.search(params());
    expect(result.results.map((a) => a.id)).toEqual(['aic:2']);
    expect(result.sources.find((s) => s.museum === 'met')).toMatchObject({
      status: 'error',
      error: 'Met search failed: 410',
    });
    expect(result.sources.find((s) => s.museum === 'aic')?.status).toBe('ok');
  });

  it('reports a timeout-shaped failure as timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { federation } = build([source('met', { failWith: timeout }), source('aic', { ids: ['aic:2'] })]);
    const result = await federation.search(params());
    expect(result.sources.find((s) => s.museum === 'met')?.status).toBe('timeout');
  });

  it("delivers a fetcher's actionable message to the client output (the Getty wording)", async () => {
    const message =
      'Getty search is unavailable: data.getty.edu now rejects unauthenticated SPARQL requests (HTTP 401). Known Getty artworks can still be fetched by id; search needs an access token from the Getty.';
    const { federation } = build([source('getty', { failWith: new Error(message) })]);
    const result = await federation.search(params({ museum: 'getty' }));
    expect(result.sources[0].error).toBe(message);
  });

  it('total failure: count is 0 but every source is an error, and the tool call is an error', async () => {
    const { federation } = build([
      source('met', { failWith: new Error('Met search failed: 410') }),
      source('getty', { failWith: new Error('Getty search is unavailable (HTTP 401)') }),
    ]);
    const result = await federation.search(params());
    expect(result.count).toBe(0);
    expect(result.sources.map((s) => s.status)).toEqual(['error', 'error']);
    const out = totalFailureResult('search_artworks', result.sources);
    expect(out?.isError).toBe(true);
    expect(out?.content[0].text).toContain('met: error: Met search failed: 410');
    expect(out?.content[0].text).toContain('getty: error: Getty search is unavailable (HTTP 401)');
  });

  it('partial failure is NOT a tool error; a genuine empty result is not an error either', async () => {
    const partial = build([source('met', { failWith: new Error('boom') }), source('aic', { ids: ['aic:2'] })]);
    expect(totalFailureResult('search_artworks', (await partial.federation.search(params())).sources)).toBeNull();
    const empty = build([source('met'), source('aic')]);
    const emptyResult = await empty.federation.search(params());
    expect(emptyResult.count).toBe(0);
    expect(totalFailureResult('search_artworks', emptyResult.sources)).toBeNull();
  });

  it('does not cache a result with a failed source, and does cache a clean one', async () => {
    const failing = build([source('met', { failWith: new Error('boom') }), source('aic', { ids: ['aic:2'] })]);
    await failing.federation.search(params());
    expect(failing.cache.queries.size).toBe(0);
    const clean = build([source('met', { ids: ['met:1'] })]);
    await clean.federation.search(params());
    expect(clean.cache.queries.size).toBe(1);
  });

  it('reports a cached query as ok per source, without a timing', async () => {
    const { federation } = build([source('met', { ids: ['met:1'] })]);
    await federation.search(params());
    const second = await federation.search(params());
    expect(second.sources).toEqual([{ museum: 'met', status: 'ok' }]);
  });

  it('emits one hook call per failed source, with the sanitised message', async () => {
    const onSourceFailure = vi.fn();
    const { federation } = build(
      [source('met', { failWith: new Error('boom') }), source('aic', { ids: ['aic:2'] })],
      { onSourceFailure },
    );
    await federation.search(params());
    expect(onSourceFailure).toHaveBeenCalledTimes(1);
    expect(onSourceFailure.mock.calls[0][0]).toMatchObject({ museum: 'met', status: 'error', error: 'boom' });
  });

  it('facets carries the same per-source status', async () => {
    const { federation } = build([
      source('met', { failWith: new Error('Met search failed: 410') }),
      source('aic', { ids: ['aic:2'] }),
    ]);
    const facets = await federation.facets(params());
    expect(facets.sources.map((s) => [s.museum, s.status])).toEqual([
      ['met', 'error'],
      ['aic', 'ok'],
    ]);
  });
});

describe('error redaction: nothing secret leaves the engine', () => {
  const KEY = 'sk-live-0123456789abcdef';

  it('never passes a keyed URL through the result or the hook', async () => {
    const onSourceFailure = vi.fn();
    const err = new Error(`request to https://api.example.org/v1/search?q=horse&api_key=${KEY}&apikey=${KEY} failed`);
    const { federation } = build([source('met', { failWith: err }), source('aic', { ids: ['aic:2'] })], {
      onSourceFailure,
    });
    const result = await federation.search(params());
    const shown = JSON.stringify(result.sources) + JSON.stringify(onSourceFailure.mock.calls);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain('api_key');
    expect(shown).toContain('https://api.example.org');
  });

  it.each([
    ['userinfo in a URL', `fetch failed for https://user:${KEY}@host.example/x`],
    ['a path-borne key', `GET https://host.example/${KEY}/objects returned 500`],
    ['a bare key=value', `bad request: api-key=${KEY}`],
    ['an Authorization header', `response headers:\nAuthorization: Bearer ${KEY}`],
    ['a Bearer token inline', `rejected Bearer ${KEY} for host`],
    ['an x-api-key header', `x-api-key: ${KEY}`],
    ['a cookie header', `Cookie: session=${KEY}`],
    ['an access_token', `https://host.example/o?access_token=${KEY}`],
  ])('redacts %s', (_label, message) => {
    expect(sanitizeSourceError(new Error(message))).not.toContain(KEY);
  });

  it('drops a stack trace and keeps a single line', () => {
    const err = new Error('Met search failed: 410\n    at metFetcher.search (/home/u/src/fetchers/met.ts:42:11)\n    at async Promise.all');
    const out = sanitizeSourceError(err);
    expect(out).toBe('Met search failed: 410');
    expect(out).not.toContain('/home/u');
  });

  it('strips an inline stack frame from a one-line message', () => {
    expect(sanitizeSourceError(new Error('failed at fn (/srv/app/x.js:1:2)'))).toBe('failed');
  });

  it('caps a long message and survives non-Error throws', () => {
    expect(sanitizeSourceError(new Error('x'.repeat(2000))).length).toBeLessThanOrEqual(300);
    expect(sanitizeSourceError('plain string')).toBe('plain string');
    expect(sanitizeSourceError(undefined)).toBe('source failed');
    expect(sanitizeSourceError(new Error(''))).toBe('source failed');
  });

  it('keeps the wording a client needs (host, status, guidance)', () => {
    const msg = 'Getty search is unavailable: data.getty.edu now rejects unauthenticated SPARQL requests (HTTP 401). Known Getty artworks can still be fetched by id; search needs an access token from the Getty.';
    expect(sanitizeSourceError(new Error(msg))).toBe(msg);
  });
});

describe('classifyFailure', () => {
  it('detects timeouts by name, code, wrapped cause and message', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classifyFailure(new Error('fetch failed', { cause: Object.assign(new Error('c'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }))).toBe('timeout');
    expect(classifyFailure(new Error('search timed out after 60000ms'))).toBe('timeout');
  });

  it('treats other failures as error', () => {
    expect(classifyFailure(new Error('Met search failed: 410'))).toBe('error');
    expect(classifyFailure('weird')).toBe('error');
  });
});

describe('redaction by key name, in every form', () => {
  const KEY = 'AbCdEf0123456789SECRETVALUE';
  const hostile: Array<[string, string]> = [
    ['a quoted JSON apikey', `HTTP 401 {"apikey":"${KEY}","error":"bad"}`],
    ['a quoted JSON key', `HTTP 401 {"key":"${KEY}"}`],
    ['a quoted JSON wskey', `HTTP 401 {"wskey":"${KEY}"}`],
    ['a quoted JSON token with spaces', `upstream said { "token" : "${KEY}" }`],
    ['a single-quoted pair', `bad config {'client_secret': '${KEY}'}`],
    ['a scheme-less URL with wskey', `request to api.europeana.eu/record/v2/search.json?wskey=${KEY} failed`],
    ['a scheme-less URL with api_key', `request to api.example.org/v1/search?q=horse&api_key=${KEY} failed`],
    ['a scheme-less URL with a custom key param', `GET host.example/x?q=1&partner_token_v2=${KEY}&n=2`],
    ['a scheme-less URL with sig', `GET host.example/x?sig=${KEY}`],
    ['a bare wskey pair', `bad request: wskey=${KEY}`],
    ['a bare ws_key pair', `bad request: ws_key: ${KEY}`],
    ['a password pair', `login failed password=${KEY}`],
  ];

  it.each(hostile)('redacts %s', (_label, message) => {
    expect(sanitizeSourceError(new Error(message))).not.toContain(KEY);
  });

  it('keeps the non-secret parts of a redacted message readable', () => {
    const out = sanitizeSourceError(new Error(`request to api.europeana.eu/record/v2/search.json?q=horse&wskey=${KEY} failed`));
    expect(out).toContain('q=horse');
    expect(out).toContain('failed');
  });

  it('does not eat ordinary words that merely contain a key-ish substring', () => {
    expect(sanitizeSourceError(new Error('design: rejected, keyword unsupported, author: unknown'))).toBe(
      'design: rejected, keyword unsupported, author: unknown',
    );
  });
});

describe('credentials hidden by an encoding are still redacted', () => {
  const KEY = 'AbCdEf0123456789SECRETVALUE';
  const hostile: Array<[string, string]> = [
    ['backslash-escaped JSON', String.raw`HTTP 401 {\"apikey\":\"${KEY}\"}`],
    ['doubly backslash-escaped JSON', String.raw`HTTP 401 {\\\"apikey\\\":\\\"${KEY}\\\"}`],
    ['a percent-encoded equals', `request failed: apikey%3D${KEY}`],
    ['a percent-encoded colon', `request failed: wskey%3A${KEY}`],
    ['a percent-encoded JSON body', `body=%7B%22apikey%22%3A%22${KEY}%22%7D`],
    ['a lowercase percent-encoded JSON body', `body=%7b%22token%22%3a%22${KEY}%22%7d`],
    ['a doubly percent-encoded pair', `request failed: apikey%253D${KEY}`],
    ['a percent-encoded scheme-less query', `GET host.example/x?q=1%26api_key%3D${KEY}`],
  ];

  it.each(hostile)('redacts %s', (_label, message) => {
    expect(sanitizeSourceError(new Error(message))).not.toContain(KEY);
  });

  it('leaves ordinary percent-escapes and a lone percent sign readable', () => {
    expect(sanitizeSourceError(new Error('bad query q=blue%20horse, 100% failed'))).toBe('bad query q=blue horse, 100% failed');
  });
});

describe('redaction cost is bounded whatever a source sends back', () => {
  // Each shape is built at a size `n`, about the length of the message.
  const hostile: Array<[string, (n: number) => string]> = [
    ['a long run of name characters', (n) => 'a-'.repeat(n / 2)],
    ['a long run with a marker at the end', (n) => `${'a'.repeat(n)}key`],
    ['a long query-like run', (n) => `?${'a'.repeat(n)}`],
    ['a long run of ampersand parameters', (n) => `?${'k&'.repeat(n / 2)}`],
    ['a long run of escaped quotes', (n) => '\\"'.repeat(n / 2)],
    ['a long run of percent escapes', (n) => '%41'.repeat(n / 3)],
  ];

  const error = (shape: (n: number) => string) => (n: number) => new Error(shape(n));

  // 7,500 and 30,000 chars are both past the scan limit, so the cost should not grow.
  it.each(hostile)('stops growing past the scan limit on %s', (_label, shape) => {
    expect(sanitizeSourceError(new Error(shape(30_000))).length).toBeLessThanOrEqual(300);
    expect(growthRatioOf(error(shape), sanitizeSourceError, 30_000)).toBeLessThan(BOUNDED_CEILING);
  }, 60_000);

  it('still redacts a credential inside the scanned window of a long message', () => {
    const out = sanitizeSourceError(new Error(`apikey=SECRETVALUE ${'x'.repeat(30000)}`));
    expect(out).not.toContain('SECRETVALUE');
  });
});

describe('local paths are not leaked', () => {
  it.each([
    ['a POSIX path', "ENOENT: no such file or directory, open '/Users/pramod/.config/keys.json'", '/Users', 'keys.json'],
    ['a deep install path', 'bundle missing: /opt/app/node_modules/open-museum-mcp/dist/data/nga.json', '/opt/app', 'nga.json'],
    ['a home-relative path', 'cannot read ~/.open-museum-mcp/cache.db', '.open-museum-mcp', 'cache.db'],
    ['a Windows path', 'ENOENT: open C:\\Users\\pramod\\data\\walters.json', 'Users', 'walters.json'],
  ])('reduces %s to its file name', (_label, message, leaked, kept) => {
    const out = sanitizeSourceError(new Error(message));
    expect(out).not.toContain(leaked);
    expect(out).toContain(kept);
  });

  it('leaves URL origins, MIME types and short slashes alone', () => {
    expect(sanitizeSourceError(new Error('got application/json from https://api.example.org/v1/x (HTTP 500)'))).toBe(
      'got application/json from https://api.example.org (HTTP 500)',
    );
  });
});

describe('a throwing onSourceFailure hook', () => {
  it('never fails the search; the failed source is still reported', async () => {
    const onSourceFailure = vi.fn(() => {
      throw new Error('hook boom');
    });
    const { federation } = build([source('met', { failWith: new Error('Met search failed: 410') }), source('aic', { ids: ['aic:2'] })], {
      onSourceFailure,
    });
    const result = await federation.search(params());
    expect(onSourceFailure).toHaveBeenCalledTimes(1);
    expect(result.results.map((r) => r.id)).toEqual(['aic:2']);
    expect(result.sources.find((s) => s.museum === 'met')?.status).toBe('error');
  });

  it('survives an async hook that rejects, without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      // a plain function, not vi.fn: the spy attaches its own handler to the
      // returned promise, which would mask exactly the rejection under test
      const onSourceFailure = async () => {
        throw new Error('async boom');
      };
      const { federation } = build([source('met', { failWith: new Error('x') }), source('aic', { ids: ['aic:2'] })], {
        onSourceFailure: onSourceFailure as unknown as (s: SourceStatus) => void,
      });
      const result = await federation.search(params());
      expect(result.results).toHaveLength(1);
      // unhandledRejection fires once the microtask queue drains
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('a cache hit never vouches for a source that did not run', () => {
  it('a source registered after the entry was cached is queried, not reported ok from cache', async () => {
    const cache = memoryCache();
    const one = createFederation({ fetchers: { met: source('met', { ids: ['met:1'] }) }, cache: cache.store });
    await one.search(params());
    expect(cache.queries.size).toBe(1);

    const two = createFederation({
      fetchers: { met: source('met', { ids: ['met:1'] }), getty: source('getty', { failWith: new Error('Getty down') }) },
      cache: cache.store,
    });
    const result = await two.search(params());
    const getty = result.sources.find((s) => s.museum === 'getty');
    expect(getty?.status).toBe('error');
    expect(getty?.error).toContain('Getty down');
  });

  it('the same source set still hits the cache regardless of registration order', async () => {
    const cache = memoryCache();
    const a = createFederation({
      fetchers: { met: source('met', { ids: ['met:1'] }), aic: source('aic', { ids: ['aic:2'] }) },
      cache: cache.store,
    });
    await a.search(params());
    const b = createFederation({
      fetchers: { aic: source('aic', { ids: ['aic:2'] }), met: source('met', { ids: ['met:1'] }) },
      cache: cache.store,
    });
    await b.search(params());
    expect(cache.queries.size).toBe(1);
  });
});
