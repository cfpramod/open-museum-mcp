#!/usr/bin/env node
// Live health check for every source the engine ships.
//
// Federated search deliberately tolerates a failing source, so a retired or
// re-keyed upstream endpoint reads as "no results from that museum" and nothing
// raises an error. This script makes one real query per source, through the
// engine's own fetcher and rights gate, and fails loudly when a source answers
// with an error, an empty result, or records the engine cannot fetch or accept.
//
// It imports the engine from the installed `open-museum-mcp` package, so run it
// from a directory that has the package installed to test what users actually
// get (see .github/workflows/source-health.yml). From a checkout it resolves to
// the local build. Fetchers are called directly, so the object cache is never
// consulted and a dead upstream cannot be masked by cached records.
//
// Usage: node source-health.mjs [--query horse] [--json] [--scope keyed|keyless]
// Exit code: 0 when no checked source is failing, 1 otherwise. Three kinds of
// pass are kept apart because they prove different things: `ok` (a live
// upstream answered), `snapshot` (an ingest-only source read its bundled
// snapshot, so there is no upstream to check) and `skipped` (a key-gated
// source with no key, never checked at all). Only `ok` counts as verified.
// A skip is only tolerated for the sources in EXPECTED_KEY_GATED; any other
// source that ends up skipped fails the run.
// `--scope` splits the key-gated sources from the rest so a workflow can hand
// API keys to a step that runs only those.

import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  query: 'horse',
  searchLimit: 10,
  timeoutMs: 60_000,
};

/**
 * The sources that are expected to need an API key, declared here and not
 * derived from the fetchers. A source may only end up skipped if it is in this
 * list: a keyless source that starts reporting `requiresApiKey` (or otherwise
 * stops being checked) is a failure, so no live source can drop out quietly.
 */
export const EXPECTED_KEY_GATED = ['europeana', 'smithsonian', 'harvard'];

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describeError(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check one source. Returns `{ code, status, detail }` where status is one of
 * `ok`, `unexpected-skip` (runAll only: skipped but not an expected key-gated
 * source), `snapshot` (ingest-only source: the bundled snapshot loaded, which is
 * not a live check), `skipped`, `error` (search threw: HTTP 4xx/410, auth, timeout),
 * `empty` (search succeeded but returned no IDs), `unfetchable` (IDs came back
 * but no record could be fetched) or `unaccepted` (records fetched, none passed
 * the rights gate).
 */
export async function checkSource(fetcher, options = {}, env = process.env) {
  const { query, searchLimit, timeoutMs } = { ...DEFAULTS, ...options };
  const code = fetcher.code;

  if (fetcher.requiresApiKey && !env[fetcher.requiresApiKey]) {
    return { code, status: 'skipped', detail: `${fetcher.requiresApiKey} not set` };
  }

  let ids;
  try {
    ids = await withTimeout(fetcher.search(query, searchLimit), timeoutMs, 'search');
  } catch (err) {
    return { code, status: 'error', detail: `search failed: ${describeError(err)}` };
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { code, status: 'empty', detail: `search for "${query}" returned no results` };
  }

  let fetched = 0;
  let accepted = 0;
  let lastError = '';
  for (const id of ids) {
    try {
      const raw = await withTimeout(fetcher.getRaw(id), timeoutMs, 'fetch');
      fetched += 1;
      const result = fetcher.normalize(raw);
      if (result.status === 'accepted') {
        accepted += 1;
        break;
      }
    } catch (err) {
      lastError = describeError(err);
    }
  }
  if (fetched === 0) {
    return {
      code,
      status: 'unfetchable',
      detail: `search returned ${ids.length} IDs but none could be fetched (${lastError})`,
    };
  }
  if (accepted === 0) {
    return {
      code,
      status: 'unaccepted',
      detail: `fetched ${fetched} of ${ids.length} records and none passed the rights gate`,
    };
  }
  if (fetcher.ingestOnly) {
    return {
      code,
      status: 'snapshot',
      detail: `bundled snapshot, not a live check (${ids.length} results, record fetched and accepted)`,
    };
  }
  return { code, status: 'ok', detail: `${ids.length} results, record fetched and accepted` };
}

/** Every registered source resolved to its fetcher instance from `/core`. */
export function resolveFetchers(core) {
  return core.FETCHER_REGISTRY.map((entry) => ({
    entry,
    fetcher: core[`${entry.code}Fetcher`],
  }));
}

/** Which sources a scope covers: key-gated ones, the rest, or both. */
function inScope(entry, fetcher, scope) {
  if (!scope || scope === 'all') return true;
  const gated = Boolean((fetcher ?? entry).requiresApiKey);
  return scope === 'keyed' ? gated : !gated;
}

export async function runAll(core, options = {}, env = process.env) {
  const results = [];
  for (const { entry, fetcher } of resolveFetchers(core)) {
    if (!inScope(entry, fetcher, options.scope)) continue;
    if (!fetcher) {
      results.push({
        code: entry.code,
        status: 'error',
        detail: 'registered source is not exported from /core',
      });
      continue;
    }
    const result = await checkSource(fetcher, options, env);
    if (result.status === 'skipped' && !EXPECTED_KEY_GATED.includes(result.code)) {
      results.push({
        code: result.code,
        status: 'unexpected-skip',
        detail: `skipped (${result.detail}) but not in the declared key-gated list, so it was never checked`,
      });
      continue;
    }
    results.push(result);
  }
  return results;
}

export function isFailure(result) {
  return !['ok', 'snapshot', 'skipped'].includes(result.status);
}

/** Counts by kind of outcome; `verified` is only sources a live upstream answered. */
export function summarize(results) {
  const count = (pred) => results.filter(pred).length;
  return {
    total: results.length,
    verified: count((r) => r.status === 'ok'),
    snapshot: count((r) => r.status === 'snapshot'),
    skipped: count((r) => r.status === 'skipped'),
    failing: count(isFailure),
  };
}

export function formatSummary(results) {
  const c = summarize(results);
  const parts = [`${c.verified} verified live`];
  if (c.snapshot) parts.push(`${c.snapshot} bundled snapshot (not a live check)`);
  if (c.skipped) parts.push(`${c.skipped} skipped (no key, not checked)`);
  parts.push(`${c.failing} failing`);
  return `${c.total} sources: ${parts.join(', ')}.`;
}

export function formatReport(results) {
  const lines = results.map(
    (r) => `${isFailure(r) ? 'FAIL' : r.status === 'skipped' ? 'SKIP' : r.status === 'snapshot' ? 'SNAP' : ' ok '}  ${r.code.padEnd(12)} ${r.status.padEnd(12)} ${r.detail}`,
  );
  lines.push('', formatSummary(results));
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const qi = args.indexOf('--query');
  const si = args.indexOf('--scope');
  const scope = si >= 0 ? args[si + 1] : 'all';
  if (!['all', 'keyed', 'keyless'].includes(scope)) {
    console.error('--scope must be one of: all, keyed, keyless');
    process.exitCode = 2;
    return;
  }
  const options = { scope, ...(qi >= 0 && args[qi + 1] ? { query: args[qi + 1] } : {}) };

  const core = await import('open-museum-mcp/core');
  const results = await runAll(core, options);
  console.log(args.includes('--json') ? JSON.stringify(results, null, 2) : formatReport(results));
  process.exitCode = results.some(isFailure) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
