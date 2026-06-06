import { afterEach, describe, expect, it, vi } from 'vitest';
import { createColorExtractor, type SharpLike } from '../../src/color/extract.js';
import type { Artwork } from '../../src/types.js';

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
    imageUrls: { full: 'https://cdn.example/full.jpg', thumbnail: 'https://cdn.example/thumb.jpg', ...over },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: { type: 'CC0', rawValue: 'true', verificationSource: 'test', verifiedAt: '2026-01-01T00:00:00.000Z', confidence: 'high' },
    source: { apiUrl: 'https://t.example/api', pageUrl: 'https://t.example/1' },
  };
}

// A fake sharp that ignores resize and yields a fixed raw RGB(A) buffer.
function fakeSharp(data: Uint8Array, channels: number): SharpLike {
  return (() => {
    const chain = {
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
    expect(fetchImage).toHaveBeenCalledWith('https://cdn.example/thumb.jpg');
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
