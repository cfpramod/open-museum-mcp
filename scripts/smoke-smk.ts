import { smkFetcher } from '../src/fetchers/smk.js';
for (const q of ['Hammershøi', 'Købke landscape', 'Rembrandt', 'Japanese woodblock']) {
  const ids = await smkFetcher.search(q, 2);
  console.log(`\n"${q}" -> ${ids.length} hits`);
  for (const id of ids) {
    const raw = await smkFetcher.getRaw(id);
    const r = smkFetcher.normalize(raw);
    if (r.status === 'accepted') {
      const a = r.artwork;
      console.log(`  ✓ ${a.id} | "${a.title}" | ${a.artist.name} | ${a.displayDate} (${a.yearStart}-${a.yearEnd}) | ${a.medium} | ${a.license.type} | ${a.imageUrls.width}x${a.imageUrls.height} | img=${a.imageUrls.full.slice(0,55)}`);
    } else console.log(`  ✗ ${id}: ${r.rejection.reason}`);
  }
}
