import { describe, expect, it } from 'vitest';
import { filterByYearRange } from '../src/yearFilter.js';
import type { Artwork } from '../src/types.js';

function art(id: string, yearStart: number | null, yearEnd: number | null): Artwork {
  return {
    id,
    museum: { code: 'met', name: 'Met', url: 'https://metmuseum.org' },
    title: 'Untitled',
    artist: { name: 'Anonymous', attributionType: 'anonymous' },
    displayDate: '',
    yearStart,
    yearEnd,
    medium: '',
    region: null,
    period: null,
    imageUrls: { full: 'https://example.org/img.jpg' },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'PD',
      rawValue: 'pd',
      verificationSource: 'test',
      verifiedAt: '2026-04-27',
      confidence: 'high',
    },
    source: { apiUrl: 'https://example.org/api', pageUrl: 'https://example.org/page' },
  };
}

describe('filterByYearRange', () => {
  const sample = [
    art('met:1', 1640, 1640), // inside
    art('met:2', 1635, 1645), // overlaps lower edge
    art('met:3', 1675, 1685), // overlaps upper edge
    art('met:4', 1700, 1700), // outside (after)
    art('met:5', 1500, 1500), // outside (before)
    art('met:6', 1640, 1680), // exact span
    art('met:7', null, null), // unknown date
    art('met:8', 1600, 1700), // envelopes the window
  ];

  it('returns input unchanged when both bounds are undefined', () => {
    const out = filterByYearRange(sample, undefined, undefined);
    expect(out).toBe(sample);
  });

  it('filters to records that overlap [yearMin, yearMax]', () => {
    // Researcher's canonical query: "Dutch genre painting 1640–1680".
    // An artwork [s, e] passes when its range overlaps the window:
    //   s <= yearMax AND e >= yearMin.
    const out = filterByYearRange(sample, 1640, 1680);
    expect(out.map((a) => a.id)).toEqual(['met:1', 'met:2', 'met:3', 'met:6', 'met:8']);
  });

  it('open-ended max (yearMin only) keeps everything from yearMin onward', () => {
    const out = filterByYearRange(sample, 1640, undefined);
    // Excludes met:5 (1500) — everything else has yearEnd >= 1640.
    expect(out.map((a) => a.id)).toEqual(['met:1', 'met:2', 'met:3', 'met:4', 'met:6', 'met:8']);
  });

  it('open-ended min (yearMax only) keeps everything up to yearMax', () => {
    const out = filterByYearRange(sample, undefined, 1680);
    // Excludes met:4 (1700) — everything else has yearStart <= 1680.
    expect(out.map((a) => a.id)).toEqual(['met:1', 'met:2', 'met:3', 'met:5', 'met:6', 'met:8']);
  });

  it('drops records with null yearStart or yearEnd when any bound is set', () => {
    // Honest behaviour: a date-range filter is a research constraint;
    // unverifiable records can't be claimed to match. Don't pollute results.
    const onlyUnknown = [art('met:7', null, null)];
    expect(filterByYearRange(onlyUnknown, 1640, 1680)).toEqual([]);
    expect(filterByYearRange(onlyUnknown, 1640, undefined)).toEqual([]);
    expect(filterByYearRange(onlyUnknown, undefined, 1680)).toEqual([]);
  });

  it('keeps null-year records when no bound is set (unconstrained search)', () => {
    const onlyUnknown = [art('met:7', null, null)];
    const out = filterByYearRange(onlyUnknown, undefined, undefined);
    expect(out).toEqual(onlyUnknown);
  });

  it('handles BCE (negative years) and cross-era windows', () => {
    const ancient = [
      art('met:bce500', -500, -500),
      art('met:bce100', -100, -100),
      art('met:ce50', 50, 50),
      art('met:ce300', 300, 300),
    ];
    // 100 BCE to 100 CE
    const out = filterByYearRange(ancient, -100, 100);
    expect(out.map((a) => a.id)).toEqual(['met:bce100', 'met:ce50']);
  });

  it('inclusive on both edges (yearStart === yearMax and yearEnd === yearMin pass)', () => {
    // Edge inclusivity matters for researchers asking "1640-1680" and
    // expecting 1640 and 1680 to both be in the set.
    const edges = [
      art('met:edge-low', 1640, 1640),
      art('met:edge-high', 1680, 1680),
    ];
    expect(filterByYearRange(edges, 1640, 1680).map((a) => a.id)).toEqual([
      'met:edge-low',
      'met:edge-high',
    ]);
  });

  it('preserves input order', () => {
    const out = filterByYearRange(sample, 1500, 1700);
    // Order in `sample` is met:1, met:2, met:3, met:4, met:5, met:6, met:8
    // (met:7 dropped for null years).
    expect(out.map((a) => a.id)).toEqual(['met:1', 'met:2', 'met:3', 'met:4', 'met:5', 'met:6', 'met:8']);
  });
});
