// Post-build asset copy. tsc copies JSON data files that are `import`ed (regions,
// dynasties), but the Walters bundle is read at runtime via fs.readFileSync (a
// 5MB bundler-transformed JSON import is pathologically slow), so tsc never sees
// it. Copy it explicitly into dist/data so it ships in the published package.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const ASSETS = ['walters.json', 'nga.json.gz'];

mkdirSync(fileURLToPath(new URL('dist/data/', root)), { recursive: true });
for (const name of ASSETS) {
  const from = fileURLToPath(new URL(`src/data/${name}`, root));
  const to = fileURLToPath(new URL(`dist/data/${name}`, root));
  copyFileSync(from, to);
  console.error(`copied ${name} -> dist/data/${name}`);
}
