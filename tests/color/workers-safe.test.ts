import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '../../src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

// The engine core (and the colour read-side math) must stay runnable on
// Cloudflare Workers: no native `sharp`, no `node:` builtins. Colour extraction
// is Node-only and lives in src/color/extract.ts, which the core never imports.
const WORKERS_SAFE_GLOBS = [join(srcRoot, 'core'), join(srcRoot, 'color', 'colorMath.ts')];

function collect(target: string): string[] {
  return statSync(target).isDirectory() ? tsFiles(target) : [target];
}

describe('Workers-safe core has no sharp or node: imports', () => {
  const files = WORKERS_SAFE_GLOBS.flatMap(collect);

  it('covers the expected modules', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Strip line and block comments so doc mentions of "node:sqlite" /
  // "color/extract" don't trip the import checks — only real imports matter.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // Collect the specifier of every static/dynamic import / require.
  const importSpecifiers = (src: string): string[] => {
    const specs: string[] = [];
    const re = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    return specs;
  };

  for (const file of WORKERS_SAFE_GLOBS.flatMap(collect)) {
    const rel = file.slice(srcRoot.length + 1);
    it(`${rel} imports neither sharp nor node: nor the Node-only extractor nor jcs`, () => {
      const specs = importSpecifiers(stripComments(readFileSync(file, 'utf8')));
      for (const spec of specs) {
        expect(spec).not.toBe('sharp');
        expect(spec.startsWith('node:')).toBe(false);
        expect(spec).not.toMatch(/color\/extract/);
        // the JCS canonicalizer is gone; the byte-exact envelope uses Web Crypto only
        expect(spec).not.toMatch(/clearance\/jcs/);
      }
    });
  }
});
