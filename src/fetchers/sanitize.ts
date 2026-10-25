/**
 * Text sanitization for upstream museum data flowing into LLM context.
 *
 * Museum APIs — especially community-contributed ones (Wikimedia, Europeana)
 * — can carry HTML markup, embedded injection payloads, or arbitrarily long
 * strings. Every field that ends up in an Artwork must be stripped and capped
 * before it reaches the wire. Strict default: strip then cap, never the
 * reverse (capping first could leave a trailing open tag). Control characters
 * are removed too, except the whitespace controls, which collapse to a space.
 *
 * Field caps (chosen to be generous for legitimate data while bounding the
 * token surface area for any single field in LLM context):
 *   title        ≤ 256 chars   — longest known real artwork title is ~200 chars
 *   description  ≤ 1024 chars  — prose summaries; museum object descriptions
 *   artistName   ≤ 200 chars   — full attribution strings incl. birth/death
 */

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

export function stripHtml(s: string): string {
  return decodeEntities(stripTags(s))
    .replace(C1_CHARS, mapWindows1252)
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export const TITLE_MAX = 256;
export const DESCRIPTION_MAX = 1024;
export const ARTIST_NAME_MAX = 200;

export function sanitizeTitle(s: string): string {
  return cap(stripHtml(s), TITLE_MAX);
}

export function sanitizeDescription(s: string): string {
  return cap(stripHtml(s), DESCRIPTION_MAX);
}

export function sanitizeArtistName(s: string): string {
  return cap(stripHtml(s), ARTIST_NAME_MAX);
}
