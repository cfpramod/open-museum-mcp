/**
 * Text sanitization for upstream museum data flowing into LLM context.
 *
 * Museum APIs — especially community-contributed ones (Wikimedia, Europeana)
 * — can carry HTML markup, embedded injection payloads, or arbitrarily long
 * strings. Every field that ends up in an Artwork must be stripped and capped
 * before it reaches the wire. Strict default: strip then cap, never the
 * reverse (capping first could leave a trailing open tag). Control characters
 * are removed too, except the whitespace controls, which collapse to a space.
 * Unicode tag characters and bidirectional embeddings, overrides and isolates
 * are removed as well: they hide or reorder text without showing it.
 *
 * Field caps (chosen to be generous for legitimate data while bounding the
 * token surface area for any single field in LLM context):
 *   title        ≤ 256 chars   — longest known real artwork title is ~200 chars
 *   description  ≤ 1024 chars  — prose summaries; museum object descriptions
 *   artistName   ≤ 200 chars   — full attribution strings incl. birth/death
 *   creditLine   ≤ 512 chars   (fund and donor lines, which can name several donors)
 *   accession    ≤ 64 chars    (object numbers, including part suffixes such as "a-c")
 *
 * The remaining text fields have caps of their own below, and
 * sanitizeArtworkText applies all of them to the finished record.
 */

import type { Artwork, CreditLine } from '../types.js';

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
};

// The HTML spec's numeric character reference end state reads references in
// 0x80..0x9F as windows-1252. stripHtml applies the same table to literal C1
// characters, which in museum text are windows-1252 bytes decoded as Latin-1
// ("1900\u00961910" is an en dash, "Monet\u0092s" an apostrophe), so a literal
// and its reference give the same output. The five code points the table
// leaves out (0x81, 0x8D, 0x8F, 0x90, 0x9D) stay C1 controls and are removed.
const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020,
  0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

// Decode a numeric character reference only when it names a Unicode scalar
// value (0..0x10FFFF, excluding the surrogate range 0xD800..0xDFFF). Anything
// else is left verbatim: String.fromCodePoint throws RangeError above 0x10FFFF,
// and a lone surrogate would put malformed UTF-16 on the wire. Within range,
// 0 becomes U+FFFD, as the spec says; 0x80..0x9F decode to C1 here and go
// through the windows-1252 table in stripHtml, with the literals.
function decodeCodePoint(ref: string, codePoint: number): string {
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return ref;
  if (codePoint === 0) return '\uFFFD';
  return String.fromCodePoint(codePoint);
}

const C1_CHARS = /[\u0080-\u009F]/g;

function mapWindows1252(c: string): string {
  const mapped = WINDOWS_1252[c.charCodeAt(0)];
  return mapped === undefined ? c : String.fromCodePoint(mapped);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&([a-z]+);/gi, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (m, code: string) => decodeCodePoint(m, parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => decodeCodePoint(m, parseInt(hex, 16)));
}

// Remove HTML tags with a single linear pass instead of a `/<[^>]*>/g` global
// replace. That regex is super-linear (O(n²)) on a pathological all-'<' string
// with no closing '>': at every '<' the engine scans to the end before failing
// to find a '>', then restarts one position over. Museum field values are
// attacker-controlled (the E1 threat model), so an uncapped '<<<<…' title would
// be a polynomial-ReDoS (CodeQL js/polynomial-redos). This scan is O(n) and
// preserves the regex's exact semantics: it strips each `<` up to the FIRST
// following `>`, and leaves an unclosed trailing `<…` (no `>`) verbatim, exactly
// as `/<[^>]*>/` would (it can't match without a closing `>`).
function stripTags(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) {
      // No closing '>': the unclosed '<…' tail is not a tag — keep it verbatim.
      out += s.slice(lt);
      break;
    }
    i = gt + 1; // skip the '<…>' tag
  }
  return out;
}

// C0 controls other than the whitespace controls \t \n \v \f \r, DEL, and the
// C1 controls the windows-1252 table leaves unmapped. Removed after decoding
// and mapping, so a decoded reference cannot bring one back,
// and before the whitespace collapse, so the whitespace controls still
// separate words. A NUL in a title truncated the cache's `title` column while
// `full_record` kept the whole string.
const CONTROL_CHARS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

