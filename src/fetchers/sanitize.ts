/**
 * Text sanitization for upstream museum data flowing into LLM context.
 *
 * Museum APIs — especially community-contributed ones (Wikimedia, Europeana)
 * — can carry HTML markup, embedded injection payloads, or arbitrarily long
 * strings. Every field that ends up in an Artwork must be stripped and capped
 * before it reaches the wire. Strict default: strip then cap, never the
 * reverse (capping first could leave a trailing open tag).
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

// Decode a numeric character reference only when it names a Unicode scalar
// value (0..0x10FFFF, excluding the surrogate range 0xD800..0xDFFF). Anything
// else is left verbatim: String.fromCodePoint throws RangeError above 0x10FFFF,
// and a lone surrogate would put malformed UTF-16 on the wire.
function decodeCodePoint(ref: string, codePoint: number): string {
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return ref;
  return String.fromCodePoint(codePoint);
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
//
// A removed tag leaves a space when it ends a line or a block (opening or
// closing), because a browser puts what follows on a new line: `a<br>b` and
// `<div>a</div><div>b</div>` read as two words, not one. Inline tags leave
// nothing, so markup inside a word ("Mon<i>et</i>") keeps the word whole.
// stripHtml's whitespace collapse folds the runs this leaves behind.
const SEPARATING_TAGS = new Set([
  'br', 'hr', 'p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main',
  'figure', 'figcaption', 'address',
]);

// The element name of the tag `s.slice(lt, gt + 1)`, lower-cased: the run of
// characters after `<` (and an optional `/`) up to whitespace, `/` or `>`.
export function tagNameAt(s: string, lt: number, gt: number): string {
  let i = lt + 1;
  if (s[i] === '/') i++;
  const start = i;
  while (i < gt && s[i] !== '/' && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n' && s[i] !== '\r' && s[i] !== '\f') i++;
  return s.slice(start, i).toLowerCase();
}

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
    if (SEPARATING_TAGS.has(tagNameAt(s, lt, gt))) out += ' ';
    i = gt + 1; // skip the '<…>' tag
  }
  return out;
}

export function stripHtml(s: string): string {
  return decodeEntities(stripTags(s))
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
