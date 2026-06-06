import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clevelandFetcher } from '../src/fetchers/cleveland.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('Cleveland adapter normalization', () => {
  it('normalizes a CC0 record (named artist, with image) into the Artwork shape', () => {
    const result = clevelandFetcher.normalize(fixture('cleveland-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('cleveland:135299');
    expect(a.museum.code).toBe('cleveland');
    expect(a.museum.name).toBe('Cleveland Museum of Art');
    expect(a.title).toBe('Adeline Ravoux');
    expect(a.artist.name).toBe('Vincent van Gogh');
    expect(a.artist.nationality).toBe('Dutch');
    expect(a.artist.lifespan).toBe('1853–1890');
    expect(a.artist.attributionType).toBe('named');
    expect(a.yearStart).toBe(1890);
    expect(a.yearEnd).toBe(1890);
    expect(a.region).toBe('netherlands');
    expect(a.medium).toBe('oil on fabric');
    expect(a.license.type).toBe('CC0');
    expect(a.license.verificationSource).toBe('cleveland.share_license_status');
    expect(a.license.confidence).toBe('high');
    expect(a.license.rawValue).toBe('CC0');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('clevelandart.org');
    expect(a.imageUrls.full).toContain('print');
    expect(a.imageUrls.thumbnail).toContain('web');
    expect(a.source.pageUrl).toContain('clevelandart.org');
    expect(a.source.apiUrl).toContain('openaccess-api.clevelandart.org');
    expect(a.description).toBe('1958.31');
  });

  it('rejects a record with non-CC0 share_license_status', () => {
    const result = clevelandFetcher.normalize(fixture('cleveland-rejected-restricted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason.toLowerCase()).toContain('copyrighted');
    expect(result.rejection.museumCode).toBe('cleveland');
  });

  it('rejects a record with no share_license_status (strict default)', () => {
    const result = clevelandFetcher.normalize(fixture('cleveland-rejected-missing-field.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('missing');
  });

  it('rejects garbage input gracefully', () => {
    expect(clevelandFetcher.normalize(null).status).toBe('rejected');
    expect(clevelandFetcher.normalize('not an object').status).toBe('rejected');
    expect(clevelandFetcher.normalize(42).status).toBe('rejected');
  });

  it('surfaces "cleveland:unknown" id on CC0-but-missing-id rejections', () => {
    // Record passes the rights gate but has no integer `id` — the fetcher
    // still rejects (downstream ID_REGEX would reject anyway), and the
    // rejection carries a placeholder id for log diagnostics.
    const result = clevelandFetcher.normalize({ data: { share_license_status: 'CC0' } });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.id).toBe('cleveland:unknown');
    expect(result.rejection.reason).toContain('missing or non-integer id');
  });

  it('accepts a record passed without the {data:...} envelope', () => {
    // A direct-record caller (e.g. a future test author) might pass the inner
    // object straight through. The fetcher tolerates either shape.
    const wrapped = fixture('cleveland-accepted.json') as { data: unknown };
    const result = clevelandFetcher.normalize(wrapped.data);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('cleveland:135299');
  });

  it('falls back to parseDisplayDate when earliest/latest are missing', () => {
    // Fixture without earliest/latest year fields, so parseDisplayDate runs.
    const baseline = fixture('cleveland-accepted.json') as { data: Record<string, unknown> };
    const sparser = {
      data: {
        ...baseline.data,
        creation_date: 'Tang dynasty (618–907)',
        creation_date_earliest: undefined,
        creation_date_latest: undefined,
      },
    };
    // JSON.stringify drops undefined keys for us, mirroring a real sparse response.
    const sparsed = JSON.parse(JSON.stringify(sparser));
    const result = clevelandFetcher.normalize(sparsed);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.yearStart).toBe(618);
    expect(result.artwork.yearEnd).toBe(907);
  });
});

describe('Cleveland adapter mediumCategory', () => {
  it('normalizes the raw `technique` field to the controlled vocab', () => {
    const result = clevelandFetcher.normalize(fixture('cleveland-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // "oil on fabric" -> painting
    expect(result.artwork.mediumCategory).toBe('painting');
  });

  it('falls back to "other" when `technique` carries no known signal', () => {
    const raw = structuredClone(fixture('cleveland-accepted.json')) as { data: Record<string, unknown> };
    raw.data.technique = '';
    const result = clevelandFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.mediumCategory).toBe('other');
  });
});
