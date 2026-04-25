import dynastiesData from './data/dynasties.json' with { type: 'json' };
import type { DateRange } from './types.js';

const dynasties = dynastiesData as unknown as Record<string, Record<string, [number, number]>>;

const flatDynasties: Record<string, [number, number]> = (() => {
  const out: Record<string, [number, number]> = {};
  for (const culture of Object.keys(dynasties)) {
    for (const [period, range] of Object.entries(dynasties[culture])) {
      out[period.toLowerCase()] = range;
    }
  }
  return out;
})();

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18,
  xix: 19, xx: 20, xxi: 21,
};

function ordinalToNumber(token: string): number | null {
  const t = token.toLowerCase().replace(/(st|nd|rd|th)$/, '');
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (ROMAN[t] !== undefined) return ROMAN[t];
  const words: Record<string, number> = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
    eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
    fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21,
  };
  return words[t] ?? null;
}

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

function tryRangeRegex(s: string): DateRange | null {
  const m = s.match(/(-?\d{1,5})\s*[-–]\s*(-?\d{1,5})\s*(b\.?c\.?e?\.?|bc)?/i);
  if (m) {
    let a = parseInt(m[1], 10);
    let b = parseInt(m[2], 10);
    if (m[3]) {
      a = -Math.abs(a);
      b = -Math.abs(b);
    }
    return { yearStart: Math.min(a, b), yearEnd: Math.max(a, b) };
  }
  return null;
}

function trySingleYear(s: string): DateRange | null {
  const bce = s.match(/(\d{1,5})\s*(b\.?c\.?e?\.?|bc)/i);
  if (bce) {
    const y = -parseInt(bce[1], 10);
    return { yearStart: y, yearEnd: y };
  }
  const circa = s.match(/(?:c\.?|ca\.?|circa|approximately|around|about)\s*(-?\d{1,5})/i);
  if (circa) {
    const y = parseInt(circa[1], 10);
    return { yearStart: y - 5, yearEnd: y + 5 };
  }
  const exact = s.match(/(?<![\d-])(\d{3,4})(?![\d-])/);
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

  const m = stripped.match(/([\w-]+)\s*(?:-|\s)?\s*century\s*(b\.?c\.?e?\.?|bc)?/i);
  if (!m) return null;

  const num = ordinalToNumber(m[1]);
  if (num === null) return null;

  const era: 'ce' | 'bce' = m[2] ? 'bce' : 'ce';
  return centuryRange(num, era, qualifier);
}

function tryDynasty(s: string): DateRange | null {
  const lower = s.toLowerCase();
  const sorted = Object.keys(flatDynasties).sort((a, b) => b.length - a.length);
  for (const period of sorted) {
    if (lower.includes(period)) {
      const [start, end] = flatDynasties[period];
      const qual = lower.match(/\b(early|mid|middle|late)\b/);
      const qualifier = qual ? qual[1] : undefined;
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
  }
  return null;
}

export function parseDisplayDate(input: string | null | undefined): DateRange {
  if (!input || typeof input !== 'string') {
    return { yearStart: null, yearEnd: null };
  }
  const s = input.trim();
  if (!s) return { yearStart: null, yearEnd: null };

  const range = tryRangeRegex(s);
  if (range) return range;

  const century = tryCentury(s);
  if (century) return century;

  const single = trySingleYear(s);
  if (single) return single;

  const dynasty = tryDynasty(s);
  if (dynasty) return dynasty;

  return { yearStart: null, yearEnd: null };
}
