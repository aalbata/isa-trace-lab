/**
 * Write THIRD_PARTY_NOTICES.md (repository) and public/THIRD_PARTY_NOTICES.txt
 * (deployed with the site) from the licence files of the packages that are
 * bundled into the browser build or copied into it. The components contained
 * in the copied Pyodide files are listed in licenses/pyodide-components.json,
 * and their licence texts are files in licenses/.
 *
 *   node scripts/third-party-notices.mjs            write both files
 *   node scripts/third-party-notices.mjs --check    exit with status 1 if either file differs from what would be written
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Dependencies of Pyodide that are used only when Pyodide runs under Node.js; they are not part of the site.
const NOT_BUNDLED = new Set(['ws', '@types/emscripten']);

const out = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' });
const packages = new Map();
for (const line of out.split(/\r?\n/)) {
  if (!line.includes('node_modules')) continue;
  const p = JSON.parse(readFileSync(join(line, 'package.json'), 'utf8'));
  if (NOT_BUNDLED.has(p.name)) continue;
  const licenceFile = readdirSync(line).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url ?? p.homepage ?? '';
  packages.set(p.name, {
    name: p.name, version: p.version, licence: p.license ?? 'UNKNOWN',
    source: repo.replace(/^git\+/, '').replace(/\.git$/, ''),
    text: licenceFile ? readFileSync(join(line, licenceFile), 'utf8').trim() : null,
  });
}

/** A licence text from licenses/, without leading blank lines and trailing white space. */
function licenceText(file) {
  const path = join(root, 'licenses', file);
  const text = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/^\s*\n/, '').trimEnd() : '';
  if (!text) throw new Error(`licenses/${file} is missing or empty`);
  return text;
}

/**
 * The entries for the components of the Pyodide files: version, licence, containing files, upstream source,
 * copyright lines and licence texts. A licence text that several components share is printed once and referred to afterwards.
 */
function componentNotices({ files, components, texts }) {
  const printed = new Map([['Pyodide-LICENSE.txt', 'at the start of this section'], ['CPython-3.14.2-LICENSE.txt', 'under CPython 3.14.2 above']]);
  const lines = [
    '-'.repeat(78), 'Components of the redistributed Pyodide files', '',
    `The files ${files.join(', ')} contain the ${components.length} components below. Each entry gives the version, the licence, the files that contain the component, its upstream source and its copyright lines, followed by the licence text taken from that source; the texts are also kept in the licenses/ folder of the repository. A licence text that applies to several components is reproduced once and referred to afterwards.`,
    '',
  ];
  components.forEach((c, i) => {
    for (const key of ['name', 'version', 'licence', 'source']) if (typeof c[key] !== 'string' || !c[key]) throw new Error(`component ${i + 1} has no ${key}`);
    if (!c.files?.length || !Array.isArray(c.copyright) || !Array.isArray(c.texts)) throw new Error(`${c.name}: files, copyright and texts must be lists`);
    const unknown = c.files.filter((f) => !files.includes(f));
    if (unknown.length) throw new Error(`${c.name}: ${unknown.join(', ')} is not one of the redistributed Pyodide files`);
    lines.push('-'.repeat(78), `[${i + 1}] ${c.name}`, `Version: ${c.version}`, `Licence: ${c.licence}`, `Contained in: ${c.files.join(', ')}`, `Source: ${c.source}`);
    if (c.copyright.length) lines.push('Copyright lines:', ...c.copyright.map((l) => `  ${l}`));
    if (c.note) lines.push(c.note);
    lines.push('');
    for (const file of c.texts) {
      if (!texts[file]) throw new Error(`licenses/pyodide-components.json gives no upstream source for ${file}`);
      if (printed.has(file)) {
        lines.push(`Licence text: licenses/${file}, reproduced ${printed.get(file)}.`, '');
      } else {
        printed.set(file, `under [${i + 1}] above`);
        lines.push(`Licence text: licenses/${file}, from ${texts[file]}`, '', licenceText(file), '');
      }
    }
  });
  return lines;
}

const runtime = JSON.parse(readFileSync(join(root, 'licenses', 'pyodide-components.json'), 'utf8'));
const pyodide = packages.get('pyodide');
if (pyodide) {
  if (runtime.pyodide !== pyodide.version) throw new Error(`licenses/pyodide-components.json describes Pyodide ${runtime.pyodide}, but Pyodide ${pyodide.version} is installed`);
  const copied = /const files = \[([^\]]*)\]/.exec(readFileSync(join(root, 'scripts', 'copy-runtime.mjs'), 'utf8'))?.[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1));
  if (copied?.join() !== runtime.files.join()) throw new Error('licenses/pyodide-components.json does not list the files that scripts/copy-runtime.mjs copies');
  pyodide.text = readFileSync(join(root, 'licenses', 'Pyodide-LICENSE.txt'), 'utf8').trim();
  pyodide.note = 'The Pyodide files are distributed unmodified. Their source code is available at https://github.com/pyodide/pyodide (tag ' + pyodide.version + '). Pyodide\'s own code is distributed under the Mozilla Public License 2.0, whose text follows. The files also contain CPython 3.14.2 and its standard library, which are distributed under the Python Software Foundation License (its text follows the Mozilla Public License), and the other components listed after the CPython licence, each under its own licence.';
  pyodide.extra = readFileSync(join(root, 'licenses', 'CPython-3.14.2-LICENSE.txt'), 'utf8').trim();
  pyodide.components = componentNotices(runtime);
}

const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const header = [
  'Third-party software in the ISA Trace Lab web application',
  '',
  ...(pyodide ? [`The site redistributes these files of Pyodide ${pyodide.version} unmodified, copied from the pyodide package: ${runtime.files.join(', ')}. They contain the ${runtime.components.length} components listed in the pyodide section below, each with its version, licence, copyright lines and licence text.`, ''] : []),
  'The browser build bundles or copies the following packages. Each keeps its own licence.',
  '',
  ...list.map((p) => `- ${p.name} ${p.version}: ${p.licence} (${p.source})`),
  '',
];
const body = [];
for (const p of list) {
  body.push('='.repeat(78), `${p.name} ${p.version} (${p.licence})`, p.source, '');
  if (p.note) body.push(p.note, '');
  body.push(p.text ?? `No licence file is included in the package; the package declares the ${p.licence} licence.`, '');
  if (p.extra) body.push('-'.repeat(78), 'CPython 3.14.2', '', p.extra, '');
  if (p.components) body.push(...p.components);
}
const text = [...header, ...body].join('\n') + '\n';
const outputs = [
  [join(root, 'public', 'THIRD_PARTY_NOTICES.txt'), text],
  [join(root, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices\n\n```text\n' + text + '```\n'],
];
if (process.argv.includes('--check')) {
  const stale = outputs.filter(([path, content]) => !existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== content);
  for (const [path] of stale) console.error(`${path} is not up to date; run node scripts/third-party-notices.mjs`);
  if (stale.length) process.exitCode = 1;
  else console.log(`${list.length} packages and ${runtime.components.length} components of the Pyodide files; notices up to date`);
} else {
  for (const [path, content] of outputs) writeFileSync(path, content);
  console.log(`${list.length} packages and ${runtime.components.length} components of the Pyodide files; notices written`);
  if (!existsSync(join(root, 'public'))) console.log('warning: public/ missing');
}
