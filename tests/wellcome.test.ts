import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wellcomeFetcher } from '../src/fetchers/wellcome.js';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
}

describe('Wellcome adapter normalization', () => {
  it('normalizes a CC0/PDM Pictures work into the Artwork shape', () => {
    const result = wellcomeFetcher.normalize(fixture('wellcome-accepted.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('wellcome:t2wgxnxy');
    expect(a.museum.code).toBe('wellcome');
    expect(a.title).toContain('John Gerard');
    expect(a.artist.name).toBe('John Payne');
    expect(a.yearStart).toBe(1633);
    expect(a.license.type).toBe('PD'); // Public Domain Mark
    expect(a.license.verificationSource).toBe('wellcome.iiif-image.license');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('iiif.wellcomecollection.org');
    expect(a.imageUrls.width).toBe(2250);
    expect(a.imageUrls.height).toBe(3480);
    expect(a.imageUrls.maxResolution).toEqual({ width: 2250, height: 3480 });
    expect(a.source.pageUrl).toBe('https://wellcomecollection.org/works/t2wgxnxy');
  });

  it('tiers a CC0-licensed image as CC0', () => {
    const raw = JSON.parse(JSON.stringify(fixture('wellcome-accepted.json'))) as {
      work: { items: Array<{ locations: Array<Record<string, unknown>> }> };
    };
    for (const it of raw.work.items) {
      for (const l of it.locations) {
        if ((l.locationType as { id?: string })?.id === 'iiif-image') l.license = { id: 'cc0', label: 'CC0' };
      }
    }
    const result = wellcomeFetcher.normalize(raw);
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.license.type).toBe('CC0');
  });

  it('REJECTS a CC-BY image (engine gate does not carry attribution yet)', () => {
    const result = wellcomeFetcher.normalize(fixture('wellcome-rejected-ccby.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/cc-by|cc0\/pdm|strict default/i);
    expect(result.rejection.museumCode).toBe('wellcome');
  });

  it('curation-REJECTS a non-art workType (Books) even when the image is PDM', () => {
    const result = wellcomeFetcher.normalize(fixture('wellcome-rejected-nonart.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/curation/i);
    expect(result.rejection.reason).toMatch(/books/i);
  });

  it('rejects when no iiif-image location exists', () => {
    const raw = JSON.parse(JSON.stringify(fixture('wellcome-accepted.json'))) as {
      work: { items: unknown[] };
    };
    raw.work.items = []; // no locations at all
    expect(wellcomeFetcher.normalize(raw).status).toBe('rejected');
  });

  it('rejects garbage input gracefully', () => {
    expect(wellcomeFetcher.normalize(null).status).toBe('rejected');
    expect(wellcomeFetcher.normalize('nope').status).toBe('rejected');
    expect(wellcomeFetcher.normalize({}).status).toBe('rejected');
  });
});

describe('Wellcome search query construction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pushes workType=Pictures + cc0,pdm licence filters server-side', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ results: [{ id: 'abc12345' }, { id: 'def67890' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ids = await wellcomeFetcher.search('anatomy', 5);
    const decoded = decodeURIComponent(capturedUrl);
    expect(decoded).toContain('workType=k');
    expect(decoded).toContain('items.locations.license=cc0,pdm');
    expect(decoded).toContain('query=anatomy');
    expect(ids).toEqual(['wellcome:abc12345', 'wellcome:def67890']);
  });
});
