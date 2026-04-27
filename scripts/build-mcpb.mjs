#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const stagingDir = join(rootDir, 'mcpb-build');
const outputPath = join(rootDir, 'open-museum-mcp.mcpb');

const run = (cmd, cwd = rootDir) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(rootDir, 'manifest.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(
    `manifest.json version (${manifest.version}) does not match package.json version (${pkg.version}). Bump manifest.json before packing.`,
  );
  process.exit(1);
}

if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
if (existsSync(outputPath)) rmSync(outputPath);

mkdirSync(stagingDir, { recursive: true });

run('npm run build');

cpSync(join(rootDir, 'dist'), join(stagingDir, 'dist'), { recursive: true });
cpSync(join(rootDir, 'manifest.json'), join(stagingDir, 'manifest.json'));
cpSync(join(rootDir, 'README.md'), join(stagingDir, 'README.md'));
cpSync(join(rootDir, 'LICENSE'), join(stagingDir, 'LICENSE'));

const stagingPkg = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  main: pkg.main,
  bin: pkg.bin,
  dependencies: pkg.dependencies,
  engines: pkg.engines,
};
writeFileSync(join(stagingDir, 'package.json'), JSON.stringify(stagingPkg, null, 2));

run('npm install --omit=dev --no-package-lock --no-audit --no-fund', stagingDir);

run(`npx -y @anthropic-ai/mcpb@2 pack ${stagingDir} ${outputPath}`);

rmSync(stagingDir, { recursive: true, force: true });

const stats = execSync(`ls -lh ${outputPath}`).toString().trim();
console.log(`\nBuilt: ${stats}`);
