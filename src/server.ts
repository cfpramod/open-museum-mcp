#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createFederation,
  ID_REGEX,
  MEDIUM_CATEGORIES,
  SearchParamsSchema,
  UnknownMuseumError,
  type CiteStyle,
} from './core/index.js';
import { handleClearanceRecord } from './clearanceTool.js';
import { createColorExtractor } from './color/extract.js';
import { COLOR_FAMILY_NAMES } from './core/index.js';
import { Cache } from './db.js';
import { buildSeedQueryFromConstraints } from './discoverSeed.js';
import { aicFetcher } from './fetchers/aic.js';
import { clevelandFetcher } from './fetchers/cleveland.js';
import { europeanaFetcher } from './fetchers/europeana.js';
import { metFetcher } from './fetchers/met.js';
import { rijksmuseumFetcher } from './fetchers/rijksmuseum.js';
import { smithsonianFetcher, smithsonianApiKey } from './fetchers/smithsonian.js';
import { smkFetcher } from './fetchers/smk.js';
import { waltersFetcher } from './fetchers/walters.js';
import { wellcomeFetcher } from './fetchers/wellcome.js';
import { wikimediaFetcher } from './fetchers/wikimedia.js';
import type { Fetcher } from './fetchers/types.js';
import { VERSION } from './version.js';

// Load env vars before reading any keys. Cwd `.env` (developer flow) wins
// over `~/.open-museum-mcp/.env` (production / MCP-client-launched flow);
// dotenv ignores files that don't exist, so missing-file is not an error.
// `quiet: true` suppresses dotenv's "◇ injected env" stdout chatter, which
// otherwise corrupts the MCP stdio transport (any non-JSON-RPC stdout
// breaks the client's parser).
dotenv.config({ quiet: true });
dotenv.config({ quiet: true, path: join(homedir(), '.open-museum-mcp', '.env') });

const FETCHERS: Record<string, Fetcher> = {
  [metFetcher.code]: metFetcher,
  [clevelandFetcher.code]: clevelandFetcher,
  [aicFetcher.code]: aicFetcher,
  [wikimediaFetcher.code]: wikimediaFetcher,
  // Rijksmuseum DIRECT (keyless Data Services + Micrio IIIF) — supersedes the
  // Europeana-mediated Rijks path with richer metadata + true print pixels.
  [rijksmuseumFetcher.code]: rijksmuseumFetcher,
  // Walters Art Museum — INGEST: a committed CC0 bundle ships in the package, so
  // it needs no API key and is always available (no live API exists since 2023).
  [waltersFetcher.code]: waltersFetcher,
  // SMK (National Gallery of Denmark) — keyless REST API, ~39k public-domain
  // image-bearing works, print-grade IIIF JP2 + full-res native JPEG.
  [smkFetcher.code]: smkFetcher,
  // Wellcome Collection — keyless Catalogue API, CC0/PDM "Pictures" via IIIF
  // (library-heavy corpus curated to visual art).
  [wellcomeFetcher.code]: wellcomeFetcher,
};

// Europeana requires a per-user API key (free tier, 10K req/day). Only
// register the fetcher when the key is present — otherwise leave it out
// of the federation rather than crashing on every search call.
if (process.env.EUROPEANA_API_KEY) {
  FETCHERS[europeanaFetcher.code] = europeanaFetcher;
} else {
  console.error(
    '[open-museum-mcp] EUROPEANA_API_KEY not set; Europeana fetcher disabled. Set it in ~/.open-museum-mcp/.env or your shell to enable.',
  );
}

// Smithsonian Open Access requires a per-user api.data.gov key (free). Only
// register the fetcher when the key is present — otherwise leave it out of the
// federation rather than throwing on every search call. Canonical var is
// SMITHSONIAN_API_KEY (EUROPEANA_API_KEY convention); SI_API_KEY is an alias.
if (smithsonianApiKey()) {
  FETCHERS[smithsonianFetcher.code] = smithsonianFetcher;
} else {
  console.error(
    '[open-museum-mcp] SMITHSONIAN_API_KEY not set; Smithsonian fetcher disabled. Set it (or the SI_API_KEY alias) in ~/.open-museum-mcp/.env or your shell to enable.',
  );
}

const CACHE_PATH = process.env.OMM_CACHE_PATH ?? join(homedir(), '.open-museum-mcp', 'cache.db');
const cache = new Cache({ path: CACHE_PATH });

// Server version, read from package.json (see ./version.ts) so it can't drift
// from the published release. Stamped into the MCP handshake and into each
// Clearance Manifest's `verification.tool` provenance field.

