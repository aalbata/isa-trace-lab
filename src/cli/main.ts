#!/usr/bin/env node
/**
 * Command-line interface of ISA Trace Lab. It exposes the headless API for
 * single programs and for batch experiments.
 *
 *   node src/cli/main.ts <command> [arguments]
 *
 * Run `node src/cli/main.ts help` for the list of commands. The exit status is
 * 0 on success, 1 when the program has errors or the runs disagree, 2 for a
 * usage or configuration error, and 3 when a comparison is incomplete because
 * a run stopped at its step limit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ArgumentCountError, DEFAULT_LIMITS, SCHEMA_VERSION, VERSION, availableBackends, checkArguments, compareTargets, comparisonVerdict,
  compileFrontEnd, compileProgram, crossCheck, crossCheckVerdict, decodeBytes, encodeAssembly, formatDiagnostic, formatIR, getBackend,
  observable, parameterNames, simulate, traceProgram,
} from '../core/api.ts';
import type { Backend, CodeRegion, ComparedBoundary, ComparisonVerdict, EngineReport, Metrics } from '../core/api.ts';
import { bytesToHex, hex, hexToBytes } from '../core/util/int32.ts';

/** Exit status of a comparison command for each verdict. */
const VERDICT_STATUS: Record<ComparisonVerdict, number> = { agree: 0, disagree: 1, incomplete: 3 };

const HELP = `ISA Trace Lab ${VERSION}

Usage: isa-trace-lab <command> [options]

Commands
  targets                               List the target profiles.
  check <file.py>                       Report diagnostics for a source program.
  ir <file.py>                          Print the intermediate representation.
  compile <file.py> -t <target>         Compile; print the listing, or write the compiled-program document with -o.
  run <file.py> -t <target>             Compile and simulate; print the outcome and metrics as JSON.
  trace <file.py> -t <target> -o <file> Compile, simulate, and write the execution-trace document.
  compare <file.py>                     Run on every target and compare at statement boundaries.
  crosscheck <file.py>                  Compare the reference evaluator, the IR interpreter, and every simulator.
  encode -t <target> <file.s>           Assemble a program written in the target's assembly syntax.
  decode -t <target> <hex bytes>        Decode instruction bytes.
  batch <manifest.json> -o <file>       Run a set of programs, arguments, and targets; write one result document.

Options
  -t, --target <id>      Target profile: ${availableBackends().map((b) => b.profile.id).join(', ')}.
  -a, --args <list>      Arguments of main, comma-separated integers, one per parameter (for example -a 10,-3).
  -o, --out <file>       Output file (JSON).
      --targets <list>   Comma-separated targets for compare, crosscheck, and batch (default: all).
      --max-steps <n>    Step limit (default ${DEFAULT_LIMITS.maxSteps}). For run, trace, compare, and batch: instructions
                         executed by each target. For crosscheck: statements executed by the reference
                         evaluator; the IR interpreter and each simulator get ten times the value in
                         IR steps and in instructions.
      --max-trace <n>    Number of instruction records kept in a trace (default 100000).
      --max-boundaries <n>
                         Number of boundary records kept in a trace (default 100000).
      --json             Print JSON instead of a table (compare).

Exit status: 0 on success, 1 when the program has errors or the runs disagree, 2 for a usage or configuration
error, 3 when a comparison (compare, crosscheck, batch) found no disagreement but is incomplete because a run
stopped at its step limit.
`;

interface Options {
  positional: string[];
  target?: string;
  args: number[];
  out?: string;
  targets?: string[];
  maxSteps?: number;
  maxTrace?: number;
  maxBoundaries?: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { positional: [], args: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`option ${a} needs a value`);
      return v;
    };
    // A whole number of at least `min`. Number('') is 0, so empty text is rejected explicitly.
    const count = (min: number): number => {
      const text = value();
      const n = Number(text);
      if (text.trim() === '' || !Number.isSafeInteger(n) || n < min) fail(`option ${a} needs a whole number of at least ${min}, not '${text}'`);
      return n;
    };
    switch (a) {
      case '-t': case '--target': o.target = value(); break;
      case '-a': case '--args': {
        // Empty text gives no arguments; otherwise every comma-separated item is one integer.
        const text = value();
        o.args = text.trim() === '' ? [] : text.split(',').map((x) => {
          const n = Number(x);
          if (x.trim() === '' || !Number.isInteger(n) || n < -2147483648 || n > 4294967295) fail(`argument '${x}' is not a 32-bit integer`);
          return n | 0;
        });
        break;
      }
      case '-o': case '--out': o.out = value(); break;
      case '--targets': o.targets = value().split(','); break;
      case '--max-steps': o.maxSteps = count(1); break;
      case '--max-trace': o.maxTrace = count(0); break;
      case '--max-boundaries': o.maxBoundaries = count(0); break;
      case '--json': o.json = true; break;
      default:
        if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) fail(`unknown option ${a}`);
        o.positional.push(a);
    }
  }
  return o;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

