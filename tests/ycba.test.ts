import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YCBA_MAX_CONCURRENCY, ycbaFetcher } from '../src/fetchers/ycba.js';
import { validateLicense } from '../src/licenseGate.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  record: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8')) as Fixture;
}

// Real LUX records + their YCBA IIIF v2 manifests (fetched 2026-10-24):
//   accepted: George Stubbs, "Horse Frightened by a Lion" (B1977.14.73), public domain.
//   hockney:  David Hockney, "Panama Hat", "© The Artist" (in-copyright control).
const ACCEPTED_ID = 'ycba:8853c843-03b5-4ad0-afe0-d3e6bfec1d3f';
const ACCEPTED_MANIFEST = 'https://manifests.collections.yale.edu/v2/ycba/obj/5007';
const HOCKNEY_MANIFEST = 'https://manifests.collections.yale.edu/v2/ycba/obj/72202';

function rawOf(f: Fixture, manifestUrl: string): unknown {
  return { record: f.record, manifest: f.manifest, manifestUrl };
}

/** Deep copy so per-test mutations never leak between tests. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function firstCanvas(manifest: Record<string, unknown>): Record<string, unknown> {
  const seq = (manifest.sequences as Array<Record<string, unknown>>)[0];
  return (seq.canvases as Array<Record<string, unknown>>)[0];
}

function setCopyrightStatement(manifest: Record<string, unknown>, value: unknown): void {
  const md = manifest.metadata as Array<Record<string, unknown>>;
  const entry = md.find((e) => e.label === 'Copyright Statement');
  if (!entry) throw new Error('fixture has no Copyright Statement');
  entry.value = value;
}

function canvasesOf(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  const seq = (manifest.sequences as Array<Record<string, unknown>>)[0];
  return seq.canvases as Array<Record<string, unknown>>;
}

function imageUseRightsEntry(canvas: Record<string, unknown>): Record<string, unknown> {
  const entry = (canvas.metadata as Array<Record<string, unknown>>).find((e) => e.label === 'Image Use Rights');
  if (!entry) throw new Error('canvas has no Image Use Rights');
  return entry;
}

function rejectionReason(raw: unknown): string {
  const result = ycbaFetcher.normalize(raw);
  expect(result.status).toBe('rejected');
  if (result.status !== 'rejected') return '';
  expect(result.rejection.museumCode).toBe('ycba');
  return result.rejection.reason;
}

describe('YCBA adapter normalization', () => {
  it('normalizes a public-domain record (real: Stubbs, B1977.14.73) into the Artwork shape', () => {
    const result = ycbaFetcher.normalize(rawOf(fixture('ycba-accepted.json'), ACCEPTED_MANIFEST));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;

    expect(a.id).toBe(ACCEPTED_ID);
    expect(a.museum).toEqual({ code: 'ycba', name: 'Yale Center for British Art', url: 'https://britishart.yale.edu' });
    expect(a.title).toBe('Horse Frightened by a Lion');
    expect(a.artist.name).toBe('George Stubbs');
    expect(a.artist.attributionType).toBe('named');
    expect(a.displayDate).toBe('between 1762 and 1768');
    expect(a.yearStart).toBe(1762);
    expect(a.yearEnd).toBe(1768);
    expect(a.medium).toBe('Oil on canvas');
    expect(a.mediumCategory).toBe('painting');
    expect(a.period).toBe('18th century');
    expect(a.objectType).toBe('painting');
    expect(a.dimensions).toBe('27 3/4 × 41 inches (70.5 × 104.1 cm)');
    expect(a.description).toBe('B1977.14.73');

    expect(a.license.type).toBe('CC0');
    expect(a.license.confidence).toBe('high');
    expect(a.license.verificationSource).toBe('ycba.iiif-manifest (Copyright Statement + canvas Image Use Rights)');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);

    expect(a.imageUrls.full).toBe(
      'https://images.collections.yale.edu/iiif/2/ycba:19504a99-09b0-4810-bb04-31ff694953f5/full/full/0/default.jpg',
    );
    expect(a.imageUrls.large).toBe(
      'https://images.collections.yale.edu/iiif/2/ycba:19504a99-09b0-4810-bb04-31ff694953f5/full/!1200,1200/0/default.jpg',
    );
    expect(a.imageUrls.thumbnail).toBe(
      'https://images.collections.yale.edu/iiif/2/ycba:19504a99-09b0-4810-bb04-31ff694953f5/full/!400,400/0/default.jpg',
    );
    expect(a.imageUrls.width).toBe(7240);
    expect(a.imageUrls.height).toBe(4871);
    expect(a.imageUrls.maxResolution).toEqual({ width: 7240, height: 4871 });

    expect(a.source.apiUrl).toBe('https://lux.collections.yale.edu/data/object/8853c843-03b5-4ad0-afe0-d3e6bfec1d3f');
    expect(a.source.pageUrl).toBe('https://collections.britishart.yale.edu/catalog/tms:5007');
  });

  it('is registered with the per-museum license dispatcher', () => {
    const decision = validateLicense('ycba', rawOf(fixture('ycba-accepted.json'), ACCEPTED_MANIFEST));
    expect(decision.accepted).toBe(true);
    expect(decision.license?.type).toBe('CC0');
  });

  it('rejects the in-copyright control (real: Hockney, "Panama Hat", "© The Artist")', () => {
    const reason = rejectionReason(rawOf(fixture('ycba-rejected-hockney.json'), HOCKNEY_MANIFEST));
    expect(reason).toContain('© The Artist');
    expect(reason).toContain('strict default reject');
  });

  it('rejects when the Copyright Statement says Public Domain but the canvas says In Copyright', () => {
    const f = clone(fixture('ycba-accepted.json'));
    // Take the real "In Copyright" canvas statement from the Hockney manifest.
    firstCanvas(f.manifest).metadata = clone(firstCanvas(fixture('ycba-rejected-hockney.json').manifest).metadata);
    const reason = rejectionReason(rawOf(f, ACCEPTED_MANIFEST));
    expect(reason).toContain('In Copyright');
    expect(reason).toContain('both signals must agree');
  });

  it('rejects when the canvas says CC0 but the Copyright Statement does not say Public Domain', () => {
    const f = clone(fixture('ycba-accepted.json'));
    setCopyrightStatement(f.manifest, '© The Artist');
    expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('© The Artist');
  });

  it('matches the Copyright Statement exactly (case and surrounding text matter)', () => {
    for (const variant of ['Public domain', 'public domain', ' Public Domain', 'Public Domain (verify)']) {
      const f = clone(fixture('ycba-accepted.json'));
      setCopyrightStatement(f.manifest, variant);
      expect(ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST)).status).toBe('rejected');
    }
  });

  it('rejects a non-string Copyright Statement value', () => {
    const f = clone(fixture('ycba-accepted.json'));
    setCopyrightStatement(f.manifest, ['Public Domain']);
    expect(ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST)).status).toBe('rejected');
  });

  it('rejects when the Copyright Statement entry is missing', () => {
    const f = clone(fixture('ycba-accepted.json'));
    f.manifest.metadata = (f.manifest.metadata as Array<Record<string, unknown>>).filter(
      (e) => e.label !== 'Copyright Statement',
    );
    expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('Copyright Statement=null');
  });

  it('rejects two Copyright Statement entries that disagree', () => {
    const f = clone(fixture('ycba-accepted.json'));
    (f.manifest.metadata as Array<Record<string, unknown>>).push({ label: 'Copyright Statement', value: '© The Artist' });
    expect(ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST)).status).toBe('rejected');
  });

  it('rejects when the canvas Image Use Rights entry is missing', () => {
    const f = clone(fixture('ycba-accepted.json'));
    delete firstCanvas(f.manifest).metadata;
    expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('Image Use Rights=null');
  });

  it('matches the canvas Image Use Rights exactly (surrounding whitespace, case and wording matter)', () => {
    const statement = imageUseRightsEntry(firstCanvas(fixture('ycba-accepted.json').manifest)).value as string;
    for (const variant of [
      ` ${statement}`,
      `${statement} `,
      `${statement}\n`,
      statement.toLowerCase(),
      statement.replace('(CC0 1.0)', '(CC0)'),
    ]) {
      const f = clone(fixture('ycba-accepted.json'));
      imageUseRightsEntry(firstCanvas(f.manifest)).value = variant;
      expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('Image Use Rights=');
    }
  });

  it('emits the image of the canvas whose rights were checked, never a later canvas', () => {
    // Canvas 0 is the real CC0 Stubbs canvas (image A); canvas 1 is the real
    // In Copyright Hockney canvas (image B). Only image A may be emitted.
    const f = clone(fixture('ycba-accepted.json'));
    canvasesOf(f.manifest).push(clone(firstCanvas(fixture('ycba-rejected-hockney.json').manifest)));
    const result = ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    for (const url of [result.artwork.imageUrls.full, result.artwork.imageUrls.large, result.artwork.imageUrls.thumbnail]) {
      expect(url).toContain('ycba:19504a99-09b0-4810-bb04-31ff694953f5');
      expect(url).not.toContain('ycba:3b5ed3d8-7485-4050-919c-46cff2a2322a');
    }
  });

  it('rejects when the first canvas is In Copyright, even if a later canvas is CC0', () => {
    const f = clone(fixture('ycba-accepted.json'));
    canvasesOf(f.manifest).unshift(clone(firstCanvas(fixture('ycba-rejected-hockney.json').manifest)));
    expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('In Copyright');
  });

  it('never treats the manifest-level CC0 license as a rights signal', () => {
    // The accepted fixture's manifest already carries `license` = CC0; strip
    // both per-object signals and the record must still reject.
    const f = clone(fixture('ycba-accepted.json'));
    expect(f.manifest.license).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    f.manifest.metadata = [];
    delete firstCanvas(f.manifest).metadata;
    expect(ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST)).status).toBe('rejected');
  });

  it('fails closed when the manifest is missing or unreadable', () => {
    const f = fixture('ycba-accepted.json');
    expect(rejectionReason({ record: f.record, manifest: null, manifestUrl: ACCEPTED_MANIFEST })).toContain(
      'missing or unreadable',
    );
    expect(ycbaFetcher.normalize({ record: f.record, manifest: 'not json', manifestUrl: ACCEPTED_MANIFEST }).status).toBe(
      'rejected',
    );
  });

  it('rejects a manifest that is not the one the record links to', () => {
    const f = fixture('ycba-accepted.json');
    // The Hockney manifest is a valid YCBA manifest, but not this record's.
    const raw = { record: f.record, manifest: fixture('ycba-rejected-hockney.json').manifest, manifestUrl: ACCEPTED_MANIFEST };
    expect(rejectionReason(raw)).toContain('not the IIIF v2 manifest the record links to');
  });

  it('rejects a manifest that is not IIIF Presentation v2', () => {
    const f = clone(fixture('ycba-accepted.json'));
    f.manifest['@context'] = 'http://iiif.io/api/presentation/3/context.json';
    expect(ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST)).status).toBe('rejected');
  });

  it('rejects a manifest URL outside the YCBA manifest path', () => {
    const f = fixture('ycba-accepted.json');
    for (const url of [
      'https://manifests.collections.yale.edu/yuag/obj/5007',
      'http://manifests.collections.yale.edu/v2/ycba/obj/5007',
      'https://manifests.collections.yale.edu.evil.com/v2/ycba/obj/5007',
    ]) {
      expect(ycbaFetcher.normalize({ record: f.record, manifest: { ...f.manifest, '@id': url }, manifestUrl: url }).status).toBe(
        'rejected',
      );
    }
  });

  it('rejects a record held by a different collection, even with a passing manifest', () => {
    const f = clone(fixture('ycba-accepted.json'));
    f.record.current_owner = [
      { id: 'https://lux.collections.yale.edu/data/group/00000000-0000-0000-0000-000000000000', type: 'Group' },
    ];
    expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('outside federated scope');
  });

  it('rejects a record whose id is not a LUX object URI', () => {
    const f = clone(fixture('ycba-accepted.json'));
    f.record.id = 'https://example.org/data/object/8853c843-03b5-4ad0-afe0-d3e6bfec1d3f';
    expect(ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST)).status).toBe('rejected');
  });

  it('rejects an accepted-rights record whose painting image is not on the Yale image server', () => {
    const f = clone(fixture('ycba-accepted.json'));
    const images = firstCanvas(f.manifest).images as Array<Record<string, unknown>>;
    const resource = images[0].resource as Record<string, unknown>;
    resource['@id'] = 'https://evil.example/full/full/0/default.jpg';
    (resource.service as Record<string, unknown>)['@id'] = 'https://evil.example/iiif/2/x';
    expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('Yale image server');
  });

  it('rejects a well-formed ycba: image service on any host but the Yale image server', () => {
    const path = '/iiif/2/ycba:19504a99-09b0-4810-bb04-31ff694953f5';
    for (const origin of [
      'https://images.evil.example',
      'https://images.collections.yale.edu.evil.com',
      'http://images.collections.yale.edu',
    ]) {
      const f = clone(fixture('ycba-accepted.json'));
      const resource = (firstCanvas(f.manifest).images as Array<Record<string, unknown>>)[0].resource as Record<
        string,
        unknown
      >;
      (resource.service as Record<string, unknown>)['@id'] = `${origin}${path}`;
      expect(rejectionReason(rawOf(f, ACCEPTED_MANIFEST))).toContain('Yale image server');
    }
  });

  it('rejects a not-found marker from getRaw', () => {
    expect(rejectionReason({ notFound: true, id: ACCEPTED_ID })).toContain('not found');
  });

  it('rejects garbage input gracefully', () => {
    for (const garbage of [null, 'not an object', 42, {}, { record: null }]) {
      expect(ycbaFetcher.normalize(garbage).status).toBe('rejected');
    }
  });

  it('caps and strips HTML from an oversized, tag-laden title', () => {
    const f = clone(fixture('ycba-accepted.json'));
    const names = f.record.identified_by as Array<Record<string, unknown>>;
    names[0].content = `<script>alert(1)</script>${'A'.repeat(1000)}`;
    const result = ycbaFetcher.normalize(rawOf(f, ACCEPTED_MANIFEST));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).not.toContain('<script>');
    expect(result.artwork.title.length).toBeLessThanOrEqual(256);
  });
});

type FetchHandler = (url: string) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): string[] {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('YCBA getRaw: two-hop hydration', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches the LUX record, then the YCBA manifest it links to', async () => {
    const f = fixture('ycba-accepted.json');
    const calls = stubFetch((url) => (url === ACCEPTED_MANIFEST ? json(f.manifest) : json(f.record)));
    const raw = await ycbaFetcher.getRaw(ACCEPTED_ID);
    expect(calls).toEqual([
      'https://lux.collections.yale.edu/data/object/8853c843-03b5-4ad0-afe0-d3e6bfec1d3f',
      ACCEPTED_MANIFEST,
    ]);
    expect(ycbaFetcher.normalize(raw).status).toBe('accepted');
  });

  it('sends the identifying User-Agent (LUX answers anonymous clients with 403)', async () => {
    const f = fixture('ycba-accepted.json');
    const agents: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      agents.push(new Headers(init?.headers).get('User-Agent'));
      return String(input) === ACCEPTED_MANIFEST ? json(f.manifest) : json(f.record);
    }) as unknown as typeof fetch;
    await ycbaFetcher.getRaw(ACCEPTED_ID);
    expect(agents).toHaveLength(2);
    for (const ua of agents) expect(ua).toContain('open-museum-mcp');
  });

  it('does NOT fetch a manifest link outside the YCBA manifest path (SSRF guard)', async () => {
    for (const evil of [
      'http://169.254.169.254/latest/meta-data/',
      'https://manifests.collections.yale.edu.evil.com/v2/ycba/obj/5007',
      'http://manifests.collections.yale.edu/v2/ycba/obj/5007',
      'https://manifests.collections.yale.edu/v2/ycba/obj/5007/../../admin',
      'not a url',
    ]) {
      const record = clone(fixture('ycba-accepted.json').record);
      record.subject_of = [
        {
          type: 'LinguisticObject',
          digitally_carried_by: [
            {
              type: 'DigitalObject',
              conforms_to: [{ id: 'http://iiif.io/api/presentation/2/context.json' }],
              access_point: [{ id: evil }],
            },
          ],
        },
      ];
      const calls = stubFetch(() => json(record));
      const raw = (await ycbaFetcher.getRaw(ACCEPTED_ID)) as { manifest: unknown };
      expect(calls).toHaveLength(1);
      expect(raw.manifest).toBeNull();
      expect(ycbaFetcher.normalize(raw).status).toBe('rejected');
    }
  });

  it('drops a record that 404s instead of throwing', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));
    const raw = await ycbaFetcher.getRaw(ACCEPTED_ID);
    expect(ycbaFetcher.normalize(raw).status).toBe('rejected');
  });

  it('drops a record that 410s (gone) instead of throwing', async () => {
    const calls = stubFetch(() => new Response('Gone', { status: 410 }));
    const raw = await ycbaFetcher.getRaw(ACCEPTED_ID);
    expect(calls).toHaveLength(1);
    expect(rejectionReason(raw)).toContain('not found');
  });

  it('bounds every Yale request with the 20s timeout', async () => {
    const f = fixture('ycba-accepted.json');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return String(input) === ACCEPTED_MANIFEST ? json(f.manifest) : json(f.record);
    }) as unknown as typeof fetch;
    await ycbaFetcher.getRaw(ACCEPTED_ID);
    expect(timeout.mock.calls).toEqual([[20_000], [20_000]]);
    expect(signals).toEqual(timeout.mock.results.map((r) => r.value));
  });

  it('refuses redirects on the manifest hop, so the host check covers the address fetched', async () => {
    const f = fixture('ycba-accepted.json');
    const redirects = new Map<string, RequestInit['redirect']>();
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      redirects.set(String(input), init?.redirect);
      return String(input) === ACCEPTED_MANIFEST ? json(f.manifest) : json(f.record);
    }) as unknown as typeof fetch;
    await ycbaFetcher.getRaw(ACCEPTED_ID);
    expect(redirects.get(ACCEPTED_MANIFEST)).toBe('error');
  });

  it('fails closed (no throw) when the manifest fetch errors', async () => {
    const f = fixture('ycba-accepted.json');
    stubFetch((url) => (url === ACCEPTED_MANIFEST ? new Response('gone', { status: 404 }) : json(f.record)));
    const raw = (await ycbaFetcher.getRaw(ACCEPTED_ID)) as { manifest: unknown };
    expect(raw.manifest).toBeNull();
    expect(ycbaFetcher.normalize(raw).status).toBe('rejected');
  });

  it('rejects a malformed id without any network call', async () => {
    const calls = stubFetch(() => json({}));
    await expect(ycbaFetcher.getRaw('ycba:../../etc')).rejects.toThrow('invalid id');
    expect(calls).toHaveLength(0);
  });

  it('throws on a non-retryable record error (e.g. 403)', async () => {
    stubFetch(() => new Response('Forbidden', { status: 403 }));
    await expect(ycbaFetcher.getRaw(ACCEPTED_ID)).rejects.toThrow('403');
  });
});

describe('YCBA resilience: backoff and bounded concurrency', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a 500 after 500ms, then after a further 1500ms, then succeeds', async () => {
    const f = fixture('ycba-accepted.json');
    let recordAttempts = 0;
    stubFetch((url) => {
      if (url === ACCEPTED_MANIFEST) return json(f.manifest);
      recordAttempts++;
      return recordAttempts < 3 ? new Response('err', { status: 500 }) : json(f.record);
    });
    const pending = ycbaFetcher.getRaw(ACCEPTED_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(recordAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(recordAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recordAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(recordAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(recordAttempts).toBe(3);
    const raw = await pending;
    expect(ycbaFetcher.normalize(raw).status).toBe('accepted');
  });

  it('retries a 429, then succeeds', async () => {
    const f = fixture('ycba-accepted.json');
    let recordAttempts = 0;
    stubFetch((url) => {
      if (url === ACCEPTED_MANIFEST) return json(f.manifest);
      recordAttempts++;
      return recordAttempts < 2 ? new Response('slow down', { status: 429 }) : json(f.record);
    });
    const pending = ycbaFetcher.getRaw(ACCEPTED_ID);
    await vi.runAllTimersAsync();
    const raw = await pending;
    expect(recordAttempts).toBe(2);
    expect(ycbaFetcher.normalize(raw).status).toBe('accepted');
  });

  it('retries a network error, then succeeds', async () => {
    const f = fixture('ycba-accepted.json');
    let recordAttempts = 0;
    stubFetch((url) => {
      if (url === ACCEPTED_MANIFEST) return json(f.manifest);
      recordAttempts++;
      if (recordAttempts < 2) throw new TypeError('fetch failed');
      return json(f.record);
    });
    const pending = ycbaFetcher.getRaw(ACCEPTED_ID);
    await vi.runAllTimersAsync();
    const raw = await pending;
    expect(recordAttempts).toBe(2);
    expect(ycbaFetcher.normalize(raw).status).toBe('accepted');
  });

  it('gives up after the retry budget on a persistent 500', async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts++;
      return new Response('err', { status: 500 });
    });
    const pending = ycbaFetcher.getRaw(ACCEPTED_ID);
    const assertion = expect(pending).rejects.toThrow('500');
    await vi.runAllTimersAsync();
    await assertion;
    expect(attempts).toBe(3);
  });

  it('never has more than YCBA_MAX_CONCURRENCY (< 8) requests in flight to Yale', async () => {
    expect(YCBA_MAX_CONCURRENCY).toBeLessThan(8);
    const f = fixture('ycba-accepted.json');
    let inFlight = 0;
    let peak = 0;
    stubFetch(async (url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return url === ACCEPTED_MANIFEST ? json(f.manifest) : json(f.record);
    });
    const all = Promise.all(Array.from({ length: 24 }, () => ycbaFetcher.getRaw(ACCEPTED_ID)));
    await vi.runAllTimersAsync();
    const raws = await all;
    expect(raws).toHaveLength(24);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(YCBA_MAX_CONCURRENCY);
  });
});

describe('YCBA search', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const page = {
    type: 'OrderedCollectionPage',
    orderedItems: [
      { id: 'https://lux.collections.yale.edu/data/object/8853c843-03b5-4ad0-afe0-d3e6bfec1d3f', type: 'HumanMadeObject' },
      { id: 'https://lux.collections.yale.edu/data/object/d113104c-f69b-42ce-906b-134b5901ae9b', type: 'HumanMadeObject' },
      { id: 'https://example.org/data/object/8853c843-03b5-4ad0-afe0-d3e6bfec1d3f', type: 'HumanMadeObject' },
      { id: 'https://lux.collections.yale.edu/data/object/not-a-uuid', type: 'HumanMadeObject' },
      { id: 42 },
    ],
  };

  function queryOf(url: string): Record<string, unknown> {
    const q = new URL(url).searchParams.get('q');
    if (!q) throw new Error('no q param');
    return JSON.parse(q) as Record<string, unknown>;
  }

  it('scopes the LUX query to YCBA, requires an image, and returns only well-formed LUX object ids', async () => {
    const calls = stubFetch(() => json(page));
    const ids = await ycbaFetcher.search('horse', 10, { hasImage: true });
    expect(ids).toEqual(['ycba:8853c843-03b5-4ad0-afe0-d3e6bfec1d3f', 'ycba:d113104c-f69b-42ce-906b-134b5901ae9b']);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://lux.collections.yale.edu/api/search/item');
    expect(url.searchParams.get('pageLength')).toBe('10');
    const q = JSON.stringify(queryOf(calls[0]));
    expect(q).toContain('"text":"horse"');
    expect(q).toContain('"hasDigitalImage":1');
    expect(q).toContain('https://lux.collections.yale.edu/data/group/0e8bc04a-6538-4792-b82a-9e0751857e7d');
  });

  it('omits the image clause when hasImage is false', async () => {
    const calls = stubFetch(() => json(page));
    await ycbaFetcher.search('horse', 5, { hasImage: false });
    expect(JSON.stringify(queryOf(calls[0]))).not.toContain('hasDigitalImage');
  });

  it("a caller's abort cancels the request and is not retried", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          calls++;
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = ycbaFetcher.search('horse', 5, { signal: controller.signal });
    await vi.waitFor(() => expect(calls).toBe(1));
    const abortedAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
    // Rejects at once rather than after the first 500 ms backoff.
    expect(Date.now() - abortedAt).toBeLessThan(250);
  });

  it('makes no request when the signal is already aborted', async () => {
    const calls = stubFetch(() => json(page));
    const controller = new AbortController();
    controller.abort();
    await expect(ycbaFetcher.search('horse', 5, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('passes the query term as JSON data, not by string concatenation', async () => {
    const calls = stubFetch(() => json(page));
    const term = 'x"},{"hasDigitalImage":0}],"OR":[{"text":"';
    await ycbaFetcher.search(term, 5);
    const q = queryOf(calls[0]) as { AND: Array<Record<string, unknown>> };
    expect(q.AND[0]).toEqual({ text: term, _lang: 'en' });
  });

  it('caps the page length', async () => {
    const calls = stubFetch(() => json(page));
    await ycbaFetcher.search('horse', 5000);
    expect(Number(new URL(calls[0]).searchParams.get('pageLength'))).toBeLessThanOrEqual(100);
  });

  it('throws on a failed search so the federation does not cache a partial result', async () => {
    stubFetch(() => new Response('Forbidden', { status: 403 }));
    await expect(ycbaFetcher.search('horse', 5)).rejects.toThrow('403');
  });
});
