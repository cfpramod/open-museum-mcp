import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFederation } from '../src/core/index.js';
import { Cache } from '../src/db.js';
import type { Artwork } from '../src/types.js';

// A cache hit is enriched on read (colour is backfilled onto a row cached before it had any), and the enriched
// record is written back. That write must not restart the row's 90-day clock: the clock bounds how old the
// rights check behind a served record can be, and an enrichment is not a rights check.

const DAY = 24 * 60 * 60 * 1000;

function artwork(id: string, verifiedAt: string): Artwork {
  return {
    id,
    museum: { code: 'met', name: 'The Metropolitan Museum of Art', url: 'https://www.metmuseum.org' },
    title: 'Test Work',
    artist: { name: 'Test Artist', attributionType: 'named' },
    displayDate: '1900',
    yearStart: 1900,
    yearEnd: 1900,
    medium: 'Oil on canvas',
    region: 'netherlands',
    period: null,
    imageUrls: { full: 'https://example.org/img.jpg' },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: 'test',
      verifiedAt,
      confidence: 'high',
    },
    citation: { full: 'x', caption: 'x', short: 'x' },
  } as unknown as Artwork;
}

describe('a cache hit that is enriched on read keeps its original expiry clock', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omm-enrich-clock-'));
    path = join(dir, 'cache.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const clockOf = (id: string): string => {
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT cached_at FROM objects WHERE id = ?').get(id) as { cached_at: string };
    db.close();
    return row.cached_at;
  };

  it('does not restart the clock, so the row still expires 90 days after its original check', async () => {
    // A row is enriched on read only while its rights check is inside the rights bound (30 days), so the
    // row here was checked and cached 20 days ago.
    const original = new Date(Date.now() - 20 * DAY).toISOString();
    const cache = new Cache({ path });
    cache.upsertObject(artwork('met:1', original));
    const db = new DatabaseSync(path);
    db.prepare('UPDATE objects SET cached_at = ? WHERE id = ?').run(original, 'met:1');
    db.close();

    let extractions = 0;
    const fed = createFederation({
      fetchers: {},
      cache,
      extractColor: async () => {
        extractions += 1;
        return { dominantColor: '#aa0000', palette: [], colorFamily: 'red' } as never;
      },
    });

    const out = await fed.getArtwork('met:1');
    expect(out.ok).toBe(true);
    expect(extractions).toBe(1); // the read really did enrich and write back
    expect(cache.getObject('met:1')?.dominantColor).toBe('#aa0000');
    expect(clockOf('met:1')).toBe(original); // the write-back did not restart the clock
    cache.close();
  });
});
