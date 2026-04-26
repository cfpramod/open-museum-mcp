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
    // Description carries "c. 1560s." → tryDecade matches "1560s" → {1560, 1569}.
    // Locks down the parseDisplayDate(description) path.
    expect(a.yearStart).toBe(1560);
    expect(a.yearEnd).toBe(1569);
    expect(a.displayDate).toBe('1560–1569');
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
    expect(result.rejection.reason).toContain('non-image or missing mime');
  });

  it('rejects a record with missing mime type even when license is PD', () => {
    // Defense in depth: a PD-licensed record without a declared MIME can't
    // honestly promise imageUrls.full is an image, so reject.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 99000005,
            title: 'File:No Mime.bin',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/NoMime.bin',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:No_Mime.bin',
                extmetadata: { License: { value: 'pd' } },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('missing mime');
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

  it('accepts the Public Domain Mark (pdm) and pdm-* subtypes', () => {
    // Creative Commons' Public Domain Mark template. Genuinely PD; locked
    // down separately so a future regex tightening doesn't drop it.
    const pdm = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000002,
            title: 'File:PDM File.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/PDM.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:PDM.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pdm' } },
              },
            ],
          },
        ],
      },
    });
    expect(pdm.status).toBe('accepted');

    const pdmVersioned = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000003,
            title: 'File:PDM 1.0.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/PDMv.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:PDMv.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pdm-1.0' } },
              },
            ],
          },
        ],
      },
    });
    expect(pdmVersioned.status).toBe('accepted');
  });

  it('decodes HTML entities in artist and description fields', () => {
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000004,
            title: 'File:Entity Test.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/Entity.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Entity.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Picasso &amp; Friends' },
                  Artist: { value: '&quot;Anonymous&quot;' },
                  ImageDescription: { value: 'Made in 1850. Gallery &#x2014; West Wing.' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).toBe('Picasso & Friends');
    expect(result.artwork.artist.name).toContain('"Anonymous"');
    expect(result.artwork.description).toContain('Made in 1850. Gallery — West Wing.');
  });

  it('strips Wikidata Quick Statements metadata from ObjectName', () => {
    // Real Commons records concatenate "title QS:P1476,en:..." into the
    // ObjectName field for structured-data tracking. Strip it.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000010,
            title: 'File:Test.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/Test.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Test.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: {
                    value: 'Landscape with the Fall of Icarus title QS:P1476,en:"Landscape with the Fall of Icarus"',
                  },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).toBe('Landscape with the Fall of Icarus');
  });

  it('strips QS metadata even with no leading space (Liliestitle QS:...)', () => {
    // The pathological case: "Water Liliestitle QS:..." with no separator.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000011,
            title: 'File:Lilies.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/Lilies.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lilies.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Water Liliestitle QS:P1476,de:"Seerosen"' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).toBe('Water Lilies');
  });

  it('falls back to title for date parsing when description has no date', () => {
    // Real Commons titles often carry the year: "Water Lilies (1916) Claude Monet".
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000012,
            title: 'File:Water Lilies 1916.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/WL1916.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:WL1916.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Water Lilies (1916)' },
                  ImageDescription: { value: 'A painting of water lilies.' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.yearStart).toBe(1916);
    expect(result.artwork.yearEnd).toBe(1916);
  });

  it('emits empty displayDate when no date can be parsed from description', () => {
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000005,
            title: 'File:Undated.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/Undated.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Undated.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ImageDescription: { value: 'A photograph with no recoverable date.' },
                  Artist: { value: 'Photographer (1900–1980)' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // Honest absence: no date in description → empty displayDate, null years.
    // The artist's lifespan is NOT used as a fallback (it's the artist's
    // life, not the artwork's date).
    expect(result.artwork.displayDate).toBe('');
    expect(result.artwork.yearStart).toBe(null);
    expect(result.artwork.yearEnd).toBe(null);
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
