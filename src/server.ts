#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cite, type CiteStyle } from './cite.js';
import { Cache } from './db.js';
import { aicFetcher } from './fetchers/aic.js';
import { clevelandFetcher } from './fetchers/cleveland.js';
import { metFetcher } from './fetchers/met.js';
import type { Fetcher } from './fetchers/types.js';
import type { Artwork } from './types.js';

const FETCHERS: Record<string, Fetcher> = {
  [metFetcher.code]: metFetcher,
  [clevelandFetcher.code]: clevelandFetcher,
  [aicFetcher.code]: aicFetcher,
};

const CACHE_PATH = process.env.OMM_CACHE_PATH ?? join(homedir(), '.open-museum-mcp', 'cache.db');
const cache = new Cache({ path: CACHE_PATH });

// Museum IDs are positive integers (no leading zeros). Tightening the regex
// here makes `met:000123` and `met:0` user errors rather than valid IDs that
// produce duplicate cache rows.
const ID_REGEX = /^[a-z]+:[1-9]\d*$/;

// Cap concurrent fetches to one museum's API. The Met has no batch endpoint,
// so a search of limit 50 fans out into up to 50 object fetches; without a
// cap, we'd hammer the upstream and risk rate-limit errors. 8 is empirically
// gentle and keeps wall-clock time within the same order of magnitude.
const FETCH_CONCURRENCY = 8;

async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

const SearchInput = z.object({
  query: z.string().min(1),
  museum: z.string().optional(),
  has_image: z.boolean().default(true),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetInput = z.object({
  id: z.string().regex(ID_REGEX),
});

const CiteInput = z.object({
  id: z.string().regex(ID_REGEX),
  style: z.enum(['short', 'full', 'caption']).default('full'),
});

async function fetchAndCache(id: string): Promise<{ ok: true; artwork: Artwork } | { ok: false; reason: string }> {
  if (!ID_REGEX.test(id)) {
    return { ok: false, reason: `invalid artwork id: ${id}` };
  }

  const cached = cache.getObject(id);
  if (cached) return { ok: true, artwork: cached };

  // ID_REGEX guarantees a non-empty `[a-z]+` segment before ':'.
  const code = id.slice(0, id.indexOf(':'));
  const fetcher = FETCHERS[code];
  if (!fetcher) return { ok: false, reason: `unknown museum code: ${code}` };

  const raw = await fetcher.getRaw(id);
  const result = fetcher.normalize(raw);
  if (result.status === 'rejected') {
    // Rejections are expected — strict-default-deny is the project's spine.
    // Log to stderr (stdout is the MCP protocol channel) so operators can
    // diagnose "why did my search return fewer results than expected?".
    console.error(`[open-museum-mcp] rejected ${id}: ${result.rejection.reason}`);
    return { ok: false, reason: result.rejection.reason };
  }

  cache.upsertObject(result.artwork);
  return { ok: true, artwork: result.artwork };
}

const server = new Server(
  { name: 'open-museum-mcp', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_artworks',
      description:
        'Search across registered open-access museum collections. Returns artwork records that pass source-specific rights verification (ambiguous records excluded by default).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query.' },
          museum: {
            type: 'string',
            description:
              'Optional museum code. Currently registered: met, cleveland, aic.',
          },
          has_image: {
            type: 'boolean',
            default: true,
            description: 'Restrict to records with an image URL. Defaults to true. Note: some museums (e.g. The Met) only expose images-only search server-side.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_artwork',
      description: 'Fetch a single artwork by its normalized ID (e.g. met:436533).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Normalized artwork ID, format museumcode:numericid' },
        },
        required: ['id'],
      },
    },
    {
      name: 'cite',
      description:
        'Render a citation for an artwork. Styles: "full" (artist, title, date, museum, license, URL), "caption" (image caption form), "short" (inline reference).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Normalized artwork ID.' },
          style: {
            type: 'string',
            enum: ['short', 'full', 'caption'],
            default: 'full',
          },
        },
        required: ['id'],
      },
    },
  ],
}));

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// The cache key includes the overfetch count, not the user-facing `limit`.
// That means limit:5 and limit:6 produce different keys (since 5*2=10 vs
// 6*2=12). The trade-off: more cache rows, but each row is guaranteed to
// hold enough IDs to satisfy a request at its overfetch tier even after
// rights-gate rejections. Bucketing would need explicit refill logic.
function searchCacheKey(query: string, museum: string | undefined, hasImage: boolean, overFetch: number): string {
  return JSON.stringify({ q: query, m: museum ?? '*', hi: hasImage, of: overFetch });
}

async function handleSearch(args: unknown) {
  const input = SearchInput.parse(args);
  const fetchers = input.museum
    ? (FETCHERS[input.museum] ? [FETCHERS[input.museum]] : [])
    : Object.values(FETCHERS);
  if (fetchers.length === 0) {
    return errorResult(`unknown museum: ${input.museum}`);
  }

  const overFetch = input.has_image ? input.limit * 2 : input.limit;
  const cacheKey = searchCacheKey(input.query, input.museum, input.has_image, overFetch);

  let allIds = cache.getQuery(cacheKey);
  if (!allIds) {
    const idLists = await Promise.all(
      fetchers.map((f) =>
        f.search(input.query, overFetch, { hasImage: input.has_image }).catch(() => [] as string[]),
      ),
    );
    allIds = idLists.flat();
    cache.putQuery(cacheKey, allIds);
  }

  const fetched = await withConcurrency(allIds, FETCH_CONCURRENCY, (id) =>
    fetchAndCache(id).catch((err: unknown) => ({
      ok: false as const,
      reason: err instanceof Error ? err.message : 'fetch failed',
    })),
  );
  const accepted: Artwork[] = fetched
    .filter((r): r is { ok: true; artwork: Artwork } => r.ok)
    .map((r) => r.artwork);
  const filtered = accepted.filter((a) => !input.has_image || Boolean(a.imageUrls.full));
  const results = filtered.slice(0, input.limit);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ count: results.length, results }, null, 2),
      },
    ],
  };
}

async function handleGet(args: unknown) {
  const input = GetInput.parse(args);
  const out = await fetchAndCache(input.id);
  if (!out.ok) return errorResult(out.reason);
  return { content: [{ type: 'text' as const, text: JSON.stringify(out.artwork, null, 2) }] };
}

async function handleCite(args: unknown) {
  const input = CiteInput.parse(args);
  const out = await fetchAndCache(input.id);
  if (!out.ok) return errorResult(out.reason);
  return { content: [{ type: 'text' as const, text: cite(out.artwork, input.style as CiteStyle) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'search_artworks') return await handleSearch(args);
    if (name === 'get_artwork') return await handleGet(args);
    if (name === 'cite') return await handleCite(args);
    return errorResult(`unknown tool: ${name}`);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResult(`invalid input: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    if (err instanceof Error) {
      return errorResult(`${name} failed: ${err.message}`);
    }
    return errorResult(`${name} failed with unknown error`);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const m = uri.match(/^museum:\/\/([a-z]+)\/(.+)$/);
  if (!m) {
    throw new Error(`invalid museum URI scheme: ${uri}`);
  }
  const id = `${m[1]}:${m[2]}`;
  if (!ID_REGEX.test(id)) {
    throw new Error(`invalid museum URI: ${uri} (id must match ${ID_REGEX})`);
  }
  const out = await fetchAndCache(id);
  if (!out.ok) {
    throw new Error(`cannot resolve ${uri}: ${out.reason}`);
  }
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(out.artwork, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
