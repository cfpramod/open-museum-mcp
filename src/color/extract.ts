/**
 * Node-side colour extraction. NOT Workers-safe and NOT imported by the engine
 * core — only the Node MCP server (or a future enrichment job) wires it in.
 *
 * `sharp` is an OPTIONAL, lazily-loaded native dependency. If it is absent — the
 * `.mcpb` bundle (which is built native-free), a Workers runtime, or CI without
 * it — extraction is simply skipped and returns null. Colour is an enrichment,
 * so it fails OPEN: a record with no colour is still valid (unlike the rights
 * gate, which fails closed). Image-fetch and decode failures fail open too.
 */

import type { Artwork } from '../types.js';
import { quantizeColors, type ColorData, type Rgb } from './colorMath.js';

/** Minimal structural type for the slice of sharp's API we use. */
export type SharpLike = (input: Uint8Array) => {
  resize: (w: number, h: number, opts?: unknown) => ReturnType<SharpLike>;
  raw: () => ReturnType<SharpLike>;
  toBuffer: (opts: { resolveWithObject: true }) => Promise<{
    data: Uint8Array;
    info: { width: number; height: number; channels: number };
  }>;
};

export interface ColorExtractorOptions {
  /**
   * Lazily load sharp; resolves null when unavailable (fail-open). Injectable so
   * tests never depend on the native module being installed.
   */
  loadSharp?: () => Promise<SharpLike | null>;
  /** Fetch image bytes; resolves null on failure. Injectable for tests. */
  fetchImage?: (url: string) => Promise<Uint8Array | null>;
  /** Square downsample target for the thumbnail. Default 32 (dominant colour is scale-invariant enough). */
  sampleSize?: number;
}

export type ColorExtractor = (artwork: Artwork) => Promise<ColorData | null>;

const DEFAULT_SAMPLE = 32;

// Defence-in-depth byte cap on the enrichment fetch. Thumbnails are tiny; a
// multi-MB response means a wrong/oversized URL, so we fail open past the cap
// rather than buffer it. Checked against Content-Length and the actual bytes.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function defaultLoadSharp(): Promise<SharpLike | null> {
  try {
    // Variable specifier on purpose: sharp is an OPTIONAL native dependency, so
    // typecheck and the `.mcpb`/Workers builds must not statically resolve it. A
    // literal `import('sharp')` would make tsc require the module to be present.
    const specifier = 'sharp';
    const mod = (await import(specifier)) as { default?: SharpLike } & Partial<SharpLike>;
    const fn = (mod.default ?? mod) as unknown;
    return typeof fn === 'function' ? (fn as SharpLike) : null;
  } catch {
    return null; // sharp not installed -> fail open
  }
}

async function defaultFetchImage(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Build a colour extractor capability to inject into the federation. The
 * federation calls it (Node only) after the rights gate passes; when it returns
 * null, colour fields stay unset.
 */
export function createColorExtractor(opts: ColorExtractorOptions = {}): ColorExtractor {
  const loadSharp = opts.loadSharp ?? defaultLoadSharp;
  const fetchImage = opts.fetchImage ?? defaultFetchImage;
  const size = opts.sampleSize ?? DEFAULT_SAMPLE;

  return async function extractColor(art: Artwork): Promise<ColorData | null> {
    const url = art.imageUrls.thumbnail || art.imageUrls.full;
    if (!url) return null;

    const sharp = await loadSharp();
    if (!sharp) return null;

    const bytes = await fetchImage(url);
    if (!bytes || bytes.length === 0) return null;

    try {
      const { data, info } = await sharp(bytes)
        .resize(size, size, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const channels = info.channels;
      if (channels < 3) return null;

      const samples: Rgb[] = [];
      for (let i = 0; i + channels - 1 < data.length; i += channels) {
        // Drop fully transparent pixels so a transparent border doesn't skew the palette.
        if (channels === 4 && data[i + 3] === 0) continue;
        samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
      }
      return quantizeColors(samples);
    } catch {
      return null; // decode failure -> fail open
    }
  };
}
