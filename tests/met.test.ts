import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(a.license.verificationSource).toBe('met.isPublicDomain');
    expect(a.license.confidence).toBe('high');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
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

  // P0 spine guard: the rights gate must keep rejecting non-public-domain
  // objects even though the search call no longer pre-filters to
  // isPublicDomain=true upstream. normalize() is the enforcement point, not the
  // search filter — removing the filter must not weaken the gate.
  it('P0 spine: still rejects a non-PD object after the search pre-filter is removed', () => {
    const result = metFetcher.normalize(fixture('met-rejected-copyrighted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('isPublicDomain=false');
  });
});

describe('Met adapter search (relevance)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: URL) => number[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const objectIDs = handler(new URL(String(input)));
        return new Response(JSON.stringify({ objectIDs, total: objectIDs.length }), { status: 200 });
      }),
    );
  }

  it('passes the query through and no longer constrains to isPublicDomain', async () => {
    let captured: URL | undefined;
    stubFetch((url) => {
      captured = url;
      return [1, 2, 3];
    });

    await metFetcher.search('van gogh', 10);

    expect(captured?.searchParams.get('q')).toBe('van gogh');
    expect(captured?.searchParams.has('isPublicDomain')).toBe(false);
    expect(captured?.searchParams.get('hasImages')).toBe('true');
  });

  it('a gibberish query does not return the same fixed set as a real query', async () => {
    // Emulates the Met API quirk that motivated the fix: with isPublicDomain=true
    // present, a non-matching query falls back to a fixed public-domain set
    // instead of an empty/relevant result, so unrelated queries collapse to the
    // same IDs. Without the filter, results track the query — relevance restored.
    const FIXED_PD_FALLBACK = [1, 2, 3];
    stubFetch((url) => {
      if (url.searchParams.has('isPublicDomain')) return FIXED_PD_FALLBACK;
      const q = url.searchParams.get('q') ?? '';
      return q === 'van gogh' ? [11, 22, 33] : [];
    });

    const real = await metFetcher.search('van gogh', 10);
    const gibberish = await metFetcher.search('zxqwvk asdfgh qpwoeiruty', 10);

    expect(real).not.toEqual(gibberish);
    expect(real).toEqual(['met:11', 'met:22', 'met:33']);
    expect(gibberish).toEqual([]);
  });
});
