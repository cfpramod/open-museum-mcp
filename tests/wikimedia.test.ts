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

  it('curation-rejects the flagship non-art SVG diagram (wikimedia:157318642), rights aside', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-rejected-nonart-svg.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/curation/i);
    expect(result.rejection.reason).toMatch(/svg/i);
  });

  it('curation-rejects raster (PNG) non-art via the topical category (wikimedia:175537332)', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-rejected-nonart-png.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/curation/i);
    expect(result.rejection.reason).toMatch(/open access|publishing/i);
  });

  it('still accepts a genuine artwork after the curation gate (no false positive)', () => {
    // the existing CC0 photograph fixture is real art with no non-art signal
    expect(wikimediaFetcher.normalize(fixture('wikimedia-accepted-cc0.json')).status).toBe('accepted');
    expect(wikimediaFetcher.normalize(fixture('wikimedia-accepted-bruegel.json')).status).toBe('accepted');
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

  it('rejects jurisdiction-scoped public-domain tokens (pd-us, pd-1923)', () => {
    // An accepted record is emitted as a worldwide PD determination (the
    // Clearance Manifest stamps the worldwide Public Domain Mark URI at
    // confidence: high). US-only tokens assert a narrower scope, so promoting
    // them to a worldwide claim would over-state the right. Strict-default-deny:
    // reject — the same reason the Europeana gate rejects NoC-US.
    const usOnly = ['pd-us', 'pd-us-no-notice', 'pd-1923', 'pd-usgov'];
    for (const value of usOnly) {
      const result = wikimediaFetcher.normalize({
        query: {
          pages: [
            {
              pageid: 88000005,
              title: `File:US-only ${value}.jpg`,
              imageinfo: [
                {
                  url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/USonly.jpg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:USonly.jpg',
                  mime: 'image/jpeg',
                  extmetadata: { License: { value } },
                },
              ],
            },
          ],
        },
      });
      expect(result.status, `expected ${value} to be rejected`).toBe('rejected');
    }
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

  it('strips multilingual language prefix from ObjectName', () => {
    // Real Commons records carry concatenated multilingual labels:
    //   "German: Seerosen Water Lilies"
    //   "Japanese: 『神奈川沖浪裏』 - Kanagawa oki nami ura"
    // Strip the leading `<Language>: ` prefix.
    const german = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000020,
            title: 'File:Seerosen.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/Seerosen.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Seerosen.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'German: Seerosen Water Lilies' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(german.status).toBe('accepted');
    if (german.status !== 'accepted') return;
    expect(german.artwork.title).toBe('Seerosen Water Lilies');

    const japanese = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000021,
            title: 'File:GreatWave.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/GW.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:GW.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Japanese: 『神奈川沖浪裏』 - Kanagawa oki nami ura' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(japanese.status).toBe('accepted');
    if (japanese.status !== 'accepted') return;
    expect(japanese.artwork.title).toBe('『神奈川沖浪裏』 - Kanagawa oki nami ura');
  });

  it('does not strip a real "<Word>:" prefix that is not a known language', () => {
    // Defensive: real titles like "Lions: An Allegory" should survive.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000022,
            title: 'File:Lions.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/Lions.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Lions.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Lions: An Allegory' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).toBe('Lions: An Allegory');
  });

  it('strips zero-padded file-numbering suffix from fileTitle fallback', () => {
    // No ObjectName in extmetadata → use page.title (filename) as fallback.
    // Commons file-numbering convention: " 02", " 03", etc.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000023,
            title: 'File:Detail of "The Water-Lily Pond" by Claude Monet 02.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/M02.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:M02.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  // ObjectName intentionally absent so fileTitle is used
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).toBe('Detail of "The Water-Lily Pond" by Claude Monet');
  });

  it('does not strip non-zero-padded trailing numbers from fileTitle', () => {
    // "Symphony No 5" or "Movement 12" are real titles, not file numbering.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000024,
            title: 'File:Symphony No 5.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/SY.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:SY.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pd' } },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.title).toBe('Symphony No 5');
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

  it('does NOT parse fileTitle as a date source (filenames encode inventory numbers)', () => {
    // British Museum file naming convention: "BM 1906.1220.0.533" — the
    // 1906 is acquisition year, not artwork creation. Filenames carry
    // these patterns reliably enough that we exclude fileTitle from date
    // sources. The honest output is null years here.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000030,
            title: 'File:Great Wave Hokusai BM 1906.1220.0.533 n02.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/G.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:G.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: '『神奈川沖浪裏』' },
                  ImageDescription: { value: 'A famous wave print by Hokusai.' },
                },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.yearStart).toBe(null);
    expect(result.artwork.yearEnd).toBe(null);
  });

  it('falls back to categories when neither description nor title carry a date', () => {
    // Real Commons records often have year-bearing categories like
    // "Category:1910s paintings by Claude Monet" even when the description
    // and title don't carry creation dates.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000031,
            title: 'File:Water Lilies.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/W.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:W.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Water Lilies' },
                },
              },
            ],
            categories: [
              { ns: 14, title: 'Category:Paintings by Claude Monet' },
              { ns: 14, title: 'Category:1910s paintings by Claude Monet' },
              { ns: 14, title: 'Category:Water Lilies by Claude Monet' },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // Decade "1910s" → {1910, 1919}
    expect(result.artwork.yearStart).toBe(1910);
    expect(result.artwork.yearEnd).toBe(1919);
  });

  it('picks the narrowest range across categories with multiple year signals', () => {
    // When a file is in both "1916 paintings" (single year, span 0) and
    // "1910s paintings" (decade, span 9) and "16th-century paintings"
    // (century, span 99), the narrowest wins because it's most specific.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000032,
            title: 'File:Some Painting.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/S.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:S.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Some Painting' },
                },
              },
            ],
            categories: [
              { ns: 14, title: 'Category:20th-century paintings' },
              { ns: 14, title: 'Category:1910s paintings' },
              { ns: 14, title: 'Category:1916 paintings' },
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

  it('skips non-art-medium categories (exhibitions, catalogue entries, locations)', () => {
    // Real false-positive cases observed on live records:
    //   "GLAMhybrid Museum Barberini 2023" → 2023 (exhibition, not creation)
    //   "October 2010 in Munich" → 2010 (photo upload location, not creation)
    //   "Le Bassin aux nymphéas (Wildenstein 1884)" → 1884 (catalogue entry, not creation)
    // Only categories naming an art medium (paintings, prints, sculpture, etc.)
    // are parsed for dates.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000034,
            title: 'File:Some Work.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/SW.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:SW.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Some Work' },
                },
              },
            ],
            categories: [
              { ns: 14, title: 'Category:GLAMhybrid Museum Barberini 2023' },
              { ns: 14, title: 'Category:October 2010 in Munich' },
              { ns: 14, title: 'Category:Le Bassin aux nymphéas (Wildenstein 1884)' },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    // No art-medium category present → honest empty.
    expect(result.artwork.yearStart).toBe(null);
    expect(result.artwork.yearEnd).toBe(null);
  });

  it('description date wins over category date (description is more authoritative)', () => {
    // Sanity check the source-order precedence: description > title > categories.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000033,
            title: 'File:Some Work.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/SW.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:SW.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  ObjectName: { value: 'Some Work' },
                  ImageDescription: { value: 'Made in 1850.' },
                },
              },
            ],
            categories: [
              // Categories say something different — description should win.
              { ns: 14, title: 'Category:1916 paintings' },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.yearStart).toBe(1850);
    expect(result.artwork.yearEnd).toBe(1850);
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

  it('surfaces image dimensions and byte size on imageUrls', () => {
    // imageinfo carries width/height/size; we already fetch them via
    // `iiprop=size`. Surface them so callers can pick the best upload
    // when multiple Commons records cover the same painting.
    const result = wikimediaFetcher.normalize(fixture('wikimedia-accepted-bruegel.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageUrls.width).toBe(1246);
    expect(result.artwork.imageUrls.height).toBe(800);
    expect(result.artwork.imageUrls.byteSize).toBe(152771);
  });

  it('omits dimensions when the Commons record does not publish them', () => {
    // Defense: width/height/size missing should not surface as 0 or null —
    // the fields stay undefined so callers can distinguish "unknown" from
    // "small image".
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000040,
            title: 'File:NoDims.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/NoDims.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:NoDims.jpg',
                mime: 'image/jpeg',
                extmetadata: { License: { value: 'pd' } },
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.imageUrls.width).toBeUndefined();
    expect(result.artwork.imageUrls.height).toBeUndefined();
    expect(result.artwork.imageUrls.byteSize).toBeUndefined();
  });

  it('parses Credit field into source.originalUrl when it carries an upstream link', () => {
    // Real Commons Credit fields wrap the originating museum's link:
    //   <a href="https://www.thyssen.org/...">Museo Thyssen-Bornemisza</a>
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000041,
            title: 'File:Modigliani.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/M.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:M.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  Credit: {
                    value:
                      '<a href="https://www.thyssen.org/lunia">Museo Nacional Thyssen-Bornemisza</a>',
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
    expect(result.artwork.source.originalUrl).toBe('https://www.thyssen.org/lunia');
  });

  it('leaves source.originalUrl undefined when Credit is plain text (no link)', () => {
    // The Bruegel fixture's Credit is "Web Gallery of Art" — plain text, no
    // anchor. Don't synthesise a URL.
    const result = wikimediaFetcher.normalize(fixture('wikimedia-accepted-bruegel.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.source.originalUrl).toBeUndefined();
  });

  it('extracts only the first href from Credit when it contains multiple anchors', () => {
    // Some Commons records have a long Credit blob with several links
    // (museum, photographer, license boilerplate). The originating
    // institution is conventionally the first anchor.
    const result = wikimediaFetcher.normalize({
      query: {
        pages: [
          {
            pageid: 88000042,
            title: 'File:MultiCredit.jpg',
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/wikipedia/commons/x/xx/MC.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:MC.jpg',
                mime: 'image/jpeg',
                extmetadata: {
                  License: { value: 'pd' },
                  Credit: {
                    value:
                      '<a href="https://museum.example.org/object/123">Example Museum</a>, photographed by <a href="https://example.com/photographer">A Photographer</a>',
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
    expect(result.artwork.source.originalUrl).toBe('https://museum.example.org/object/123');
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

describe('Wikimedia Commons adapter mediumCategory', () => {
  // Commons has no reliable structured medium field; the curated art-medium
  // categories ("16th-century oil paintings") are the signal. The artwork title
  // (ObjectName) is deliberately NOT used — a work titled "The Sculptor" is not
  // a sculpture, and guessing from a title would violate strict-other.
  it('derives mediumCategory from an art-medium category title', () => {
    const raw = structuredClone(fixture('wikimedia-accepted-bruegel.json')) as {
      query: { pages: Array<Record<string, unknown>> };
    };
    raw.query.pages[0].categories = [
      { ns: 14, title: 'Category:Web Gallery of Art' },
      { ns: 14, title: 'Category:16th-century oil paintings' },
    ];
    const result = wikimediaFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.mediumCategory).toBe('painting');
  });

  it('falls back to "other" when no category names a medium (title is not used)', () => {
    // The Bruegel fixture carries no categories and its ObjectName is a title
    // ("Landscape with the Fall of Icarus") — no medium signal, so strict other.
    const result = wikimediaFetcher.normalize(fixture('wikimedia-accepted-bruegel.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.mediumCategory).toBe('other');
  });
});
