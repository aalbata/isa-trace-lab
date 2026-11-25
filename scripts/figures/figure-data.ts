/**
 * Computes the data behind the figures and listings of the article with the
 * headless API and writes it to experiments/results/figure-data.json.
 *
 *   node scripts/figures/figure-data.ts [output.json]
 *
 * For each selected example program and each target it records the compiled
 * listing, the outcome and metrics of one run, the instruction index of every
 * statement boundary, and the verdict of the cross-target comparison. It also
 * records the decoded fields of the array load of the running example and a
 * summary of the four target profiles.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  VERSION, availableBackends, compareTargets, comparisonVerdict, compileProgram, decodeBytes, simulate, traceProgram,
} from '../../src/core/api.ts';

const root = join(import.meta.dirname, '..', '..');
const output = process.argv[2] ?? join(root, 'experiments', 'results', 'figure-data.json');

interface ExampleEntry { id: string; file: string; args: number[][] }
const index = JSON.parse(readFileSync(join(root, 'examples', 'index.json'), 'utf8')) as { examples: ExampleEntry[] };

/** The examples used in the article, with the source line whose instructions are listed. */
const SELECTED: { id: string; statement: string }[] = [
  { id: 'arithmetic', statement: 'big = 100000 + s' },
  { id: 'summation', statement: '' },
  { id: 'array_traversal', statement: 'total += data[i]' },
];

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const backends = availableBackends();

const profiles = backends.map((b) => {
  const p = b.profile;
  return {
    id: p.id,
    name: p.name,
    isa: p.isa,
    registerBits: p.registerBits,
    operationBits: p.operationBits,
    endianness: p.endianness,
    instructionLength: { min: p.instructionLength.min, max: p.instructionLength.max },
    flags: p.flags.map((f) => f.name),
    registers: p.registers.length,
    serviceInstruction: p.conventions.serviceInsn,
  };
});

const examples = SELECTED.map(({ id, statement }) => {
  const entry = index.examples.find((e) => e.id === id);
  if (!entry) throw new Error(`example ${id} is not in examples/index.json`);
  const source = readFileSync(join(root, 'examples', entry.file), 'utf8');
  const args = entry.args[0] ?? [];
  const lines = source.split(/\r?\n/);
  const statementLine = statement ? lines.findIndex((l) => l.trim() === statement) + 1 : 0;
  if (statement && statementLine === 0) throw new Error(`statement "${statement}" not found in ${entry.file}`);

  const targets = backends.map((b) => {
    const target = b.profile.id;
    const compiled = compileProgram(source, target);
    if (!compiled.ok) throw new Error(`${id} does not compile for ${target}`);
    const run = simulate(compiled.compiled, target, { args });
    const trace = traceProgram(compiled.compiled, target, { args, maxTraceSteps: 0, maxBoundaries: 1_000_000 });
    if (trace.boundaries.length !== run.metrics.boundaries) throw new Error(`${id} on ${target}: boundary record incomplete`);
    return {
      target,
      outcome: run.outcome,
      metrics: run.metrics,
      listing: compiled.document.instructions.map((i) => ({
        address: i.address, bytes: i.bytes, text: i.text, region: i.region, lines: i.lines, note: i.note ?? '',
      })),
      boundaries: trace.boundaries.map((x) => ({ ordinal: x.ordinal, line: x.line, step: x.step })),
    };
  });

  const comparison = compareTargets(source, args, backends);
  return {
    id,
    file: `examples/${entry.file}`,
    source,
    args,
    statementLine,
    verdict: comparisonVerdict(comparison),
    targets,
  };
});

/** Decoded fields of the instruction that loads the array element in the listed statement of the running example. */
const running = examples.find((e) => e.id === 'array_traversal');
if (!running) throw new Error('running example missing');
const encodings = running.targets.map((t) => {
  const insn = t.listing.find((i) => i.lines.includes(running.statementLine) && /^(lw|ldr)\b|dword ptr \[/.test(i.text));
  if (!insn) throw new Error(`no array load found for ${t.target}`);
  const decoded = decodeBytes(t.target, hexToBytes(insn.bytes), insn.address)[0];
  return { target: t.target, line: running.statementLine, instruction: decoded };
});

const document = {
  schema: 'isa-trace-lab/figure-data',
  schemaVersion: '1.0',
  software: { name: 'isa-trace-lab', version: VERSION },
  profiles,
  examples,
  encodings,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(document, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) + '\n');
console.log(`wrote ${output}`);
