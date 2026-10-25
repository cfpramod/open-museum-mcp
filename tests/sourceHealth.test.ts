import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with no type declarations
import { checkSource, formatReport, isFailure, runAll, summarize } from '../scripts/source-health.mjs';

interface StubOptions {
  search?: () => Promise<string[]>;
  getRaw?: (id: string) => Promise<unknown>;
  accept?: (raw: unknown) => boolean;
  requiresApiKey?: string;
  ingestOnly?: true;
}

function stub(code: string, o: StubOptions = {}) {
  return {
    code,
    name: code,
    requiresApiKey: o.requiresApiKey,
    ingestOnly: o.ingestOnly,
    search: o.search ?? (async () => ['1', '2']),
    getRaw: o.getRaw ?? (async (id: string) => ({ id })),
    normalize: (raw: unknown) =>
      (o.accept ?? (() => true))(raw)
        ? { status: 'accepted', artwork: {} }
        : { status: 'rejected', rejection: {} },
  };
}

describe('checkSource', () => {
  it('passes a source that searches, fetches and accepts a record', async () => {
    const r = await checkSource(stub('met'), {}, {});
    expect(r.status).toBe('ok');
  });

  it('fails when the search throws, keeping the upstream status in the detail', async () => {
    const f = stub('met', {
      search: async () => {
        throw new Error('Met search failed: HTTP 410');
      },
    });
    const r = await checkSource(f, {}, {});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('410');
  });

  it('fails an empty result, the silent failure federation tolerates', async () => {
    const r = await checkSource(stub('met', { search: async () => [] }), {}, {});
    expect(r.status).toBe('empty');
    expect(isFailure(r)).toBe(true);
  });

  it('fails when IDs come back but no record can be fetched (auth error)', async () => {
    const f = stub('getty', {
      getRaw: async () => {
        throw new Error('HTTP 401 Wrong Authorization Token');
      },
    });
    const r = await checkSource(f, {}, {});
    expect(r.status).toBe('unfetchable');
    expect(r.detail).toContain('401');
  });

  it('fails when records fetch but none passes the rights gate', async () => {
    const r = await checkSource(stub('x', { accept: () => false }), {}, {});
    expect(r.status).toBe('unaccepted');
  });

  it('keeps going past a rejected or unfetchable record to find an accepted one', async () => {
    const f = stub('x', {
      search: async () => ['bad', 'rejected', 'good'],
      getRaw: async (id: string) => {
        if (id === 'bad') throw new Error('boom');
        return { id };
      },
      accept: (raw) => (raw as { id: string }).id === 'good',
    });
    expect((await checkSource(f, {}, {})).status).toBe('ok');
  });

  it('fails a search that hangs past the timeout', async () => {
    const f = stub('slow', { search: () => new Promise(() => {}) });
    const r = await checkSource(f, { timeoutMs: 20 }, {});
    expect(r.status).toBe('error');
    expect(r.detail).toContain('timed out');
  });

  it('skips a key-gated source whose key is absent, and checks it when present', async () => {
    const f = stub('europeana', { requiresApiKey: 'EUROPEANA_API_KEY' });
    const skipped = await checkSource(f, {}, {});
    expect(skipped.status).toBe('skipped');
    expect(isFailure(skipped)).toBe(false);
    const checked = await checkSource(f, {}, { EUROPEANA_API_KEY: 'k' });
    expect(checked.status).toBe('ok');
  });
});

describe('runAll', () => {
  it('flags a registered source that /core does not export', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'ghost' }],
      metFetcher: stub('met'),
    };
    const results = await runAll(core, {}, {});
    expect(results.map((r: { status: string }) => r.status)).toEqual(['ok', 'error']);
  });

  it('reports the failing count in the summary', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'aic' }],
      metFetcher: stub('met', { search: async () => [] }),
      aicFetcher: stub('aic'),
    };
    const report = formatReport(await runAll(core, {}, {}));
    expect(report).toContain('2 sources: 1 verified live, 1 failing.');
    expect(report).toMatch(/FAIL\s+met/);
  });

  it('never counts a skipped source as healthy', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'europeana' }, { code: 'smithsonian' }],
      metFetcher: stub('met'),
      europeanaFetcher: stub('europeana', { requiresApiKey: 'EUROPEANA_API_KEY' }),
      smithsonianFetcher: stub('smithsonian', { requiresApiKey: 'SMITHSONIAN_API_KEY' }),
    };
    const results = await runAll(core, {}, {});
    expect(summarize(results)).toEqual({ total: 3, verified: 1, snapshot: 0, skipped: 2, failing: 0 });
    const report = formatReport(results);
    expect(report).toContain('3 sources: 1 verified live, 2 skipped (no key, not checked), 0 failing.');
    expect(report).not.toMatch(/healthy/);
  });

  it('labels an ingest-only source as a bundled snapshot, not a live check', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'nga' }],
      metFetcher: stub('met'),
      ngaFetcher: stub('nga', { ingestOnly: true }),
    };
    const results = await runAll(core, {}, {});
    expect(results.map((r: { status: string }) => r.status)).toEqual(['ok', 'snapshot']);
    expect(results.some(isFailure)).toBe(false);
    const report = formatReport(results);
    expect(report).toContain('bundled snapshot, not a live check');
    expect(report).toContain('2 sources: 1 verified live, 1 bundled snapshot (not a live check), 0 failing.');
  });

  it('still fails an ingest-only source whose snapshot returns nothing', async () => {
    const f = stub('walters', { ingestOnly: true, search: async () => [] });
    const r = await checkSource(f, {}, {});
    expect(r.status).toBe('empty');
    expect(isFailure(r)).toBe(true);
  });

  it('limits a run to key-gated or keyless sources by scope', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'europeana', requiresApiKey: 'EUROPEANA_API_KEY' }],
      metFetcher: stub('met'),
      europeanaFetcher: stub('europeana', { requiresApiKey: 'EUROPEANA_API_KEY' }),
    };
    const codes = async (scope: string) =>
      (await runAll(core, { scope }, {})).map((r: { code: string }) => r.code);
    expect(await codes('keyless')).toEqual(['met']);
    expect(await codes('keyed')).toEqual(['europeana']);
    expect(await codes('all')).toEqual(['met', 'europeana']);
  });

  it('fails a source that is skipped but is not in the declared key-gated list', async () => {
    const core = {
      FETCHER_REGISTRY: [{ code: 'met' }, { code: 'europeana' }],
      metFetcher: stub('met', { requiresApiKey: 'MET_API_KEY' }),
      europeanaFetcher: stub('europeana', { requiresApiKey: 'EUROPEANA_API_KEY' }),
    };
    const results = await runAll(core, {}, {});
    expect(results.map((r: { status: string }) => r.status)).toEqual(['unexpected-skip', 'skipped']);
    expect(results.filter(isFailure).map((r: { code: string }) => r.code)).toEqual(['met']);
    expect(formatReport(results)).toMatch(/FAIL\s+met/);
  });
});
