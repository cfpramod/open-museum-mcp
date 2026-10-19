import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Every file that states the release version must agree, and the plugin's npx
// pin must be exact. A release bumps all of them together; a missed one ships a
// plugin or bundle that points at a different build than the package users get.

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8'));
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const bundle = readJson('manifest.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const plugin = readJson('plugin/.claude-plugin/plugin.json');

const pinArg: string = plugin.mcpServers['open-museum-mcp'].args.find((a: string) =>
  a.startsWith('open-museum-mcp@'),
);

const SITES: Array<[string, string]> = [
  ['package.json', pkg.version],
  ['package-lock.json (root)', lock.version],
  ['package-lock.json (packages[""])', lock.packages[''].version],
  ['manifest.json (bundle)', bundle.version],
  ['.claude-plugin/marketplace.json (plugin entry)', marketplace.plugins[0].version],
  ['plugin/.claude-plugin/plugin.json', plugin.version],
  ['plugin npx pin', pinArg?.slice('open-museum-mcp@'.length)],
];

describe('release versions', () => {
  it('finds the plugin npx pin', () => {
    expect(pinArg).toBeTruthy();
  });

  it.each(SITES)('%s matches package.json', (_site, version) => {
    expect(version).toBe(pkg.version);
  });

  it('pins the plugin to an exact version, not a range or a tag', () => {
    expect(pinArg).toMatch(/^open-museum-mcp@\d+\.\d+\.\d+$/);
  });

  it('lists the marketplace plugin once, so the check above covers it', () => {
    expect(marketplace.plugins).toHaveLength(1);
  });
});