/** Read a text file. A UTF-8 byte-order mark at its start is not part of the text, as CPython treats source files. */
function readText(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`cannot read ${path}`);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readSource(o: Options): { path: string; text: string } {
  const path = o.positional[0];
  if (!path) fail('missing input file');
  return { path, text: readText(path) };
}

function requireTarget(o: Options): Backend {
  if (!o.target) fail('missing --target');
  try {
    return getBackend(o.target);
  } catch (e) {
    fail((e as Error).message);
  }
}

function selectedBackends(o: { targets?: string[] }): Backend[] {
  if (!o.targets) return availableBackends();
  return o.targets.map((t) => {
    try {
      return getBackend(t);
    } catch (e) {
      fail((e as Error).message);
    }
  });
}

/** Call the API; arguments that do not match the parameters of main are a configuration error. */
function withArguments<T>(call: () => T): T {
  try {
    return call();
  } catch (e) {
    if (e instanceof ArgumentCountError) fail(`${e.message}; give one value per parameter with -a`);
    throw e;
  }
}

function emit(o: Options, document: unknown): void {
  const text = JSON.stringify(document, null, 2) + '\n';
  if (o.out) {
    writeFileSync(o.out, text);
    process.stderr.write(`wrote ${o.out}\n`);
  } else process.stdout.write(text);
}

function limitsOf(o: Options): { maxSteps?: number } {
  return o.maxSteps !== undefined ? { maxSteps: o.maxSteps } : {};
}

/** A count with its unit in the singular or the plural, for example `1 boundary` or `45 boundaries`. */
function counted(n: number, unit: string, units = `${unit}s`): string {
  return `${n} ${n === 1 ? unit : units}`;
}

/** A number of statement boundaries. */
function boundaryCount(n: number): string {
  return counted(n, 'boundary', 'boundaries');
}

/** Number of kept boundaries that at least two runs reached, which are the boundaries that were compared. */
function comparedBoundaries(rows: readonly ComparedBoundary[]): number {
  return rows.filter((row) => Object.keys(row.variables).length > 1).length;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ')).join('\n');
}

const REGIONS: CodeRegion[] = ['startup', 'main', 'helper', 'trap'];

function metricRows(runs: { target: string; metrics: Metrics }[]): string[][] {
  const head = ['metric', ...runs.map((r) => r.target)];
  const row = (name: string, f: (m: Metrics) => number): string[] => [name, ...runs.map((r) => String(f(r.metrics)))];
  return [
    head,
    row('static instructions', (m) => m.staticInstructions),
    ...REGIONS.map((g) => row(`  in ${g}`, (m) => m.staticInstructionsByRegion[g])),
    row('code bytes', (m) => m.codeBytes),
    row('executed instructions', (m) => m.executedInstructions),
    ...REGIONS.map((g) => row(`  in ${g}`, (m) => m.executedByRegion[g])),
    row('data loads', (m) => m.dataLoads),
    row('data stores', (m) => m.dataStores),
    row('registers written', (m) => m.registersWritten),
    row('boundaries', (m) => m.boundaries),
  ];
}

interface ManifestProgram {
  name: string;
  file: string;
  text: string;
  args: number[][];
}

/**
 * Read and check a batch manifest: its programs, their argument tuples, and
 * its targets. Every problem is a configuration error.
 */
