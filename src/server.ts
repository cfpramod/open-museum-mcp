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
import { metFetcher } from './fetchers/met.js';
import type { Fetcher } from './fetchers/types.js';
import type { Artwork } from './types.js';

const FETCHERS: Record<string, Fetcher> = {
  [metFetcher.code]: metFetcher,
};

const cache = new Cache({
  path: join(homedir(), '.open-museum-mcp', 'cache.db'),
});

const SearchInput = z.object({
  query: z.string().min(1),
  museum: z.string().optional(),
  has_image: z.boolean().default(true),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetInput = z.object({
  id: z.string().regex(/^[a-z]+:[\w-]+$/),
});

const CiteInput = z.object({
  id: z.string().regex(/^[a-z]+:[\w-]+$/),
  style: z.enum(['short', 'full', 'caption']).default('full'),
});

async function fetchAndCache(id: string): Promise<{ ok: true; artwork: Artwork } | { ok: false; reason: string }> {
  const cached = cache.getObject(id);
  if (cached) return { ok: true, artwork: cached };

  const [code] = id.split(':');
  const fetcher = FETCHERS[code];
  if (!fetcher) return { ok: false, reason: `unknown museum code: ${code}` };

  const raw = await fetcher.getRaw(id);
  const result = fetcher.normalize(raw);
  if (result.status === 'rejected') {
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
          museum: { type: 'string', description: 'Optional museum code (met, cleveland, aic).' },
          has_image: {
            type: 'boolean',
            default: true,
            description: 'Restrict to records with an image URL. Defaults to true.',
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

async function handleSearch(args: unknown) {
  const input = SearchInput.parse(args);
  const fetchers = input.museum
    ? [FETCHERS[input.museum]].filter((f): f is Fetcher => Boolean(f))
    : Object.values(FETCHERS);
  if (fetchers.length === 0) {
    return errorResult(`unknown museum: ${input.museum}`);
  }

  const idLists = await Promise.all(
    fetchers.map((f) => f.search(input.query, input.limit).catch(() => [] as string[])),
  );
  const allIds = idLists.flat().slice(0, input.limit);

  const fetched = await Promise.all(
    allIds.map((id) =>
      fetchAndCache(id).catch((err: unknown) => ({
        ok: false as const,
        reason: err instanceof Error ? err.message : 'fetch failed',
      })),
    ),
  );
  const results: Artwork[] = fetched
    .filter((r): r is { ok: true; artwork: Artwork } => r.ok)
    .map((r) => r.artwork)
    .filter((a) => !input.has_image || Boolean(a.imageUrls.full));

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
  if (!m) throw new Error(`invalid museum URI: ${uri}`);
  const id = `${m[1]}:${m[2]}`;
  const out = await fetchAndCache(id);
  if (!out.ok || !out.artwork) {
    throw new Error(`cannot resolve resource ${uri}: ${out.ok ? 'not found' : out.reason}`);
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
