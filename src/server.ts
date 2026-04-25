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
import { Cache } from './db.js';
import { metFetcher } from './fetchers/met.js';
import type { Fetcher } from './fetchers/types.js';

const FETCHERS: Record<string, Fetcher> = {
  [metFetcher.code]: metFetcher,
};

const cache = new Cache({
  path: join(homedir(), '.open-museum-mcp', 'cache.db'),
});

const SearchInput = z.object({
  query: z.string().min(1),
  museum: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const GetInput = z.object({
  id: z.string().regex(/^[a-z]+:[\w-]+$/),
});

async function fetchAndCache(id: string): Promise<{ ok: true; artwork: ReturnType<Cache['getObject']> } | { ok: false; reason: string }> {
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
        'Search across registered open-access museum collections. Returns license-verified artwork records.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query.' },
          museum: { type: 'string', description: 'Optional museum code (met, cleveland, aic).' },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search_artworks') {
    const input = SearchInput.parse(args);
    const fetchers = input.museum ? [FETCHERS[input.museum]].filter(Boolean) : Object.values(FETCHERS);
    if (fetchers.length === 0) {
      return { content: [{ type: 'text', text: `unknown museum: ${input.museum}` }], isError: true };
    }

    const results = [];
    for (const f of fetchers) {
      const ids = await f.search(input.query, input.limit);
      for (const id of ids) {
        const out = await fetchAndCache(id);
        if (out.ok && out.artwork) results.push(out.artwork);
        if (results.length >= input.limit) break;
      }
      if (results.length >= input.limit) break;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: results.length, results }, null, 2),
        },
      ],
    };
  }

  if (name === 'get_artwork') {
    const input = GetInput.parse(args);
    const out = await fetchAndCache(input.id);
    if (!out.ok) {
      return { content: [{ type: 'text', text: out.reason }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(out.artwork, null, 2) }] };
  }

  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
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