function readManifest(path: string, o: Options): { programs: ManifestProgram[]; backends: Backend[] } {
  let data: unknown;
  const text = readText(path);
  try {
    data = JSON.parse(text);
  } catch {
    fail(`${path} is not a JSON document`);
  }
  const m = (typeof data === 'object' && data !== null ? data : {}) as { programs?: unknown; targets?: unknown };
  if (!Array.isArray(m.programs)) fail(`${path}: the manifest needs a 'programs' list`);
  if (m.targets !== undefined && (!Array.isArray(m.targets) || !m.targets.every((t) => typeof t === 'string'))) {
    fail(`${path}: 'targets' must be a list of target names`);
  }
  const backends = selectedBackends(m.targets !== undefined ? { targets: m.targets as string[] } : o);
  const programs = (m.programs as unknown[]).map((entry, k): ManifestProgram => {
    const p = (typeof entry === 'object' && entry !== null ? entry : {}) as { name?: unknown; file?: unknown; args?: unknown };
    const where = `${path}: program ${k + 1}`;
    if (typeof p.file !== 'string') fail(`${where} needs a 'file'`);
    if (p.name !== undefined && typeof p.name !== 'string') fail(`${where}: 'name' must be text`);
    const args = p.args ?? [[]];
    if (!Array.isArray(args) || !args.every((t) => Array.isArray(t))) fail(`${where}: 'args' must be a list of argument lists`);
    if (args.length === 0) fail(`${where}: 'args' must hold at least one argument list`);
    const tuples = (args as unknown[][]).map((t) => t.map((x) => {
      if (typeof x !== 'number' || !Number.isInteger(x) || x < -2147483648 || x > 4294967295) fail(`${where}: argument ${JSON.stringify(x)} is not a 32-bit integer`);
      return x | 0;
    }));
    const name = (p.name as string | undefined) ?? p.file;
    const source = readText(resolve(dirname(path), p.file));
    // Each argument tuple supplies every parameter of main; a program with errors is reported in the results instead.
    const front = compileFrontEnd(source);
    if (front.ok && front.ir) {
      const parameters = parameterNames(front.ir);
      for (const t of tuples) {
        try {
          checkArguments(parameters, t);
        } catch (e) {
          if (e instanceof ArgumentCountError) fail(`${where} (${name}), arguments [${t.join(', ')}]: ${e.message}`);
          throw e;
        }
      }
    }
    return { name, file: p.file, text: source, args: tuples };
  });
  return { programs, backends };
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    case 'version':
    case '--version':
      process.stdout.write(VERSION + '\n');
      return;
    case 'targets':
      for (const b of availableBackends()) process.stdout.write(`${b.profile.id.padEnd(8)} ${b.profile.name}: ${b.profile.isa}\n`);
      return;
    case 'check': {
      const { text } = readSource(o);
      const front = compileFrontEnd(text);
      for (const d of front.diagnostics) process.stdout.write(formatDiagnostic(d) + '\n');
      process.stdout.write(front.ok ? 'no errors\n' : `${front.diagnostics.filter((d) => d.severity === 'error').length} error(s)\n`);
      process.exitCode = front.ok ? 0 : 1;
      return;
    }
    case 'ir': {
      const { text } = readSource(o);
      const front = compileFrontEnd(text);
      if (!front.ok || !front.ir) {
        for (const d of front.diagnostics) process.stderr.write(formatDiagnostic(d) + '\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write(formatIR(front.ir) + '\n');
      return;
    }
    case 'compile': {
      const { text } = readSource(o);
      const backend = requireTarget(o);
      const r = compileProgram(text, backend.profile.id);
      if (!r.ok) {
        for (const d of r.diagnostics) process.stderr.write(formatDiagnostic(d) + '\n');
        process.exitCode = 1;
        return;
      }
      if (o.out) {
        emit(o, r.document);
        return;
      }
      for (const i of r.document.instructions) {
        for (const l of i.labels) process.stdout.write(`${l}:\n`);
        const note = i.pseudo ? `; ${i.pseudo.text}` : '';
        const lines = i.lines.length > 0 ? `line ${i.lines.join(',')}` : i.region;
        process.stdout.write(`  ${hex(i.address)}  ${i.bytes.padEnd(30)} ${i.text.padEnd(34)} ${note.padEnd(26)} [${lines}]\n`);
      }
      return;
    }
    case 'run': {
      const { text } = readSource(o);
      const backend = requireTarget(o);
      const r = compileProgram(text, backend.profile.id);
      if (!r.ok) {
        for (const d of r.diagnostics) process.stderr.write(formatDiagnostic(d) + '\n');
        process.exitCode = 1;
        return;
      }
      const result = withArguments(() => simulate(r.compiled, backend.profile.id, { args: o.args, limits: limitsOf(o) }));
      emit(o, { target: backend.profile.id, args: o.args, ...result });
      return;
    }
    case 'trace': {
      const { text } = readSource(o);
      const backend = requireTarget(o);
      const r = compileProgram(text, backend.profile.id);
      if (!r.ok) {
        for (const d of r.diagnostics) process.stderr.write(formatDiagnostic(d) + '\n');
        process.exitCode = 1;
        return;
      }
      const options: Parameters<typeof traceProgram>[2] = { args: o.args, limits: limitsOf(o) };
      if (o.maxTrace !== undefined) options.maxTraceSteps = o.maxTrace;
      if (o.maxBoundaries !== undefined) options.maxBoundaries = o.maxBoundaries;
      emit(o, withArguments(() => traceProgram(r.compiled, backend.profile.id, options)));
      return;
    }
    case 'compare': {
      const { text } = readSource(o);
      const backends = selectedBackends(o);
      const limits = { ...DEFAULT_LIMITS, ...limitsOf(o) };
      const cmp = withArguments(() => compareTargets(text, o.args, backends, { limits }));
      if (!cmp.front.ok) {
        for (const d of cmp.front.diagnostics) process.stderr.write(formatDiagnostic(d) + '\n');
        process.exitCode = 1;
        return;
      }
      const verdict = comparisonVerdict(cmp);
      process.exitCode = VERDICT_STATUS[verdict];
      if (o.json || o.out) {
        emit(o, {
          args: o.args, verdict, outcomesAgree: cmp.outcomesAgree, boundariesAgree: cmp.boundariesAgree, boundariesTruncated: cmp.boundariesTruncated,
          limitReached: cmp.limitReached, runs: cmp.runs.map((r) => ({ target: r.target, outcome: r.outcome, metrics: r.metrics })), boundaries: cmp.boundaries,
        });
        return;
      }
      process.stdout.write(table(metricRows(cmp.runs)) + '\n\n');
      for (const r of cmp.runs) process.stdout.write(`${r.target.padEnd(8)} ${observable(r.outcome)}\n`);
      // Outcomes are compared between the runs that ended on their own.
      const ended = cmp.runs.length - cmp.limitReached.length;
      const outcomes = ended < 2 ? 'outcomes not compared' : `outcomes agree: ${cmp.outcomesAgree}`;
      process.stdout.write(`\n${outcomes}; ${boundaryCount(comparedBoundaries(cmp.boundaries))} compared, agree: ${cmp.boundariesAgree}\n`);
      for (const r of cmp.runs) {
        if (!cmp.limitReached.includes(r.target)) continue;
        process.stdout.write(`${r.target} stopped at the limit of ${counted(limits.maxSteps, 'instruction')} after ${boundaryCount(r.metrics.boundaries)}; it is compared on the boundaries it reached\n`);
      }
      process.stdout.write(`verdict: ${verdict}\n`);
      return;
    }
    case 'crosscheck': {
      const { text } = readSource(o);
      const backends = selectedBackends(o);
      const cc = withArguments(() => crossCheck(text, o.args, backends, limitsOf(o)));
      if (!cc.front.ok) {
        for (const d of cc.front.diagnostics) process.stderr.write(formatDiagnostic(d) + '\n');
        process.exitCode = 1;
        return;
      }
      const stepLimits = cc.stepLimits!;
      const referenceStopped = cc.limitReached.includes('reference');
      // An engine agrees without qualification only when it and the reference evaluator both ended on their own.
      const report = (r: EngineReport, limit: string): string => {
        if (r.mismatch !== null) return r.mismatch;
        if (!referenceStopped && !r.limitReached) return 'agrees';
        const compared = r.compared === 0 ? 'no boundary was compared' : `agrees on the ${boundaryCount(r.compared)} compared`;
        return r.limitReached ? `${compared}; stopped at its limit of ${limit}` : compared;
      };
      process.stdout.write(`reference  ${observable(cc.reference!)}${referenceStopped ? `  stopped at its limit of ${counted(stepLimits.statements, 'statement')}` : ''}\n`);
      process.stdout.write(`ir         ${observable(cc.ir!.outcome)}  ${report(cc.ir!, counted(stepLimits.irSteps, 'IR step'))}\n`);
      for (const m of cc.machines) process.stdout.write(`${m.target.padEnd(10)} ${observable(m.outcome)}  ${report(m, counted(stepLimits.instructions, 'instruction'))}\n`);
      const verdict = crossCheckVerdict(cc);
      process.stdout.write(`verdict: ${verdict}\n`);
      process.exitCode = VERDICT_STATUS[verdict];
      return;
    }
    case 'encode': {
      const { text } = readSource(o);
      const backend = requireTarget(o);
      const r = encodeAssembly(backend.profile.id, text);
      if (!r.ok) {
        for (const e of r.errors) process.stderr.write(`line ${e.line}: ${e.message}\n`);
        process.exitCode = 1;
        return;
      }
      const p = r.program;
      if (o.out) {
        emit(o, {
          target: backend.profile.id, base: p.base, bytes: bytesToHex(p.bytes, ''), symbols: p.symbols,
          instructions: p.insns.map((i) => ({ address: i.address, bytes: bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + i.length), ''), text: i.text, pseudo: i.meta.pseudo?.text })),
        });
        return;
      }
      for (const i of p.insns) {
        for (const l of i.labels) process.stdout.write(`${l}:\n`);
        const bytes = bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + i.length));
        process.stdout.write(`  ${hex(i.address)}  ${bytes.padEnd(32)} ${i.text}${i.meta.pseudo ? '    ; ' + i.meta.pseudo.text : ''}\n`);
      }
      return;
    }
    case 'decode': {
      const backend = requireTarget(o);
      const bytes = hexToBytes(o.positional.join(''));
      if (!bytes) fail('expected hexadecimal bytes, for example: decode -t riscv "93 08 20 00"');
      const decoded = decodeBytes(backend.profile.id, bytes);
      if (o.json || o.out) {
        emit(o, decoded);
        return;
      }
      for (const d of decoded) {
        process.stdout.write(`${hex(d.address)}  ${d.bytes.padEnd(32)} ${d.ok ? d.text + (d.alias ? `    ; ${d.alias}` : '') : `(${d.kind}) ${d.message}`}\n`);
        for (const f of d.fields ?? []) process.stdout.write(`      [${String(f.hi).padStart(2)}:${String(f.lo).padStart(2)}] ${f.name.padEnd(22)} ${f.value.toString(2).padStart(f.hi - f.lo + 1, '0').padEnd(22)} ${f.text}\n`);
        for (const f of d.byteFields ?? []) process.stdout.write(`      +${f.offset} (${f.length}) ${f.name.padEnd(14)} ${f.text}\n`);
      }
      return;
    }
    case 'batch': {
      const manifestPath = o.positional[0];
      if (!manifestPath) fail('missing manifest file');
      const { programs, backends } = readManifest(manifestPath, o);
      const limits = limitsOf(o);
      const results: unknown[] = [];
      // Comparisons by verdict, and programs that could not be run.
      const counts = { agree: 0, disagree: 0, incomplete: 0, error: 0 };
      for (const p of programs) {
        for (const args of p.args) {
          const cmp = compareTargets(p.text, args, backends, { limits, maxBoundaries: 100000 });
          if (!cmp.front.ok) {
            results.push({ program: p.name, args, error: cmp.front.diagnostics.map(formatDiagnostic) });
            counts.error++;
            continue;
          }
          const verdict = comparisonVerdict(cmp);
          counts[verdict]++;
          results.push({
            program: p.name, args, verdict, outcomesAgree: cmp.outcomesAgree, boundariesAgree: cmp.boundariesAgree,
            boundaries: comparedBoundaries(cmp.boundaries), limitReached: cmp.limitReached,
            runs: cmp.runs.map((r) => ({ target: r.target, outcome: r.outcome, metrics: r.metrics })),
          });
        }
      }
      emit(o, {
        schema: 'isa-trace-lab/batch-result', schemaVersion: SCHEMA_VERSION, tool: 'isa-trace-lab', version: VERSION,
        targets: backends.map((b) => b.profile.id), limits: { ...DEFAULT_LIMITS, ...limits }, counts, results,
      });
      process.exitCode = counts.disagree > 0 || counts.error > 0 ? 1 : counts.incomplete > 0 ? 3 : 0;
      return;
    }
    default:
      fail(`unknown command '${command}'; run 'isa-trace-lab help'`);
  }
}

main();
