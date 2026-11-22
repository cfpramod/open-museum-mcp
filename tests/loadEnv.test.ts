import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/loadEnv.js';

const VARS = ['OMM_TEST_HOME_ONLY', 'OMM_TEST_BOTH', 'OMM_TEST_CWD_ONLY'];

describe('loadEnv: cwd .env, then ~/.open-museum-mcp/.env', () => {
  let root: string;
  let home: string;
  let cwdDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omm-loadenv-'));
    home = join(root, 'home');
    cwdDir = join(root, 'cwd');
    mkdirSync(join(home, '.open-museum-mcp'), { recursive: true });
    mkdirSync(cwdDir);
    for (const v of VARS) delete process.env[v];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const v of VARS) delete process.env[v];
    rmSync(root, { recursive: true, force: true });
  });

  const writeHome = (text: string): void => writeFileSync(join(home, '.open-museum-mcp', '.env'), text);
  const writeCwd = (text: string): void => writeFileSync(join(cwdDir, '.env'), text);

  it('does not throw when the working directory no longer exists, and still loads the home file', () => {
    // A launcher whose cwd was on a volume that has since been unmounted: process.cwd() throws.
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT', syscall: 'uv_cwd' });
    });
    writeHome('OMM_TEST_HOME_ONLY=from-home\n');
    expect(() => loadEnv({ home })).not.toThrow();
    expect(process.env.OMM_TEST_HOME_ONLY).toBe('from-home');
  });

  it('says so on stderr, once, when the working directory is unavailable, and keeps stdout clean', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT', syscall: 'uv_cwd' });
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write');
    loadEnv({ home });
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toBe(
      '[open-museum-mcp] working directory is unavailable; skipping the .env in it.\n',
    );
    expect(out).not.toHaveBeenCalled();
  });

  it('prints no notice when the working directory is available', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    loadEnv({ home });
    expect(err).not.toHaveBeenCalled();
  });

  it('lets the cwd .env win over the home file for a key both define', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    writeCwd('OMM_TEST_BOTH=from-cwd\nOMM_TEST_CWD_ONLY=cwd\n');
    writeHome('OMM_TEST_BOTH=from-home\nOMM_TEST_HOME_ONLY=home\n');
    loadEnv({ home });
    expect(process.env.OMM_TEST_BOTH).toBe('from-cwd');
    expect(process.env.OMM_TEST_CWD_ONLY).toBe('cwd');
    expect(process.env.OMM_TEST_HOME_ONLY).toBe('home');
  });

  it('never overwrites a variable the shell already exported', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    process.env.OMM_TEST_BOTH = 'from-shell';
    writeCwd('OMM_TEST_BOTH=from-cwd\n');
    writeHome('OMM_TEST_BOTH=from-home\n');
    loadEnv({ home });
    expect(process.env.OMM_TEST_BOTH).toBe('from-shell');
  });

  it('treats missing files as normal', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    expect(() => loadEnv({ home })).not.toThrow();
  });

  it('writes nothing to stdout, which carries the MCP transport', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    writeCwd('OMM_TEST_CWD_ONLY=x\n');
    const out = vi.spyOn(process.stdout, 'write');
    loadEnv({ home });
    expect(out).not.toHaveBeenCalled();
  });
});

// True when the source reads from the dotenv package in any form. Matching the call `dotenv.config(` is not
// enough: an aliased default import, a named `config` import, a side-effect `import 'dotenv/config'`, a
// `require` and a dynamic `import()` all reach the same unguarded cwd lookup without ever spelling it.
const DOTENV_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])dotenv(?:\/[^'"`]*)?\1/;
const DOTENV_CALL = /\bdotenv\s*\.\s*config\s*\(/;
const importsDotenv = (source: string): boolean => DOTENV_SPECIFIER.test(source) || DOTENV_CALL.test(source);

describe('the dotenv import detector', () => {
  const offending = [
    ["import dotenv from 'dotenv';", 'a default import'],
    ['import dotenv from "dotenv";', 'a default import in double quotes'],
    ["import env from 'dotenv';\nenv.config();", 'an aliased default import'],
    ["import { config } from 'dotenv';", 'a named config import'],
    ["import { config as load, parse } from 'dotenv';", 'a renamed named import'],
    ["import * as dotenv from 'dotenv';", 'a namespace import'],
    ["import 'dotenv/config';", 'the side-effect import'],
    ["import dotenv from 'dotenv/config.js';", 'a subpath import'],
    ["const d = require('dotenv');", 'a require'],
    ["const { config } = await import('dotenv');", 'a dynamic import'],
    ["const d = require(`dotenv`);", 'a require with a backtick-quoted specifier'],
    ["const { config } = await import(`dotenv/config`);", 'a dynamic import with a backtick-quoted specifier'],
    ["import dotenv from 'dotenv'\ndotenv . config ( { quiet: true } )", 'a spaced call'],
  ] as const;
  for (const [source, what] of offending) {
    it(`flags ${what}`, () => {
      expect(importsDotenv(source)).toBe(true);
    });
  }

  // What a static source scan cannot see, stated rather than hidden: `createRequire(import.meta.url)('dotenv')`
  // and an import whose specifier is computed (`import(name)`) never spell the package where a scan can read it.
  // The scan is a guard against the common forms, not a proof.
  const clean = [
    ["import { loadEnv } from '../src/loadEnv.js';", 'the guarded loader'],
    ["const note = 'see the dotenvx docs';", 'a similar word in a string'],
    ["import { x } from './dotenv-helper.js';", 'a local file with a similar name'],
    ["// dotenv is only imported in src/loadEnv.ts", 'a comment that names the package'],
  ] as const;
  for (const [source, what] of clean) {
    it(`does not flag ${what}`, () => {
      expect(importsDotenv(source)).toBe(false);
    });
  }
});

describe('loadEnv is the only reader of a .env file', () => {
  // dotenv.config() asks for process.cwd() itself, even with an explicit path, so a process whose launch
  // directory has gone away dies on it. Every entry point (the server and the dev smoke scripts) must go
  // through loadEnv, which guards that call.
  const roots = [new URL('../src/', import.meta.url), new URL('../scripts/', import.meta.url)];
  const files = roots.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|mjs|js)$/.test(f))
      .map((f) => ({ name: `${dir.pathname.split('/').slice(-2)[0]}/${f}`, url: new URL(f, dir) })),
  );

  it('finds the source files it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.name === 'src/loadEnv.ts')).toBe(true);
    expect(files.some((f) => f.name === 'scripts/smoke-curation.ts')).toBe(true);
  });

  it('has no dotenv import of any kind outside the guarded loader', () => {
    const offenders = files
      .filter((f) => f.name !== 'src/loadEnv.ts')
      .filter((f) => importsDotenv(readFileSync(f.url, 'utf8')))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});
