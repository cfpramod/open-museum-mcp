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
  /**
   * Time allowed for the whole default image fetch (every redirect hop and the
   * body). Ignored when `fetchImage` is injected. Default 10000.
   */
  imageTimeoutMs?: number;
  /** Square downsample target for the thumbnail. Default 32 (dominant colour is scale-invariant enough). */
  sampleSize?: number;
}

export type ColorExtractor = (artwork: Artwork) => Promise<ColorData | null>;

const DEFAULT_SAMPLE = 32;

// Defence-in-depth byte cap on the enrichment fetch. Thumbnails are tiny; a
// multi-MB response means a wrong/oversized URL, so we fail open past the cap
// rather than buffer it. Checked against Content-Length and the actual bytes.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Time allowed for one enrichment image fetch, redirect hops and body included.
// Colour is awaited inside getArtwork, so an image host that stalls would stall
// the search that asked for the record. Measured live on SMK, the slowest source
// this path fetches: 23 thumbnails answered in 0.15-0.92s, and whole extractions
// mostly took 0.06-0.6s with occasional first requests of 1.7-4.8s. 10s leaves
// twice the slowest measured call and still bounds a host that never answers.
const DEFAULT_IMAGE_TIMEOUT_MS = 10_000;

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

// Positive allowlist of known museum image CDN hostnames. Color extraction is
// attempted ONLY for these hosts. Any other host (including unknown third-party
// CDNs that Europeana's edmIsShownBy may reference) causes extraction to fail
// OPEN — the record is still valid, color is simply omitted. This closes the
// DNS-rebinding vector (F1): an attacker-controlled domain that resolves to an
// internal IP passes isSafeImageUrl's string checks but is stopped here before
// any outbound fetch occurs.
const CDN_ALLOWLIST = new Set([
  'images.metmuseum.org',           // Met Museum image CDN
  'openaccess-cdn.clevelandart.org', // Cleveland Museum of Art CDN
  'www.artic.edu',                   // Art Institute of Chicago (full images)
  'iiif.artic.edu',                  // Art Institute of Chicago (IIIF server)
  'upload.wikimedia.org',            // Wikimedia Commons media repository
  'commons.wikimedia.org',           // Wikimedia Commons (some thumb paths)
  'api.europeana.eu',                // Europeana thumbnail proxy
  'ids.si.edu',                      // Smithsonian IDS image server (deliveryService + IIIF)
  'iiif.micr.io',                    // Rijksmuseum images via Micrio IIIF (data.rijksmuseum.nl)
  'iiif.wellcomecollection.org',     // Wellcome Collection IIIF image server
  'api.nga.gov',                     // National Gallery of Art IIIF image server
  // SMK's 1024px thumbnail rendition for records with an IIIF image.
  'iip-thumb.smk.dk',
  'media.getty.edu',                 // J. Paul Getty Museum IIIF image server
  // Europeana edmIsShownBy (full images) comes from arbitrary per-provider
  // CDNs — those are intentionally NOT listed here and will fail open.
]);

// Hosts allowed only for one path shape. api.smk.dk publishes the thumbnail for
// records without an IIIF image, but the same host also serves the full-resolution
// /download derivative, which 503s, returns empty bodies and streams for minutes
// (measured live), and colour never needs it. The pattern is one plain path
// segment with no query: dot segments are resolved by URL parsing before this
// check, and percent-encoded slashes or backslashes cannot match.
const CDN_PATH_SCOPED: ReadonlyMap<string, RegExp> = new Map([
  ['api.smk.dk', /^\/api\/v1\/thumbnail\/[A-Za-z0-9-]+\.jpg$/],
]);

/**
 * Returns true when the image URL's hostname is on the CDN allowlist, or is a
 * path-scoped host and the URL matches its one allowed path shape.
 * Non-allowlisted URLs cause color extraction to fail open (return null)
 * without any outbound fetch — the record itself is unaffected.
 */
export function isAllowlistedImageHost(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  if (CDN_ALLOWLIST.has(url.hostname)) return true;
  const pathPattern = CDN_PATH_SCOPED.get(url.hostname);
  return pathPattern !== undefined && url.search === '' && pathPattern.test(url.pathname);
}

/**
 * Returns true when a native (non-IPv4-mapped) IPv6 hostname falls in a private
 * or cloud-infrastructure range not covered by PRIVATE_HOST_RE:
 *   - fc00::/7  (unique-local — IPv6 equivalent of RFC1918 private ranges)
 *   - fe80::/10 (link-local — IPv6 equivalent of 169.254.x.x)
 *   - ::        (unspecified address, all zeros)
 *
 * Operates on the bracket-stripped WHATWG-normalized hostname.  WHATWG always
 * lowercases and compresses IPv6, so the first colon-delimited group is a
 * predictable 1–4 hex digit string that can be checked with bitmask arithmetic.
 */
