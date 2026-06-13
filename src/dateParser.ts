import dynastiesData from './data/dynasties.json' with { type: 'json' };
import type { DateRange } from './types.js';

const dynasties = dynastiesData as unknown as Record<string, Record<string, [number, number]>>;

const flatDynasties: Record<string, [number, number]> = (() => {
  const out: Record<string, [number, number]> = {};
  const seen = new Set<string>();
  for (const culture of Object.keys(dynasties)) {
    for (const [period, range] of Object.entries(dynasties[culture])) {
      const key = period.toLowerCase();
      if (seen.has(key)) {
        console.warn(`[open-museum-mcp] dynasty table: duplicate period "${key}" across cultures; last definition wins`);
      }
      seen.add(key);
      out[key] = range;
    }
  }
  return out;
})();

// Pre-sort once at module load: longest keys first so multi-word periods
// ("three kingdoms", "delhi sultanate") match before any prefix overlap with
// shorter keys. Re-sorting on every tryDynasty call was wasted work.
const FLAT_DYNASTY_KEYS_LONGEST_FIRST = Object.keys(flatDynasties).sort(
  (a, b) => b.length - a.length,
);

// Parallel array of word-boundary regexes — one per dynasty key. Pre-compiled
// at module load so tryDynasty doesn't pay regex-construction cost per call.
// Word-boundary anchoring (`\b`) prevents false-positives like "Hanka" hitting
// the "han" key, "Tangerine" hitting "tang", etc. (#21).
const FLAT_DYNASTY_REGEXES_LONGEST_FIRST = FLAT_DYNASTY_KEYS_LONGEST_FIRST.map(
  (key) => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
);

const QUALIFIER_RE = /\b(early|mid|middle|late)\b/;

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18,
  xix: 19, xx: 20, xxi: 21,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21,
};

function ordinalToNumber(token: string): number | null {
  const lower = token.toLowerCase();
  // Check the word dictionary BEFORE stripping suffixes — otherwise hyphenated
  // forms like "twenty-first" get mangled into "twenty-fir" by the suffix
  // regex and never match.
  if (ORDINAL_WORDS[lower] !== undefined) return ORDINAL_WORDS[lower];
  const stripped = lower.replace(/(st|nd|rd|th)$/, '');
  if (/^\d+$/.test(stripped)) return parseInt(stripped, 10);
  if (ROMAN[stripped] !== undefined) return ROMAN[stripped];
  return ORDINAL_WORDS[stripped] ?? null;
}

// 19th century CE = 1801–1900 (no year zero, century N spans years
// (N-1)*100+1 to N*100). qualifier divides the span into thirds; floor()
// accepts that the 99-year span doesn't divide evenly — close enough for
// catalog metadata and matches museum convention.
function centuryRange(n: number, era: 'ce' | 'bce', qualifier?: string): DateRange {
  let start: number, end: number;
  if (era === 'ce') {
    start = (n - 1) * 100 + 1;
    end = n * 100;
  } else {
    end = -((n - 1) * 100 + 1);
    start = -(n * 100);
  }
  const span = end - start;
  if (qualifier === 'early') {
    return { yearStart: start, yearEnd: start + Math.floor(span / 3) };
  }
  if (qualifier === 'mid' || qualifier === 'middle') {
    return {
      yearStart: start + Math.floor(span / 3),
      yearEnd: end - Math.floor(span / 3),
    };
  }
  if (qualifier === 'late') {
    return { yearStart: end - Math.floor(span / 3), yearEnd: end };
  }
  return { yearStart: start, yearEnd: end };
}

// True only when the string carries BOTH a BCE marker and a CE marker —
// signals a cross-era range that tryRangeRegex must defer on so
// tryCrossEraRange can handle it correctly. The CE side accepts CE/C.E.
// as well as AD/A.D.: the Smithsonian (and many US museums) write the
// upper bound of an antiquity range as "A.D." rather than "CE", e.g.
// "100 B.C.-100 A.D.". Without the AD marker, hasMixedEras returns false,
// tryRangeRegex can't parse the punctuated form, and trySingleYear grabs
// only the BCE half — collapsing "100 B.C.-100 A.D." to {-100, -100}.
function hasMixedEras(s: string): boolean {
  const hasBce = /\b(b\.?c\.?e?\.?|bc)\b/i.test(s);
  if (!hasBce) return false;
  return /\bce\b/i.test(s) || /\bc\.e\./i.test(s) || /\ba\.?d\.?/i.test(s);
}

function tryCrossEraRange(s: string): DateRange | null {
  const m = s.match(
    /(\d{1,5})\s*(?:b\.?c\.?e?\.?|bc)\s*[-–]\s*(\d{1,5})\s*(?:c\.?e\.?|ce|a\.?d\.?|ad)/i,
  );
  if (m) {
    return {
      yearStart: -parseInt(m[1], 10),
      yearEnd: parseInt(m[2], 10),
    };
  }
  return null;
}

