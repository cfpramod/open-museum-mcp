import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createColorExtractor, isAllowlistedImageHost, type SharpLike } from '../../src/color/extract.js';
import type { Artwork } from '../../src/types.js';

describe('isAllowlistedImageHost — CDN allowlist (exact hostname)', () => {
  it.each([
    'https://api.nga.gov/iiif/d6b29041-544b-4914-9c4b-342953febbee/full/full/0/default.jpg',
    'https://iip-thumb.smk.dk/iiif/jp2/fn107176m_kksgb12522.tif.reconstructed.tif.jp2/full/!1024,/0/default.jpg',
    'https://media.getty.edu/iiif/image/fb184f3a-57ca-4a2b-b4da-30be59f301c3/full/max/0/default.jpg',
  ])('allows the image host of a source whose records otherwise stay colourless: %s', (u) => {
    expect(isAllowlistedImageHost(u)).toBe(true);
  });

  it.each([
    'https://api.nga.gov.evil.example/x',
    'https://evil-api.smk.dk.attacker.test/x',
    'https://iip-thumb.smk.dk.attacker.test/x',
    // The full-resolution /download derivative: 503s, empty bodies and minutes-long
    // streams measured live, and colour never needs it.
    'https://api.smk.dk/api/v1/download/abc/KMS1.jpg',
    'https://getty.edu/x',
    'https://data.getty.edu/x',
  ])('still rejects look-alike and sibling hosts: %s', (u) => {
    expect(isAllowlistedImageHost(u)).toBe(false);
  });

  describe('api.smk.dk is allowed only for its thumbnail path', () => {
    it('allows the thumbnail SMK publishes for records without an IIIF image', () => {
      expect(isAllowlistedImageHost('https://api.smk.dk/api/v1/thumbnail/0607f3ca-f8b9-4ecc-9fd0-af0607241cc7.jpg')).toBe(true);
    });

    it.each([
      // The download derivative and every other endpoint on the same host.
      'https://api.smk.dk/api/v1/download/W3siaW1nX3VybCI6IiJ9XQ/KMS3352.jpg',
      'https://api.smk.dk/api/v1/iiif/manifest?id=KMS3352',
      'https://api.smk.dk/',
      // Dot segments resolve before the check, so they cannot climb out of the prefix.
      'https://api.smk.dk/api/v1/thumbnail/../download/x/KMS1.jpg',
      'https://api.smk.dk/api/v1/thumbnail/%2e%2e/download/x/KMS1.jpg',
      // An encoded slash is not resolved by URL parsing but may be by the server.
      'https://api.smk.dk/api/v1/thumbnail/x%2F..%2F..%2Fdownload%2Fy.jpg',
      'https://api.smk.dk/api/v1/thumbnail/x%5C..%5Cdownload.jpg',
      'https://api.smk.dk/api/v1/thumbnail/x%2Fdownload%2Fy.jpg',
      'https://api.smk.dk/api/v1/thumbnail/x%5Cdownload.jpg',
      'https://api.smk.dk/api/v1/thumbnail/a/b.jpg',
      'https://api.smk.dk/api/v1/thumbnail/',
      'https://api.smk.dk/api/v1/thumbnailx/0607f3ca.jpg',
      'https://api.smk.dk/api/v1/thumbnail/0607f3ca.jpg?redirect=/api/v1/download/x',
      'https://api.smk.dk.attacker.test/api/v1/thumbnail/0607f3ca.jpg',
    ])('refuses %s', (u) => {
      expect(isAllowlistedImageHost(u)).toBe(false);
    });
  });

  it('allows the Rijksmuseum Micrio IIIF host (OM-CR N1: colour facet no longer fails closed)', () => {
    expect(isAllowlistedImageHost('https://iiif.micr.io/QkOGy/full/max/0/default.jpg')).toBe(true);
  });
  it('still rejects a look-alike host (no substring spoofing)', () => {
    expect(isAllowlistedImageHost('https://iiif.micr.io.evil.com/x.jpg')).toBe(false);
    expect(isAllowlistedImageHost('https://evil.com/?x=iiif.micr.io')).toBe(false);
  });
  it('keeps the existing hosts allowed', () => {
    expect(isAllowlistedImageHost('https://ids.si.edu/ids/deliveryService?id=x')).toBe(true);
    expect(isAllowlistedImageHost('https://images.metmuseum.org/full.jpg')).toBe(true);
  });
  it('allows the Wellcome Collection IIIF host (colour extraction has silently skipped every Wellcome record until now)', () => {
    expect(isAllowlistedImageHost('https://iiif.wellcomecollection.org/image/V0010411/full/full/0/default.jpg')).toBe(true);
  });
  it('still rejects a Wellcome look-alike host (no substring spoofing)', () => {
    expect(isAllowlistedImageHost('https://iiif.wellcomecollection.org.evil.com/x.jpg')).toBe(false);
    expect(isAllowlistedImageHost('https://evil.com/?x=iiif.wellcomecollection.org')).toBe(false);
  });
  it('allows the Yale IIIF image host the YCBA fetcher emits', () => {
    expect(
      isAllowlistedImageHost(
        'https://images.collections.yale.edu/iiif/2/ycba:19504a99-09b0-4810-bb04-31ff694953f5/full/full/0/default.jpg',
      ),
    ).toBe(true);
  });
  it('still rejects a Yale look-alike host (no substring spoofing)', () => {
    expect(isAllowlistedImageHost('https://images.collections.yale.edu.evil.com/x.jpg')).toBe(false);
    expect(isAllowlistedImageHost('https://evil.com/?x=images.collections.yale.edu')).toBe(false);
    expect(isAllowlistedImageHost('https://collections.yale.edu/x.jpg')).toBe(false);
  });
});

