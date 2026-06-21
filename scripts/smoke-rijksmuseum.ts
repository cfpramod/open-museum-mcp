// Live smoke for the Rijksmuseum DIRECT fetcher — hits the real keyless Data
// Services (Linked-Art) + Micrio IIIF through the actual fetcher: search ->
// getRaw (object -> VisualItem -> DigitalObject -> info.json) -> normalize, with
// the commercial-POD rights gate + the >=3000px print floor applied live.
//   npm run smoke:rijksmuseum
import { rijksmuseumFetcher } from '../src/fetchers/rijksmuseum.js';

async function sample(query: string, limit: number) {
  console.log(`\n===== rijksmuseum · search "${query}" =====`);
  const ids = await rijksmuseumFetcher.search(query, limit, { hasImage: true });
  console.log(`search() -> ${ids.length} ids`);
  let accepted = 0;
  let rejected = 0;
  for (const id of ids) {
    try {
      const res = rijksmuseumFetcher.normalize(await rijksmuseumFetcher.getRaw(id));
      if (res.status === 'accepted') {
        accepted++;
        const a = res.artwork;
        console.log(
          `  ✓ ${id} "${a.title}" / ${a.artist.name} / ${a.displayDate} / ${a.license.type} / ${a.imageUrls.width}x${a.imageUrls.height}`,
        );
      } else {
        rejected++;
        console.log(`  ✗ ${id} — ${res.rejection.reason}`);
      }
    } catch (e) {
      console.log(`  ERR ${id} — ${(e as Error).message}`);
    }
  }
  console.log(`  -> ${accepted} accepted, ${rejected} rejected (of ${ids.length})`);
}

async function main() {
  await sample('Vermeer', 4);
  await sample('Rembrandt', 4);
  await sample('The Night Watch', 3);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