// Numeric range with optional trailing BCE marker. Bare digits separated by
// hyphen/en-dash. Note: ordinal-century inputs like "14th-15th century" are
// NOT matched here because the regex requires the dash to immediately follow
// digits — the "th" between "14" and "-" breaks the match. Don't relax the
// regex without locking down that invariant in tests; tryCenturyRange owns
// ordinal-century parsing.
// Plausible-year bounds for the standard range path. BCE ranges go through
// tryCrossEraRange first; modern ranges (year 100 to year 2200 inclusive)
// cover all realistic museum domain values without admitting inventory
// numbers like "P.2017-0004" → {a: 17, b: 4} or "April 2017" → {a: 4, b: 2017}.
const YEAR_PLAUSIBLE_MIN = 100;
const YEAR_PLAUSIBLE_MAX = 2200;

function tryRangeRegex(s: string): DateRange | null {
  if (hasMixedEras(s)) return null;

  // Negative lookbehind for `.` blocks inventory-number false matches like
  // "P.2017-0004" cleanly when the regex starts at "2017". Belt-and-
  // suspenders: the year-plausibility check below also rejects the case
  // where the regex backtracks and matches "017-0004" (preceded by a digit
  // that the lookbehind permits).
  const m = s.match(/(?<!\.)(-?\d{1,5})\s*[-–]\s*(-?\d{1,5})\s*(b\.?c\.?e?\.?|bc)?/i);
  if (m) {
    const firstStr = m[1];
    const secondStr = m[2];
    let a = parseInt(firstStr, 10);
    let b = parseInt(secondStr, 10);

    // Year-plausibility guard on the literal first token. A one- or
    // two-digit first number is almost never a year. "4-2017" (from
    // "April 2017") used to surface as {yearStart: 4, yearEnd: 2017}.
    if (!firstStr.startsWith('-') && firstStr.length < 3) return null;

    const firstIsCleanFourDigit = !firstStr.startsWith('-') && firstStr.length === 4;
    const secondIsShortSuffix = !secondStr.startsWith('-') && (secondStr.length === 1 || secondStr.length === 2);

    // Short-suffix forms expand the second number by reusing digits from the
    // first: "1820-5" → 1820–1825 (decade rollover), "1899–05" → 1899–1905
    // (century rollover). When the candidate would land before the start
    // year, bump it forward by the rollover unit.
    if (!m[3] && firstIsCleanFourDigit && secondIsShortSuffix) {
      const decade = Math.floor(a / 10) * 10;
      const century = Math.floor(a / 100) * 100;
      const candidateDecade = decade + b;
      const candidateCentury = century + b;
      let resolved: number;
      if (secondStr.length === 1) {
        resolved = candidateDecade < a ? candidateDecade + 10 : candidateDecade;
      } else {
        resolved = candidateCentury < a ? candidateCentury + 100 : candidateCentury;
      }
      return { yearStart: a, yearEnd: resolved };
    }

    if (m[3]) {
      a = -Math.abs(a);
      b = -Math.abs(b);
    } else if (
      a < YEAR_PLAUSIBLE_MIN ||
      a > YEAR_PLAUSIBLE_MAX ||
      b < YEAR_PLAUSIBLE_MIN ||
      b > YEAR_PLAUSIBLE_MAX
    ) {
      // Both numbers must read as plausible CE years on the standard path.
      // Catches "017-0004" (parsed a=17, b=4) which the lookbehind misses
      // when the regex backtracks past the inventory-number prefix.
      return null;
    }
    return { yearStart: Math.min(a, b), yearEnd: Math.max(a, b) };
  }
  return null;
}

function tryCenturyRange(s: string): DateRange | null {
  // Bound [\w-]{1,30}: legitimate ordinal tokens ("twenty-first", "xxii") are
  // short; unbounded [\w-]+ caused catastrophic backtracking on long inputs.
  const m = s.match(/([\w-]{1,30})\s*[-–]\s*([\w-]{1,30})\s*(?:-|\s)?\s*century\s*(b\.?c\.?e?\.?|bc)?/i);
  if (!m) return null;
  const startN = ordinalToNumber(m[1]);
  const endN = ordinalToNumber(m[2]);
  if (startN === null || endN === null) return null;
  const era: 'ce' | 'bce' = m[3] ? 'bce' : 'ce';
  const startRange = centuryRange(startN, era);
  const endRange = centuryRange(endN, era);
  return {
    yearStart: Math.min(startRange.yearStart!, endRange.yearStart!),
    yearEnd: Math.max(startRange.yearEnd!, endRange.yearEnd!),
  };
}

function tryDecade(s: string): DateRange | null {
  const m = s.match(/(?<![\d-])(\d{3,4})s\b/i);
  if (m) {
    const y = parseInt(m[1], 10);
    return { yearStart: y, yearEnd: y + 9 };
  }
  return null;
}

