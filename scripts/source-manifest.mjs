/**
 * SHA-256 manifest of the files that the validation reads or executes. Its
 * combined hash identifies the software that produced a set of results: the
 * export and every stage of the validation compute it when they start and
 * record it in their output, and the summary accepts only results that record
 * the hash of the tree it runs in (docs/validation.md, section 5).
 *
 *   node scripts/source-manifest.mjs [--root <tree>] [--out validation/results/source-manifest.json]
 *   node scripts/source-manifest.mjs [--root <tree>] --check [validation/results/source-manifest.json]
 *   node scripts/source-manifest.mjs [--root <tree>] --hash
 *
 * The manifest covers the files that a pattern of HASHED matches and no
 * pattern of NOT_HASHED matches; nothing else decides it, and .gitignore is not
 * read. A file without a NUL byte is text and is hashed with its CRLF line
 * endings converted to LF, so that a checkout that converts line endings has
 * the same manifest. --check recomputes the manifest of the tree and compares
 * it with a recorded one: the entries, the file count, and the combined hash,
 * which is also recomputed from the recorded entries. It lists every
 * difference and exits with 1 when there is one. --hash prints the combined
 * hash of the tree and nothing else. --root selects the tree; the default is
 * the tree that contains this script. Relative paths are relative to the tree.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = 'validation/results/source-manifest.json';

/**
 * The files that the validation reads or executes. In a pattern, `*` stands
 * for any characters of one name, and `**` for any number of folders, or at
 * the end of a pattern for everything below a folder.
 */
export const HASHED = [
  // The settings under which Node.js runs the scripts, and the pinned packages.
  'package.json', 'package-lock.json', 'tsconfig.json',
  // The software under test: every script of the validation imports it.
  'src/core/**',
  // The scripts that scripts/validate-all.mjs runs, the one that the harness runs (reencode.ts), and their shared modules.
  'scripts/validate-all.mjs', 'scripts/source-manifest.mjs', 'scripts/crosscheck-corpus.ts', 'scripts/export-validation.ts',
  'scripts/reencode.ts', 'scripts/summarize-validation.ts', 'scripts/coverage-tables.ts', 'scripts/lib/**',
  // The harness of the reference tools, its pinned requirements, and the edge programs of the corpus.
  'validation/**',
  // The example programs of the corpus and their argument tuples.
  'examples/index.json', 'examples/*.py',
];

/** Files below the hashed folders that a run writes: the inputs and results of the stages, the bytecode that Python caches, and logs. */
export const NOT_HASHED = ['validation/work/**', 'validation/results/**', '**/__pycache__/**', '**/*.log'];

export const HASHING =
  'SHA-256 of each file that a pattern of "hashed" matches and no pattern of "not_hashed" matches; ' +
  'a file without a NUL byte is hashed with CRLF line endings converted to LF; ' +
  'the combined hash is the SHA-256 of the lines "<path> NUL <file hash> LF", sorted by the UTF-8 bytes of the path';

/** Regular expression source of one name of a pattern: `*` matches any characters except `/`. */
const nameSource = (name) => name.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*');

/** Regular expression for the paths, relative to the tree and separated by `/`, that a pattern matches. */
function patternRegExp(pattern) {
  const parts = pattern.split('/');
  const body = parts.map((part, i) => {
    const last = i === parts.length - 1;
    if (part === '**') return last ? '.*' : '(?:[^/]+/)*';
    return nameSource(part) + (last ? '' : '/');
  });
  return new RegExp(`^${body.join('')}$`);
}

/** True when a file below the folder with the given names can match the pattern. */
function reaches(pattern, folder) {
  const parts = pattern.split('/');
  for (let i = 0; i < folder.length; i++) {
    if (parts[i] === '**') return true;
    if (i >= parts.length - 1 || !new RegExp(`^${nameSource(parts[i])}$`).test(folder[i])) return false;
  }
  return true;
}

