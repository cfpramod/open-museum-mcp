// Live smoke test for Paris Musées. Needs PARISMUSEES_API_KEY. Counts API
// requests, since the public quota is 1,000 a day: each search should cost two,
// and the per-record lookups after it none. Exits non-zero if any search fails.
import { parismuseesFetcher } from '../src/fetchers/parismusees.js';

let apiRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input).includes('apicollections.parismusees.paris.fr')) apiRequests++;
  return realFetch(input, init);
};

for (const q of ['soleil couchant', 'Carnavalet enseigne', 'cheval', 'horse']) {
  const before = apiRequests;
  let ids: string[];
  try {
    ids = await parismuseesFetcher.search(q, 5);
  } catch (err) {
    console.log(`\n"${q}" -> FAILED: ${err instanceof Error ? err.message : String(err)}`);
    // Keep going so every query reports, but fail the run.
    process.exitCode = 1;
    continue;
  }
  console.log(`\n"${q}" -> ${ids.length} hits`);
  for (const id of ids) {
    const r = parismuseesFetcher.normalize(await parismuseesFetcher.getRaw(id));
    if (r.status === 'accepted') {
      const a = r.artwork;
      console.log(`  ✓ ${a.id} | "${a.title.slice(0, 40)}" | ${a.artist.name.slice(0, 24)} | ${a.displayDate} | ${a.museum.name.slice(0, 24)} | ${a.license.type}`);
    } else console.log(`  ✗ ${id}: ${r.rejection.reason}`);
  }
  console.log(`  API requests for this query: ${apiRequests - before}`);
}
