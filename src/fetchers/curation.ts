/**
 * Non-art CURATION gate for the noisy federated sources (Wikimedia Commons,
 * Europeana). These are NOT curated art museums: they hold diagrams, charts,
 * logos, maps, flags, publication pages and specimens alongside genuine art, all
 * correctly licensed. The rights gate (licenseGate.ts) is satisfied for that
 * junk — this is a SEPARATE gate that keeps artworks and rejects non-art.
 *
 * Same idea as the Smithsonian object_type gate (smithsonian.ts): the curated
 * museums (Met/AIC/Cleveland) need no such gate; the federations do. Posture is
 * PRECISION OVER RECALL — for launch credibility it is better to drop an edge
 * artwork than to admit a publishing diagram into the collection.
 *
 * The denylist is deliberately word-boundary matched and curated to avoid
 * collisions with art vocabulary:
 *   - NO bare 'graph'  (would match photoGRAPH / lithoGRAPH)
 *   - NO 'icon'        (Orthodox / religious icons ARE art)
 *   - NO 'table'/'plate' (vegeTABLE, art "plates")
 * Each term below is a thing that is itself non-art, not a subject an artwork
 * might depict.
 */

// Unambiguous non-art nouns/phrases. Matched case-insensitively on word
// boundaries against titles + curatorial categories.
export const NON_ART_TERMS = [
  'diagram',
  'diagrams',
  'infographic',
  'infographics',
  'flowchart',
  'flowcharts',
  'flow chart',
  'schematic',
  'schematics',
  'screenshot',
  'screenshots',
  'chart',
  'charts',
  'pie chart',
  'bar chart',
  'spreadsheet',
  'spreadsheets',
  'barcode',
  'barcodes',
  'qr code',
  'clipart',
  'clip art',
  'logo',
  'logos',
  'map',
  'maps',
  'open access',
  'open-access',
  'publishing',
  'coat of arms',
  'coats of arms',
  'title page',
  'data visualization',
  'data visualisation',
] as const;

// Build one alternation, longest-first so multi-word phrases win, each guarded
// by word boundaries. Hyphens are treated as their own boundary so 'open-access'
// matches in 'open-access publishing'.
const NON_ART_RE = new RegExp(
  `\\b(?:${[...NON_ART_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i',
);

/** Return the matched non-art term (lowercased) if `text` contains one, else null. */
export function matchesNonArtTerm(text: string): string | null {
  const m = NON_ART_RE.exec(text ?? '');
  return m ? m[0].toLowerCase() : null;
}

export interface WikimediaCurationInput {
  /** imageinfo MIME (already image/* by the time the gate runs). */
  mime: string;
  /** Commons category titles (Category: prefix already stripped). */
  categories: string[];
  /** The record's display title / ObjectName. */
  title: string;
}

/**
 * Decide whether a Wikimedia Commons record is non-art. Returns a short reason
 * when it should be rejected, else null.
 *
 * Two signals:
 *  1. `image/svg+xml` — on Commons, SVG is overwhelmingly diagrams, logos,
 *     charts, maps, flags and icons, essentially never a digitised artwork
 *     (those are raster JPEG/PNG/TIFF). This is the single highest-precision rule
 *     and it catches the bulk of the publishing-diagram class.
 *  2. A category/title denylist hit — catches RASTER non-art that the SVG rule
 *     misses (e.g. a PNG "Open Access Models Overview" categorised under
 *     "Open access (publishing)").
 */
export function isNonArtWikimedia(input: WikimediaCurationInput): string | null {
  if (/^image\/svg(\+xml)?$/i.test(input.mime.trim())) {
    return 'svg vector graphic (diagram/logo/chart/map class)';
  }
  const hay = [input.title, ...input.categories].join(' | ');
  const term = matchesNonArtTerm(hay);
  return term ? `non-art signal "${term}" in title/category` : null;
}

// Europeana exposes a near-controlled type/medium signal (dcType / dctermsMedium
// / dcFormat). When it explicitly names a non-art form we reject; when it is
// absent we PASS (see the boundary note below). This list adds a few EDM/object
// types beyond the shared denylist; it is matched ONLY against the type/medium
// field, never the title, so documentary photographs are not mis-rejected.
const EUROPEANA_NON_ART_TYPES = [
  ...NON_ART_TERMS,
  'text',
  'sound',
  'video',
  'dataset',
  'specimen',
  'fossil',
  'mineral',
  'herbarium',
  '3d',
] as const;

const EUROPEANA_NON_ART_RE = new RegExp(
  `\\b(?:${[...EUROPEANA_NON_ART_TYPES]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\b`,
  'i',
);

export interface EuropeanaCurationInput {
  /** The joined dcType / dctermsMedium / dcFormat string the fetcher builds. */
  medium: string;
  /** Title — accepted for symmetry/diagnostics, NOT matched (precision). */
  title: string;
}

/**
 * Decide whether a Europeana record is non-art, on the TYPE/MEDIUM signal only.
 *
 * BOUNDARY (honest scope): most Europeana image records carry no type in the
 * search profile. Europeana's documentary-photo keyword-noise (e.g. "access road
 * to ..." matching the query word "access") is a RELEVANCE/RANKING problem — those
 * are real photographs, indistinguishable from art photographs by type — and is
 * addressed by search ranking (v1.2), NOT by this binary non-art gate. Matching
 * such records by title would reject genuine art, so this gate deliberately does
 * not. It only fires when an explicit non-art type is present.
 */
export function isNonArtEuropeana(input: EuropeanaCurationInput): string | null {
  const m = EUROPEANA_NON_ART_RE.exec(input.medium ?? '');
  return m ? m[0].toLowerCase() : null;
}