function artwork(over: Partial<Artwork['imageUrls']> = {}): Artwork {
  return {
    id: 'test:1',
    museum: { code: 'test', name: 'TEST', url: 'https://t.example' },
    title: 'x',
    artist: { name: 'A', attributionType: 'named' },
    displayDate: '1900',
    yearStart: 1900,
    yearEnd: 1900,
    medium: 'oil',
    mediumCategory: 'painting',
    region: null,
    period: null,
    imageUrls: { full: 'https://images.metmuseum.org/full.jpg', thumbnail: 'https://images.metmuseum.org/thumb.jpg', ...over },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: { type: 'CC0', rawValue: 'true', verificationSource: 'test', verifiedAt: '2026-01-01T00:00:00.000Z', confidence: 'high' },
    source: { apiUrl: 'https://t.example/api', pageUrl: 'https://t.example/1' },
  };
}

// A fake sharp that ignores resize and yields a fixed raw RGB(A) buffer.
// metadata() returns dimensions well within the decompression-bomb cap.
function fakeSharp(data: Uint8Array, channels: number): SharpLike {
  return (() => {
    const chain = {
      metadata: async () => ({ width: 2, height: 2, channels }),
      resize: () => chain,
      raw: () => chain,
      toBuffer: async () => ({ data, info: { width: 2, height: 2, channels } }),
    };
    return chain;
  }) as unknown as SharpLike;
}

describe('createColorExtractor — fail-open', () => {
  it('returns null when sharp is unavailable (the .mcpb / Workers / no-sharp case)', async () => {
    const extract = createColorExtractor({
      loadSharp: async () => null,
      fetchImage: async () => new Uint8Array([1, 2, 3]),
    });
    expect(await extract(artwork())).toBeNull();
  });

  it('returns null when the record has no image url', async () => {
    const extract = createColorExtractor({
      loadSharp: async () => fakeSharp(new Uint8Array([255, 0, 0]), 3),
      fetchImage: async () => new Uint8Array([1]),
    });
    expect(await extract(artwork({ full: '', thumbnail: '' }))).toBeNull();
  });

  it('returns null when the image fetch fails', async () => {
    const extract = createColorExtractor({
      loadSharp: async () => fakeSharp(new Uint8Array([255, 0, 0]), 3),
      fetchImage: async () => null,
    });
    expect(await extract(artwork())).toBeNull();
  });

  it('returns null (does not throw) when decoding throws', async () => {
    const throwingSharp = (() => ({
      resize: () => {
        throw new Error('decode boom');
      },
    })) as unknown as SharpLike;
    const extract = createColorExtractor({
      loadSharp: async () => throwingSharp,
      fetchImage: async () => new Uint8Array([1, 2, 3]),
    });
    expect(await extract(artwork())).toBeNull();
  });
});

describe('createColorExtractor — default fetch byte cap', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails open when the image exceeds the byte cap (oversized Content-Length)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-length': String(50 * 1024 * 1024) },
      })),
    );
    // default fetchImage (not injected) so the cap is exercised
    const extract = createColorExtractor({
      loadSharp: async () => fakeSharp(new Uint8Array([255, 0, 0]), 3),
    });
    expect(await extract(artwork())).toBeNull();
  });
});

