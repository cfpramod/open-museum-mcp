import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('matches the package.json version (no drift)', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
