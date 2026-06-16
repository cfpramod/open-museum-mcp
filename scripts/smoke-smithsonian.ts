// Live smoke for the Smithsonian fetcher — hits the real api.si.edu (EDAN).
// Loads ~/.open-museum-mcp/.env, runs search -> getRaw -> normalize, and reports
// accepted artworks + non-art rejections so the curation gate is visible live.
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { smithsonianFetcher } from '../src/fetchers/smithsonian.js';

// Load env exactly as src/server.ts does: shell/CWD .env first, then the
// canonical ~/.open-museum-mcp/.env (missing files are ignored by dotenv).
function loadEnv() {
  dotenv.config({ quiet: true });
  dotenv.config({ quiet: true, path: join(homedir(), '.open-museum-mcp', '.env') });
}

async function runQuery(query: string) {
  console.log(`\n${'='.repeat(70)}\nQUERY: "${query}"\n${'='.repeat(70)}`);
  const ids = await smithsonianFetcher.search(query, 8, { hasImage: true });
  console.log(`search() returned ${ids.length} ids: ${ids.join(', ') || '(none)'}`);
  let accepted = 0;
  let rejected = 0;
  for (const id of ids) {
    let raw: unknown;
    try {
      raw = await smithsonianFetcher.getRaw(id);
    } catch (e) {
      console.log(`  [${id}] getRaw FAILED: ${(e as Error).message}`);
      continue;
    }
    const res = smithsonianFetcher.normalize(raw);
    if (res.status === 'accepted') {
      accepted++;
      const a = res.artwork;
      console.log(
        `  ✓ ACCEPT [${id}] "${a.title}"\n` +
          `      artist: ${a.artist.name}${a.artist.nationality ? ` [${a.artist.nationality}]` : ''}` +
          `${a.artist.lifespan ? ` (${a.artist.lifespan})` : ''}\n` +
          `      date: ${a.displayDate} -> {${a.yearStart}, ${a.yearEnd}} | medium: ${a.mediumCategory}\n` +
          `      license: ${a.license.type} (${a.license.confidence}) | imageOpenAccess: ${a.imageOpenAccess}\n` +
          `      image: ${a.imageUrls.full || '(none)'}`,
      );
    } else {
      rejected++;
      console.log(`  ✗ REJECT [${id}] — ${res.rejection.reason}`);
    }
  }
  console.log(`\nRESULT: ${accepted} accepted, ${rejected} rejected (of ${ids.length})`);
}

async function main() {
  loadEnv();
  const hasKey = !!(process.env.SMITHSONIAN_API_KEY || process.env.SI_API_KEY);
  console.log(`SMITHSONIAN_API_KEY present: ${!!process.env.SMITHSONIAN_API_KEY}`);
  console.log(`SI_API_KEY present: ${!!process.env.SI_API_KEY}`);
  console.log(`fetcher will resolve a key: ${hasKey}`);
  if (!hasKey) {
    console.log('No key resolvable — Smithsonian would be DISABLED. Aborting live calls.');
    return;
  }
  for (const q of ['japanese woodblock print', 'vincent van gogh', 'sunflowers']) {
    await runQuery(q);
  }
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
