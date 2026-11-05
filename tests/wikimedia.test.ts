import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { wikimediaFetcher } from '../src/fetchers/wikimedia.js';
import { growthRatio, LINEAR_CEILING } from './helpers/growth.js';

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

describe('Wikimedia non-displayable originals (image/tiff → displayable full + master) [W1]', () => {
  // PR #105 made `full` contractually browser-displayable. Commons hosts raster
  // TIFF art scans that pass the image/ MIME prefix AND survive the curation gate
  // (a TIFF painting is legitimate art) but DON'T render in an <img>. They must be
  // routed to `master`, with `full` set to a Commons-rendered JPEG — or rejected.
  function tiffPage(opts: { thumburl?: string; title?: string }) {
    const imageinfo: Record<string, unknown> = {
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Great_Painting.tif',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Great_Painting.tif',
      mime: 'image/tiff',
      width: 9000,
      height: 7000,
      size: 350_000_000,
      extmetadata: { License: { value: 'pd' }, ObjectName: { value: 'Great Painting' } },
    };
    if (opts.thumburl) {
      imageinfo.thumburl = opts.thumburl;
      imageinfo.thumbwidth = 2048;
      imageinfo.thumbheight = 1593;
    }
    return {
      query: {
        pages: [
          { pageid: 77000001, title: opts.title ?? 'File:Great_Painting.tif', imageinfo: [imageinfo] },
        ],
      },
    };
  }

  it('uses the imageinfo thumburl (rendered JPEG) as `full`, routes the TIFF to `master`', () => {
    const result = wikimediaFetcher.normalize(
      tiffPage({
        thumburl:
          'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Great_Painting.tif/2048px-Great_Painting.tif.jpg',
      }),
    );
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const iu = result.artwork.imageUrls;
    // `full` is a rendered JPEG — never the raw .tif.
    expect(iu.full).toContain('.jpg');
    expect(iu.full).not.toMatch(/\.tif$/);
    expect(iu.width).toBe(2048);
    expect(iu.height).toBe(1593);
    // master carries the full-resolution TIFF original, flagged as image/tiff.
    expect(iu.master?.url).toMatch(/\.tif$/);
    expect(iu.master?.format).toBe('image/tiff');
    expect(iu.master?.width).toBe(9000);
    expect(iu.master?.height).toBe(7000);
    expect(iu.master?.byteSize).toBe(350_000_000);
    // maxResolution reports the TRUE max (the master), not the 2048px derivative.
    expect(iu.maxResolution).toEqual({ width: 9000, height: 7000 });
  });

  it('falls back to Special:FilePath?width= when no thumburl is published', () => {
    const result = wikimediaFetcher.normalize(tiffPage({}));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const iu = result.artwork.imageUrls;
    expect(iu.full).toContain('Special:FilePath');
    expect(iu.full).toContain('width=2048');
    expect(iu.full).not.toMatch(/\.tif$/);
    expect(iu.master?.format).toBe('image/tiff');
    expect(iu.maxResolution).toEqual({ width: 9000, height: 7000 });
  });

  it('rejects a non-displayable original when no rendition can be produced (no thumburl, no title)', () => {
    const result = wikimediaFetcher.normalize(tiffPage({ title: '' }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toMatch(/no browser-displayable rendition/);
    expect(result.rejection.reason).toContain('image/tiff');
  });

  it('leaves a normal JPEG untouched: original is `full`, no master', () => {
    const result = wikimediaFetcher.normalize(fixture('wikimedia-accepted-bruegel.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const iu = result.artwork.imageUrls;
    expect(iu.full).toContain('upload.wikimedia.org');
    expect(iu.full).toMatch(/\.jpg$/i);
    expect(iu.master).toBeUndefined();
    expect(iu.maxResolution).toEqual({ width: 1246, height: 800 });
  });
});

// Commons extmetadata is free text written by uploaders, and the mapper strips
// HTML from it before any length cap applies. Tag stripping must stay linear on
// a long run of unclosed '<' (a `/<[^>]*>/g` replace is quadratic on that input).
// 100k chars: the linear pass takes well under 100ms; a quadratic pass takes
// seconds on one field, so a regression fails the 1s ceiling quickly.
describe('Wikimedia mapper: tag stripping is linear on unclosed "<" runs', () => {
  const UNCLOSED = '<'.repeat(100_000);

  function withExtField(field: string, value: string): unknown {
    const raw = fixture('wikimedia-accepted-cc0.json') as {
      query: { pages: Array<{ imageinfo: Array<{ extmetadata: Record<string, unknown> }> }> };
    };
    raw.query.pages[0].imageinfo[0].extmetadata[field] = { value, source: 'commons-desc-page' };
    return raw;
  }

  for (const field of ['ObjectName', 'Artist', 'ImageDescription']) {
    it(`normalizes a 100k unclosed-"<" ${field} in under 1s`, () => {
      const raw = withExtField(field, `<b>Kept</b> ${UNCLOSED}`);
      const start = performance.now();
      const result = wikimediaFetcher.normalize(raw);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
      expect(result.status).toBe('accepted');
    });
  }
});

// Commons renders extmetadata from wiki templates, so the HTML carries layout
// the reader never sees as text. Two live records (both saved verbatim as
// fixtures) showed the effect: the {{title}} template puts the original-language
// title and its English translation on two lines, which fused into one word,
// and the {{Unknown}} template appends a hidden copy of its own label, which
// doubled the artist name.
describe('Wikimedia mapper: template layout in ObjectName and Artist', () => {
  function withExtField(field: string, value: string): unknown {
    const raw = fixture('wikimedia-accepted-cc0.json') as {
      query: { pages: Array<{ imageinfo: Array<{ extmetadata: Record<string, unknown> }> }> };
    };
    raw.query.pages[0].imageinfo[0].extmetadata[field] = { value, source: 'commons-desc-page' };
    return raw;
  }

  function accepted(raw: unknown) {
    const result = wikimediaFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('expected an accepted record');
    return result.artwork;
  }

  it('titles a {{title}} template record as the original title with the English in parentheses', () => {
    const a = accepted(fixture('wikimedia-accepted-title-template.json'));
    expect(a.id).toBe('wikimedia:74450965');
    expect(a.title).toBe('De triomf van de Doods (The Triumph of Death)');
    expect(a.artist.name).toBe('Pieter Brueghel the Elder');
  });

  it('drops the hidden copy {{Unknown}} appends to the artist label', () => {
    const a = accepted(fixture('wikimedia-accepted-hidden-span.json'));
    expect(a.id).toBe('wikimedia:152447317');
    expect(a.artist.name).toBe('Unknown author');
    expect(a.artist.attributionType).toBe('anonymous');
  });

  it('titles a Wikidata-driven record as original (English) and leaves out the alternative titles', () => {
    const a = accepted(fixture('wikimedia-accepted-alternative-title.json'));
    expect(a.id).toBe('wikimedia:11452106');
    expect(a.title).toBe("Dama con l'ermelli (Lady with an Ermine)");
  });

  it('ends the title at the hidden Wikidata label block, as the text marker did before', () => {
    const a = accepted(
      withExtField(
        'ObjectName',
        '<div>Zonnebloemen</div><div style="display: none;">label QS:Len,"Sunflowers"</div>' +
          '<br><b>Alternative title(s): </b><br> <div>Vase with Fifteen Sunflowers</div>',
      ),
    );
    expect(a.title).toBe('Zonnebloemen');
  });

  it('reads an italic translation wrapped in layout elements after the line break', () => {
    const a = accepted(
      withExtField(
        'ObjectName',
        '<div>Italian: <div lang="it"><i>Girasoli</i></div></div><br>' +
          '<div style="font-weight:bold"><div lang="en"><i>Sunflowers</i></div></div>',
      ),
    );
    expect(a.title).toBe('Girasoli (Sunflowers)');
  });

  it('keeps a line break followed by a layout element without italics as a plain separator', () => {
    const a = accepted(withExtField('ObjectName', '<div>Zonnebloemen</div><br><div>Arles, 1888</div>'));
    expect(a.title).toBe('Zonnebloemen Arles, 1888');
  });

  it('gives one title, without parentheses, when the translation repeats the original', () => {
    const a = accepted(withExtField('ObjectName', '<div>Sunflowers</div><br><i>Sunflowers</i>'));
    expect(a.title).toBe('Sunflowers');
  });

  it('gives the original title alone when the translation line is empty', () => {
    const a = accepted(withExtField('ObjectName', '<div>Zonnebloemen</div><br><i></i>'));
    expect(a.title).toBe('Zonnebloemen');
  });

  it('keeps a line break that is not followed by an italic translation as a plain separator', () => {
    const a = accepted(withExtField('ObjectName', 'Zonnebloemen<br>Arles, 1888'));
    expect(a.title).toBe('Zonnebloemen Arles, 1888');
  });

  it('does not read an <img> after the line break as an italic translation', () => {
    const a = accepted(withExtField('ObjectName', 'Zonnebloemen<br><img src="x">Sunflowers'));
    expect(a.title).toBe('Zonnebloemen Sunflowers');
  });

  it('drops the Wikidata marker from the translation line too', () => {
    const a = accepted(
      withExtField('ObjectName', '<div>Zonnebloemen</div><br><i>Sunflowers</i> title QS:P1476,nl:"Zonnebloemen"'),
    );
    expect(a.title).toBe('Zonnebloemen (Sunflowers)');
  });

  it('drops a hidden element together with everything nested inside it', () => {
    const a = accepted(
      withExtField('Artist', 'Jan Steen<div style="display:none"><span>Jan</span> <span>Steen</span></div>'),
    );
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('drops a hidden element nested in an element of the same name', () => {
    const a = accepted(
      withExtField('Artist', '<span>Jan <span style="display: none">x</span>Steen</span>'),
    );
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('drops a hidden element that contains an element of its own name, up to its own close', () => {
    const a = accepted(
      withExtField('Artist', 'Jan Steen<span style="display:none"><span>Jan</span> Steen</span>'),
    );
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('drops a hidden void or self-closing element without swallowing the text after it', () => {
    const a = accepted(
      withExtField(
        'ImageDescription',
        'Oil on canvas.<img style="display:none" src="x"> Signed<span style="display:none"/> lower left.',
      ),
    );
    expect(a.description).toBe('Oil on canvas. Signed lower left.');
  });

  it('keeps an element whose attribute name only ends in "style"', () => {
    const a = accepted(withExtField('Artist', '<span data-style="display:none">Jan Steen</span>'));
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('does not read an italic inside a bold element after the line break as a translation', () => {
    const a = accepted(withExtField('ObjectName', 'Zonnebloemen<br><b><i>Arles</i></b>'));
    expect(a.title).toBe('Zonnebloemen Arles');
  });

  it('does not read an italic in the next block as a translation when the line break ends its own block', () => {
    const a = accepted(withExtField('ObjectName', '<div>Zonnebloemen<br></div><div><i>Arles</i></div>'));
    expect(a.title).toBe('Zonnebloemen Arles');
  });

  it('drops an unclosed hidden element to the end of the field, as a browser would', () => {
    const a = accepted(withExtField('Artist', 'Jan Steen<span style="DISPLAY : NONE">Jan Steen'));
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('keeps elements whose style only mentions another display value', () => {
    const a = accepted(withExtField('Artist', '<span style="display:inline-block">Jan Steen</span>'));
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('keeps an element whose non-style attribute happens to say display:none', () => {
    const a = accepted(withExtField('Artist', '<span title="display:none">Jan Steen</span>'));
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('drops hidden text from the description as well', () => {
    const a = accepted(
      withExtField('ImageDescription', 'Oil on canvas.<span style="display:none">Oil on canvas.</span>'),
    );
    expect(a.description).toBe('Oil on canvas.');
  });

  it('stays linear on a long run of nested hidden elements', () => {
    const value = (count: number): string => `Jan Steen${'<span style="display:none">'.repeat(count)}x`;
    const ratio = growthRatio((count) => wikimediaFetcher.normalize(withExtField('Artist', value(count))), 20_000);
    expect(ratio).toBeLessThan(LINEAR_CEILING);
    expect(accepted(withExtField('Artist', value(20_000))).artist.name).toBe('Jan Steen');
  }, 60_000);

  // The marker used to be matched on the stripped, decoded text, where a tag
  // between "label" and "QS:" left nothing and a whitespace entity read as a
  // space. The raw-HTML match has to see through the same things.
  for (const [what, between] of [
    ['an empty inline element', '<span></span> '],
    ['a decimal space entity', '&#32;'],
    ['a hexadecimal space entity', '&#x20;'],
    ['a named no-break space', '&nbsp;'],
    ['a numeric no-break space', '&#160;'],
    ['a decimal em space', '&#8195;'],
    ['a hexadecimal em space', '&#x2003;'],
    ['a form feed', '&#12;'],
    ['an ideographic space', '&#x3000;'],
    ['a byte order mark', '&#65279;'],
    ['a tag holding a second "<"', '<x <y>'],
    ['an inline tag and a space entity', '<i></i>&#x2003;<b></b>'],
  ]) {
    it(`ends the title at a Wikidata label marker split by ${what}`, () => {
      const a = accepted(
        withExtField(
          'ObjectName',
          `<div>Sun</div><div style="display: none;">label${between}QS:Len,"S"</div>` +
            '<br><b>Alternative title(s): </b><br> <div>ALT LEAK</div>',
        ),
      );
      expect(a.title).toBe('Sun');
    });
  }

  // "&amp;#32;" decodes once, to the literal text "&#32;", which is not
  // whitespace, so there is no marker: the title shows what the page shows.
  it('finds no marker where an escaped reference stands between the keyword and "QS:"', () => {
    const visible = accepted(withExtField('ObjectName', 'Sun label&amp;#32;QS:Len,"S" ALT LEAK'));
    expect(visible.title).toBe('Sun label&#32;QS:Len,"S" ALT LEAK');
    const hidden = accepted(
      withExtField(
        'ObjectName',
        '<div>Sun</div><div style="display: none;">label&amp;#32;QS:Len,"S"</div>' +
          '<br><b>Alternative title(s): </b><br> <div>ALT LEAK</div>',
      ),
    );
    expect(hidden.title).toBe('Sun Alternative title(s): ALT LEAK');
  });

  it('sees a marker after a "<" that no ">" follows, which the text view kept as text', () => {
    const a = accepted(
      withExtField('ObjectName', 'Lilies 3 < 4 label QS:Lfr,"x" Alternative title(s): ALT LEAK'),
    );
    expect(a.title).toBe('Lilies 3 < 4');
  });

  it('sees a marker whose keyword is split by inline markup or an entity, as the text view did', () => {
    expect(accepted(withExtField('ObjectName', 'Sun la<i></i>bel QS:Len,"S" ALT LEAK')).title).toBe('Sun');
    expect(accepted(withExtField('ObjectName', 'Sun &#108;abel QS:Len,"S" ALT LEAK')).title).toBe('Sun');
  });

  it('does not read a separating tag inside the keyword as part of a marker', () => {
    const a = accepted(withExtField('ObjectName', 'Sun la<br>bel QS:x'));
    expect(a.title).toBe('Sun la bel QS:x');
  });

  it('ignores a marker inside an attribute value, which the text view never saw', () => {
    const a = accepted(withExtField('ObjectName', '<div title="label QS:x">Sun</div>'));
    expect(a.title).toBe('Sun');
  });

  it('never cuts inside a tag, so no raw markup reaches the title', () => {
    const a = accepted(withExtField('ObjectName', '<img src=x onerror=alert(1) title="label QS:x">Sun'));
    expect(a.title).toBe('Sun');
    expect(a.title).not.toContain('<');
  });

  it('still cuts at a real marker that follows one inside an attribute value', () => {
    const a = accepted(
      withExtField(
        'ObjectName',
        '<div title="label QS:x">Sun</div><div style="display:none">label QS:Len,"S"</div>' +
          '<br><b>Alternative title(s): </b><br> <div>ALT LEAK</div>',
      ),
    );
    expect(a.title).toBe('Sun');
  });

  for (const [what, unit] of [
    ['unclosed "<" after each keyword', 'label<'],
    ['an entity after each keyword', 'label&nbsp;'],
    ['tags after each keyword', 'label<b></b>'],
    ['tags holding a second "<" after each keyword', 'label<x <y>'],
    ['numeric entities after each keyword', 'label&#x2003;'],
    ['markers inside one attribute', 'label QS:'],
  ]) {
    it(`finds the marker in linear time on a 1 MB run of ${what}`, () => {
      const run = (size: number): string => unit.repeat(Math.ceil(size / unit.length));
      const shapes = [(size: number) => `<span title="${run(size)}">Sun</span>`, run];
      for (const shape of shapes) {
        const ratio = growthRatio((size) => wikimediaFetcher.normalize(withExtField('ObjectName', shape(size))), 1_000_000);
        expect(ratio).toBeLessThan(LINEAR_CEILING);
      }
    }, 60_000);
  }

  it('reads an italic translation after an earlier plain line break', () => {
    const a = accepted(withExtField('ObjectName', 'De triomf<br>van de Doods<br><i>The Triumph</i>'));
    expect(a.title).toBe('De triomf van de Doods (The Triumph)');
  });

  it('reads an italic translation after a block that holds its own line break', () => {
    const a = accepted(withExtField('ObjectName', '<div>A<br>B</div><br><i>T</i>'));
    expect(a.title).toBe('A B (T)');
  });

  it('stays linear on many line breaks that are not translations', () => {
    const value = (count: number): string => `Sun${('<br>' + '<span>'.repeat(50)).repeat(count)}`;
    const ratio = growthRatio((count) => wikimediaFetcher.normalize(withExtField('ObjectName', value(count))), 1_000);
    expect(ratio).toBeLessThan(LINEAR_CEILING);
    expect(accepted(withExtField('ObjectName', value(1_000))).title).toBe('Sun');
  }, 60_000);

  it('does not read "style=" inside another attribute value as a style attribute', () => {
    const a = accepted(withExtField('Artist', '<span title="a style=display:none">Rembrandt</span>'));
    expect(a.artist.name).toBe('Rembrandt');
  });

  it('does not read "style=" inside a single-quoted attribute value either', () => {
    const a = accepted(withExtField('Artist', `<span title='x style="display:none"'>Rembrandt</span>`));
    expect(a.artist.name).toBe('Rembrandt');
  });

  it('still hides an element whose real style attribute follows a quoted decoy', () => {
    const a = accepted(withExtField('Artist', '<span title="style" style="display:none">x</span>Jan Steen'));
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('reads past a self-closing slash among the attributes', () => {
    expect(accepted(withExtField('Artist', 'Jan<br/>Steen')).artist.name).toBe('Jan Steen');
    const a = accepted(withExtField('Artist', '<span title="a" / style="display:none">x</span>Jan Steen'));
    expect(a.artist.name).toBe('Jan Steen');
  });

  it('keeps an element whose style value only becomes display:none if a reference is decoded twice', () => {
    const a = accepted(withExtField('Artist', 'Rembrandt <span style="display&amp;#58;none">van Rijn</span>'));
    expect(a.artist.name).toBe('Rembrandt van Rijn');
  });

  it('hides an element whose style value spells a character as a reference, as a browser decodes it', () => {
    for (const style of ['display&#58;none', 'display&#x3A;none', 'display:&#110;one', 'display:&#78;ONE', 'display:&#32;none']) {
      const a = accepted(withExtField('Artist', `Rembrandt<span style="${style}">ZZHIDDEN</span>`));
      expect(a.artist.name).toBe('Rembrandt');
    }
  });

  it('keeps an element whose style value only becomes display:none if a no-break space is read as CSS whitespace', () => {
    const a = accepted(withExtField('Artist', '<span style="display:&nbsp;none">Rembrandt</span>'));
    expect(a.artist.name).toBe('Rembrandt');
  });

  it('still hides an element whose unquoted style attribute follows an unquoted attribute', () => {
    const a = accepted(withExtField('Artist', '<span data-x=y style=display:none>x</span>Jan Steen'));
    expect(a.artist.name).toBe('Jan Steen');
  });
});

// Commons escapes markup that wikitext does not allow, so an uploader's literal
// `<a href="...">` reaches the API as `&lt;a href="..."&gt;`. stripHtml removes
// real tags before it decodes entities, so without a second pass the decoded
// tag reaches the wire as text. The fixture is a real record verbatim
// (File:Out Of The East.djvu): its escaped anchor wraps a real one, so a
// decode-then-strip order would still leave `" rel="nofollow">` behind.
describe('Wikimedia mapper: entity-escaped markup is removed after decoding', () => {
  function withExtField(field: string, value: string): unknown {
    const raw = fixture('wikimedia-accepted-cc0.json') as {
      query: { pages: Array<{ imageinfo: Array<{ extmetadata: Record<string, unknown> }> }> };
    };
    raw.query.pages[0].imageinfo[0].extmetadata[field] = { value, source: 'commons-desc-page' };
    return raw;
  }

  function accepted(raw: unknown) {
    const result = wikimediaFetcher.normalize(raw);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('expected accepted');
    return result.artwork;
  }

  it('removes the escaped anchor from a real description and keeps its text', () => {
    const a = accepted(fixture('wikimedia-accepted-escaped-markup.json'));
    expect(a.id).toBe('wikimedia:59145303');
    expect(a.description).toContain('Book Source: Digital Library of India Item 2015.45846');
    expect(a.description).not.toMatch(/<\/?a\b/);
    expect(a.description).not.toContain('nofollow');
    expect(a.title).toBe('OUT OF THE EAST');
    expect(a.artist.name).toBe('Lafcadio Hearn');
  });

  for (const field of ['ObjectName', 'Artist', 'ImageDescription']) {
    it(`removes an escaped tag pair from ${field}`, () => {
      const a = accepted(
        withExtField(field, '&lt;a href="https://example.org/x"&gt;Kept text&lt;/a&gt; &lt;br/&gt;tail'),
      );
      const value = field === 'ObjectName' ? a.title : field === 'Artist' ? a.artist.name : a.description;
      expect(value).toBe('Kept text tail');
    });
  }

  it('leaves a space where an escaped line break or block tag stood, as a real one does', () => {
    const a = accepted(withExtField('ImageDescription', 'First line&lt;br&gt;second&lt;/p&gt;&lt;p&gt;third'));
    expect(a.description).toBe('First line second third');
  });

  it('matches escaped tag names in any case', () => {
    const a = accepted(
      withExtField('ImageDescription', 'First&lt;BR&gt;second &lt;A HREF="https://example.org/x"&gt;link&lt;/A&gt;'),
    );
    expect(a.description).toBe('First second link');
  });

  it('removes a closing tag with the longest element name', () => {
    const a = accepted(withExtField('ImageDescription', '&lt;blockquote&gt;Quoted&lt;/blockquote&gt;after'));
    expect(a.description).toBe('Quoted after');
  });

  it('keeps decoded angle brackets that do not form an HTML tag', () => {
    for (const text of ['&lt;untitled&gt;', '5 &lt; 6 and 7 &gt; 3', 'a &lt;-&gt; b', '&lt;Hearn&gt;', '&lt;i.e.&gt;', '&lt;a-z&gt;']) {
      const a = accepted(withExtField('ImageDescription', text));
      expect(a.description).toBe(
        text.replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      );
    }
  });

  it('keeps an escaped tag that is never closed', () => {
    const a = accepted(withExtField('ImageDescription', 'Before &lt;a href="https://example.org/x" after'));
    expect(a.description).toBe('Before <a href="https://example.org/x" after');
  });

  // Escapes `<` and `>` so the text reaches the second pass, as Commons sends it.
  const escaped = (text: string): string => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Element names that can be spelled from the property test's alphabet, plus
  // the common ones; kept here rather than read from the fetcher, so a name
  // dropped from the fetcher's list fails this test instead of passing it.
  const ELEMENT_NAMES = new Set([
    'a', 'b', 'i', 'p', 's', 'br', 'tr', 'rp', 'rt', 'abbr', 'script', 'img', 'image', 'param', 'div', 'span', 'iframe', 'style', 'selectedcontent',
  ]);

  // The guarantee: no `<name` or `</name`, for an HTML element name, followed
  // by whitespace, `/` or `>` and with a `>` somewhere after it.
  function formsElementTag(text: string): boolean {
    for (const m of text.matchAll(/<\/?([a-z][a-z0-9]*)[\s/>]/gi)) {
      if (ELEMENT_NAMES.has(m[1].toLowerCase()) && text.indexOf('>', m.index + 1) !== -1) return true;
    }
    return false;
  }

  // Removing a tag joins the text on either side of it. A `<` kept as text
  // can then meet the rest of an element name and form a tag that was not in
  // the source: `<scr<script>ipt>` would become `<script>`.
  for (const [input, expected] of [
    ['<scr<script>ipt>alert(1)</scr</script>ipt>', 'Before alert(1)'],
    ['<<a>a href="https://evil.example">x<</a>/a>', 'Before x'],
    ['<im<b>g src=x onerror=alert(1)>', 'Before'],
    ['<<b>i>bold<<b>/i>', 'Before bold'],
    ['<a<br>>', 'Before'],
  ]) {
    it(`does not join kept text into a new tag: ${input}`, () => {
      const a = accepted(withExtField('ImageDescription', escaped(`Before ${input}`)));
      expect(a.description).toBe(expected);
      expect(formsElementTag(a.description ?? '')).toBe(false);
    });
  }

  // Names a browser still builds an element for, which the element list here
  // lacked: the parser rewrites `<image>` to `<img>`, so an escaped
  // `<image src=x onerror=...>` is as live as an `<img>`.
  for (const tag of [
    '<image src=x onerror=alert(1)>', '<param name=x>', '<rb>', '<rtc>', '<plaintext>', '<xmp>', '<listing>',
    '<noembed>', '<keygen>', '<menuitem>', '<bgsound src=x>', '<isindex>', '<nextid>', '<spacer>', '<multicol>', '<blink>',
  ]) {
    it(`removes an escaped tag the parser still builds: ${tag}`, () => {
      const a = accepted(withExtField('ImageDescription', escaped(`Before ${tag}after`)));
      expect(a.description).toBe('Before after');
    });
  }

  // The longest current element name, longer than any other in the list, so
  // it checks that the name window is wide enough for every name.
  it('removes an escaped selectedcontent tag and its closing tag', () => {
    const a = accepted(withExtField('ImageDescription', escaped('Before <selectedcontent>x</selectedcontent> after')));
    expect(a.description).toBe('Before x after');
  });

  it('breaks a tag still standing after nesting deeper than the repeated pass reaches', () => {
    let nested = '<script>';
    for (let k = 0; k < 12; k++) nested = `<scr${nested}ipt>`;
    const a = accepted(withExtField('ImageDescription', escaped(`Before ${nested}alert(1)`)));
    expect(formsElementTag(a.description ?? '')).toBe(false);
    expect(a.description).not.toMatch(/<script/i);
    expect(a.description).toContain('alert(1)');
  });

  // mulberry32: a fixed seed keeps a failure reproducible.
  function seeded(start: number): () => number {
    let seed = start;
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FIELDS = ['ObjectName', 'Artist', 'ImageDescription'];
  function fieldText(field: string, text: string): string {
    const a = accepted(withExtField(field, escaped(`Text ${text}`)));
    return field === 'ObjectName' ? a.title : field === 'Artist' ? a.artist.name : (a.description ?? '');
  }

  it('never leaves an element tag in title, artist or description, over random markup', () => {
    const random = seeded(0x5eed206);
    const alphabet = '<>/abiprsct ';
    for (let n = 0; n < 3000; n++) {
      let text = '';
      const length = 1 + Math.floor(random() * 24);
      for (let c = 0; c < length; c++) text += alphabet[Math.floor(random() * alphabet.length)];
      for (const field of FIELDS) {
        const value = fieldText(field, text);
        expect(formsElementTag(value), `${field}: ${JSON.stringify(text)} -> ${JSON.stringify(value)}`).toBe(false);
      }
    }
  }, 60_000);

  // Uniform random strings rarely nest deeper than the repeats reach, so this
  // builds the nesting directly: a tag split at a random point around another
  // split tag, up to ten deep, with stray text between the layers.
  it('never leaves an element tag over tags nested inside tags', () => {
    const random = seeded(0x0c2206);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const names = [...ELEMENT_NAMES];
    const tag = (): string => `<${random() < 0.3 ? '/' : ''}${pick(names)}${pick(['', ' x=1', '/', ' '])}>`;
    const nest = (depth: number): string => {
      if (depth === 0) return random() < 0.5 ? tag() : pick(['', 'x', '<', '>', ' ']);
      const outer = tag();
      const cut = 1 + Math.floor(random() * (outer.length - 1));
      return outer.slice(0, cut) + nest(depth - 1) + pick(['', '', 'x', '<', ' ']) + outer.slice(cut);
    };
    for (let n = 0; n < 8000; n++) {
      const text = nest(Math.floor(random() * 11)) + (random() < 0.3 ? nest(Math.floor(random() * 6)) : '');
      const field = pick(FIELDS);
      const value = fieldText(field, text);
      expect(formsElementTag(value), `${field}: ${JSON.stringify(text)} -> ${JSON.stringify(value)}`).toBe(false);
    }
  }, 120_000);

  // Each shape drives one branch of the pass once per repeat: an unclosed tag
  // (the early exit), a removed tag, a kept `<`, a removed separating tag, and
  // nesting deep enough to reach the final sweep. The repeat count keeps a
  // quadratic pass to seconds, so a regression fails here instead of hanging.
  const repeats = 4_000;
  for (const [what, unit] of [
    ['unclosed tags', '&lt;a '],
    ['removed tags', '&lt;a&gt;'],
    ['kept "<"', '&lt;x'],
    ['removed line breaks', '&lt;br&gt;x'],
    ['nested tags', escaped(`${'<scr'.repeat(6)}<script>${'ipt>'.repeat(6)}`)],
  ]) {
    it(`removes escaped tags in linear time on a run of ${what}`, () => {
      const ratio = growthRatio(
        (count) => wikimediaFetcher.normalize(withExtField('ImageDescription', `x ${unit.repeat(count)}`)),
        repeats,
      );
      expect(ratio).toBeLessThan(LINEAR_CEILING);
    }, 60_000);
  }
});
