import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harvardFetcher } from '../src/fetchers/harvard.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
}

describe('Harvard adapter normalization', () => {
  it('surfaces an open-access record (imagepermissionlevel=0) as OTHER, openAccess=true', () => {
    const result = harvardFetcher.normalize(fixture('harvard-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('harvard:299918');
    expect(a.museum.code).toBe('harvard');
    expect(a.title).toContain('Dara Shikoh');
    expect(a.region).toBe('india'); // from culture "Indian"
    // Open Clearance: the rights are surfaced honestly, not promoted to CC0/PD.
    expect(a.license.type).toBe('OTHER');
    expect(a.license.verificationSource).toBe('harvard.imagepermissionlevel');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('harvard');
    expect(a.source.pageUrl).toContain('harvard');
  });

  it('REJECTS a restricted image (imagepermissionlevel=1)', () => {
    const result = harvardFetcher.normalize(fixture('harvard-rejected-restricted.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/imagepermissionlevel=1|open access/i);
    expect(result.rejection.museumCode).toBe('harvard');
  });

  it('rejects a record with no primary image', () => {
    const result = harvardFetcher.normalize(fixture('harvard-rejected-no-image.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/image/i);
  });

  it('rejects garbage input gracefully', () => {
    expect(harvardFetcher.normalize(null).status).toBe('rejected');
    expect(harvardFetcher.normalize('nope').status).toBe('rejected');
    expect(harvardFetcher.normalize(42).status).toBe('rejected');
  });

  it('is marked no-cache (Harvard ToS forbids caching beyond two weeks)', () => {
    expect(harvardFetcher.noCache).toBe(true);
  });
});

describe('Harvard search query construction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the API key + hasimage filter and parses numeric ids', async () => {
    const prev = process.env.HARVARD_API_KEY;
    process.env.HARVARD_API_KEY = 'test-key';
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ records: [{ id: 299918 }, { id: 303829 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ids = await harvardFetcher.search('mughal', 5);
    expect(capturedUrl).toContain('apikey=test-key');
    expect(capturedUrl).toContain('hasimage=1');
    expect(ids).toEqual(['harvard:299918', 'harvard:303829']);
    if (prev === undefined) delete process.env.HARVARD_API_KEY;
    else process.env.HARVARD_API_KEY = prev;
  });
});

describe('Harvard provenance mapping (v0.20.0, openclearance P-7 posture)', () => {
  it('carries the provenance string as verbatim raw text plus a single-entry interpretation', () => {
    const result = harvardFetcher.normalize(fixture('harvard-provenance.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    const prov = result.artwork.provenance;
    expect(prov).toBeDefined();
    expect(prov!.rawFormat).toBe('text');
    expect(prov!.raw.length).toBeGreaterThan(0);
    expect(prov!.entries![0].description).toBe(prov!.raw);
  });

  it('omits provenance when the source publishes null (real capture; absence is not a finding)', () => {
    const result = harvardFetcher.normalize(fixture('harvard-accepted.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect('provenance' in result.artwork).toBe(false);
  });
});
