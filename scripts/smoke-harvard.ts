import { harvardFetcher } from '../src/fetchers/harvard.js';
for (const q of ['Sargent watercolor', 'Chinese landscape painting', 'Mughal', 'Rembrandt']) {
  const ids = await harvardFetcher.search(q, 3);
  console.log(`\n"${q}" -> ${ids.length} hits`);
  for (const id of ids) {
    const raw = await harvardFetcher.getRaw(id);
    const r = harvardFetcher.normalize(raw);
    if (r.status === 'accepted') {
      const a = r.artwork;
      console.log(`  ✓ ${a.id} | "${a.title.slice(0,34)}" | ${a.artist.name.slice(0,22)} | ${a.displayDate} | ${a.license.type} openAcc=${a.imageOpenAccess} | region=${a.region} | ${a.imageUrls.width}x${a.imageUrls.height}`);
    } else console.log(`  ✗ ${id}: ${r.rejection.reason}`);
  }
}