// Format characters that change what a field says without being seen. Tag
// characters (U+E0000-U+E007F) mirror ASCII and render as nothing, so a field
// can carry an instruction a reader never sees but a language model reads.
// Bidirectional embeddings, overrides and isolates (U+202A-U+202E,
// U+2066-U+2069) reorder the display, so the text shown is not the text
// stored. Removed after decoding, like the controls. Bidirectional marks
// (U+200E, U+200F, U+061C), the zero-width joiners and variation selectors
// stay: right-to-left titles, Persian and Indic scripts and ideographic
// variants depend on them.
const HIDDEN_FORMAT_CHARS = /[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

// The character-level half of stripHtml: map C1, remove controls and hidden
// format characters, collapse whitespace. It decodes nothing, so applying it
// to its own output, or to stripHtml's, changes nothing. That is what lets
// sanitizeArtworkText run over fields an adapter has already sanitized.
export function cleanText(s: string): string {
  return s
    .replace(C1_CHARS, mapWindows1252)
    .replace(CONTROL_CHARS, '')
    .replace(HIDDEN_FORMAT_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripHtml(s: string): string {
  return cleanText(decodeEntities(stripTags(s)));
}

// Cut to at most maxLen UTF-16 units without splitting a surrogate pair,
// then drop any space the cut leaves at the end. Its output is never longer
// than maxLen, never ends in a space and holds no lone surrogate it did not
// receive, so capping it again (as sanitizeArtworkText does after an adapter
// has) changes nothing.
function cap(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const last = s.charCodeAt(maxLen - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maxLen - 1 : maxLen;
  return s.slice(0, end).trimEnd();
}

export const TITLE_MAX = 256;
export const DESCRIPTION_MAX = 1024;
export const ARTIST_NAME_MAX = 200;
export const CREDIT_LINE_MAX = 512;
export const ACCESSION_MAX = 64;

// Caps for the other upstream text fields, set well above the longest value
// in about 14,700 cached records: medium 803, dimensions 302, display date 200,
// object type, period, region and tags all under 60.
export const MEDIUM_MAX = 1024;
export const DIMENSIONS_MAX = 512;
export const SHORT_TEXT_MAX = 256;

/**
 * Sanitize an upstream text field that has no dedicated function: strip
 * markup, decode references, clean characters, then cap.
 */
export function sanitizeText(s: string, maxLen: number): string {
  return cap(stripHtml(s), maxLen);
}

function cleanRequired(s: string, maxLen: number, fallback: string): string {
  return cap(cleanText(s), maxLen) || fallback;
}

function cleanOptional(s: string | undefined, maxLen: number): string | undefined {
  if (s === undefined) return undefined;
  return cap(cleanText(s), maxLen) || undefined;
}

function cleanNullable(s: string | null, maxLen: number): string | null {
  if (s === null) return null;
  return cap(cleanText(s), maxLen) || null;
}

// A credit line that cleans to no holder, or to neither a fund nor an
// accession number, becomes absent, as buildCreditLine would have made it.
function cleanCreditLine(line: CreditLine | undefined): CreditLine | undefined {
  if (line === undefined) return undefined;
  const holder = cap(cleanText(line.holder), TITLE_MAX);
  const fund = cleanOptional(line.fund, CREDIT_LINE_MAX);
  const accession = cleanOptional(line.accession, ACCESSION_MAX);
  if (holder === '' || (fund === undefined && accession === undefined)) return undefined;
  const out: CreditLine = { holder };
  if (fund !== undefined) out.fund = fund;
  if (accession !== undefined) out.accession = accession;
  return out;
}

/**
 * The last step of every adapter's normalize(): clean and cap every text
 * field of the record, whatever path the adapter took to fill it. Adapters
 * still decode their own fields, since only they know whether a source sends
 * markup; this pass decodes nothing and is idempotent, so a field the adapter
 * already sanitized comes through unchanged. A field that cleans to nothing
 * takes the same fallback the adapters use.
 *
 * Two fields are left as the source sent them: `license.rawValue`, which the
 * clearance manifest quotes as the value the source API returned, and
 * `provenance`, whose `raw` is verbatim by definition.
 */
export function sanitizeArtworkText(artwork: Artwork): Artwork {
  const { artist } = artwork;
  return {
    ...artwork,
    museum: {
      ...artwork.museum,
      name: cleanRequired(artwork.museum.name, SHORT_TEXT_MAX, artwork.museum.code),
    },
    title: cleanRequired(artwork.title, TITLE_MAX, '(Untitled)'),
    artist: {
      ...artist,
      name: cleanRequired(artist.name, ARTIST_NAME_MAX, 'Unknown'),
      nationality: cleanOptional(artist.nationality, ARTIST_NAME_MAX),
      lifespan: cleanOptional(artist.lifespan, ARTIST_NAME_MAX),
    },
    displayDate: cap(cleanText(artwork.displayDate), SHORT_TEXT_MAX),
    medium: cap(cleanText(artwork.medium), MEDIUM_MAX),
    region: cleanNullable(artwork.region, SHORT_TEXT_MAX),
    period: cleanNullable(artwork.period, SHORT_TEXT_MAX),
    description: cleanOptional(artwork.description, DESCRIPTION_MAX),
    objectType: cleanOptional(artwork.objectType, SHORT_TEXT_MAX),
    dimensions: cleanOptional(artwork.dimensions, DIMENSIONS_MAX),
    creditLine: cleanCreditLine(artwork.creditLine),
    rawTags: artwork.rawTags
      ?.map((t) => cap(cleanText(t), SHORT_TEXT_MAX))
      .filter((t) => t !== ''),
  };
}

export function sanitizeTitle(s: string): string {
  return cap(stripHtml(s), TITLE_MAX);
}

export function sanitizeDescription(s: string): string {
  return cap(stripHtml(s), DESCRIPTION_MAX);
}

export function sanitizeArtistName(s: string): string {
  return cap(stripHtml(s), ARTIST_NAME_MAX);
}

/**
 * Sanitise an optional upstream text field: `undefined` for a non-string, and
 * for a string that is empty once markup and whitespace are removed, so an
 * Artwork field stays absent instead of carrying `""`.
 */
export function optionalText(v: unknown, sanitize: (s: string) => string): string | undefined {
  if (typeof v !== 'string') return undefined;
  const out = sanitize(v);
  return out.length > 0 ? out : undefined;
}

/**
 * Build an Artwork's credit line from a museum's raw values. Absent unless the
 * record publishes a credit line or an accession number, and absent when the
 * holder is empty. Each part is kept verbatim after sanitising; a credit line
 * that opens with the holder's own name keeps it.
 */
export function buildCreditLine(holder: string, fund: unknown, accession: unknown): CreditLine | undefined {
  const h = sanitizeTitle(holder);
  const f = optionalText(fund, (s) => cap(stripHtml(s), CREDIT_LINE_MAX));
  const a = optionalText(accession, (s) => cap(stripHtml(s), ACCESSION_MAX));
  if (h.length === 0 || (f === undefined && a === undefined)) return undefined;
  const line: CreditLine = { holder: h };
  if (f !== undefined) line.fund = f;
  if (a !== undefined) line.accession = a;
  return line;
}
