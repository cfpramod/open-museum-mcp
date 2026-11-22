/**
 * The text form of an HTML source string.
 *
 * Museums publish provenance, and other free text, as HTML. A string that the engine writes itself (an
 * interpretation string) must be text, never markup. This module derives text from an HTML source string by the
 * rules of the Clearance Manifest proposal "provenance source markup" (openclearance #59, section 4), so two
 * producers given the same source derive the same text:
 *
 *   textForm(s) = strip(decode(strip(s)))
 *
 *  - strip: one left-to-right read that removes tags, comments and declarations as they form, so markup that a
 *    removal joins together is read as it forms (`<<b>b>x` gives `x`). Comments end where HTML ends them. An
 *    unclosed tag loses only its `<`.
 *  - decode: character references decoded once, as the HTML standard decodes them in text content.
 *
 * Properties the callers rely on, each pinned by tests/textForm.test.ts against the proposal's own vectors:
 *  - deterministic, and linear in the length of the string;
 *  - the output never holds a `<` followed by an ASCII letter, `/`, `!` or `?` (the proposal's P-11 check);
 *  - a string with no markup opener and no `&` is returned unchanged, whitespace included;
 *  - NOT idempotent, and it must not be applied to its own output: it reads its input as HTML, so applying it
 *    twice would read text such as `&lt;b&gt;` as a tag. A verifier checks P-11 on an interpretation string; it
 *    never re-derives it.
 *
 * This is a function from HTML to text, not the field sanitiser: it does not collapse whitespace, cap length or
 * fold anything. A source string that must be carried as published (`ObjectProvenance.raw`) is never passed
 * through it.
 */

import { HTML_NAMED_REFERENCES, HTML_NAMED_REFERENCE_MAX_LENGTH } from './htmlEntities.js';

const LT = 0x3c;
const GT = 0x3e;
const BANG = 0x21;
const DASH = 0x2d;

// '<' followed by one of these opens markup when the HTML tokenizer reads it: an ASCII letter, '/', '!' or '?'.
// Every character the rules look at is ASCII, so working on UTF-16 code units never splits a surrogate pair.
function isOpenerUnit(u: number): boolean {
  return (u >= 0x41 && u <= 0x5a) || (u >= 0x61 && u <= 0x7a) || u === 0x2f || u === BANG || u === 0x3f;
}

// Appending to a string one chunk at a time keeps the largest argument well under the engine's argument limit.
function unitsToString(units: Uint16Array): string {
  let text = '';
  for (let i = 0; i < units.length; i += 8192) {
    text += String.fromCharCode.apply(null, units.subarray(i, i + 8192) as unknown as number[]);
  }
  return text;
}

/**
 * One left-to-right read into an output buffer. Markup is removed from the end of the buffer as soon as it is
 * complete, so markup that a removal forms is read as it forms, and each character is read at most twice.
 */
function strip(s: string): string {
  const out = new Uint16Array(s.length);
  let n = 0;
  let open = -1; // index in `out` of the '<' of the markup now open, or -1
  let comments = true;

  // Markup open at out[open] is a comment once it reads '<!--'.
  const isComment = (): boolean =>
    n - open >= 4 && out[open + 1] === BANG && out[open + 2] === DASH && out[open + 3] === DASH;

  // A comment ends at the '>' just read when HTML ends it there: '<!-->' and '<!--->', or a '>' after '--' or
  // '--!' that follows the opening '<!--'.
  const commentEnds = (): boolean => {
    const j = n - 1 - open;
    return (
      j === 4 ||
      (j === 5 && out[open + 4] === DASH) ||
      (j >= 6 && out[n - 3] === DASH && out[n - 2] === DASH) ||
      (j >= 7 && out[n - 4] === DASH && out[n - 3] === DASH && out[n - 2] === BANG)
    );
  };

  const read = (units: Uint16Array, from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      const u = units[i] as number;
      out[n] = u;
      n += 1;
      if (open < 0) {
        if (n >= 2 && out[n - 2] === LT && isOpenerUnit(u)) open = n - 2;
      } else if (u === GT && (!(comments && isComment()) || commentEnds())) {
        n = open;
        open = -1;
      }
    }
  };

  const units = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i += 1) units[i] = s.charCodeAt(i);
  read(units, 0, units.length);

  // A comment that never ends is read again as markup that ends at its first '>'. No comment opening after it
  // can end either, so comments stay off for the second read.
  if (open >= 0 && comments && isComment()) {
    const rest = out.slice(open, n);
    n = open;
    open = -1;
    comments = false;
    read(rest, 0, rest.length);
  }

  let kept: Uint16Array = out.subarray(0, n);
  if (open >= 0) {
    // Unclosed markup loses its '<'. Then, from the end back, each '<' whose next kept character opens markup
    // is dropped, which ends any chain a drop forms.
    const swept = new Uint16Array(n);
    let k = n;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (i === open) continue;
      if (out[i] === LT && k < n && isOpenerUnit(swept[k] as number)) continue;
      k -= 1;
      swept[k] = out[i] as number;
    }
    kept = swept.subarray(k);
  }
  return unitsToString(kept);
}

