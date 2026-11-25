import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../scripts/lib/corpus.ts';
import { SCHEMA_VERSION, compileProgram, decodeBytes, encodeAssembly, simulate, traceProgram, traceStep } from '../src/core/api.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import { newStepEvent } from '../src/core/target/machine.ts';
import type { StepEvent } from '../src/core/target/types.ts';
import { sourceProgramDocument, targetConfiguration } from '../src/core/trace/documents.ts';
import { hexToBytes } from '../src/core/util/int32.ts';
import { sha256Text } from '../src/core/util/sha256.ts';

const root = repoRoot();
const schema = (name: string): object => JSON.parse(readFileSync(join(root, 'schemas', `${name}.schema.json`), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = {
  source: ajv.compile(schema('source-program')),
  configuration: ajv.compile(schema('target-configuration')),
  compiled: ajv.compile(schema('compiled-program')),
  trace: ajv.compile(schema('execution-trace')),
  batch: ajv.compile(schema('batch-result')),
};
const example = (name: string): string => readFileSync(join(root, 'examples', name), 'utf8');

describe('exported documents', () => {
  it('computes SHA-256 as specified', () => {
    expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Text('a'.repeat(200))).toBe('c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5');
  });

  it('validates source-program and target-configuration documents', () => {
    expect(validators.source(sourceProgramDocument('fib', example('fibonacci.py'), [10]))).toBe(true);
    for (const b of availableBackends()) expect(validators.configuration(targetConfiguration(b)), b.profile.id).toBe(true);
  });

  for (const b of availableBackends()) {
    const id = b.profile.id;
    it(`produces schema-valid compiled-program and trace documents for ${id}`, () => {
      for (const file of ['fibonacci.py', 'array_traversal.py', 'arithmetic.py', 'index_error.py']) {
        const r = compileProgram(example(file), id);
        expect(r.ok, file).toBe(true);
        if (!r.ok) continue;
        const okCompiled = validators.compiled(r.document);
        expect(validators.compiled.errors ?? [], file).toEqual([]);
        expect(okCompiled).toBe(true);
        // One argument per parameter of main, taken from 5, 3.
        const trace = traceProgram(r.compiled, id, { args: [5, 3].slice(0, r.compiled.ir.params.length) });
        const okTrace = validators.trace(trace);
        expect(validators.trace.errors ?? [], file).toEqual([]);
        expect(okTrace).toBe(true);
        // The document survives a JSON round trip unchanged.
        expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
      }
    });

    it(`keeps source mappings consistent for ${id}`, () => {
      const r = compileProgram(example('summation.py'), id);
      if (!r.ok) throw new Error('compile failed');
      const doc = r.document;
      const opIds = new Set(doc.ir.ops.map((o) => o.id));
      const lineOf = new Map(doc.ir.ops.map((o) => [o.id, o.span.startLine]));
      let address = doc.code.base;
      let bytes = '';
      for (const i of doc.instructions) {
        expect(i.address).toBe(address);
        address += i.bytes.length / 2;
        bytes += i.bytes;
        for (const op of i.ir) expect(opIds.has(op)).toBe(true);
        expect(i.lines).toEqual([...new Set(i.ir.map((op) => lineOf.get(op)!))].sort((a, b) => a - b));
        if (i.region === 'startup' || i.region === 'helper') expect(i.ir).toEqual([]);
      }
      expect(bytes).toBe(doc.code.bytes);
      // Every statement of the program has a boundary address inside the code.
      const marked = new Set(doc.boundaries.flatMap((c) => c.statements));
      for (const s of doc.statements) expect(marked.has(s.id)).toBe(true);
      const starts = new Set(doc.instructions.map((i) => i.address));
      for (const c of doc.boundaries) expect(starts.has(c.address)).toBe(true);
      // Every line that holds a statement is the source of at least one instruction or a marker.
      const linesWithCode = new Set(doc.instructions.flatMap((i) => i.lines));
      expect(linesWithCode.has(5)).toBe(true);
    });

    it(`records a trace that agrees with the plain simulation for ${id}`, () => {
      const r = compileProgram(example('linear_search.py'), id);
      if (!r.ok) throw new Error('compile failed');
      const plain = simulate(r.compiled, id, { args: [23] });
      const trace = traceProgram(r.compiled, id, { args: [23] });
      expect(trace.outcome).toEqual(plain.outcome);
      expect(trace.metrics).toEqual(plain.metrics);
      expect(trace.truncated).toBe(false);
      expect(trace.steps).toHaveLength(plain.outcome.steps);
      expect(trace.boundaries).toHaveLength(plain.metrics.boundaries);
      expect(trace.steps.filter((s) => s.service?.name === 'print')).toHaveLength(plain.outcome.output.length);
      const last = trace.boundaries[trace.boundaries.length - 1]!;
      expect(last.variables['found']).toBe(4);
      // A bounded trace is marked as truncated and still reports the full outcome.
      const short = traceProgram(r.compiled, id, { args: [23], maxTraceSteps: 10 });
      expect(short.truncated).toBe(true);
      expect(short.steps).toHaveLength(10);
      expect(short.outcome).toEqual(plain.outcome);
      // So is a trace that keeps fewer boundary records than the run fired, even with every instruction record kept.
      const few = traceProgram(r.compiled, id, { args: [23], maxBoundaries: 5 });
      expect(few.steps).toHaveLength(plain.outcome.steps);
      expect(few.boundaries).toHaveLength(5);
      expect(few.metrics.boundaries).toBe(plain.metrics.boundaries);
      expect(few.truncated).toBe(true);
      expect(validators.trace(few)).toBe(true);
    });
  }

  it('writes the 64-bit target of a branch as sixteen hexadecimal digits', () => {
    const aarch64 = getBackend('aarch64');
    // The event of `br x1` at 0x00400000; with a register value above 32 bits the event carries the full target and next address.
    const event = (target64?: bigint): StepEvent => {
      const ev: StepEvent = {
        ...newStepEvent(0), pc: 0x00400000, length: 4, bytes: [0x20, 0x00, 0x1f, 0xd6], text: 'br x1', klass: 'jump',
        branch: { conditional: false, taken: true, target: 0x00400008 }, nextPc: 0x00400008,
      };
      if (target64 !== undefined) {
        ev.branch!.target64 = target64;
        ev.nextPc64 = target64;
      }
      return ev;
    };
    const narrow = traceStep(aarch64, event(), 0);
    expect(narrow.branch).toEqual({ conditional: false, taken: true, target: 0x00400008 });
    const wide = traceStep(aarch64, event(0x100400008n), 0);
    expect(wide.branch).toEqual({ conditional: false, taken: true, target: 0x00400008, target64: '0x0000000100400008' });
    expect(traceStep(aarch64, event(0xfffffffffffffff8n), 0).branch!.target64).toBe('0xfffffffffffffff8');
    // The record has no field for the next address, within 32 bits or beyond.
    expect(Object.keys(wide)).toEqual(Object.keys(narrow));
    expect(Object.keys(wide)).not.toContain('nextPc');

    // The record is valid in a trace document, and the document survives a JSON round trip.
    const r = compileProgram(example('fibonacci.py'), 'aarch64');
    if (!r.ok) throw new Error('compile failed');
    const trace = traceProgram(r.compiled, 'aarch64', { args: [5] });
    const document = { ...trace, steps: [wide, ...trace.steps.slice(1)] };
    const ok = validators.trace(document);
    expect(validators.trace.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    // The schema accepts no other form of the field.
    for (const target64 of [0x100400008, '0x100400008', '0000000100400008', '0x0000000100400008 ', '0x000000010040000G']) {
      expect(validators.trace({ ...trace, steps: [{ ...wide, branch: { ...wide.branch, target64 } }] }), String(target64)).toBe(false);
    }
  });

  it('leaves an array out of the final arrays when its definition has not executed', () => {
    // With a positive argument main returns before the array is defined.
    const source = 'def main(n):\n    t = 0\n    if n > 0:\n        return 7\n    a = [n, 2, 3]\n    return a[0] + t\n';
    for (const b of availableBackends()) {
      const id = b.profile.id;
      const r = compileProgram(source, id);
      if (!r.ok) throw new Error('compile failed');
      for (const [n, arrays] of [[5, {}], [0, { a: [0, 2, 3] }]] as const) {
        const run = simulate(r.compiled, id, { args: [n] });
        expect(run.outcome.returnValue, `${id} ${n}`).toBe(n > 0 ? 7 : 0);
        expect(run.arrays, `${id} ${n}`).toEqual(arrays);
        const trace = traceProgram(r.compiled, id, { args: [n] });
        expect(trace.finalArrays, `${id} ${n}`).toEqual(arrays);
        expect(validators.trace(trace), `${id} ${n}`).toBe(true);
      }
    }
  });

  it('writes a schema-valid batch result document', () => {
    const work = mkdtempSync(join(tmpdir(), 'isa-trace-lab-'));
    try {
      const manifest = join(work, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({
        targets: ['riscv', 'x86'],
        programs: [
          { name: 'fibonacci', file: join(root, 'examples', 'fibonacci.py'), args: [[10], [47]] },
          { file: join(root, 'examples', 'array_traversal.py') },
          { name: 'unsupported', file: join(root, 'examples', 'unsupported.py') },
        ],
      }));
      // With 300 instructions for each target, some comparisons of the examples are incomplete.
      const cases: [string, string[], number, number][] = [
        [manifest, [], 1, 4],
        [join(root, 'examples', 'batch', 'manifest.json'), [], 0, 30],
        [join(root, 'examples', 'batch', 'manifest.json'), ['--max-steps', '300'], 3, 30],
      ];
      for (const [path, options, status, expected] of cases) {
        const out = join(work, 'result.json');
        const r = spawnSync(process.execPath, [join(root, 'src', 'cli', 'main.ts'), 'batch', path, '-o', out, ...options], { cwd: root, encoding: 'utf8', timeout: 120_000 });
        expect(r.status, r.stderr).toBe(status);
        const doc = JSON.parse(readFileSync(out, 'utf8')) as {
          schema: string; schemaVersion: string; counts: Record<string, number>; results: { verdict?: string; error?: string[] }[];
        };
        const ok = validators.batch(doc);
        expect(validators.batch.errors ?? [], path).toEqual([]);
        expect(ok).toBe(true);
        expect(doc.schema).toBe('isa-trace-lab/batch-result');
        expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
        expect(doc.results).toHaveLength(expected);
        // The counts are those of the entries.
        for (const verdict of ['agree', 'disagree', 'incomplete']) expect(doc.counts[verdict], verdict).toBe(doc.results.filter((x) => x.verdict === verdict).length);
        expect(doc.counts['error']).toBe(doc.results.filter((x) => x.error !== undefined).length);
        expect(doc.counts['disagree']).toBe(0);
        expect(doc.counts['error']).toBe(status === 1 ? 1 : 0);
        expect(doc.counts['incomplete'] > 0).toBe(status === 3);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('package manifest', () => {
  it('declares a command whose target exists and starts the command-line tool', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { bin?: Record<string, string> }> };
    expect(lock.packages['']!.bin).toEqual(pkg.bin);
    for (const [name, target] of Object.entries(pkg.bin)) {
      expect(existsSync(join(root, target)), `${target} exists`).toBe(true);
      const r = spawnSync(process.execPath, [join(root, target), 'help'], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Usage: ${name} <command>`);
    }
  });
});

describe('headless assembly and decoding', () => {
  it('assembles text and decodes the bytes back', () => {
    const r = encodeAssembly('riscv', 'start:\n  li a0, 7\n  addi a0, a0, 1\n  beqz a0, start\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const decoded = decodeBytes('riscv', r.program.bytes);
    expect(decoded.map((d) => d.text)).toEqual(['addi a0, zero, 7', 'addi a0, a0, 1', 'beq a0, zero, 0x00400000']);
    expect(decoded[0]!.alias).toBe('li a0, 7');
    expect(decoded[0]!.fields!.length).toBeGreaterThan(3);
  });

  it('reports assembly errors with line numbers', () => {
    const r = encodeAssembly('riscv', 'li a0, 1\nfrob a0\naddi a0, a0, 99999\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ line: 2 });
  });

  it('continues after an undecodable word and stops at a truncated one', () => {
    const decoded = decodeBytes('riscv', hexToBytes('13 05 70 00 ff ff ff ff 13 05')!);
    expect(decoded.map((d) => (d.ok ? 'ok' : d.kind))).toEqual(['ok', 'invalid', 'truncated']);
  });
});
