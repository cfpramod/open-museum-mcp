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

import { USER_AGENT } from '../fetchers/helpers.js';
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
// Covers IPv4 loopback/private/link-local, IPv6 loopback, IPv4-mapped IPv6
// (::ffff:a.b.c.d decimal notation and ::ffff:hex:hex notation for 169.254.x.x),
// known cloud metadata hostnames, and known DNS-to-IP resolver services.
const PRIVATE_HOST_RE = new RegExp(
  '^(' +
  // IPv4 loopback and wildcard
  'localhost|0\\.0\\.0\\.0|' +
  '127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|' +
  // IPv4 private class-A
  '10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|' +
  // IPv4 private class-B (172.16–172.31)
  '172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|' +
  // IPv4 private class-C
  '192\\.168\\.\\d{1,3}\\.\\d{1,3}|' +
  // IPv4 link-local / AWS+GCP IMDS
  '169\\.254\\.\\d{1,3}\\.\\d{1,3}|' +
  // IPv6 loopback
  '::1|' +
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — loopback
  '::ffff:127\\.\\d+\\.\\d+\\.\\d+|' +
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — class-A private
  '::ffff:10\\.\\d+\\.\\d+\\.\\d+|' +
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — class-B private
  '::ffff:172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+|' +
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — class-C private
  '::ffff:192\\.168\\.\\d+\\.\\d+|' +
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — link-local / IMDS (decimal)
  '::ffff:169\\.254\\.\\d+\\.\\d+|' +
  // IPv4-mapped IPv6: ::ffff:a9fe:a9fe = 169.254.169.254 (hex, WHATWG-compressed)
  '::ffff:a9fe:a9fe|' +
  // GCP metadata hostname
  'metadata\\.google\\.internal' +
  ')$',
  'i',
);

// Known DNS-to-IP resolver suffixes used in SSRF probes (e.g. nip.io, sslip.io).
// A hostname like "169.254.169.254.nip.io" resolves to 169.254.169.254.
const METADATA_RESOLVER_SUFFIX_RE = /\.(nip\.io|xip\.io|sslip\.io)$/i;

/**
 * Returns true when a URL is safe to fetch as an image:
 *   - scheme is http or https only
 *   - hostname is not a loopback, private-range, link-local, IPv4-mapped IPv6,
 *     known cloud metadata hostname, or known DNS resolver service
 *
 * Called on the initial URL and on every Location hop during redirect following,
 * so both direct and redirect-based SSRF vectors are blocked.
 */
export function isSafeImageUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // WHATWG URL serializes IPv6 hostnames with surrounding brackets ("[::1]").
  // Strip them before pattern matching so the regex doesn't need two forms.
  const h = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_RE.test(h)) return false;
  if (METADATA_RESOLVER_SUFFIX_RE.test(h)) return false;
  return true;
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

// Hard cap on redirect hops. Museum CDNs don't chain beyond 2–3 hops;
// anything deeper is suspicious. Fail open (return null) on overflow.
const MAX_REDIRECT_HOPS = 5;

/**
 * Fetch an image URL following redirects manually so we can re-run
 * isSafeImageUrl on every Location header before following. Uses
 * `redirect: 'manual'` to prevent the platform fetch from silently
 * following a redirect to a private IP (C2 / redirect TOCTOU fix).
 */
async function fetchImageWithSafeRedirects(startUrl: string): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      // Resolve relative Location against the current URL before validating.
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        return null;
      }
      if (!isSafeImageUrl(next)) return null;
      url = next;
      continue;
    }
    return res;
  }
  return null;
}

async function defaultFetchImage(url: string): Promise<Uint8Array | null> {
  try {
    // Museum CDNs can also 403 a UA-less request from datacenter IPs; send the
    // descriptive UA on the enrichment image fetch too. See helpers.USER_AGENT.
    // Manual redirect following re-validates every Location hop (C2 guard).
    const res = await fetchImageWithSafeRedirects(url);
    if (!res || !res.ok) return null;
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
