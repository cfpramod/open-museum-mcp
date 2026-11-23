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

// A named, decimal or hexadecimal character reference.
const ENTITY_RE = /&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/gi;

// The text one ENTITY_RE match stands for, or the reference itself when it is
// left verbatim (an unknown name, or a number that is not a scalar value).
function decodeReference(ref: string, name?: string, dec?: string, hex?: string): string {
  if (name !== undefined) return HTML_ENTITIES[name.toLowerCase()] ?? ref;
  return decodeCodePoint(ref, dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16));
}

// One pass, as HTML decodes: the text a reference produces is never read
// again, so "&amp;#32;" is the literal text "&#32;", not a space.
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (ref: string, name?: string, dec?: string, hex?: string) =>
    decodeReference(ref, name, dec, hex),
  );
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
export const SEPARATING_TAGS = new Set([
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

// Walk `s` as the tag stripper reads it, reporting each run of text that stays
// and the position of each tag that leaves a separating space.
function walkTags(s: string, text: (from: number, to: number) => void, separator: (at: number) => void): void {
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      text(i, s.length);
      break;
    }
    text(i, lt);
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) {
      // No closing '>': the unclosed '<…' tail is not a tag — keep it verbatim.
      text(lt, s.length);
      break;
    }
    if (SEPARATING_TAGS.has(tagNameAt(s, lt, gt))) separator(lt);
    i = gt + 1; // skip the '<…>' tag
  }
}

function stripTags(s: string): string {
  let out = '';
  walkTags(
    s,
    (from, to) => {
      out += s.slice(from, to);
    },
    () => {
      out += ' ';
    },
  );
  return out;
}

// The text stripHtml reads, before its whitespace collapse, with the index in
// `s` that each character came from. A caller that finds something in the text
// can then act on the markup at the same place. Tags follow stripTags, and
// each character reference is decoded once with decodeEntities' own per-match
// function, after the tags are gone, as stripHtml does.
export function textView(s: string): { text: string; offsets: number[] } {
  let stripped = '';
  const strippedFrom: number[] = [];
  walkTags(
    s,
    (from, to) => {
      stripped += s.slice(from, to);
      for (let k = from; k < to; k++) strippedFrom.push(k);
    },
    (at) => {
      stripped += ' ';
      strippedFrom.push(at);
    },
  );
  let text = '';
  const offsets: number[] = [];
  let i = 0;
  const keep = (from: number, to: number): void => {
    text += stripped.slice(from, to);
    for (let k = from; k < to; k++) offsets.push(strippedFrom[k]);
  };
  for (const m of stripped.matchAll(ENTITY_RE)) {
    const [ref, name, dec, hex] = m;
    const decoded = decodeReference(ref, name, dec, hex);
    if (decoded === ref) continue; // left verbatim, kept with the text around it
    keep(i, m.index);
    text += decoded;
    for (let k = 0; k < decoded.length; k++) offsets.push(strippedFrom[m.index]);
    i = m.index + ref.length;
  }
  keep(i, stripped.length);
  return { text, offsets };
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
