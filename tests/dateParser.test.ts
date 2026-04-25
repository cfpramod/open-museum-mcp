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
});
