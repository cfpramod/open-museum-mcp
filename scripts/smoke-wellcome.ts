import { wellcomeFetcher } from '../src/fetchers/wellcome.js';
for (const q of ['anatomy engraving', 'botanical', 'portrait physician', 'plague']) {
  const ids = await wellcomeFetcher.search(q, 2);
  console.log(`\n"${q}" -> ${ids.length} hits`);
  for (const id of ids) {
    const raw = await wellcomeFetcher.getRaw(id);
    const r = wellcomeFetcher.normalize(raw);
    if (r.status === 'accepted') {
      const a = r.artwork;
      console.log(`  ✓ ${a.id} | "${a.title.slice(0,42)}" | ${a.artist.name.slice(0,28)} | ${a.displayDate} (${a.yearStart}) | ${a.license.type} | ${a.imageUrls.width}x${a.imageUrls.height} | ${a.imageUrls.full.slice(0,52)}`);
    } else console.log(`  ✗ ${id}: ${r.rejection.reason}`);
  }
}
