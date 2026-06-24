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