describe('createColorExtractor — default fetch is bounded in time and bytes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const sharpOk = () => fakeSharp(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]), 3);

  async function settles<T>(p: Promise<T>, afterMs: number): Promise<{ settled: boolean; value?: T }> {
    let settled = false;
    let value: T | undefined;
    void p.then((v) => {
      settled = true;
      value = v;
    });
    await vi.advanceTimersByTimeAsync(afterMs);
    return { settled, value };
  }

  it('gives up on a fetch that never resolves and ignores the abort signal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const extract = createColorExtractor({ loadSharp: async () => sharpOk(), imageTimeoutMs: 2000 });
    const pending = extract(artwork());
    expect((await settles(pending, 1999)).settled).toBe(false);
    const after = await settles(pending, 1);
    expect(after.settled).toBe(true);
    expect(after.value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the underlying request at the bound', async () => {
    const seen: { signal?: AbortSignal | null } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        seen.signal = init?.signal;
        return new Promise<Response>(() => undefined);
      }),
    );
    const extract = createColorExtractor({ loadSharp: async () => sharpOk(), imageTimeoutMs: 500 });
    const pending = extract(artwork());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBeNull();
    expect(seen.signal?.aborted).toBe(true);
  });

  it('gives up on a body that starts and then stalls', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const extract = createColorExtractor({ loadSharp: async () => sharpOk(), imageTimeoutMs: 1000 });
    const pending = extract(artwork());
    expect((await settles(pending, 999)).settled).toBe(false);
    const after = await settles(pending, 1);
    expect(after.settled).toBe(true);
    expect(after.value).toBeNull();
  });

  it('one deadline covers the whole redirect chain', async () => {
    let hop = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        hop++;
        await new Promise((r) => setTimeout(r, 400));
        return new Response(null, { status: 302, headers: { location: `https://images.metmuseum.org/hop${hop}.jpg` } });
      }),
    );
    const extract = createColorExtractor({ loadSharp: async () => sharpOk(), imageTimeoutMs: 1000 });
    const pending = extract(artwork());
    const out = await settles(pending, 1000);
    expect(out.settled).toBe(true);
    expect(out.value).toBeNull();
    expect(hop).toBeLessThan(5);
  });

  it('refuses a redirect from the SMK thumbnail path to another path on the same host', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://api.smk.dk/api/v1/download/x/KMS1.jpg' } }));
    vi.stubGlobal('fetch', fetchMock);
    const extract = createColorExtractor({ loadSharp: async () => sharpOk() });
    const result = await extract(artwork({ thumbnail: 'https://api.smk.dk/api/v1/thumbnail/0607f3ca-f8b9-4ecc-9fd0-af0607241cc7.jpg' }));
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops reading a body that outgrows the byte cap when no Content-Length is declared', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1024 * 1024;
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const extract = createColorExtractor({ loadSharp: async () => sharpOk() });
    expect(await extract(artwork())).toBeNull();
    // 8 MiB cap: it must stop within a few chunks of it, not drain the stream.
    expect(pulled).toBeLessThan(16 * 1024 * 1024);
  });

  it('still returns colour for a normal image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9, 9, 9, 9]), { status: 200 })));
    const extract = createColorExtractor({ loadSharp: async () => sharpOk() });
    const result = await extract(artwork());
    expect(result).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unusable image timeout (%s)', (bad) => {
    expect(() => createColorExtractor({ imageTimeoutMs: bad })).toThrow(RangeError);
  });
});

describe('createColorExtractor — extraction', () => {
  it('extracts colour from the decoded pixels (solid red)', async () => {
    // four red pixels, 3 channels
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]);
    const extract = createColorExtractor({
      loadSharp: async () => fakeSharp(data, 3),
      fetchImage: async () => new Uint8Array([1, 2, 3]),
    });
    const c = await extract(artwork());
    expect(c?.dominantColor).toBe('#ff0000');
    expect(c?.colorFamily).toBe('red');
  });

  it('prefers the thumbnail URL over the full image (bandwidth)', async () => {
    const fetchImage = vi.fn(async () => new Uint8Array([255, 0, 0, 255, 0, 0]));
    const extract = createColorExtractor({
      loadSharp: async () => fakeSharp(new Uint8Array([255, 0, 0, 255, 0, 0]), 3),
      fetchImage,
    });
    await extract(artwork());
    expect(fetchImage).toHaveBeenCalledWith('https://images.metmuseum.org/thumb.jpg');
  });

  it('skips fully transparent pixels when an alpha channel is present', async () => {
    // one opaque blue pixel + one transparent pixel (alpha 0)
    const data = new Uint8Array([0, 0, 255, 255, 0, 0, 0, 0]);
    const extract = createColorExtractor({
      loadSharp: async () => fakeSharp(data, 4),
      fetchImage: async () => new Uint8Array([1]),
    });
    const c = await extract(artwork());
    expect(c?.dominantColor).toBe('#0000ff');
    expect(c?.colorFamily).toBe('blue');
  });
});
