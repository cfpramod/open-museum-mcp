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

import { httpGet } from '../fetchers/helpers.js';
import type { Artwork } from '../types.js';
import { quantizeColors, type ColorData, type Rgb } from './colorMath.js';

/**
 * Minimal structural type for the slice of sharp's API we use.
 * Includes metadata() for the decompression-bomb pre-check (reads image
 * header only, much cheaper than full decode).
 */
type SharpChain = {
  metadata: () => Promise<{ width?: number; height?: number; channels?: number }>;
  resize: (w: number, h: number, opts?: unknown) => SharpChain;
  raw: () => SharpChain;
  toBuffer: (opts: { resolveWithObject: true }) => Promise<{
    data: Uint8Array;
    info: { width: number; height: number; channels: number };
  }>;
};

export type SharpLike = (input: Uint8Array, opts?: unknown) => SharpChain;

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

// Decompression-bomb cap: reject images whose uncompressed pixel buffer
// (width × height × channels) would exceed 50 MB. A 50 MP RGB image expands
// to ~150 MB; this cap rejects pathological inputs well before decode while
// leaving legitimate high-resolution thumbnails untouched.
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

// Private IP ranges that must never be fetched from museum image URLs.
// Covers: loopback (127.x), class-A private (10.x), class-B private
// (172.16–172.31), class-C private (192.168.x), link-local / metadata
// (169.254.x — the AWS/GCP IMDS address), and the "localhost" hostname.
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|::1|0\.0\.0\.0)$/i;

/**
 * Returns true when a URL is safe to fetch as an image:
 *   - scheme is http or https only
 *   - hostname is not a loopback, private-range, or link-local address
 *
 * This is the SSRF guard for the colour-extraction path.
 */
export function isSafeImageUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !PRIVATE_HOST_RE.test(url.hostname);
}

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
    // Museum CDNs can also 403 a UA-less request from datacenter IPs; send the
    // descriptive UA on the enrichment image fetch too. See helpers.USER_AGENT.
    const res = await httpGet(url);
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

    // SSRF guard: reject private IPs and non-HTTP(S) schemes before any fetch.
    if (!isSafeImageUrl(url)) return null;

    const sharp = await loadSharp();
    if (!sharp) return null;

    const bytes = await fetchImage(url);
    if (!bytes || bytes.length === 0) return null;

    try {
      const instance = sharp(bytes);

      // Decompression-bomb pre-check: read the image header only (cheap) and
      // reject before decode if the uncompressed buffer would exceed the cap.
      const meta = await instance.metadata();
      const uncompressed = (meta.width ?? 0) * (meta.height ?? 0) * (meta.channels ?? 4);
      if (uncompressed > MAX_UNCOMPRESSED_BYTES) return null;

      const { data, info } = await instance
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
