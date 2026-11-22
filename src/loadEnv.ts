import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

/** Read one `.env` file into `process.env` without overwriting a variable that is already set. */
function loadFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // missing or unreadable: not an error
  }
  dotenv.populate(process.env as Record<string, string>, dotenv.parse(text));
}

/**
 * Load environment variables before any key is read. A `.env` in the working
 * directory (developer flow) wins over `~/.open-museum-mcp/.env` (production /
 * MCP-client-launched flow); a variable already set in the shell wins over both,
 * because dotenv never overwrites. A missing file is not an error.
 *
 * The working directory is resolved here, inside a guard, and the files are read
 * and parsed directly: `dotenv.config()` asks for `process.cwd()` itself, even
 * when it is given an explicit path, and that throws (`uv_cwd`, ENOENT) when the
 * directory the process was launched from no longer exists, for example after an
 * external volume is remounted. That throw happened at import time and stopped
 * the server before it could answer anything. With the directory gone there is
 * no cwd `.env` to read, so only the home file loads.
 *
 * Reading through `parse` and `populate` also means dotenv prints nothing: any
 * stdout that is not JSON-RPC corrupts the MCP stdio transport.
 */
export function loadEnv(options: { home?: string } = {}): void {
  const home = options.home ?? homedir();
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
  } catch {
    process.stderr.write('[open-museum-mcp] working directory is unavailable; skipping the .env in it.\n');
  }
  if (cwd !== undefined) loadFile(join(cwd, '.env'));
  loadFile(join(home, '.open-museum-mcp', '.env'));
}
