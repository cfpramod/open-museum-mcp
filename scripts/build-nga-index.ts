/**
 * Build-time ingest for the National Gallery of Art (Washington) — an INGEST
 * source like Walters, but gzipped (the filtered bundle is ~15MB raw / ~3.7MB
 * gzipped, 3x Walters, so it ships compressed).
 *
 * NGA has no live query API; it publishes its collection as CC0 CSV files at
 * github.com/NationalGalleryOfArt/opendata. This script joins objects.csv ⨝
 * published_images.csv on `depictstmsobjectid = objectid` (NOT uuid — the image
 * uuid differs from the object uuid), keeps only PRIMARY images flagged
 * `openaccess=1` (NGA's CC0 open-access program), trims, and writes the gzipped
 * bundle `src/data/nga.json.gz` shipped in the package.
 *
 * Needs a large heap (the 80MB objects.csv parses to ~3GB of JS objects):
 *   NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/build-nga-index.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { httpGet } from '../src/fetchers/helpers.js';

const REPO = 'https://raw.githubusercontent.com/NationalGalleryOfArt/opendata/main/data';

/** Minimal RFC-4180 CSV parser (quoted fields with embedded commas/newlines/""). */
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
  if (!res.ok) throw new Error(`NGA: ${name} fetch failed (${res.status})`);
  return parseCsv(await res.text());
}

function toIntOrNull(v: string): number | null {
  const t = (v ?? '').trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

async function main() {
  console.error('Fetching NGA CSVs…');
  const [objects, images] = await Promise.all([fetchCsv('objects.csv'), fetchCsv('published_images.csv')]);
  console.error(`  objects=${objects.length} images=${images.length}`);

  // Primary open-access image per object (joined on depictstmsobjectid = objectid).
  const primary = new Map<string, { uuid: string; w: number; h: number }>();
  for (const im of images) {
    if (im.openaccess !== '1' || im.viewtype !== 'primary') continue;
    const oid = im.depictstmsobjectid;
    if (!oid || primary.has(oid)) continue;
    // iiifurl = https://api.nga.gov/iiif/<image-uuid> — store just the uuid.
    const uuid = (im.iiifurl || '').split('/iiif/').pop() ?? '';
    if (!uuid) continue;
    primary.set(oid, { uuid, w: toIntOrNull(im.width) ?? 0, h: toIntOrNull(im.height) ?? 0 });
  }
  console.error(`  primary open-access images: ${primary.size}`);

  const out = [];
  for (const o of objects) {
    const im = primary.get(o.objectid);
    if (!im) continue;
    out.push({
      i: o.objectid,
      t: o.title,
      d: o.displaydate,
      a: toIntOrNull(o.beginyear),
      b: toIntOrNull(o.endyear),
      m: o.medium,
      c: o.attribution,
      l: o.classification,
      g: im.uuid, // IIIF image uuid
      w: im.w,
      h: im.h,
      o: 1, // open-access (CC0) marker — the per-record affirmative rights signal
    });
  }
  console.error(`  kept (CC0 open-access, image-bearing): ${out.length}`);

  const bundle = {
    meta: {
      source: 'github.com/NationalGalleryOfArt/opendata',
      license: 'CC0',
      rightsNote: 'NGA open-access images (published_images.openaccess=1, primary view) are CC0.',
      count: out.length,
    },
    objects: out,
  };

  const path = fileURLToPath(new URL('../src/data/nga.json.gz', import.meta.url));
  const gz = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf-8'), { level: 9 });
  writeFileSync(path, gz);
  console.error(`Wrote ${path} (${out.length} objects, ${(gz.length / 1e6).toFixed(2)} MB gzipped)`);
}

await main();