// The federation engine is transport-agnostic. The MCP server is one front
// door over it (stdio JSON-RPC); the web app is another (HTTP + KV cache).
// Rejections are logged to stderr — stdout is the MCP protocol channel — so
// operators can diagnose "why did my search return fewer results than
// expected?". The strict-default-deny gate lives inside each fetcher's
// `normalize`, so no rejected record ever reaches the cache or the wire.
const federation = createFederation({
  fetchers: FETCHERS,
  cache,
  engineVersion: VERSION,
  onReject: (id, reason) => console.error(`[open-museum-mcp] rejected ${id}: ${reason}`),
  // Node-side colour enrichment. createColorExtractor lazily loads the optional
  // `sharp` dependency; if it's absent (e.g. a sharp-less install) extraction
  // fails open and colour fields stay unset. Workers never inject this.
  extractColor: createColorExtractor(),
});

const GetInput = z.object({
  id: z.string().regex(ID_REGEX),
});

const CiteInput = z.object({
  id: z.string().regex(ID_REGEX),
  style: z.enum(['short', 'full', 'caption']).default('full'),
});

const DiscoverInput = z.object({
  region: z.string().min(1).optional(),
  period: z.string().min(1).optional(),
  not_artist: z.array(z.string().min(1)).optional(),
  museum: z.string().min(1).optional(),
});

const server = new Server(
  { name: 'open-museum-mcp', version: VERSION },
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
        'Search across registered open-access museum collections. Returns artwork records that pass source-specific rights verification (ambiguous records excluded by default). Supports an optional date-range filter for researcher queries like "Dutch genre painting 1640–1680".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query.' },
          museum: {
            type: 'string',
            description:
              'Optional museum code. Always available: met, cleveland, aic, rijksmuseum, walters, smk, wellcome, wikimedia (Commons). Key-gated: europeana (EUROPEANA_API_KEY), smithsonian (SMITHSONIAN_API_KEY). Omit to search every registered source.',
          },
          has_image: {
            type: 'boolean',
            default: true,
            description: 'Restrict to records with an image URL. Defaults to true. Note: some museums (e.g. The Met) only expose images-only search server-side.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          year_min: {
            type: 'integer',
            description:
              'Optional inclusive lower bound on artwork creation year. Negative for BCE (e.g. -500 = 500 BCE). Records with no parseable date are excluded when any year bound is set.',
          },
          year_max: {
            type: 'integer',
            description:
              'Optional inclusive upper bound on artwork creation year. Negative for BCE. Records with no parseable date are excluded when any year bound is set.',
          },
          medium: {
            type: 'string',
            enum: [...MEDIUM_CATEGORIES],
            description:
              'Optional medium-category filter. One of the controlled values (painting, drawing, print, photograph, sculpture, textile, ceramic, metalwork, furniture, manuscript, other). Like the year filter, it is applied after rights verification over a bounded candidate window — so a medium that is rare for the query may return fewer than `limit` results. Use the facets tool to see which values are present for a query.',
          },
          color: {
            type: 'string',
            description:
              'Optional hex colour (#rrggbb). Re-ranks results by perceptual (CIEDE2000) nearness to this colour, nearest first. Colour is precomputed Node-side from the thumbnail; records without colour (not yet enriched) are excluded from a colour-ranked search.',
          },
          color_family: {
            type: 'string',
            enum: [...COLOR_FAMILY_NAMES],
            description:
              'Optional coarse colour-family filter (red, orange, yellow, green, blue, purple, pink, brown, neutral, black, white). Post-fetch over the bounded window, so a rare family may return fewer than `limit`. Use the facets tool to see which families are present.',
          },
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
    {
      name: 'discover_random',
      description:
        'Pick one random artwork from the local cache that matches the given constraints. Useful for breaking out of repetitive search territory (e.g. surface a random Edo-period work to satisfy a no-back-to-back-European-pre-1900 pairing rule). On a cold cache with `region` or `period` constraints provided, auto-seeds via a small search_artworks call derived from those constraints before sampling — so first-time use works without manually warming the cache. Without constraints, returns a hint to run search_artworks first.',
      inputSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            description: 'Normalized region tag (e.g. "china", "japan", "netherlands"). Exact match.',
          },
          period: {
            type: 'string',
            description: 'Normalized period tag (e.g. "tang dynasty", "edo", "safavid"). Exact match.',
          },
          not_artist: {
            type: 'array',
            items: { type: 'string' },
            description: 'Artist names to exclude (exact match against the canonical artist name field).',
          },
          museum: {
            type: 'string',
            description: 'Optional museum code to restrict to (e.g. met, rijksmuseum, smk, wellcome, walters).',
          },
        },
      },
    },
    {
      name: 'list_traditions',
      description:
        'List the regions and periods present in non-expired cached records, with per-museum record counts. Helps you see which traditions are well-represented before searching, and where holdings are sparse. Returns { regions, periods } where each entry has { tag, label, coverage: { museumCode: count } }. On an empty cache, returns a hint to run search_artworks first — list_traditions is a meta-tool over what you have already collected, not a search trigger.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'facets',
      description:
        'Return available facet values and counts for a query: medium categories, century date-buckets, top artists, and colour families. Counts are computed over a BOUNDED candidate window of up to ~150 rights-verified records per museum (not the entire corpus), so they reflect the head of the result set, not exhaustive totals. Only values actually present in that window are returned (no empty buckets). Use the returned medium/colorFamily values with search_artworks({ ..., medium, color_family }) to drill down.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text query.' },
          museum: { type: 'string', description: 'Optional museum code to restrict to.' },
          has_image: { type: 'boolean', default: true, description: 'Restrict to records with an image URL.' },
          year_min: { type: 'integer', description: 'Optional inclusive lower bound on creation year (negative = BCE).' },
          year_max: { type: 'integer', description: 'Optional inclusive upper bound on creation year (negative = BCE).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'clearance_record',
      description:
        'Emit a portable, fail-closed Clearance Manifest (rights-clearance + provenance + citation) for an artwork id, wrapped in a byte-exact Tier-0 integrity envelope: the manifest is carried as an exact UTF-8 JSON string in `payload`, with a SHA-256 over those exact bytes in `integrity.hash`. Consumers hash the payload string verbatim, then JSON.parse it to read. A non-cleared work — rejected by the rights gate, an unknown museum, or an invalid id — returns a definitive DENY manifest, not an error: a deny is a valid answer. Conforms to the in-repo Clearance Manifest spec at spec/clearance/v0.1 (openclearance.org/v0.1).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Normalized artwork ID, format museumcode:id (e.g. met:436535).' },
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
  const params = SearchParamsSchema.parse(args);
  try {
    const result = await federation.search(params);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    if (err instanceof UnknownMuseumError) {
      return errorResult(`unknown museum: ${err.museum}`);
    }
    throw err;
  }
}

