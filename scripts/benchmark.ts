/**
 * Performance measurements of the headless core in Node.js.
 *
 *   node scripts/benchmark.ts [--repetitions 30] [--warmup 5] [--out experiments/results/benchmark.json]
 *
 * Measured, each separately:
 *   cold compile   first compilation of a program in a fresh process (one measurement per target);
 *   warm compile   compilation of each example for each target, after warm-up, repeated;
 *   simulation     instructions per second of the processor models on long programs, three ways:
 *                  plain stepping, stepping with a recorded step event, and trace recording
 *                  (the trace is limited to the first 200,000 instructions of the run);
 *   bytecode       loading the Pyodide runtime once, then disassembling each example, repeated.
 * Times are wall-clock milliseconds from performance.now(). Summaries give the median, the
 * 25th and 75th percentiles, and the minimum and maximum of the repetitions.
 */
import { execSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compile } from '../src/core/compile.ts';
import { availableBackends } from '../src/core/target/index.ts';
import { loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { recordTrace } from '../src/core/trace/documents.ts';
import { VERSION } from '../src/core/version.ts';
import { repoRoot } from './lib/corpus.ts';

const root = repoRoot();
const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const repetitions = Number(opt('repetitions', '30'));
const warmup = Number(opt('warmup', '5'));
const out = join(root, opt('out', 'experiments/results/benchmark.json'));

function summary(xs: number[]): { n: number; median: number; p25: number; p75: number; min: number; max: number } {
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number): number => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
  };
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return { n: s.length, median: r(q(0.5)), p25: r(q(0.25)), p75: r(q(0.75)), min: r(s[0]!), max: r(s[s.length - 1]!) };
}

const examples = (JSON.parse(readFileSync(join(root, 'examples', 'index.json'), 'utf8')) as { examples: { id: string; file: string; args: number[][]; expectDiagnostics?: boolean }[] }).examples
  .filter((e) => !e.expectDiagnostics)
  .map((e) => ({ id: e.id, source: readFileSync(join(root, 'examples', e.file), 'utf8'), args: e.args[0] ?? [] }));

// Long programs: loops whose executed-instruction count is in the millions on every target.
const LONG: { id: string; source: string; args: number[] }[] = [
  { id: 'sum_loop', source: 'def main(n):\n    total = 0\n    for i in range(n):\n        total += i ^ (i >> 3)\n    return total\n', args: [200000] },
  { id: 'array_passes', source: 'def main(n):\n    a = [0] * 256\n    t = 0\n    for k in range(n):\n        for i in range(256):\n            a[i] = a[i] + i + k\n        t += a[k & 255]\n    return t\n', args: [400] },
  { id: 'multiply_loop', source: 'def main(n):\n    x = 1\n    for i in range(n):\n        x = x * 1103515245 + 12345\n    return x\n', args: [50000] },
];

const backends = availableBackends();
const environment = {
  date: new Date().toISOString(),
  software: VERSION,
  node: process.version,
  v8: process.versions.v8,
  os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model ?? 'unknown',
  logicalCores: os.cpus().length,
  memoryGiB: Math.round(os.totalmem() / 2 ** 30),
  method: 'performance.now() wall-clock time in one Node.js process, single-threaded',
  repetitions,
  warmup,
};

