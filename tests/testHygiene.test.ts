import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const self = fileURLToPath(import.meta.url);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('._') || entry === 'fixtures') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (entry.endsWith('.ts') && p !== self) out.push(p);
  }
  return out;
}

// Block comments keep their newlines so reported line numbers stay true.
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');

// A plain assignment to a global or to process.env is never undone by
// vi.restoreAllMocks() or by the unstub config options, so it survives into
// every later test in the file. Stubs go through vi.stubGlobal / vi.stubEnv,
// which vitest.config.ts reverts before each test.
const LEAKY_WRITES: Array<[string, RegExp]> = [
  ['assignment to a globalThis/global property', /\b(?:globalThis|global)\.\w+\s*=(?!=)/],
  ['assignment to process.env', /\bprocess\.env(?:\.\w+|\[[^\]]+\])\s*=(?!=)/],
  ['delete of a process.env entry', /\bdelete\s+process\.env\b/],
];

describe('test fetch/env stubbing cannot leak between tests', () => {
  it('vitest.config.ts reverts stubbed globals and env before each test', () => {
    const config = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/unstubGlobals:\s*true/);
    expect(config).toMatch(/unstubEnvs:\s*true/);
  });

  // The pair below runs in order: the second test sees what the first left behind.
  const realFetch = globalThis.fetch;
  const probeEnv = 'OMM_TEST_HYGIENE_PROBE';

  it('a stub set in one test ...', () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv(probeEnv, 'set');
    expect(globalThis.fetch).not.toBe(realFetch);
    expect(process.env[probeEnv]).toBe('set');
  });

  it('... is gone in the next', () => {
    expect(globalThis.fetch).toBe(realFetch);
    expect(process.env[probeEnv]).toBeUndefined();
  });

  const files = testFiles(here);

  it('scans the test tree', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = file.slice(repoRoot.length + 1);
    it(`${rel} stubs globals and env only through vi.stubGlobal / vi.stubEnv`, () => {
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      const hits: string[] = [];
      lines.forEach((line, i) => {
        for (const [what, re] of LEAKY_WRITES) {
          if (re.test(line)) hits.push(`${rel}:${i + 1} ${what}: ${line.trim()}`);
        }
      });
      expect(hits).toEqual([]);
    });
  }
});
