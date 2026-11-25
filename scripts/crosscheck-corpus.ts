/**
 * Cross-engine agreement on the validation corpus: for every program and
 * argument tuple, the reference evaluator, the IR interpreter, and the
 * machine-code simulator of every target must reach the same outcome and the
 * same state (statement, variables, arrays, output length) at every boundary.
 *
 *   node scripts/crosscheck-corpus.ts [--per-family N] [--max-steps N] [--out validation/results/crosscheck.json]
 *
 * A run passes only when its verdict is `agree` (crossCheckVerdict): no engine
 * disagrees and no engine stopped at its step limit. A run in which an engine
 * stopped at its step limit is `incomplete`: it was compared only on the
 * boundaries reached, so it is counted on its own and never as passed. The
 * script exits with 1 when any run disagrees or is incomplete. --max-steps
 * sets the statement limit of the reference evaluator (the default is that of
 * crossCheck).
 *
 * The result records the combined hash of the source tree, computed when the
 * script starts (scripts/source-manifest.mjs).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { availableBackends } from '../src/core/target/index.ts';
import { crossCheck, crossCheckVerdict } from '../src/core/trace/crosscheck.ts';
import { VERSION } from '../src/core/version.ts';
import { CORPUS_SETTINGS, loadCorpus, repoRoot } from './lib/corpus.ts';
import { sourceManifest } from './lib/source-tree.ts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const perFamily = Number(opt('per-family', String(CORPUS_SETTINGS.programsPerFamily)));
const out = resolve(repoRoot(), opt('out', 'validation/results/crosscheck.json'));
const maxSteps = opt('max-steps', '');
if (maxSteps !== '' && !(Number.isInteger(Number(maxSteps)) && Number(maxSteps) > 0)) {
  console.error(`--max-steps takes a positive whole number, not '${maxSteps}'`);
  process.exit(2);
}
const limits = maxSteps === '' ? undefined : { maxSteps: Number(maxSteps) };
const sourceTree = sourceManifest().sha256;
const backends = availableBackends();
const corpus = loadCorpus({ perFamily });

const started = Date.now();
const byGroup: Record<string, { programs: number; runs: number; passed: number; incomplete: number; exited: number; trap: number; limit: number }> = {};
// Per target: `agreed` counts the runs in which the simulator agrees with the reference evaluator and neither of the
// two stopped at its step limit, `incomplete` the runs without a disagreement in which one of the two stopped at its
// step limit, and `boundaries` the boundaries at which the simulator was compared and agreed.
const perTarget: Record<string, { runs: number; agreed: number; incomplete: number; instructions: number; boundaries: number }> = {};
for (const b of backends) perTarget[b.profile.id] = { runs: 0, agreed: 0, incomplete: 0, instructions: 0, boundaries: 0 };
const failures: { program: string; args: number[]; failures: string[] }[] = [];
const incomplete: { program: string; args: number[]; limitReached: string[]; boundariesCompared: number }[] = [];
let runs = 0;
let passed = 0;
let boundaries = 0;
for (const p of corpus) {
  const g = (byGroup[p.group] ??= { programs: 0, runs: 0, passed: 0, incomplete: 0, exited: 0, trap: 0, limit: 0 });
  g.programs++;
  for (const args of p.args) {
    const cc = crossCheck(p.source, args, backends, limits);
    runs++;
    g.runs++;
    if (!cc.front.ok || !cc.reference) {
      failures.push({ program: p.name, args, failures: ['the program does not compile'] });
      continue;
    }
    g[cc.reference.status === 'fault' ? 'limit' : cc.reference.status]++;
    // The boundaries at which every engine was compared with the reference evaluator and agreed.
    const compared = Math.min(...[...(cc.ir ? [cc.ir] : []), ...cc.machines].map((e) => e.compared));
    boundaries += compared;
    for (const m of cc.machines) {
      const t = perTarget[m.target]!;
      t.runs++;
      t.instructions += m.executed;
      t.boundaries += m.compared;
      if (m.mismatch !== null) continue;
      if (cc.limitReached.includes('reference') || cc.limitReached.includes(m.target)) t.incomplete++;
      else t.agreed++;
    }
    const verdict = crossCheckVerdict(cc);
    if (verdict === 'agree') {
      passed++;
      g.passed++;
    } else if (verdict === 'incomplete') {
      g.incomplete++;
      incomplete.push({ program: p.name, args, limitReached: cc.limitReached, boundariesCompared: compared });
    } else failures.push({ program: p.name, args, failures: cc.failures.slice(0, 4) });
  }
}
const result = {
  stage: 'crosscheck',
  tool: 'isa-trace-lab',
  version: VERSION,
  source: sourceTree,
  corpus: { ...CORPUS_SETTINGS, programsPerFamily: perFamily, programs: corpus.length },
  engines: ['reference evaluator', 'IR interpreter', ...backends.map((b) => `${b.profile.id} simulator`)],
  totals: { runs, passed, failed: failures.length, incomplete: incomplete.length, boundariesCompared: boundaries },
  byGroup,
  perTarget,
  failures: failures.slice(0, 25),
  incomplete: incomplete.slice(0, 25),
  // A run that disagrees and a run that is incomplete both fail the comparison.
  failure_count: failures.length + incomplete.length,
  seconds: Math.round((Date.now() - started) / 100) / 10,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(`crosscheck: ${corpus.length} programs, ${runs} runs, ${passed} passed, ${failures.length} disagreeing, ${incomplete.length} incomplete, ${boundaries} boundaries compared on every engine (${result.seconds} s)`);
process.exit(result.failure_count === 0 ? 0 : 1);
