import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { europeanaFetcher } from '../src/fetchers/europeana.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf-8'));
}

describe('Europeana adapter normalization', () => {
  it('accepts a CC0 record (Rijksmuseum Night Watch fixture)', () => {
    const result = europeanaFetcher.normalize(fixture('europeana-accepted-cc0.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    const a = result.artwork;
    expect(a.id).toBe('europeana:90402/SK_C_5');
    expect(a.museum.code).toBe('europeana');
    expect(a.museum.name).toBe('Rijksmuseum');
    expect(a.title).toBe('The Night Watch');
    expect(a.artist.name).toBe('Rembrandt van Rijn');
    expect(a.artist.attributionType).toBe('named');
    expect(a.license.type).toBe('CC0');
    expect(a.license.rawValue).toBe('http://creativecommons.org/publicdomain/zero/1.0/');
    expect(a.license.verificationSource).toBe('europeana.rights');
    expect(a.imageOpenAccess).toBe(true);
    expect(a.metadataOpenAccess).toBe(true);
    expect(a.imageUrls.full).toContain('Night_Watch.jpg');
    expect(a.imageUrls.thumbnail).toContain('thumbnail');
    expect(a.source.pageUrl).toBe('https://www.europeana.eu/en/item/90402/SK_C_5');
    expect(a.source.originalUrl).toBe('https://www.rijksmuseum.nl/nl/collectie/SK-C-5');
    expect(a.yearStart).toBe(1642);
    expect(a.yearEnd).toBe(1642);
    expect(a.region).toBe('netherlands');
    expect(a.description).toContain('militia company');
  });

  it('accepts a Public Domain Mark record (https URI variant)', () => {
    // Tests two things: (1) PDM as a separate license tier, (2) the
    // URI normaliser strips both http:// and https:// equivalently.
    const result = europeanaFetcher.normalize(fixture('europeana-accepted-pdm.json'));
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.license.type).toBe('PD');
    expect(result.artwork.license.rawValue).toContain('publicdomain/mark');
    expect(result.artwork.id).toBe('europeana:2058616/object_KMSKB_2729');
    expect(result.artwork.title).toBe('Landscape with the Fall of Icarus');
  });

  it('rejects CC-BY-SA (share-alike obligation; mirrors Wikimedia gate)', () => {
    const result = europeanaFetcher.normalize(fixture('europeana-rejected-cc-by-sa.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('by-sa');
    expect(result.rejection.id).toBe('europeana:123/aargauer_hodler_1');
  });

  it('rejects In-Copyright records (Swiss-museum reality check)', () => {
    // Live spike found that flagship Swiss artists at flagship Swiss museums
    // (e.g. Hodler at Aargauer Kunsthaus) carry InC rights, not CC0. Lock
    // down that this case rejects cleanly.
    const result = europeanaFetcher.normalize(fixture('europeana-rejected-in-copyright.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
    expect(result.rejection.reason).toContain('rightsstatements.org/vocab/InC');
  });

  it('rejects records with no rights field at all', () => {
    const result = europeanaFetcher.normalize(fixture('europeana-rejected-missing-rights.json'));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('rights field missing');
  });

  it('rejects garbage input', () => {
    expect(europeanaFetcher.normalize(null).status).toBe('rejected');
    expect(europeanaFetcher.normalize('not an object').status).toBe('rejected');
    expect(europeanaFetcher.normalize(42).status).toBe('rejected');
  });

  it('rejects when items array is empty (no record found)', () => {
    const result = europeanaFetcher.normalize({ items: [], totalResults: 0 });
    // No record → falls through to validateEuropeanaLicense on the wrapper,
    // which has no `rights` array, so the rejection reason is the missing-
    // rights one. That's the right behavior (empty result = nothing to accept).
    expect(result.status).toBe('rejected');
  });

  it('accepts a record passed as a direct item object (not wrapped in items[])', () => {
    // For fixture authoring convenience and to tolerate alternate response
    // shapes, an unwrapped item should normalise the same way.
    const wrapped = fixture('europeana-accepted-cc0.json') as { items: unknown[] };
    const result = europeanaFetcher.normalize(wrapped.items[0]);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.id).toBe('europeana:90402/SK_C_5');
  });

  it('strips leading slash from Europeana IDs in the suffix', () => {
    // Europeana returns IDs as `/9200338/Bibliographic...` with a leading
    // slash. Our `museum:id` convention has no leading slash on the suffix.
    const result = europeanaFetcher.normalize(fixture('europeana-accepted-cc0.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.id).not.toMatch(/europeana:\//);
    expect(result.artwork.id).toBe('europeana:90402/SK_C_5');
  });

  it('falls back across language preferences for title and creator', () => {
    // Title has en + nl. Creator has only en. Both should resolve to en.
    const result = europeanaFetcher.normalize(fixture('europeana-accepted-cc0.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.title).toBe('The Night Watch'); // en preferred over nl
    expect(result.artwork.artist.name).toBe('Rembrandt van Rijn');
  });

  it('parses year from `year` field when displayDate is sparse', () => {
    // Europeana's `year` array carries the parsed year(s). Our date parser
    // handles "1642" trivially; verify the wiring.
    const result = europeanaFetcher.normalize(fixture('europeana-accepted-cc0.json'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.artwork.yearStart).toBe(1642);
    expect(result.artwork.yearEnd).toBe(1642);
  });

  it('rejects multi-URI rights when ANY entry is restrictive (strict-default-deny)', () => {
    // Hardened rights gate: a hybrid record carrying CC0 plus an InC URI
    // would have been silently accepted under a "first match wins" check.
    // Strict-default-deny requires every URI to be in the accept set.
    const mixedRights = {
      items: [
        {
          id: '/1/mixed_rights_record',
          rights: [
            'http://creativecommons.org/publicdomain/zero/1.0/',
            'http://rightsstatements.org/vocab/InC/1.0/',
          ],
          dcTitleLangAware: { en: ['Hybrid record'] },
        },
      ],
    };
    const result = europeanaFetcher.normalize(mixedRights);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.rejection.reason).toContain('strict default reject');
  });

  it('accepts multi-URI rights when ALL entries are in the accept set', () => {
    // Records that are dual-marked CC0 + PDM are genuinely public domain.
    // The first URI determines the license tier (CC0 takes precedence).
    const dualMarked = {
      items: [
        {
          id: '/2/dual_marked_record',
          rights: [
            'http://creativecommons.org/publicdomain/zero/1.0/',
            'http://creativecommons.org/publicdomain/mark/1.0/',
          ],
          dcTitleLangAware: { en: ['Dual-marked record'] },
        },
      ],
    };
    const result = europeanaFetcher.normalize(dualMarked);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.license.type).toBe('CC0');
  });

  it('accepts a bare-string rights shape (some EDM serializers omit the array wrapper)', () => {
    // Defensive: if Europeana ever returns rights as a plain string rather
    // than a one-element array, the gate must still validate it. Otherwise
    // we silently false-negative every record from that endpoint.
    const bareStringRights = {
      items: [
        {
          id: '/3/bare_string_rights',
          rights: 'http://creativecommons.org/publicdomain/zero/1.0/',
          dcTitleLangAware: { en: ['Bare-string-rights record'] },
        },
      ],
    };
    const result = europeanaFetcher.normalize(bareStringRights);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.license.type).toBe('CC0');
  });

  it('coerces numeric year values to strings for the date parser', () => {
    // Europeana sometimes returns `year: [1642]` (number) instead of
    // `year: ["1642"]` (string). The fetcher must treat both shapes the
    // same way; otherwise dates silently disappear from records that
    // serialize numeric years.
    const numericYear = {
      items: [
        {
          id: '/4/numeric_year_record',
          year: [1642],
          rights: ['http://creativecommons.org/publicdomain/zero/1.0/'],
          dcTitleLangAware: { en: ['Numeric-year record'] },
        },
      ],
    };
    const result = europeanaFetcher.normalize(numericYear);
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.artwork.yearStart).toBe(1642);
    expect(result.artwork.yearEnd).toBe(1642);
  });
});