function trySingleYear(s: string): DateRange | null {
  const bce = s.match(/(\d{1,5})\s*(b\.?c\.?e?\.?|bc)\b/i);
  if (bce) {
    const y = -parseInt(bce[1], 10);
    return { yearStart: y, yearEnd: y };
  }

  const ce = s.match(/(?<!\w)(\d{1,5})\s*(c\.?e\.?|ce)\b/i);
  if (ce) {
    const y = parseInt(ce[1], 10);
    return { yearStart: y, yearEnd: y };
  }

  const circa = s.match(/(?:c\.?|ca\.?|circa|approximately|around|about)\s*(-?\d{1,5})/i);
  if (circa) {
    const y = parseInt(circa[1], 10);
    return { yearStart: y - 5, yearEnd: y + 5 };
  }

  // Block catalogue-number context on both sides:
  //   `(?<![\d.-])` — not preceded by digit, dash, OR period (so "0.533"
  //                   doesn't surface 533 as a year, but "(1916)" still
  //                   matches because "(" passes).
  //   `(?![\d-]|\.\d)` — not followed by digit/dash, and not followed by
  //                     period+digit (so "1906.1220" doesn't surface 1906,
  //                     but end-of-sentence "1906." still matches because
  //                     the period isn't followed by a digit).
  const exact = s.match(/(?<![\d.-])(\d{3,4})(?![\d-]|\.\d)/);
  if (exact) {
    const y = parseInt(exact[1], 10);
    return { yearStart: y, yearEnd: y };
  }
  return null;
}

function tryCentury(s: string): DateRange | null {
  const qual = s.match(/\b(early|mid|middle|late)\b/i);
  const qualifier = qual ? qual[1].toLowerCase() : undefined;

  const stripped = s.replace(/\b(early|mid|middle|late)\b[\s\-]*/i, ' ').trim();

  // Bound [\w-]{1,30}: same catastrophic-backtracking prevention as tryCenturyRange.
  const m = stripped.match(/([\w-]{1,30})\s*(?:-|\s)?\s*century\s*(b\.?c\.?e?\.?|bc)?/i);
  if (!m) return null;

  const num = ordinalToNumber(m[1]);
  if (num === null) return null;

  const era: 'ce' | 'bce' = m[2] ? 'bce' : 'ce';
  return centuryRange(num, era, qualifier);
}

function tryDynasty(s: string): DateRange | null {
  const lower = s.toLowerCase();
  const qualifier = lower.match(QUALIFIER_RE)?.[1];
  for (let i = 0; i < FLAT_DYNASTY_KEYS_LONGEST_FIRST.length; i++) {
    if (!FLAT_DYNASTY_REGEXES_LONGEST_FIRST[i].test(lower)) continue;
    const period = FLAT_DYNASTY_KEYS_LONGEST_FIRST[i];
    const [start, end] = flatDynasties[period];
    const span = end - start;
    if (qualifier === 'early') {
      return { yearStart: start, yearEnd: start + Math.floor(span / 3) };
    }
    if (qualifier === 'mid' || qualifier === 'middle') {
      return {
        yearStart: start + Math.floor(span / 3),
        yearEnd: end - Math.floor(span / 3),
      };
    }
    if (qualifier === 'late') {
      return { yearStart: end - Math.floor(span / 3), yearEnd: end };
    }
    return { yearStart: start, yearEnd: end };
  }
  return null;
}

/**
 * Parse a museum-supplied display date into a {yearStart, yearEnd} range.
 *
 * Strategies are tried in this exact order — earlier strategies win:
 *   1. cross-era range ("500 BCE – 50 CE")
 *   2. numeric range ("1820–1830", "1820-5", "1899–05")
 *   3. ordinal-century range ("14th-15th century")
 *   4. ordinal century with optional early/mid/late qualifier
 *   5. decade ("1820s")
 *   6. single year ("1888", "ca. 1820", "500 BCE")
 *   7. dynasty/period lookup (longest key first to avoid prefix shadowing)
 *
 * Returns {null, null} when nothing matches — never guesses. BCE is encoded
 * as negative integers so range arithmetic Just Works.
 */
// Defense-in-depth cap on the parser input. Museum display dates are short,
// but wikimedia/met sometimes pass full prose descriptions (e.g. "c. 1560s.
// Oil on canvas…", ~130 chars) to let the parser extract an embedded year.
// 256 covers all observed museum inputs while still blocking 10k-char payloads.
// The primary O(n²) defense is the {1,30}-bounded quantifiers in the century
// regexes below; this cap is a belt-and-suspenders guard on top.
const DATE_INPUT_MAX = 256;

export function parseDisplayDate(input: string | null | undefined): DateRange {
  if (!input || typeof input !== 'string') {
    return { yearStart: null, yearEnd: null };
  }
  const s = input.trim();
  if (!s) return { yearStart: null, yearEnd: null };
  if (s.length > DATE_INPUT_MAX) return { yearStart: null, yearEnd: null };

  const cross = tryCrossEraRange(s);
  if (cross) return cross;

  const range = tryRangeRegex(s);
  if (range) return range;

  const centuryRangeMatch = tryCenturyRange(s);
  if (centuryRangeMatch) return centuryRangeMatch;

  const century = tryCentury(s);
  if (century) return century;

  const decade = tryDecade(s);
  if (decade) return decade;

  const single = trySingleYear(s);
  if (single) return single;

  const dynasty = tryDynasty(s);
  if (dynasty) return dynasty;

  return { yearStart: null, yearEnd: null };
}
