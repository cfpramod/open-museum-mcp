import { describe, expect, it } from 'vitest';
import { createFederation } from '../../src/core/index.js';
import type { CacheStore } from '../../src/core/index.js';
import { ClearanceInput, handleClearanceRecord } from '../../src/clearanceTool.js';

function memoryCache(): CacheStore {
  const objects = new Map();
  const queries = new Map();
  return {
    getObject: (id) => objects.get(id) ?? null,
    upsertObject: (a) => {
      objects.set(a.id, a);
    },
    getQuery: (k) => queries.get(k) ?? null,
    putQuery: (k, ids) => {
      queries.set(k, ids);
    },
  };
}

describe('clearance_record tool input contract', () => {
  it('accepts an arbitrary string id — no ID_REGEX gate at the tool boundary', () => {
    // The tool contract is "a non-cleared work returns a DENY manifest, not an
    // error". A regex gate here (as get_artwork/cite use) would convert a
    // malformed id into a ZodError instead of letting the engine emit the deny.
    expect(ClearanceInput.safeParse({ id: 'not a valid id' }).success).toBe(true);
    expect(ClearanceInput.safeParse({ id: 'met:436535' }).success).toBe(true);
  });

  it('still requires an id', () => {
    expect(ClearanceInput.safeParse({}).success).toBe(false);
    expect(ClearanceInput.safeParse({ id: 123 }).success).toBe(false);
  });

  it('a malformed id yields a deny manifest as a normal (non-error) tool result', async () => {
    const fed = createFederation({ fetchers: {}, cache: memoryCache() });
    const res = await handleClearanceRecord(fed, { id: 'not a valid id' });

    expect(res.isError).toBeUndefined();
    const env = JSON.parse(res.content[0].text);
    expect(env.tier).toBe(0);
    expect(env.payload.clearance.commercialReproduction.permitted).toBe(false);
    expect(env.payload.clearance.commercialReproduction.basis.summary).toContain(
      'invalid artwork id',
    );
  });
});
