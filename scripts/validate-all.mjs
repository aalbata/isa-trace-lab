/**
 * Full independent validation in one command:
 *   1. source manifest (identity of the evaluated software);
 *   2. cross-engine agreement on the corpus;
 *   3. export of the validation inputs;
 *   4. controls of the harness;
 *   5. comparison with the reference assembler, disassembler, and emulator;
 *   6. summary tables (docs/validation-results.md, the support matrix of the
 *      application) and the instruction coverage tables (docs/coverage.md);
 *   7. check that the source tree still matches the manifest of step 1, so the
 *      recorded hash identifies the tree that the run leaves behind.
 *
 * Steps 2, 3, and 5 record the combined hash of the source tree in what they
 * write, and step 6 summarizes only results that record the hash of the tree
 * as it is then (docs/validation.md, section 5).
 *
 *   node scripts/validate-all.mjs [--per-family N] [--python <path to the venv python>]
 *
 * The Python environment must have the pinned packages of validation/requirements.txt.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const perFamily = opt('per-family', '200');
const venv = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
const python = opt('python', existsSync(venv) ? venv : 'python3');

function step(title, command, args) {
  console.log(`\n== ${title}`);
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${title} failed with exit code ${r.status}`);
    process.exitCode = 1;
  }
}

step('source manifest', process.execPath, ['scripts/source-manifest.mjs']);
step('cross-engine agreement', process.execPath, ['scripts/crosscheck-corpus.ts', '--per-family', perFamily]);
step('export of validation inputs', process.execPath, ['scripts/export-validation.ts', '--target', 'all', '--per-family', perFamily]);
step('harness controls', python, ['validation/harness_controls.py']);
step('reference tools', python, ['validation/run_validation.py', '--target', 'all', '--stage', 'all']);
step('summary', process.execPath, ['scripts/summarize-validation.ts']);
step('coverage tables', process.execPath, ['scripts/coverage-tables.ts']);
step('source manifest check', process.execPath, ['scripts/source-manifest.mjs', '--check']);
