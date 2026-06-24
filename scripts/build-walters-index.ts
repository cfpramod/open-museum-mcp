/**
 * Build-time ingest for the Walters Art Museum (the engine's first INGEST source).
 *
 * The Walters v1 REST API closed in 2023; the collection is now published only as
 * static CSV files at github.com/WaltersArtMuseum/api-thewalters-org, under a
 * blanket CC0 license (museum rights policy + repo README). This script fetches
 * those CSVs, applies the strict rights gate, joins creators + primary image,
 * trims to the search/normalize fields, and writes a committed JSON bundle
 * (`src/data/walters.json`) that ships inside the npm package — so EVERY consumer
 * of open-museum-mcp gets Walters offline, not just the web app.
 *
 * Re-run when Walters refreshes its dump (rare — the API is frozen):
 *   NODE_OPTIONS=--experimental-sqlite npx tsx scripts/build-walters-index.ts
 *
 * Rights model (no per-object rights field exists in the CSVs):
 *   - The museum declares the WHOLE released dataset CC0. We treat that as the
 *     affirmative grant, but DEFENSIVELY EXCLUDE the ambiguous tail to honour
 *     strict-default-deny: objects dated 1928+ (possible live copyright),
 *     loan-flagged credit lines, and explicit copyright mentions. Each kept
 *     record is therefore pre-1928, image-bearing, and unencumbered — the runtime
 *     `validateWaltersLicense` re-checks the age + image as defense in depth.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { httpGet } from '../src/fetchers/helpers.js';

const REPO = 'https://raw.githubusercontent.com/WaltersArtMuseum/api-thewalters-org/main';
const COPYRIGHT_CUTOFF_YEAR = 1928; // works whose latest date is >= this may still be in copyright
const LOAN_TERMS = ['on loan', 'lent by', 'promised gift', 'courtesy of', 'loaned'];

/** Minimal RFC-4180 CSV parser: handles quoted fields with embedded commas,
 *  newlines, and "" escapes (the Description column carries multiline HTML). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx]])));
}

async function fetchCsv(name: string): Promise<Record<string, string>[]> {
  const res = await httpGet(`${REPO}/${name}`);
  if (!res.ok) throw new Error(`Walters: ${name} fetch failed (${res.status})`);
  return parseCsv(await res.text());
}

function toIntOrNull(v: string): number | null {
  const t = (v ?? '').trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

async function main() {
  console.error('Fetching Walters CSVs…');
  const [art, creators, media] = await Promise.all([
    fetchCsv('art.csv'),
    fetchCsv('creators.csv'),
    fetchCsv('media.csv'),
  ]);
  console.error(`  art=${art.length} creators=${creators.length} media=${media.length}`);

  const creatorName = new Map(creators.map((c) => [c.id, c.name]));
  // Primary image filename per ObjectID (IsPrimary=1 wins, else first seen).
  const primaryImage = new Map<string, string>();
  for (const m of media) {
    const file = (m.ImageURL || '').split('/raw/').pop() ?? '';
    if (!file) continue;
    if (m.IsPrimary === '1' || !primaryImage.has(m.ObjectID)) primaryImage.set(m.ObjectID, file);
  }

  let modern = 0, loaned = 0, noImage = 0;
  const objects = [];
  for (const r of art) {
    const endYear = toIntOrNull(r.DateEndYear);
    if (endYear !== null && endYear >= COPYRIGHT_CUTOFF_YEAR) { modern++; continue; }
    const image = primaryImage.get(r.ObjectID);
    if (!image) { noImage++; continue; }
    const haystack = `${r.CreditLine} ${r.Description}`.toLowerCase();
    if (LOAN_TERMS.some((t) => haystack.includes(t))) { loaned++; continue; }

    const names = (r.Creators || '')
      .split('|')
      .map((id) => creatorName.get(id) ?? '')
      .filter(Boolean)
      .join('|');

    objects.push({
      i: r.ObjectID,
      n: r.ObjectNumber,
      t: r.Title,
      d: r.DateText,
      a: toIntOrNull(r.DateBeginYear),
      b: endYear,
      m: r.Medium,
      c: r.Culture,
      l: r.Classification,
      p: r.Period,
      y: r.Dynasty,
      k: r.Keywords,
      r: names,
      g: image,
    });
  }

  console.error(`  excluded: modern(>=${COPYRIGHT_CUTOFF_YEAR})=${modern} loaned=${loaned} noImage=${noImage}`);
  console.error(`  kept (CC0, pre-1928, image-bearing): ${objects.length}`);

  const bundle = {
    meta: {
      source: 'github.com/WaltersArtMuseum/api-thewalters-org',
      license: 'CC0',
      rightsNote:
        'Walters declares the whole released dataset CC0. Strict gate: kept records are pre-1928, ' +
        'image-bearing, and not loan/copyright-flagged; the 1928+ and loaned tail is excluded.',
      copyrightCutoffYear: COPYRIGHT_CUTOFF_YEAR,
      count: objects.length,
    },
    objects,
  };

  const out = fileURLToPath(new URL('../src/data/walters.json', import.meta.url));
  writeFileSync(out, JSON.stringify(bundle));
  console.error(`Wrote ${out} (${objects.length} objects)`);
}

await main();
