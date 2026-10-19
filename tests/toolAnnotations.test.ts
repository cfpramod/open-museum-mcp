import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

const SERVER_ENTRY = fileURLToPath(new URL('../src/server.ts', import.meta.url));

// Marketplace and directory review require every tool to declare a human title and
// readOnlyHint (or destructiveHint), with names of at most 64 characters. This test
// reads the tool list the way a client does, over stdio, so a newly registered tool
// cannot ship unannotated.
describe('tool annotations (as seen by an MCP client)', () => {
  let client: Client;
  let tools: ListedTool[];
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'omm-annotations-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-sqlite', '--import', 'tsx', SERVER_ENTRY],
      env: {
        PATH: process.env.PATH ?? '',
        OMM_CACHE_PATH: join(cacheDir, 'cache.db'),
        NODE_NO_WARNINGS: '1',
      },
      stderr: 'ignore',
    });
    client = new Client({ name: 'annotations-test', version: '0.0.0' });
    await client.connect(transport);
    tools = (await client.listTools()).tools;
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  it('registers the seven documented tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'cite',
        'clearance_record',
        'discover_random',
        'facets',
        'get_artwork',
        'list_traditions',
        'search_artworks',
      ].sort(),
    );
  });

  it('gives every tool a name of at most 64 characters', () => {
    for (const tool of tools) expect(tool.name.length).toBeLessThanOrEqual(64);
  });

  it('gives every tool a non-empty human title distinct from its name', () => {
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.title).not.toBe(tool.name);
    }
  });

  it('marks every tool read-only', () => {
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
    }
  });

  it('declares openWorldHint explicitly, false only for the cache-only tool', () => {
    for (const tool of tools) {
      const expected = tool.name !== 'list_traditions';
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(expected);
    }
  });
});
