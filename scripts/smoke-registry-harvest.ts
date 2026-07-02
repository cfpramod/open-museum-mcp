import { runClevelandHarvest } from '../src/core/registry/index.js';
import type { HarvestCheckpointStore } from '../src/core/registry/index.js';
import type { RegistryEntry, RegistryStore } from '../src/core/registry/index.js';

// Throwaway in-memory store, live-verification only, the real store is OMA's build.
const entries = new Map<string, RegistryEntry>();
const store: RegistryStore = {
  getEntry: (id) => entries.get(id) ?? null,
  upsertEntry: (entry) => {
    entries.set(entry.identity.registryId, entry);
  },
  proposeAssertion: () => {
    throw new Error('not exercised by this smoke');
  },
  getStats: () => ({
    entryCount: entries.size,
    withEnrichmentCount: [...entries.values()].filter((e) => e.assertions.length > 1).length,
  }),
};

let checkpoint: string | null = null;
const checkpoints: HarvestCheckpointStore = {
  getCheckpoint: () => checkpoint,
  setCheckpoint: (skip) => {
    checkpoint = skip;
  },
};

const result = await runClevelandHarvest(store, checkpoints, { batchSize: 5, maxBatches: 2 });
console.log('harvest run result:', result);
console.log('checkpoint after run:', checkpoint);

for (const [id, entry] of entries) {
  console.log(
    `  ${id} | ${entry.canonicalStatus} | ${entry.trust.evidenceGrade} | ${entry.assertions.length} assertions | posture=${entry.rightsPosture.posture}`,
  );
  for (const a of entry.assertions) {
    console.log(`      ${a.field} = ${JSON.stringify(a.value)}`);
  }
}

if (entries.size === 0) {
  console.error('SMOKE FAILED: zero entries stored from a live Cleveland harvest run.');
  process.exit(1);
}
console.log(`\nSMOKE OK: ${entries.size} live Cleveland records harvested and stamped.`);
