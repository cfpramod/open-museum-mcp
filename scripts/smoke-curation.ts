// Live smoke for the non-art curation gate (Wikimedia + Europeana) — hits the
// real Commons + Europeana APIs through the actual fetchers and prints a
// before/after sample: junk filtered, genuine art kept.
//   npm run smoke:curation
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { europeanaFetcher } from '../src/fetchers/europeana.js';
import { wikimediaFetcher } from '../src/fetchers/wikimedia.js';
import type { Fetcher } from '../src/fetchers/types.js';

dotenv.config({ quiet: true });
dotenv.config({ quiet: true, path: join(homedir(), '.open-museum-mcp', '.env') });

async function sample(fetcher: Fetcher, query: string, limit: number) {
  console.log(`\n===== ${fetcher.code} · search "${query}" =====`);
  const ids = await fetcher.search(query, limit, { hasImage: true });
  let accepted = 0;
  let curationRejected = 0;
  for (const id of ids) {
    const raw = await fetcher.getRaw(id);
    const res = fetcher.normalize(raw);
    if (res.status === 'accepted') {
      accepted++;
      console.log(`  ✓ ACCEPT ${id} "${res.artwork.title}"`);
    } else {
      if (/curation reject/.test(res.rejection.reason)) curationRejected++;
      console.log(`  ✗ reject ${id} — ${res.rejection.reason}`);
    }
  }
  console.log(
    `  -> ${accepted} accepted, ${curationRejected} CURATION-rejected (of ${ids.length}). ` +
      `Before the gate the curation-rejected, rights-valid records were accepted.`,
  );
}

async function checkIds(fetcher: Fetcher, ids: string[]) {
  console.log(`\n===== ${fetcher.code} · flagship junk IDs (direct) =====`);
  for (const id of ids) {
    const res = fetcher.normalize(await fetcher.getRaw(id));
    console.log(
      `  ${id}: ${res.status === 'accepted' ? `ACCEPT "${res.artwork.title}"` : `reject -> ${res.rejection.reason}`}`,
    );
  }
}

async function main() {
  // The reported non-art junk: the SUPSI open-access publishing diagram set.
  await checkIds(wikimediaFetcher, ['wikimedia:157318642', 'wikimedia:175537332', 'wikimedia:157318588']);
  // "open access" is the brand term people type — worst-hit by non-art noise.
  await sample(wikimediaFetcher, 'open access', 12);
  // genuine art must survive untouched (no curation false positives).
  await sample(wikimediaFetcher, 'sunflowers painting', 12);
  if (process.env.EUROPEANA_API_KEY) {
    await sample(europeanaFetcher, 'sunflowers painting', 10);
  } else {
    console.log('\n(EUROPEANA_API_KEY not set — skipping Europeana live sample)');
  }
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
