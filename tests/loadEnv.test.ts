import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
