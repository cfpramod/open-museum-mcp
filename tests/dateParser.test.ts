import { describe, expect, it } from 'vitest';
import { parseDisplayDate } from '../src/dateParser.js';

describe('parseDisplayDate', () => {
  describe('explicit ranges', () => {
    it('parses simple year range', () => {
      expect(parseDisplayDate('1820–1830')).toEqual({ yearStart: 1820, yearEnd: 1830 });
    });

    it('parses range with hyphen', () => {
      expect(parseDisplayDate('1820-1830')).toEqual({ yearStart: 1820, yearEnd: 1830 });
    });

    it('parses BCE range', () => {
      expect(parseDisplayDate('500–300 BCE')).toEqual({ yearStart: -500, yearEnd: -300 });
    });

    it('parses abbreviated range "ca. 1850–60" as 1850–1860', () => {
      expect(parseDisplayDate('ca. 1850–60')).toEqual({ yearStart: 1850, yearEnd: 1860 });
    });

    it('parses abbreviated range "1899–05" as 1899–1905 (century rollover)', () => {
      expect(parseDisplayDate('1899–05')).toEqual({ yearStart: 1899, yearEnd: 1905 });
    });

    it('parses single-digit suffix "1820-5" as 1820–1825', () => {
      expect(parseDisplayDate('1820-5')).toEqual({ yearStart: 1820, yearEnd: 1825 });
    });

    it('parses single-digit rollover "1829-2" as 1829–1832', () => {
      expect(parseDisplayDate('1829-2')).toEqual({ yearStart: 1829, yearEnd: 1832 });
    });
  });

  describe('cross-era ranges', () => {
    it('parses "500 BCE – 50 CE" as -500 to 50', () => {
      expect(parseDisplayDate('500 BCE – 50 CE')).toEqual({ yearStart: -500, yearEnd: 50 });
    });

    it('parses "100 BC - 200 CE" as -100 to 200', () => {
      expect(parseDisplayDate('100 BC - 200 CE')).toEqual({ yearStart: -100, yearEnd: 200 });
    });
  });

  describe('CE marker', () => {
    it('parses "50 CE" as exact year', () => {
      expect(parseDisplayDate('50 CE')).toEqual({ yearStart: 50, yearEnd: 50 });
    });

    it('parses "200 C.E." with periods', () => {
      expect(parseDisplayDate('200 C.E.')).toEqual({ yearStart: 200, yearEnd: 200 });
    });
  });

  describe('decades', () => {
    it('parses "1820s" as 1820–1829', () => {
      expect(parseDisplayDate('1820s')).toEqual({ yearStart: 1820, yearEnd: 1829 });
    });

    it('parses "1900s" as 1900–1909', () => {
      expect(parseDisplayDate('1900s')).toEqual({ yearStart: 1900, yearEnd: 1909 });
    });
  });

  describe('century-to-century ranges', () => {
    it('parses "14th-15th century" as 1301–1500', () => {
      expect(parseDisplayDate('14th-15th century')).toEqual({ yearStart: 1301, yearEnd: 1500 });
    });

    it('parses "5th-6th century BCE" as -600 to -401', () => {
      expect(parseDisplayDate('5th-6th century BCE')).toEqual({ yearStart: -600, yearEnd: -401 });
    });
  });

  describe('prefix tolerance', () => {
    it('parses "dated 1782" as exact year', () => {
      expect(parseDisplayDate('dated 1782')).toEqual({ yearStart: 1782, yearEnd: 1782 });
    });

    it('parses "Dated, 1782" with punctuation', () => {
      expect(parseDisplayDate('Dated, 1782')).toEqual({ yearStart: 1782, yearEnd: 1782 });
    });

    it('parses "made 1782" with alternative prefix', () => {
      expect(parseDisplayDate('made 1782')).toEqual({ yearStart: 1782, yearEnd: 1782 });
    });
  });

  describe('single years', () => {
    it('parses bare year', () => {
      expect(parseDisplayDate('1888')).toEqual({ yearStart: 1888, yearEnd: 1888 });
    });

    it('parses circa year as a small range', () => {
      expect(parseDisplayDate('c. 1820')).toEqual({ yearStart: 1815, yearEnd: 1825 });
    });

    it('parses ca. abbreviation', () => {
      expect(parseDisplayDate('ca. 1500')).toEqual({ yearStart: 1495, yearEnd: 1505 });
    });

    it('parses BCE single year', () => {
      expect(parseDisplayDate('500 BCE')).toEqual({ yearStart: -500, yearEnd: -500 });
    });
  });

  describe('centuries', () => {
    it('parses bare century', () => {
      expect(parseDisplayDate('19th century')).toEqual({ yearStart: 1801, yearEnd: 1900 });
    });

    it('parses "Mid-14th century" to ~1334–1366', () => {
      const r = parseDisplayDate('Mid-14th century');
      expect(r.yearStart).toBeGreaterThanOrEqual(1330);
      expect(r.yearEnd).toBeLessThanOrEqual(1370);
      expect(r.yearStart).toBeLessThan(r.yearEnd!);
    });

    it('parses "late 18th century" to upper third', () => {
      const r = parseDisplayDate('late 18th century');
      expect(r.yearStart).toBeGreaterThanOrEqual(1760);
      expect(r.yearEnd).toBe(1800);
    });

    it('parses "early 20th century" to lower third', () => {
      const r = parseDisplayDate('early 20th century');
      expect(r.yearStart).toBe(1901);
      expect(r.yearEnd).toBeLessThanOrEqual(1935);
    });

    it('parses BCE century', () => {
      expect(parseDisplayDate('5th century BCE')).toEqual({ yearStart: -500, yearEnd: -401 });
    });
  });

  describe('dynasties and periods', () => {
    it('parses Tang Dynasty as 618–907', () => {
      expect(parseDisplayDate('Tang dynasty')).toEqual({ yearStart: 618, yearEnd: 907 });
    });

    it('parses Edo period as 1603–1868', () => {
      expect(parseDisplayDate('Edo period')).toEqual({ yearStart: 1603, yearEnd: 1868 });
    });

    it('parses late Edo period as upper third', () => {
      const r = parseDisplayDate('late Edo period');
      expect(r.yearStart).toBeGreaterThanOrEqual(1780);
      expect(r.yearEnd).toBe(1868);
    });

    it('parses Safavid period', () => {
      expect(parseDisplayDate('Safavid period')).toEqual({ yearStart: 1501, yearEnd: 1736 });
    });

    it('parses Mughal period', () => {
      expect(parseDisplayDate('Mughal period')).toEqual({ yearStart: 1526, yearEnd: 1857 });
    });

    it('handles "Tang dynasty (618–907)" — explicit range wins', () => {
      expect(parseDisplayDate('Tang dynasty (618–907)')).toEqual({ yearStart: 618, yearEnd: 907 });
    });

    it('handles "Edo period, 1860" — explicit year wins over period', () => {
      const r = parseDisplayDate('Edo period, 1860');
      expect(r.yearStart).toBe(1860);
      expect(r.yearEnd).toBe(1860);
    });
  });

  describe('failures', () => {
    it('returns null/null for empty input', () => {
      expect(parseDisplayDate('')).toEqual({ yearStart: null, yearEnd: null });
    });

    it('rejects implausible "month-year" strings as numeric ranges (4-2017 etc.)', () => {
      // "April 2017" sometimes renders as "4-2017" in upstream metadata. The
      // first number being 1–2 digits means it can't be a year, so the range
      // strategy must skip it. trySingleYear can't recover "2017" because the
      // hyphen blocks its negative lookbehind, so the honest answer is null.
      // Better than the previous {yearStart: 4, yearEnd: 2017} mis-parse.
      expect(parseDisplayDate('4-2017')).toEqual({ yearStart: null, yearEnd: null });
      expect(parseDisplayDate('12-2017')).toEqual({ yearStart: null, yearEnd: null });
    });

    it('rejects inventory-number patterns ("P.2017-0004", "No.1820-30")', () => {
      // Museum catalogue prose contains accession or inventory numbers that
      // look range-shaped: "Collection Number : P.2017-0004". `parseInt` of
      // "0004" strips leading zeros to 4, which used to surface as
      // {yearStart: 4, yearEnd: 2017} — a real bug seen on a Wikimedia
      // record (Monet, NMWA Tokyo). The trailing dash on "2017" also blocks
      // trySingleYear's exact match, so the whole fragment honestly fails.
      expect(parseDisplayDate('Collection Number : P.2017-0004')).toEqual({
        yearStart: null,
        yearEnd: null,
      });
      expect(parseDisplayDate('No.1820-30')).toEqual({ yearStart: null, yearEnd: null });
    });

    it('rejects "year.digit" patterns from museum acquisition numbers', () => {
      // British Museum format: "BM 1906.1220.0.533" — 1906 is acquisition
      // year, NOT artwork creation. Block standalone "1906" when followed
      // by ".digit" (catalogue context). End-of-sentence "1906." stays
      // valid (period followed by space or end, not digit).
      expect(parseDisplayDate('BM 1906.1220.0.533')).toEqual({ yearStart: null, yearEnd: null });
      expect(parseDisplayDate('Made in 1906.')).toEqual({ yearStart: 1906, yearEnd: 1906 });
      expect(parseDisplayDate('Made in 1906. Then more text.')).toEqual({
        yearStart: 1906,
        yearEnd: 1906,
      });
    });

    it('still recovers a real year from prose containing an inventory number', () => {
      // The full smoke-test scenario: "(1916) by Claude Monet ... Collection
      // Number : P.2017-0004". Range regex skips the inventory; trySingleYear
      // catches "(1916)".
      const r = parseDisplayDate(
        '"Le Bassin aux nymphéas" (1916) by Claude Monet. Collection Number : P.2017-0004',
      );
      expect(r).toEqual({ yearStart: 1916, yearEnd: 1916 });
    });

    it('returns null/null for unparseable strings', () => {
      expect(parseDisplayDate('Some unintelligible date')).toEqual({
        yearStart: null,
        yearEnd: null,
      });
    });

    it('returns null/null for null input', () => {
      expect(parseDisplayDate(null)).toEqual({ yearStart: null, yearEnd: null });
    });
  });

  describe('strategy ordering invariants', () => {
    // Locks down a subtle invariant: tryRangeRegex runs BEFORE
    // tryCenturyRange in parseDisplayDate. The numeric-range regex looks like
    // it could match the digits inside "14th-15th century" as `14-15`, but
    // the "th" between digit and dash breaks the match. If someone relaxes
    // the regex later, this test catches the regression.
    it('"14th-15th century" parses as a century range, not a small-number range', () => {
      expect(parseDisplayDate('14th-15th century')).toEqual({ yearStart: 1301, yearEnd: 1500 });
    });

    it('"twenty-first century" resolves via word ordinal (regression for hyphen-suffix bug)', () => {
      expect(parseDisplayDate('twenty-first century')).toEqual({ yearStart: 2001, yearEnd: 2100 });
    });
  });
});
