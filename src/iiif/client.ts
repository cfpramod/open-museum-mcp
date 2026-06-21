/**
 * Reusable IIIF client — the shared foundation for every IIIF-backed source
 * (Rijksmuseum, NGA, SMK, Yale, Belvedere, Basel, Wellcome, ...).
 *
 * Handles BOTH IIIF Presentation/Image API 2.x and 3.x, because the sources mix
 * versions. It does three things:
 *  - parse a Presentation manifest -> label, the per-object `rights` URI, and the
 *    Image API service(s);
 *  - parse an Image API `info.json` -> real pixel width/height (authoritative for
 *    the print-resolution floor);
 *  - build a `/full/max|full/0/default.jpg` request and check the >=3000px bar.
 *
 * IIIF is NOT a guarantee of print resolution — always read info.json (per the
 * integration research). This module never decides RIGHTS; it only surfaces the
 * rights URI for the shared commercial gate to judge.
 */
import { httpGet } from '../fetchers/helpers.js';

export type IiifApiVersion = 2 | 3;

export interface IiifImageRef {
  /** IIIF Image API service base (no /full/... suffix). */
  serviceId: string;
  /** A ready-to-use full-resolution request built from the service base. */
  fullUrl: string;
  /** Pixel dimensions from the canvas/body, when the manifest carries them. */
  width?: number;
  height?: number;
}

export interface IiifManifestParsed {
  apiVersion: IiifApiVersion;
  label: string;
  /** The `rights` (v3) / `license` (v2) URI, or null when absent (never guessed). */
  rights: string | null;
  /** Image services, primary canvas first. */
  images: IiifImageRef[];
}

