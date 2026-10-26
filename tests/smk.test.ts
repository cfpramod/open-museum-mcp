import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { smkFetcher } from '../src/fetchers/smk.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
}

describe('SMK adapter normalization', () => {
  it('normalizes a public-domain record (Hammershøi) into the Artwork shape', () => {
    const result = smkFetcher.normalize(fixture('smk-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('smk:KMS3352');
    expect(a.museum.code).toBe('smk');
    expect(a.title).toContain('Ida Hammershøi');
    expect(a.artist.name).toBe('Vilhelm Hammershøi');
    expect(a.artist.attributionType).toBe('named');
    expect(a.yearStart).toBe(1907);
    expect(a.yearEnd).toBe(1907);
    expect(a.license.type).toBe('PD'); // PD Mark, not CC0
    expect(a.license.verificationSource).toBe('smk.public_domain');
    expect(a.license.confidence).toBe('high');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('api.smk.dk');
    expect(a.imageUrls.width).toBe(5750);
    expect(a.imageUrls.height).toBe(7229);
    expect(a.imageUrls.maxResolution).toEqual({ width: 5750, height: 7229 });
    expect(a.source.pageUrl).toMatch(/smk\.dk/);
  });

  it('tiers a CC0-dedicated record as CC0 (not PD Mark)', () => {
    const raw = { ...(fixture('smk-accepted.json') as Record<string, unknown>), rights: 'https://creativecommons.org/publicdomain/zero/1.0/' };
    const result = smkFetcher.normalize(raw);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.license.type).toBe('CC0');
  });

  it('does not classify a HOST-SPOOFED CC0 URI as CC0 (rights URL is parsed, not substring-matched)', () => {
    // public_domain===true is the grant; the rights URI only tiers CC0 vs PD. A
    // forged host must NOT promote the record to CC0 — it falls back to PD.
    for (const spoof of [
      'https://creativecommons.org.evil.com/publicdomain/zero/1.0/',
      'https://evil.com/?x=creativecommons.org/publicdomain/zero/1.0/',
      'https://creativecommons.org@evil.com/publicdomain/zero/1.0/',
      'https://notcreativecommons.org/publicdomain/zero/1.0/',
    ]) {
      const raw = { ...(fixture('smk-accepted.json') as Record<string, unknown>), rights: spoof };
      const result = smkFetcher.normalize(raw);
      if (result.status !== 'accepted') throw new Error('expected accepted (public_domain still true)');
      expect(result.artwork.license.type, spoof).toBe('PD'); // NOT CC0 — host spoofed
    }
    // The genuine CC0 host + path still tiers as CC0.
    const real = { ...(fixture('smk-accepted.json') as Record<string, unknown>), rights: 'https://creativecommons.org/publicdomain/zero/1.0/' };
    const r = smkFetcher.normalize(real);
    if (r.status !== 'accepted') throw new Error('expected accepted');
    expect(r.artwork.license.type).toBe('CC0');
  });

  it('rejects a record with public_domain=false', () => {
    const result = smkFetcher.normalize(fixture('smk-rejected-not-pd.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/public_domain=false/);
    expect(result.rejection.museumCode).toBe('smk');
  });

  it('rejects a record with no public_domain field (strict default)', () => {
    const result = smkFetcher.normalize(fixture('smk-rejected-missing.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/public_domain|strict default/i);
  });

  it('rejects garbage input gracefully', () => {
    expect(smkFetcher.normalize(null).status).toBe('rejected');
    expect(smkFetcher.normalize('nope').status).toBe('rejected');
    expect(smkFetcher.normalize(42).status).toBe('rejected');
  });
});

describe('SMK search query construction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pushes public_domain + has_image filters server-side and parses object_number ids', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ items: [{ object_number: 'KMS3352' }, { object_number: 'KKSgb8919' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const ids = await smkFetcher.search('hammershøi', 5);
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('[public_domain:true]');
    expect(decoded).toContain('[has_image:true]');
    expect(decoded).toContain('keys=hammershøi');
    expect(ids).toEqual(['smk:KMS3352', 'smk:KKSgb8919']);
  });

  it('omits the has_image filter when hasImage is false', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await smkFetcher.search('q', 5, { hasImage: false });
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('[public_domain:true]');
    expect(decoded).not.toContain('[has_image:true]');
  });
});

describe('SMK credit line', () => {
  it('carries the object number; SMK publishes no credit line', () => {
    const result = smkFetcher.normalize(fixture('smk-accepted.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.creditLine).toEqual({
      holder: 'Statens Museum for Kunst (National Gallery of Denmark)',
      accession: 'KMS3352',
    });
  });

});

describe('SMK dimensions composed from structured measurements', () => {
  afterEach(() => vi.restoreAllMocks());

  function dimsOf(dimensions: unknown): string | undefined {
    const raw = { ...(fixture('smk-accepted.json') as Record<string, unknown>), dimensions };
    const result = smkFetcher.normalize(raw);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    return result.artwork.dimensions;
  }
  const m = (part: string | undefined, type: string, unit: string | undefined, value: string) => ({
    ...(part === undefined ? {} : { part }),
    type,
    ...(unit === undefined ? {} : { unit }),
    value,
  });

  it('requests dimensions from the API', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await smkFetcher.getRaw('smk:KMS3352');
    const fields = new URL(capturedUrl).searchParams.get('fields')?.split(',') ?? [];
    expect(fields).toContain('dimensions');
  });

  it('writes the unframed and framed size of a painting (the accepted fixture)', () => {
    const result = smkFetcher.normalize(fixture('smk-accepted.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.dimensions).toBe('Unframed: 91 x 73.5 cm; Framed: 94 x 76 x 4.2 cm');
  });

  it('writes a sheet size in millimetres', () => {
    expect(dimsOf([m('bladmaal', 'højde', 'millimeter', '238'), m('bladmaal', 'bredde', 'millimeter', '180')]))
      .toBe('Sheet: 238 x 180 mm');
  });

  it('names every part SMK uses, whatever the spelling, in the order the record gives them', () => {
    expect(dimsOf([
      m('monteringsmaal', 'højde', 'millimeter', '500'), m('monteringsmaal', 'bredde', 'millimeter', '400'),
      m('monteringsmaal', 'dybde', 'millimeter', '20'),
      m('Bladmål', 'højde', 'millimeter', '300'), m('Bladmål', 'bredde', 'millimeter', '250'),
      m('Plademål', 'højde', 'millimeter', '200'), m('Plademål', 'bredde', 'millimeter', '150'),
      m('billedmaal', 'højde', 'millimeter', '180'), m('billedmaal', 'bredde', 'millimeter', '130'),
    ])).toBe('Mount: 500 x 400 x 20 mm; Sheet: 300 x 250 mm; Plate: 200 x 150 mm; Image: 180 x 130 mm');
    expect(dimsOf([
      m('netto', 'højde', 'centimeter', '10'), m('netto', 'bredde', 'centimeter', '8'),
      m('Bruttomål', 'højde', 'centimeter', '12'), m('Bruttomål', 'bredde', 'centimeter', '10'),
    ])).toBe('Unframed: 10 x 8 cm; Framed: 12 x 10 cm');
    expect(dimsOf([m('Nettomål', 'højde', 'centimeter', '10'), m('Nettomål', 'bredde', 'centimeter', '8')]))
      .toBe('Unframed: 10 x 8 cm');
  });

  it('groups a part whose entries are not adjacent', () => {
    expect(dimsOf([
      m('bladmaal', 'højde', 'millimeter', '300'), m('plademaal', 'højde', 'millimeter', '200'),
      m('bladmaal', 'bredde', 'millimeter', '250'), m('plademaal', 'bredde', 'millimeter', '150'),
    ])).toBe('Sheet: 300 x 250 mm; Plate: 200 x 150 mm');
  });

  it('writes a size with no part and no label when the record names none', () => {
    expect(dimsOf([m(undefined, 'højde', 'centimeter', '50'), m(undefined, 'bredde', 'centimeter', '40')]))
      .toBe('50 x 40 cm');
  });

  it('labels each measurement when height and width are not both given', () => {
    expect(dimsOf([m(undefined, 'højde', 'centimeter', '39.5')])).toBe('height 39.5 cm');
    expect(dimsOf([m('Netto', 'bredde', 'centimeter', '34')])).toBe('Unframed: width 34 cm');
    expect(dimsOf([m('bladmaal', 'diameter', 'millimeter', '265')])).toBe('Sheet: diameter 265 mm');
    expect(dimsOf([m('Netto', 'højde', 'centimeter', '30'), m('Netto', 'diameter', 'centimeter', '12')]))
      .toBe('Unframed: height 30 cm, diameter 12 cm');
    expect(dimsOf([m('Netto', 'højde', 'centimeter', '30'), m('Netto', 'dybde', 'centimeter', '5')]))
      .toBe('Unframed: height 30 cm, depth 5 cm');
  });

  it('labels each measurement when a diameter comes with height and width', () => {
    expect(dimsOf([
      m('Netto', 'højde', 'centimeter', '30'), m('Netto', 'bredde', 'centimeter', '20'),
      m('Netto', 'diameter', 'centimeter', '12'),
    ])).toBe('Unframed: height 30 cm, width 20 cm, diameter 12 cm');
  });

  it('reads the English names the API gives with lang=en, and the unit spellings in the data', () => {
    expect(dimsOf([m('Netto', 'height', 'cm', '239'), m('Netto', 'width', 'cm', '307'), m('Netto', 'depth', 'cm', '9')]))
      .toBe('Unframed: 239 x 307 x 9 cm');
    expect(dimsOf([m('bladmaal', 'højde', 'milimeter', '161'), m('bladmaal', 'bredde', 'mm', '120')]))
      .toBe('Sheet: 161 x 120 mm');
  });

  it('keeps the value as SMK writes it', () => {
    expect(dimsOf([m('Netto', 'højde', 'centimeter', '91.0'), m('Netto', 'bredde', 'centimeter', '73.50')]))
      .toBe('Unframed: 91.0 x 73.50 cm');
  });

  it('ignores a weight and keeps the size beside it', () => {
    expect(dimsOf([
      m('Netto', 'højde', 'centimeter', '91'), m('Netto', 'bredde', 'centimeter', '73.5'),
      m(undefined, 'vægt', 'kilo', '12'), m('Netto', 'weight', 'kg', '12'),
    ])).toBe('Unframed: 91 x 73.5 cm');
  });

  it('drops a part when any of its measurements lacks a unit, and writes the rest', () => {
    // KMS8914 as published: the height carries no unit.
    expect(dimsOf([m('Netto', 'højde', undefined, '39.5'), m('Netto', 'bredde', 'centimeter', '34')])).toBeUndefined();
    expect(dimsOf([
      m('Netto', 'højde', undefined, '39.5'), m('Netto', 'bredde', 'centimeter', '34'),
      m('Brutto', 'højde', 'centimeter', '50'), m('Brutto', 'bredde', 'centimeter', '44'),
    ])).toBe('Framed: 50 x 44 cm');
  });

  it('drops a part that gives two values for one measurement', () => {
    // KKSgb21766 as published: two sheet heights.
    expect(dimsOf([m('bladmaal', 'højde', 'millimeter', '161'), m('bladmaal', 'højde', 'millimeter', '165')]))
      .toBeUndefined();
  });

  it('drops a part that mixes units', () => {
    expect(dimsOf([m('Netto', 'højde', 'centimeter', '91'), m('Netto', 'bredde', 'millimeter', '735')])).toBeUndefined();
  });

  it('drops a part whose measurement type is missing or not a size it knows', () => {
    expect(dimsOf([m('Netto', 'længde', 'centimeter', '91'), m('Netto', 'bredde', 'centimeter', '73.5')])).toBeUndefined();
    expect(dimsOf([{ part: 'Netto', unit: 'centimeter', value: '91' }, m('Netto', 'bredde', 'centimeter', '73.5')]))
      .toBeUndefined();
  });

  it('drops a part with a value that is not a positive number', () => {
    for (const value of ['0', '0.0', '-12', '', '12 cm', '1,5', '1e3', 'NaN', ' 12', '1234567', '1.12345']) {
      expect(dimsOf([m('Netto', 'højde', 'centimeter', value), m('Netto', 'bredde', 'centimeter', '40')])).toBeUndefined();
    }
    expect(dimsOf([{ part: 'Netto', type: 'højde', unit: 'centimeter', value: 91 }])).toBeUndefined();
    expect(dimsOf([{ part: 'Netto', type: 'højde', unit: 'centimeter' }])).toBeUndefined();
  });

  it('drops a part whose name it does not know', () => {
    expect(dimsOf([m('104,5', 'højde', 'centimeter', '91'), m('104,5', 'bredde', 'centimeter', '73.5')])).toBeUndefined();
    expect(dimsOf([{ part: 7, type: 'højde', unit: 'centimeter', value: '91' }])).toBeUndefined();
  });

  it('is absent when the record has no usable measurements', () => {
    expect(dimsOf(undefined)).toBeUndefined();
    expect(dimsOf([])).toBeUndefined();
    expect(dimsOf('91 x 73.5 cm')).toBeUndefined();
    expect(dimsOf([null, 'x', 3])).toBeUndefined();
    expect(dimsOf([m(undefined, 'vægt', 'kilo', '12')])).toBeUndefined();
  });

  it('ignores the notes text, which can disagree with the values', () => {
    // KKS4016 as published: notes "256 x 204 mm" beside values 51 x 52.
    expect(dimsOf([
      { notes: '256 x 204 mm', part: 'bladmaal', type: 'højde', unit: 'millimeter', value: '51' },
      { notes: '256 x 204 mm', part: 'bladmaal', type: 'bredde', unit: 'millimeter', value: '52' },
    ])).toBe('Sheet: 51 x 52 mm');
  });
});
