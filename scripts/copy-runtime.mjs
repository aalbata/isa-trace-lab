/**
 * Copy the files of the pinned Pyodide runtime from node_modules into
 * public/pyodide, so that the development server and the production build
 * serve them from the application's own origin. Run before `dev` and `build`.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pyodide');
const to = join(root, 'public', 'pyodide');
const files = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

mkdirSync(to, { recursive: true });
const version = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version;
const manifest = { package: 'pyodide', version, license: 'MPL-2.0', source: 'https://github.com/pyodide/pyodide', files: {} };
let total = 0;
for (const name of files) {
  copyFileSync(join(from, name), join(to, name));
  const bytes = readFileSync(join(to, name));
  manifest.files[name] = { bytes: statSync(join(to, name)).size, sha256: createHash('sha256').update(bytes).digest('hex') };
  total += bytes.length;
}
writeFileSync(join(to, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`pyodide ${version}: ${files.length} files, ${(total / 1048576).toFixed(1)} MiB copied to public/pyodide`);