// ---- cold compilation (fresh process per target) --------------------------------------
const cold: Record<string, number> = {};
for (const b of backends) {
  const code = `import { compile } from './src/core/compile.ts'; import { getBackend } from './src/core/target/index.ts';` +
    `const s = ${JSON.stringify(examples.find((e) => e.id === 'fibonacci')!.source)};` +
    `const t0 = performance.now(); compile(s, getBackend('${b.profile.id}')); console.log(performance.now() - t0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
  cold[b.profile.id] = Number(r.stdout.trim());
}

// ---- warm compilation ------------------------------------------------------------------
const warm: Record<string, Record<string, ReturnType<typeof summary>>> = {};
for (const b of backends) {
  warm[b.profile.id] = {};
  for (const e of examples) {
    for (let k = 0; k < warmup; k++) compile(e.source, b);
    const xs: number[] = [];
    for (let k = 0; k < repetitions; k++) {
      const t0 = performance.now();
      compile(e.source, b);
      xs.push(performance.now() - t0);
    }
    warm[b.profile.id]![e.id] = summary(xs);
  }
}

// ---- simulation throughput -------------------------------------------------------------
const simRepetitions = Math.max(5, Math.floor(repetitions / 3));
const simulation: Record<string, Record<string, { instructions: number; plainMips: ReturnType<typeof summary>; eventsMips: ReturnType<typeof summary>; traceMips: ReturnType<typeof summary> }>> = {};
for (const b of backends) {
  simulation[b.profile.id] = {};
  for (const p of LONG) {
    const r = compile(p.source, b);
    if (!r.ok) throw new Error(`${p.id} does not compile`);
    const c = r.compiled;
    const runPlain = (): number => {
      const m = loadCompiled(b, c, { args: p.args, limits: { maxSteps: 100_000_000 } });
      m.run();
      return m.executed;
    };
    const runEvents = (): number => {
      const m = loadCompiled(b, c, { args: p.args, limits: { maxSteps: 100_000_000 } });
      while (m.step(newStepEvent(m.executed))) {
        // every step records its event
      }
      return m.executed;
    };
    // Trace recording keeps one record per instruction, so it is measured on the first 200,000 instructions.
    const runTrace = (): number => recordTrace(b, c, { args: p.args, limits: { maxSteps: 200_000 }, maxTraceSteps: 200_000, maxBoundaries: 200_000 }).metrics.executedInstructions;
    const measure = (f: () => number): { n: number; xs: number[] } => {
      f();
      const xs: number[] = [];
      let n = 0;
      for (let k = 0; k < simRepetitions; k++) {
        const t0 = performance.now();
        n = f();
        xs.push(n / ((performance.now() - t0) / 1000) / 1e6);
      }
      return { n, xs };
    };
    const plain = measure(runPlain);
    const events = measure(runEvents);
    const trace = measure(runTrace);
    simulation[b.profile.id]![p.id] = { instructions: plain.n, plainMips: summary(plain.xs), eventsMips: summary(events.xs), traceMips: summary(trace.xs) };
  }
}

// ---- CPython bytecode (Path A) ----------------------------------------------------------
const { loadPyodide } = await import('pyodide');
const { createDisassembler } = await import('../src/bytecode/disassembler.ts');
const t0 = performance.now();
const pyodide = await loadPyodide();
const dis = createDisassembler(pyodide as unknown as Parameters<typeof createDisassembler>[0]);
const loadMs = performance.now() - t0;
const bytecode: Record<string, ReturnType<typeof summary>> = {};
for (const e of examples) {
  for (let k = 0; k < warmup; k++) dis.disassemble(e.source);
  const xs: number[] = [];
  for (let k = 0; k < repetitions; k++) {
    const t1 = performance.now();
    dis.disassemble(e.source);
    xs.push(performance.now() - t1);
  }
  bytecode[e.id] = summary(xs);
}

let commitNote = '';
try {
  commitNote = execSync('node scripts/source-manifest.mjs --out experiments/results/benchmark-source-manifest.json', { cwd: root, encoding: 'utf8' }).trim();
} catch {
  commitNote = 'source manifest not written';
}

const result = { environment, source: commitNote, coldCompileMs: cold, warmCompileMs: warm, simulation, bytecode: { pyodideLoadMs: Math.round(loadMs), pyodideVersion: pyodide.version, disassembleMs: bytecode } };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(`benchmark written to ${out}`);
for (const [t, progs] of Object.entries(simulation)) {
  for (const [p, v] of Object.entries(progs)) console.log(`${t.padEnd(8)} ${p.padEnd(14)} ${String(v.instructions).padStart(10)} instr  plain ${v.plainMips.median} M/s  events ${v.eventsMips.median} M/s  trace ${v.traceMips.median} M/s`);
}
console.log('pyodide load ms', Math.round(loadMs), 'cold compile ms', cold);
process.exit(0);
