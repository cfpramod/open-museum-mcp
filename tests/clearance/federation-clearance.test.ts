import { describe, expect, it } from 'vitest';
import { createFederation } from '../../src/core/index.js';
import type { CacheStore } from '../../src/core/index.js';
import type { Fetcher } from '../../src/fetchers/types.js';
import type { Artwork, ValidationResult } from '../../src/types.js';

function memoryCache(): CacheStore {
  const objects = new Map<string, Artwork>();
  const queries = new Map<string, string[]>();
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

function cc0Artwork(id: string): Artwork {
  const code = id.slice(0, id.indexOf(':'));
  return {
    id,
    museum: { code, name: code.toUpperCase(), url: `https://${code}.example` },
    title: `Work ${id}`,
    artist: { name: 'Anon', attributionType: 'named' },
    displayDate: '1700',
    yearStart: 1700,
    yearEnd: 1700,
    medium: 'oil',
    region: null,
    period: null,
    imageUrls: { full: `https://img.example/${id}.jpg` },
    imageOpenAccess: true,
    metadataOpenAccess: true,
    license: {
      type: 'CC0',
      rawValue: 'true',
      verificationSource: `${code}.isPublicDomain`,
      verifiedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'high',
    },
    source: { apiUrl: `https://${code}.example/api/${id}`, pageUrl: `https://${code}.example/${id}` },
  };
}

const accepting: Fetcher = {
  code: 'test',
  name: 'TEST',
  async search() {
    return [];
  },
  async getRaw(id) {
    return { id };
  },
  normalize(raw): ValidationResult {
    return { status: 'accepted', artwork: cc0Artwork((raw as { id: string }).id) };
  },
};

const rejecting: Fetcher = {
  code: 'test',
  name: 'TEST',
  async search() {
    return [];
  },
  async getRaw(id) {
    return { id };
  },
  normalize(raw): ValidationResult {
    const id = (raw as { id: string }).id;
    return {
      status: 'rejected',
      rejection: { id, museumCode: 'test', reason: 'test: not open', rawSnapshot: raw },
    };
  },
};

describe('federation.clearanceManifest', () => {
  it('emits a Tier-0 envelope; an accepted id is permitted', async () => {
    const fed = createFederation({ fetchers: { test: accepting }, cache: memoryCache() });
    const env = await fed.clearanceManifest('test:1');
    expect(env.tier).toBe(0);
    expect(env.payload.type).toBe('ClearanceManifest');
    expect(env.payload.clearance.commercialReproduction.permitted).toBe(true);
    expect(env.integrity.hash).toMatch(/^[0-9a-f]{64}$/);
    // the hash lives in the envelope, never inside the payload
    expect(JSON.stringify(env.payload)).not.toContain(env.integrity.hash);
  });

  it('a rejected id yields a deny manifest, not an error', async () => {
    const fed = createFederation({ fetchers: { test: rejecting }, cache: memoryCache() });
    const env = await fed.clearanceManifest('test:9');
    expect(env.payload.clearance.commercialReproduction.permitted).toBe(false);
    expect(env.payload.clearance.commercialReproduction.basis.rule).toBe('default-deny');
    expect(env.payload.verification.determinedBy.actor).toBe('engine:open-museum-mcp');
  });

  it('an invalid id yields a deny manifest carrying the reason, not a throw', async () => {
    const fed = createFederation({ fetchers: { test: accepting }, cache: memoryCache() });
    const env = await fed.clearanceManifest('not a valid id');
    expect(env.payload.clearance.commercialReproduction.permitted).toBe(false);
    expect(env.payload.clearance.commercialReproduction.basis.summary).toContain('invalid artwork id');
  });

  it('an unknown museum code yields a deny manifest', async () => {
    const fed = createFederation({ fetchers: { test: accepting }, cache: memoryCache() });
    const env = await fed.clearanceManifest('zzz:1');
    expect(env.payload.clearance.commercialReproduction.permitted).toBe(false);
    expect(env.payload.clearance.commercialReproduction.basis.summary).toContain('unknown museum code');
  });

  it('threads the host engine version into the manifest tool provenance', async () => {
    const fed = createFederation({
      fetchers: { test: accepting },
      cache: memoryCache(),
      engineVersion: '9.9.9',
    });
    const env = await fed.clearanceManifest('test:1');
    expect(env.payload.verification.tool).toContain('@9.9.9');
  });
});