export interface IiifInfo {
  apiVersion: IiifApiVersion;
  width: number;
  height: number;
  maxWidth?: number;
  maxHeight?: number;
  maxArea?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** IIIF v3 labels are language maps ({en:[...]}); v2 are strings or arrays. */
function firstLabel(label: unknown): string {
  if (typeof label === 'string') return label;
  if (Array.isArray(label)) {
    const s = label.find((x) => typeof x === 'string');
    if (typeof s === 'string') return s;
  }
  if (isObj(label)) {
    const en = label.en ?? label.none ?? Object.values(label)[0];
    if (Array.isArray(en) && typeof en[0] === 'string') return en[0];
    if (typeof en === 'string') return en;
  }
  return '';
}

function detectPresentationVersion(raw: Record<string, unknown>): IiifApiVersion {
  const ctx = JSON.stringify(raw['@context'] ?? '');
  if (ctx.includes('presentation/2')) return 2;
  if (ctx.includes('presentation/3')) return 3;
  // Structural fallback: v2 uses `sequences`, v3 uses `items`.
  return Array.isArray(raw.sequences) ? 2 : 3;
}

function v3Images(raw: Record<string, unknown>): IiifImageRef[] {
  const out: IiifImageRef[] = [];
  const canvases = Array.isArray(raw.items) ? raw.items : [];
  for (const canvas of canvases) {
    if (!isObj(canvas)) continue;
    const cw = asNum(canvas.width);
    const ch = asNum(canvas.height);
    const pages = Array.isArray(canvas.items) ? canvas.items : [];
    for (const page of pages) {
      if (!isObj(page)) continue;
      const annos = Array.isArray(page.items) ? page.items : [];
      for (const anno of annos) {
        if (!isObj(anno)) continue;
        const body = anno.body;
        if (!isObj(body)) continue;
        const services = Array.isArray(body.service) ? body.service : body.service ? [body.service] : [];
        const svc = services.find(isObj);
        const serviceId = svc ? (typeof svc.id === 'string' ? svc.id : typeof svc['@id'] === 'string' ? (svc['@id'] as string) : '') : '';
        if (!serviceId) continue;
        out.push({
          serviceId,
          fullUrl: fullImageUrl(serviceId, 3),
          width: asNum(body.width) ?? cw,
          height: asNum(body.height) ?? ch,
        });
      }
    }
  }
  return out;
}

function v2Images(raw: Record<string, unknown>): IiifImageRef[] {
  const out: IiifImageRef[] = [];
  const sequences = Array.isArray(raw.sequences) ? raw.sequences : [];
  for (const seq of sequences) {
    if (!isObj(seq)) continue;
    const canvases = Array.isArray(seq.canvases) ? seq.canvases : [];
    for (const canvas of canvases) {
      if (!isObj(canvas)) continue;
      const cw = asNum(canvas.width);
      const ch = asNum(canvas.height);
      const images = Array.isArray(canvas.images) ? canvas.images : [];
      for (const image of images) {
        if (!isObj(image)) continue;
        const resource = isObj(image.resource) ? image.resource : undefined;
        const service = resource && isObj(resource.service) ? resource.service : undefined;
        const serviceId = service ? (typeof service['@id'] === 'string' ? (service['@id'] as string) : typeof service.id === 'string' ? (service.id as string) : '') : '';
        if (!serviceId) continue;
        out.push({ serviceId, fullUrl: fullImageUrl(serviceId, 2), width: cw, height: ch });
      }
    }
  }
  return out;
}

/** Parse an IIIF Presentation manifest (v2 or v3). Tolerant: absent fields -> null/empty. */
export function parseManifest(raw: unknown): IiifManifestParsed {
  if (!isObj(raw)) {
    return { apiVersion: 3, label: '', rights: null, images: [] };
  }
  const apiVersion = detectPresentationVersion(raw);
  const label = firstLabel(raw.label);
  const rightsField = apiVersion === 3 ? raw.rights : (raw.rights ?? raw.license);
  const rights = typeof rightsField === 'string' ? rightsField : null;
  const images = apiVersion === 3 ? v3Images(raw) : v2Images(raw);
  return { apiVersion, label, rights, images };
}

/** Build the IIIF Image API full-resolution request for a service base. */
export function fullImageUrl(serviceId: string, apiVersion: IiifApiVersion): string {
  const base = serviceId.replace(/\/+$/, '');
  // v3 deprecates `full/full`; the canonical "largest" size is `full/max`.
  return apiVersion === 3 ? `${base}/full/max/0/default.jpg` : `${base}/full/full/0/default.jpg`;
}

/** Parse an Image API info.json. Throws if no usable width/height are present. */
export function parseInfoJson(raw: unknown): IiifInfo {
  if (!isObj(raw)) throw new Error('iiif: info.json is not an object');
  const width = asNum(raw.width);
  const height = asNum(raw.height);
  if (width === undefined || height === undefined) {
    throw new Error('iiif: info.json has no usable width/height');
  }
  const ctx = JSON.stringify(raw['@context'] ?? '');
  const apiVersion: IiifApiVersion = ctx.includes('image/2') || raw.type === 'ImageService2' ? 2 : 3;
  return {
    apiVersion,
    width,
    height,
    maxWidth: asNum(raw.maxWidth),
    maxHeight: asNum(raw.maxHeight),
    maxArea: asNum(raw.maxArea),
  };
}

/** True when the long edge meets the print/POD floor (default 3000px ≈ 300dpi @ A3). */
export function meetsPrintResolution(width: number, height: number, floorPx = 3000): boolean {
  return Math.max(width, height) >= floorPx;
}

/** Fetch + parse a Presentation manifest. */
export async function fetchManifest(url: string): Promise<IiifManifestParsed> {
  const res = await httpGet(url, { headers: { Accept: 'application/ld+json,application/json' } });
  if (!res.ok) throw new Error(`iiif: manifest fetch failed (${res.status}) for ${url}`);
  return parseManifest(await res.json());
}

/** Fetch + parse an Image API info.json for a service base. */
export async function fetchInfoJson(serviceId: string): Promise<IiifInfo> {
  const url = `${serviceId.replace(/\/+$/, '')}/info.json`;
  const res = await httpGet(url, { headers: { Accept: 'application/ld+json,application/json' } });
  if (!res.ok) throw new Error(`iiif: info.json fetch failed (${res.status}) for ${url}`);
  return parseInfoJson(await res.json());
}