async function handleFacets(args: unknown) {
  const params = SearchParamsSchema.parse(args);
  try {
    const result = await federation.facets(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof UnknownMuseumError) {
      return errorResult(`unknown museum: ${err.museum}`);
    }
    throw err;
  }
}

async function handleGet(args: unknown) {
  const input = GetInput.parse(args);
  const out = await federation.getArtwork(input.id);
  if (!out.ok) return errorResult(out.reason);
  return { content: [{ type: 'text' as const, text: JSON.stringify(out.artwork, null, 2) }] };
}

async function handleCite(args: unknown) {
  const input = CiteInput.parse(args);
  const out = await federation.cite(input.id, input.style as CiteStyle);
  if (!out.ok) return errorResult(out.reason);
  return { content: [{ type: 'text' as const, text: out.citation }] };
}

async function handleDiscoverRandom(args: unknown) {
  const input = DiscoverInput.parse(args);
  if (input.museum && !FETCHERS[input.museum]) {
    return errorResult(`unknown museum: ${input.museum}`);
  }

  const lookup = {
    region: input.region,
    period: input.period,
    notArtist: input.not_artist,
    museumCode: input.museum,
  };

  let artwork = cache.getRandomObject(lookup);

  // Cold-start path: when the cache has nothing for these constraints AND the
  // constraints carry enough signal to build a meaningful query, auto-seed
  // by running a small search_artworks call first. Logged to stderr so
  // operators can see the extra fetches happening on a fresh install.
  if (!artwork) {
    const seedQuery = buildSeedQueryFromConstraints(input);
    if (seedQuery) {
      console.error(
        `[open-museum-mcp] discover_random: cache empty for these constraints; auto-seeding via search_artworks(query="${seedQuery}", museum=${input.museum ?? 'all'})`,
      );
      await handleSearch({
        query: seedQuery,
        limit: 10,
        has_image: true,
        museum: input.museum,
      });
      artwork = cache.getRandomObject(lookup);
    }
  }

  if (!artwork) {
    return errorResult(
      'No cached artwork matches these constraints. discover_random samples from records you have already collected — try search_artworks with a topic first (e.g. search_artworks({ query: "edo painting" })), then call discover_random again.',
    );
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(artwork, null, 2) }] };
}

function handleListTraditions() {
  const traditions = cache.listTraditions();
  const isEmpty = traditions.regions.length === 0 && traditions.periods.length === 0;
  if (isEmpty) {
    return errorResult(
      'Cache is empty. list_traditions summarizes the regions and periods across artworks you have already collected — there is nothing to list yet. Run search_artworks for a topic first (e.g. search_artworks({ query: "renaissance painting" }) or search_artworks({ query: "edo" })), then call list_traditions to see what coverage you have.',
    );
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(traditions, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'search_artworks') return await handleSearch(args);
    if (name === 'facets') return await handleFacets(args);
    if (name === 'get_artwork') return await handleGet(args);
    if (name === 'cite') return await handleCite(args);
    if (name === 'discover_random') return await handleDiscoverRandom(args);
    if (name === 'list_traditions') return handleListTraditions();
    if (name === 'clearance_record') return await handleClearanceRecord(federation, args);
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
  const out = await federation.getArtwork(id);
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
