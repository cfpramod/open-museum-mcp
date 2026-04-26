import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { wikimediaFetcher } from '../src/fetchers/wikimedia.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  const path = join(here, 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('Wikimedia Commons adapter normalization', () => {
  it('normalizes a PD-licensed file (Bruegel Fall of Icarus) into the Artwork shape', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-accepted-bruegel.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;

    const a = result.artwork;
    expect(a.id).toBe('wikimedia:15493856');
    expect(a.museum.code).toBe('wikimedia');
    expect(a.museum.name).toBe('Wikimedia Commons');
    expect(a.title).toBe('Landscape with the Fall of Icarus');
    expect(a.artist.name).toContain('Pieter Brueghel the Elder');
    expect(a.artist.attributionType).toBe('named');
    expect(a.license.type).toBe('PD');
    expect(a.license.rawValue).toBe('pd');
    expect(a.license.verificationSource).toBe('wikimedia.extmetadata.License');
    expect(a.license.confidence).toBe('high');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('upload.wikimedia.org');
    expect(a.source.pageUrl).toContain('commons.wikimedia.org');
  });

  it('normalizes a CC0-licensed file with the CC0 license tier', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-accepted-cc0.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.license.type).toBe('CC0');
    expect(result.artwork.license.rawValue).toBe('cc0');
  });

  it('rejects a CC BY-SA file (attribution + share-alike imposes obligations)', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-rejected-cc-by-sa.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('cc-by-sa-4.0');
  });

  it('rejects a file with no License field (strict default deny)', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-rejected-missing-license.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('missing');
  });

  it('rejects garbage input gracefully', () => {
    expect(wikimediaFetcher.normalize(null).status).toBe('rejected');
    expect(wikimediaFetcher.normalize('not an object').status).toBe('rejected');
    expect(wikimediaFetcher.normalize(42).status).toBe('rejected');
  });

  it('rejects when the response has no pages', () => {
    const result = wikimediaFetcher.normalize({ batchcomplete: '', query: { pages: [] } });
    expect(result.status).toBe('rejected');
  });

  it('rejects when imageinfo is missing (deleted file or non-image)', () => {
    const result = wikimediaFetcher.normalize({
      query: { pages: [{ pageid: 12345, title: 'File:Deleted.txt' }] },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('imageinfo missing');
  });

  it('rejects a non-image mime type even when license is PD', () => {
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 99000004,
            title: 'File:Some PDF.pdf',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/SomePDF.pdf',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Some_PDF.pdf',
                mime: 'application/pdf',
                extmetadata: { License: { value: 'pd' } },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('non-image mime');
  });

  it('accepts a file passed as a direct page object (unwrapped fixture form)', () => {
    const wrapped = fixture('wikimedia-accepted-bruegel.json') as { query: { pages: unknown[] } };
    const page = wrapped.query.pages[0];
    const result = wikimediaFetcher.normalize(page);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('wikimedia:15493856');
  });

  it('tolerates legacy formatversion=1 page-object-keyed-by-pageid shape', () => {
    const result = wikimediaFetcher.normalize({
      query: {
        pages: {
          '15493856': {
            pageid: 15493856,
            title: 'File:Test.jpg',
            imageinfo: [
              {
                url: 'https://example.org/img.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Test.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pd' } },
              },
            ],
          },
        },
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('wikimedia:15493856');
  });

  it('accepts pd-art subtype (PD-Art template for 2D PD reproductions)', () => {
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000001,
            title: 'File:Some PD-Art File.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/PDArt.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:PDArt.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pd-art' } },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.license.type).toBe('PD');
    expect(result.artwork.license.rawValue).toBe('pd-art');
  });

  it('surfaces "wikimedia:unknown" id on rights-pass + bad-pageid rejections', () => {
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            // pageid missing / not an integer
            title: 'File:Some File.jpg',
            imageinfo: [
              {
                url: 'https://example.org/img.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pd' } },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.id).toBe('wikimedia:unknown');
    expect(result.rejection.reason).toContain('missing or non-integer pageid');
  });
});
