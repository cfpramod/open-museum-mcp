import { ngaFetcher } from '../src/fetchers/nga.js';
for (const q of ['Vermeer', 'Rembrandt self portrait', 'Monet', 'American landscape']) {
  const ids = await ngaFetcher.search(q, 2);
  console.log(`\n"${q}" -> ${ids.length} hits`);
  for (const id of ids) {
    const raw = await ngaFetcher.getRaw(id);
    const r = ngaFetcher.normalize(raw);
    if (r.status === 'accepted') {
      const a = r.artwork;
      console.log(`  ✓ ${a.id} | "${a.title.slice(0,40)}" | ${a.artist.name.slice(0,24)} | ${a.displayDate} | ${a.license.type} | ${a.imageUrls.width}x${a.imageUrls.height} | ${a.imageUrls.full.slice(0,50)}`);
    } else console.log(`  ✗ ${id}: ${r.rejection.reason}`);
  }
}