// The HTML standard's replacements for numeric references 0x80 to 0x9F (the Windows-1252 positions). The five
// positions the standard leaves out (0x81, 0x8D, 0x8F, 0x90, 0x9D) decode to themselves.
const C1_REPLACEMENTS: Readonly<Record<number, number>> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT_CHARACTER = 0xfffd;

function numericReferenceValue(value: number): string {
  if (value === 0 || value > MAX_CODE_POINT || (value >= 0xd800 && value <= 0xdfff)) {
    return String.fromCodePoint(REPLACEMENT_CHARACTER);
  }
  const replaced = C1_REPLACEMENTS[value];
  return String.fromCodePoint(replaced ?? value);
}

const isAsciiAlnum = (u: number): boolean =>
  (u >= 0x30 && u <= 0x39) || (u >= 0x41 && u <= 0x5a) || (u >= 0x61 && u <= 0x7a);
const isDecimalDigit = (u: number): boolean => u >= 0x30 && u <= 0x39;
const hexDigitValue = (u: number): number => {
  if (u >= 0x30 && u <= 0x39) return u - 0x30;
  if (u >= 0x41 && u <= 0x46) return u - 0x41 + 10;
  if (u >= 0x61 && u <= 0x66) return u - 0x61 + 10;
  return -1;
};

/**
 * Decode character references once, as the HTML standard decodes them in text content: named references from
 * the HTML table, including the legacy names accepted without a final ';' (so '&copy 1920' decodes, and
 * '&notit;' decodes its longest legacy prefix to '¬it;'), and numeric references with the standard's
 * replacements. An '&' that starts no reference stays as it is.
 */
function decode(s: string): string {
  let amp = s.indexOf('&');
  if (amp === -1) return s;
  let out = '';
  let from = 0;
  while (amp !== -1) {
    out += s.slice(from, amp);
    let consumedTo = amp + 1; // index just past what this '&' consumed
    let replacement = '&';

    if (s.charCodeAt(amp + 1) === 0x23) {
      // '&#' then decimal digits, or 'x'/'X' then hex digits, then an optional ';'.
      let j = amp + 2;
      const hex = s.charCodeAt(j) === 0x78 || s.charCodeAt(j) === 0x58;
      if (hex) j += 1;
      let value = 0;
      let digits = 0;
      for (;;) {
        const u = s.charCodeAt(j);
        const d = hex ? hexDigitValue(u) : isDecimalDigit(u) ? u - 0x30 : -1;
        if (d < 0) break;
        // Hold the value just past the last code point: anything larger decodes to U+FFFD either way.
        value = Math.min(value * (hex ? 16 : 10) + d, MAX_CODE_POINT + 1);
        digits += 1;
        j += 1;
      }
      if (digits > 0) {
        if (s.charCodeAt(j) === 0x3b) j += 1;
        replacement = numericReferenceValue(value);
        consumedTo = j;
      }
    } else {
      // A name is ASCII letters and digits, then an optional ';'. Take the longest prefix the table holds.
      let run = 0;
      while (run < HTML_NAMED_REFERENCE_MAX_LENGTH && isAsciiAlnum(s.charCodeAt(amp + 1 + run))) run += 1;
      const longest = Math.min(run + (s.charCodeAt(amp + 1 + run) === 0x3b ? 1 : 0), HTML_NAMED_REFERENCE_MAX_LENGTH);
      for (let length = longest; length >= 1; length -= 1) {
        const name = s.slice(amp + 1, amp + 1 + length);
        if (Object.hasOwn(HTML_NAMED_REFERENCES, name)) {
          replacement = HTML_NAMED_REFERENCES[name] as string;
          consumedTo = amp + 1 + length;
          break;
        }
      }
    }

    out += replacement;
    from = consumedTo;
    amp = s.indexOf('&', from);
  }
  return out + s.slice(from);
}

/** The text form of an HTML source string. See the module comment for the rules and what it does not do. */
export function textForm(s: string): string {
  return strip(decode(strip(s)));
}
