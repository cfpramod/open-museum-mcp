import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { metFetcher } from '../src/fetchers/met.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('Met adapter normalization', () => {
  it('normalizes a Tang dynasty CC0 object to yearStart=618', () => {
    const result = metFetcher.normalize(fixture('met-tang-fixture.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('met:39901');
    expect(a.yearStart).toBe(618);
    expect(a.yearEnd).toBe(907);
    expect(a.license.type).toBe('CC0');
    expect(a.museum.code).toBe('met');
    expect(a.region).toBe('china');
    expect(a.title).toContain('Funerary');
    expect(a.artist.attributionType).toBe('anonymous');
    expect(a.source.pageUrl).toContain('metmuseum.org');
  });

  it('rejects an object with isPublicDomain=false', () => {
    const result = metFetcher.normalize(fixture('met-rejected-copyrighted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('isPublicDomain=false');
  });

  it('rejects an object with missing isPublicDomain (strict default)', () => {
    const result = metFetcher.normalize(fixture('met-rejected-missing-field.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default');
  });

  it('rejects garbage input gracefully', () => {
    const result = metFetcher.normalize(null);
    expect(result.status).toBe('rejected');
  });
});
