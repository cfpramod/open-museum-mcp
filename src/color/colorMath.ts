/**
 * Pure colour math — Workers-safe (no `node:` imports, no `sharp`, no I/O).
 *
 * This is the READ-side of the colour feature: hex/RGB/CIELAB conversion,
 * CIEDE2000 perceptual distance, the controlled colour-family bins, and a small
 * pixel quantizer. Colour *extraction* (decoding image bytes) lives in the
 * Node-only `extract.ts` and is never imported by the engine core, so the core
 * stays runnable on Cloudflare Workers, which only ever read precomputed colour.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  l: number;
  a: number;
  b: number;
}

export interface PaletteEntry {
  hex: string;
  /** Fraction of sampled pixels in this colour's cluster, 0..1. */
  weight: number;
}

export const COLOR_FAMILY_NAMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'brown',
  'neutral',
  'black',
  'white',
] as const;

export type ColorFamily = (typeof COLOR_FAMILY_NAMES)[number];

/** Precomputed colour for one artwork. Stored on the cached record. */
export interface ColorData {
  dominantColor: string;
  palette: PaletteEntry[];
  colorFamily: ColorFamily;
  /** CIELAB of the dominant colour, for distance queries (derivable from hex). */
  lab: Lab;
}

// --- hex <-> rgb ---

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace(/^#/, '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// --- rgb -> CIELAB (sRGB, D65) ---

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToLab({ r, g, b }: Rgb): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  // sRGB -> XYZ (D65), scaled to the 0..100 reference-white range.
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) * 100;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) * 100;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) * 100;
  // D65 reference white.
  const Xn = 95.047;
  const Yn = 100.0;
  const Zn = 108.883;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const f = (t: number) => (t > e ? Math.cbrt(t) : (k * t + 16) / 116);
  const fx = f(x / Xn);
  const fy = f(y / Yn);
  const fz = f(z / Zn);
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function hexToLab(hex: string): Lab {
  return rgbToLab(hexToRgb(hex));
}

// --- CIEDE2000 perceptual distance ---

const DEG = Math.PI / 180;

function hueDeg(b: number, ap: number): number {
  if (b === 0 && ap === 0) return 0;
  const h = Math.atan2(b, ap) / DEG;
  return h < 0 ? h + 360 : h;
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). kL=kC=kH=1. */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const { l: L1, a: a1, b: b1 } = lab1;
  const { l: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    let diff = h2p - h1p;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    dhp = diff;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) {
      if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
      else hbarp = (h1p + h2p - 360) / 2;
    } else {
      hbarp = (h1p + h2p) / 2;
    }
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG);

  const dtheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dtheta * DEG) * Rc;

  return Math.sqrt(
    Math.pow(dLp / Sl, 2) +
      Math.pow(dCp / Sc, 2) +
      Math.pow(dHp / Sh, 2) +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// --- colour-family bins ---

interface FamilyRef {
  name: ColorFamily;
  hex: string;
}

// Reference anchors for the eleven bins. A colour is assigned to the family
// whose anchor is nearest in CIEDE2000 — because CIEDE2000 weights chroma
// strongly, low-chroma colours fall naturally to black/neutral/white by
// lightness rather than to a saturated hue.
const FAMILY_REFS: FamilyRef[] = [
  { name: 'red', hex: '#ff0000' },
  { name: 'orange', hex: '#ff8000' },
  { name: 'yellow', hex: '#ffff00' },
  { name: 'green', hex: '#00a000' },
  { name: 'blue', hex: '#0000ff' },
  { name: 'purple', hex: '#800080' },
  { name: 'pink', hex: '#ff80c0' },
  { name: 'brown', hex: '#804000' },
  { name: 'neutral', hex: '#808080' },
  { name: 'black', hex: '#000000' },
  { name: 'white', hex: '#ffffff' },
];

/** The eleven colour-family bins with their reference anchor hexes. */
export const COLOR_FAMILIES: ReadonlyArray<{ name: ColorFamily; hex: string }> = FAMILY_REFS;

const FAMILY_LABS: Array<{ name: ColorFamily; lab: Lab }> = FAMILY_REFS.map((f) => ({
  name: f.name,
  lab: hexToLab(f.hex),
}));

/** Bin a CIELAB colour to its nearest colour family by CIEDE2000. */
export function nearestColorFamily(lab: Lab): ColorFamily {
  let best: ColorFamily = 'neutral';
  let bestDist = Infinity;
  for (const ref of FAMILY_LABS) {
    const d = ciede2000(lab, ref.lab);
    if (d < bestDist) {
      bestDist = d;
      best = ref.name;
    }
  }
  return best;
}

// --- quantization ---

// Quantize each channel to 16 levels (>>4) so near-identical pixels cluster.
function bucketKey({ r, g, b }: Rgb): number {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

/**
 * Cluster sampled pixels into a dominant colour + top-5 palette, then derive the
 * CIELAB and colour family of the dominant. Returns null for an empty sample set
 * so the caller can fail open (colour fields stay null, record still valid).
 */
export function quantizeColors(samples: Rgb[]): ColorData | null {
  if (samples.length === 0) return null;

  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (const px of samples) {
    const key = bucketKey(px);
    let e = buckets.get(key);
    if (!e) {
      e = { count: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, e);
    }
    e.count++;
    e.r += px.r;
    e.g += px.g;
    e.b += px.b;
  }

  const total = samples.length;
  const palette: PaletteEntry[] = [...buckets.values()]
    .sort((x, y) => y.count - x.count)
    .slice(0, 5)
    .map((e) => ({
      hex: rgbToHex({ r: e.r / e.count, g: e.g / e.count, b: e.b / e.count }),
      weight: e.count / total,
    }));

  const dominantColor = palette[0].hex;
  const lab = hexToLab(dominantColor);
  return { dominantColor, palette, colorFamily: nearestColorFamily(lab), lab };
}