const hashed = HASHED.map(patternRegExp);
const notHashed = NOT_HASHED.map(patternRegExp);

function walk(root, folder, out) {
  for (const name of readdirSync(join(root, ...folder)).sort()) {
    const names = [...folder, name];
    const rel = names.join('/');
    const st = statSync(join(root, ...names));
    if (st.isDirectory()) {
      // A folder is entered only when a hashed pattern can match a file below it and no pattern excludes all of it.
      if (HASHED.some((p) => reaches(p, names)) && !notHashed.some((re) => re.test(`${rel}/`))) walk(root, names, out);
    } else if (st.isFile() && hashed.some((re) => re.test(rel)) && !notHashed.some((re) => re.test(rel))) out.push(rel);
  }
  return out;
}

/** The bytes that are hashed: a text file (no NUL byte) with CRLF converted to LF, any other file as it is. */
function canonicalBytes(bytes) {
  if (bytes.includes(0)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

function combine(entries) {
  const combined = createHash('sha256');
  for (const e of entries) combined.update(`${e.path}\0${e.sha256}\n`);
  return combined.digest('hex');
}

/** The manifest of a tree: the number of hashed files, their combined hash, and one entry per file in path order. */
export function sourceManifest(root = DEFAULT_ROOT) {
  const files = walk(root, [], []).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const entries = files.map((rel) => {
    const bytes = canonicalBytes(readFileSync(join(root, rel)));
    return { path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { files: entries.length, sha256: combine(entries), entries };
}

/**
 * Differences between a recorded manifest and the manifest of the tree, as lines; empty when they agree. The entries
 * are compared file by file; the recorded file count must be the number of recorded entries; and the recorded
 * combined hash must be both the hash of the recorded entries and the combined hash of the tree.
 */
export function compareManifests(recorded, current) {
  const lines = [];
  const before = new Map(recorded.entries.map((e) => [e.path, e.sha256]));
  const after = new Map(current.entries.map((e) => [e.path, e.sha256]));
  for (const [path, hash] of after) {
    if (!before.has(path)) lines.push(`added    ${path}`);
    else if (before.get(path) !== hash) lines.push(`changed  ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) lines.push(`removed  ${path}`);
  if (recorded.files !== recorded.entries.length) lines.push(`the recorded file count ${recorded.files} is not the number of recorded entries, ${recorded.entries.length}`);
  if (combine(recorded.entries) !== recorded.sha256) lines.push('the recorded combined hash is not the hash of the recorded entries');
  if (lines.length === 0 && recorded.sha256 !== current.sha256) {
    lines.push('the recorded entries are not the entries of the tree in path order, so the recorded combined hash is not that of the tree');
  }
  return lines;
}

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
  };
  const root = resolve(value('--root') ?? DEFAULT_ROOT);
  const m = sourceManifest(root);
  if (argv.includes('--hash')) console.log(m.sha256);
  else if (argv.includes('--check')) {
    const recorded = JSON.parse(readFileSync(resolve(root, value('--check') ?? DEFAULT_OUT), 'utf8'));
    const differences = compareManifests(recorded, m);
    for (const line of differences) console.log(line);
    if (differences.length === 0) console.log(`source tree matches the recorded manifest: ${m.files} files, sha256 ${m.sha256}`);
    else {
      console.log(`source tree differs from the recorded manifest: recorded ${recorded.files} files, sha256 ${recorded.sha256}; now ${m.files} files, sha256 ${m.sha256}`);
      console.log('the recorded results do not identify this tree; run node scripts/validate-all.mjs --per-family 200 to produce results for it');
      process.exitCode = 1;
    }
  } else {
    const out = resolve(root, value('--out') ?? DEFAULT_OUT);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), hashing: HASHING, hashed: HASHED, not_hashed: NOT_HASHED, ...m }, null, 1) + '\n');
    console.log(`${m.files} files, source tree sha256 ${m.sha256}`);
  }
}