function isPrivateNativeIPv6(h: string): boolean {
  if (h === '::') return true;
  // Addresses starting with '::' (other than bare '::') are handled by
  // PRIVATE_HOST_RE (::1 loopback, ::ffff:... IPv4-mapped) — skip here.
  if (h.startsWith('::')) return false;
  const firstColon = h.indexOf(':');
  if (firstColon <= 0) return false;
  const val = parseInt(h.slice(0, firstColon), 16);
  if (isNaN(val)) return false;
  // fc00::/7 — unique-local: first 7 bits == 1111 110x (mask 0xfe00, value 0xfc00).
  // Covers fc00:: through fdff::, including fd00:ec2::254 (AWS IMDSv2).
  if ((val & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local: first 10 bits == 1111 1110 10xx xxxx (mask 0xffc0, value 0xfe80).
  // Covers fe80:: through febf::.
  if ((val & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * Returns true when a URL is safe to fetch as an image:
 *   - scheme is http or https only
 *   - hostname is not a loopback, private-range, link-local, IPv4-mapped IPv6,
 *     native IPv6 private/link-local, known cloud metadata hostname, or known
 *     DNS resolver service
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
  if (isPrivateNativeIPv6(h)) return false;
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
async function fetchImageWithSafeRedirects(startUrl: string, signal: AbortSignal): Promise<Response | null> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal,
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
      if (!isSafeImageUrl(next) || !isAllowlistedImageHost(next)) return null;
      url = next;
      continue;
    }
    return res;
  }
  return null;
}

/**
 * Wait for `work`, but give up the moment `signal` aborts. A fetch that honours
 * the signal rejects on its own; this also covers one that does not (a stub, a
 * stalled body read), so the deadline holds either way.
 */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Read a response body, stopping at the byte cap rather than buffering past it.
 * The Content-Length check alone is not enough: the header can be absent or wrong.
 */
async function readCapped(res: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(signal, reader.read());
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function makeDefaultFetchImage(timeoutMs: number): (url: string) => Promise<Uint8Array | null> {
  return async function defaultFetchImage(url: string): Promise<Uint8Array | null> {
    // One deadline covers every redirect hop and the body, so no stage can hold
    // the caller past it. Aborting also tears the request down.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException(`image fetch timed out after ${timeoutMs}ms`, 'TimeoutError')), timeoutMs);
    try {
      // Museum CDNs can also 403 a UA-less request from datacenter IPs; send the
      // descriptive UA on the enrichment image fetch too. See helpers.USER_AGENT.
      // Manual redirect following re-validates every Location hop (C2 guard).
      const res = await untilAborted(controller.signal, fetchImageWithSafeRedirects(url, controller.signal));
      if (!res || !res.ok) return null;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
      return await readCapped(res, controller.signal);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Build a colour extractor capability to inject into the federation. The
 * federation calls it (Node only) after the rights gate passes; when it returns
 * null, colour fields stay unset.
 */
export function createColorExtractor(opts: ColorExtractorOptions = {}): ColorExtractor {
  const loadSharp = opts.loadSharp ?? defaultLoadSharp;
  const imageTimeoutMs = opts.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  if (!Number.isFinite(imageTimeoutMs) || imageTimeoutMs <= 0) {
    throw new RangeError(`imageTimeoutMs must be a positive, finite number of milliseconds (got ${String(imageTimeoutMs)})`);
  }
  const fetchImage = opts.fetchImage ?? makeDefaultFetchImage(Math.min(imageTimeoutMs, 2 ** 31 - 1));
  const size = opts.sampleSize ?? DEFAULT_SAMPLE;

  return async function extractColor(art: Artwork): Promise<ColorData | null> {
    const url = art.imageUrls.thumbnail || art.imageUrls.full;
    if (!url) return null;

    // SSRF guard: reject private IPs and non-HTTP(S) schemes before any fetch.
    if (!isSafeImageUrl(url)) return null;

    // CDN allowlist: only attempt color extraction for known museum image hosts.
    // Unknown / third-party hosts (e.g. Europeana's per-provider edmIsShownBy
    // CDNs) fail open — color is omitted, the record stays valid.
    if (!isAllowlistedImageHost(url)) return null;

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
