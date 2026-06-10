import { readFileSync } from 'node:fs';

// Single source of truth for the server version: read it straight from
// package.json at load time so the value stamped into the MCP handshake and
// into every Clearance Manifest's `verification.tool` provenance field can
// never drift from the actual published release.
//
// package.json sits one level above this module in every shipping layout:
//   - src/version.ts (tsx dev)        -> ../package.json (repo root)
//   - dist/version.js (npm install)   -> ../package.json (the package root;
//                                        npm always includes package.json)
//   - dist/version.js (.mcpb bundle)  -> ../package.json (staged at the bundle
//                                        root by scripts/build-mcpb.mjs)
// so the relative URL resolves in all of them. This module has no side effects,
// so it is safe to import from tests.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

export const VERSION: string = pkg.version;
