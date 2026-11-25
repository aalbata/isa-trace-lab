/**
 * Versioned JSON documents: source program, target configuration, compiled
 * program with its source mappings, and execution trace. The matching JSON
 * Schema files are in `schemas/`. Register and memory values are hexadecimal
 * strings with a `0x` prefix, eight digits for 32-bit registers and sixteen
 * for 64-bit registers, so that wide values survive JSON exactly. Code
 * addresses are integers; a branch target with nonzero upper 32 bits is given
 * in full as a second field in the same hexadecimal form.
 */
import type { CompiledProgram } from '../compile.ts';
import { parameterNames } from '../compile.ts';
import type { Outcome, RunLimits } from '../exec.ts';
import { DEFAULT_LIMITS, checkArguments } from '../exec.ts';
import { formatOp } from '../ir/ir.ts';
import type { Machine } from '../target/machine.ts';
import { loadCompiled, newStepEvent } from '../target/machine.ts';
import { LAYOUT } from '../target/memory.ts';
import type { Backend, CodeRegion, StepEvent, TargetId } from '../target/types.ts';
import { bytesToHex } from '../util/int32.ts';
import { sha256, sha256Text } from '../util/sha256.ts';
import { OPTIMIZATION_POLICY, SCHEMA_VERSION, VERSION } from '../version.ts';

const SOFTWARE = { name: 'isa-trace-lab', version: VERSION } as const;

export interface SourceProgramDocument {
  schema: 'isa-trace-lab/source-program';
  schemaVersion: string;
  name: string;
  source: string;
  /** Arguments of main, signed 32-bit integers. */
  args: number[];
}

export interface TargetConfigurationDocument {
  schema: 'isa-trace-lab/target-configuration';
  schemaVersion: string;
  target: TargetId;
  isa: string;
  codeBase: number;
  dataBase: number;
  stackTop: number;
  optimization: string;
  limits: RunLimits;
}

export interface SpanJson {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface CompiledProgramDocument {
  schema: 'isa-trace-lab/compiled-program';
  schemaVersion: string;
  software: { name: string; version: string };
  configuration: TargetConfigurationDocument;
  source: { text: string; sha256: string };
  code: { base: number; bytes: string; sha256: string };
  data: { base: number; bytes: string };
  entry: number;
  symbols: Record<string, number>;
  instructions: {
    address: number;
    bytes: string;
    text: string;
    /** Pseudoinstruction or alias that the instruction expands, with its position in the expansion. */
    pseudo?: { text: string; index: number; count: number };
    region: CodeRegion;
    /** IR operations implemented by the instruction. */
    ir: number[];
    /** Source lines of those operations; empty for runtime support code. */
    lines: number[];
    note?: string;
    labels: string[];
  }[];
  ir: {
    blocks: { id: number; label: string; ops: number[] }[];
    ops: { id: number; block: number; text: string; statement: number; node: number; span: SpanJson }[];
  };
  statements: { id: number; kind: string; span: SpanJson }[];
  /** Addresses at which a statement boundary fires, with the statements in firing order. */
  boundaries: { address: number; statements: number[] }[];
  variables: { name: string; type: string; hidden: boolean; home: { register: string } | { stackOffset: number } }[];
  arrays: { name: string; length: number; address: number }[];
}

export interface Metrics {
  /** Instructions in the program image, in total and per part of the image. */
  staticInstructions: number;
  staticInstructionsByRegion: Record<CodeRegion, number>;
  /** Size of the encoded program in bytes. */
  codeBytes: number;
  codeBytesByRegion: Record<CodeRegion, number>;
  /** Instructions executed, in total and per part of the image. */
  executedInstructions: number;
  executedByRegion: Record<CodeRegion | 'unknown', number>;
  /** Loads and stores executed on the data and stack regions (instruction fetches excluded). */
  dataLoads: number;
  dataStores: number;
  /** Registers written at least once, by the loader's argument setup or by an executed instruction. */
  registersWritten: number;
  boundaries: number;
}

/**
 * Record of one executed instruction. The record has no field for the address
 * of the next instruction (`nextPc` and `nextPc64` of the step event): within
 * 32 bits that address is the `pc` of the following record. After a taken
 * branch it is the target in `branch`, except on MIPS, where the following
 * record is the delay-slot instruction at `pc` + 4. Above 32 bits the `pc` holds
 * only the low 32 bits and `branch.target64` holds the full target.
 */
export interface TraceStep {
  index: number;
  pc: number;
  bytes: string;
  text: string;
  class: string;
  regWrites: { reg: string; value: string }[];
  memReads: { address: number; size: number; value: string }[];
  memWrites: { address: number; size: number; value: string }[];
  flags?: Record<string, number>;
  /**
   * `target64` is the full target address as sixteen hexadecimal digits,
   * present only when its upper 32 bits are not zero; `target` then holds the
   * low 32 bits.
   */
  branch?: { conditional: boolean; taken: boolean; target: number; target64?: string };
  delaySlot?: boolean;
  service?: { number: number; name: string; argument: number };
  /** Ordinals of the boundaries that fired when this instruction was fetched. */
  boundaries?: number[];
  /** Reason the machine stopped at this instruction, when it faulted. */
  fault?: string;
}

export interface TraceBoundary {
  /** Zero-based position in the boundary sequence of the run. */
  ordinal: number;
  statement: number;
  /** How many times this statement's boundary had fired before. */
  occurrence: number;
  line: number;
  /** Number of instructions executed before the boundary. */
  step: number;
  /** Values of the source variables that have been written, as signed integers. */
  variables: Record<string, number>;
  outputLength: number;
}

export interface ExecutionTraceDocument {
  schema: 'isa-trace-lab/execution-trace';
  schemaVersion: string;
  software: { name: string; version: string };
  configuration: TargetConfigurationDocument;
  program: { sourceSha256: string; codeSha256: string };
  args: number[];
  outcome: Outcome;
  metrics: Metrics;
  /**
   * True when the run executed more instructions, or fired more boundaries,
   * than the trace keeps records of; compare `steps` and `boundaries` with
   * `metrics.executedInstructions` and `metrics.boundaries`.
   */
  truncated: boolean;
  steps: TraceStep[];
  boundaries: TraceBoundary[];
  /** Contents at the end of the run of the arrays whose definition has executed. */
  finalArrays: Record<string, number[]>;
}

function spanJson(s: { start: { line: number; col: number }; end: { line: number; col: number } }): SpanJson {
  return { startLine: s.start.line, startColumn: s.start.col + 1, endLine: s.end.line, endColumn: s.end.col + 1 };
}

export function sourceProgramDocument(name: string, source: string, args: readonly number[] = []): SourceProgramDocument {
  return { schema: 'isa-trace-lab/source-program', schemaVersion: SCHEMA_VERSION, name, source, args: args.map((a) => a | 0) };
}

export function targetConfiguration(backend: Backend, limits: Partial<RunLimits> = {}): TargetConfigurationDocument {
  return {
    schema: 'isa-trace-lab/target-configuration',
    schemaVersion: SCHEMA_VERSION,
    target: backend.profile.id,
    isa: backend.profile.isa,
    codeBase: LAYOUT.codeBase,
    dataBase: LAYOUT.dataBase,
    stackTop: LAYOUT.stackTop,
    optimization: OPTIMIZATION_POLICY,
    limits: { ...DEFAULT_LIMITS, ...limits },
  };
}

export function compiledProgramDocument(backend: Backend, c: CompiledProgram, limits: Partial<RunLimits> = {}): CompiledProgramDocument {
  const p = c.program;
  const lineOf = (op: number): number => c.opSpans[op]!.start.line;
  const ops: CompiledProgramDocument['ir']['ops'] = [];
  for (const b of c.ir.blocks) {
    for (const op of [...b.ops, b.term]) {
      ops.push({ id: op.id, block: b.id, text: formatOp(c.ir, op), statement: op.stmt, node: op.node, span: spanJson(op.span) });
    }
  }
  return {
    schema: 'isa-trace-lab/compiled-program',
    schemaVersion: SCHEMA_VERSION,
    software: { ...SOFTWARE },
    configuration: targetConfiguration(backend, limits),
    source: { text: c.source, sha256: sha256Text(c.source) },
    code: { base: p.base, bytes: bytesToHex(p.bytes, ''), sha256: sha256(p.bytes) },
    data: { base: LAYOUT.dataBase, bytes: bytesToHex(c.dataImage, '') },
    entry: c.entry,
    symbols: { ...p.symbols },
    instructions: p.insns.map((i) => {
      const lines = [...new Set(i.meta.irOps.map(lineOf))].sort((a, b) => a - b);
      const out: CompiledProgramDocument['instructions'][number] = {
        address: i.address,
        bytes: bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + i.length), ''),
        text: i.text,
        region: i.meta.region,
        ir: i.meta.irOps.slice(),
        lines,
        labels: i.labels.slice(),
      };
      if (i.meta.pseudo) out.pseudo = { ...i.meta.pseudo };
      if (i.meta.note) out.note = i.meta.note;
      return out;
    }),
    ir: { blocks: c.ir.blocks.map((b) => ({ id: b.id, label: b.label, ops: [...b.ops.map((o) => o.id), b.term.id] })), ops },
    statements: Object.values(c.ir.stmts).map((s) => ({ id: s.id, kind: s.kind, span: spanJson(s.span) })),
    boundaries: p.boundaries.map((k) => ({ address: k.address, statements: k.stmts.slice() })),
    variables: c.variables.map((v) => ({
      name: v.name, type: v.type, hidden: v.hidden,
      home: v.home.kind === 'reg' ? { register: v.home.reg } : { stackOffset: v.slotOffset ?? 0 },
    })),
    arrays: c.arrays.map((a) => ({ ...a })),
  };
}

/** Static and dynamic measures of a machine that has run a compiled program. */
export function metricsOf(backend: Backend, c: CompiledProgram, m: Machine): Metrics {
  const staticByRegion: Record<CodeRegion, number> = { startup: 0, main: 0, helper: 0, trap: 0 };
  const bytesByRegion: Record<CodeRegion, number> = { startup: 0, main: 0, helper: 0, trap: 0 };
  let staticInstructions = 0;
  for (const i of c.program.insns) {
    bytesByRegion[i.meta.region] += i.length;
    if (i.insn !== null) {
      staticByRegion[i.meta.region]++;
      staticInstructions++;
    }
  }
  return {
    staticInstructions,
    staticInstructionsByRegion: staticByRegion,
    codeBytes: c.program.bytes.length,
    codeBytesByRegion: bytesByRegion,
    executedInstructions: m.executed,
    executedByRegion: { ...m.regionCounts },
    dataLoads: m.mem.loads,
    dataStores: m.mem.stores,
    registersWritten: backend.profile.registers.filter((r) => m.cpu.wasWritten(r.name)).length,
    boundaries: m.boundaryCount,
  };
}

function hexValue(v: bigint, bits: number): string {
  return '0x' + BigInt.asUintN(bits, v).toString(16).padStart(bits / 4, '0');
}

export function traceStep(backend: Backend, ev: StepEvent, firstBoundary: number): TraceStep {
  const bits = backend.profile.registerBits;
  const step: TraceStep = {
    index: ev.index,
    pc: ev.pc,
    bytes: bytesToHex(ev.bytes, ''),
    text: ev.text,
    class: ev.klass,
    regWrites: ev.regWrites.map((w) => ({ reg: w.reg, value: hexValue(w.value, bits) })),
    memReads: ev.memReads.map((r) => ({ address: r.address, size: r.size, value: hexValue(r.value, 8 * r.size) })),
    memWrites: ev.memWrites.map((w) => ({ address: w.address, size: w.size, value: hexValue(w.value, 8 * w.size) })),
  };
  if (ev.flags) step.flags = { ...ev.flags.after };
  if (ev.branch) {
    const { target64, ...branch } = ev.branch;
    step.branch = target64 === undefined ? branch : { ...branch, target64: hexValue(target64, 64) };
  }
  if (ev.delaySlot) step.delaySlot = true;
  if (ev.service) step.service = { ...ev.service };
  if (ev.boundaries && ev.boundaries.length > 0) step.boundaries = ev.boundaries.map((_, k) => firstBoundary + k);
  if (ev.stop?.kind === 'fault') step.fault = ev.stop.message;
  return step;
}

export interface TraceOptions {
  args?: readonly number[];
  limits?: Partial<RunLimits>;
  /** Maximum number of instruction records kept; later instructions are executed but not recorded. */
  maxTraceSteps?: number;
  /** Maximum number of boundary records kept. */
  maxBoundaries?: number;
}

/**
 * Run a compiled program and record its execution as a trace document.
 * Throws ArgumentCountError unless `args` has one value per parameter of main.
 */
export function recordTrace(backend: Backend, c: CompiledProgram, options: TraceOptions = {}): ExecutionTraceDocument {
  checkArguments(parameterNames(c.ir), options.args ?? []);
  const args = (options.args ?? []).map((a) => a | 0);
  const maxSteps = options.maxTraceSteps ?? 100_000;
  const maxBoundaries = options.maxBoundaries ?? 100_000;
  const m = loadCompiled(backend, c, { args, limits: options.limits });
  const steps: TraceStep[] = [];
  const boundaries: TraceBoundary[] = [];
  const occurrences = new Map<number, number>();
  const visible = c.variables.filter((v) => !v.hidden);
  let ordinal = 0;
  m.onBoundary = (stmt, state) => {
    const occurrence = occurrences.get(stmt) ?? 0;
    occurrences.set(stmt, occurrence + 1);
    const index = ordinal++;
    if (boundaries.length >= maxBoundaries) return;
    const variables: Record<string, number> = {};
    for (const v of visible) {
      const value = state.variable(v.name);
      if (value !== undefined) variables[v.name] = value;
    }
    boundaries.push({
      ordinal: index, statement: stmt, occurrence, line: c.ir.stmts[stmt]?.span.start.line ?? 0, step: m.executed, variables,
      outputLength: state.outputLength(),
    });
  };
  for (;;) {
    if (steps.length < maxSteps) {
      const ev = newStepEvent(m.executed);
      const before = ordinal;
      const more = m.step(ev);
      if (ev.length > 0 || ev.stop) steps.push(traceStep(backend, ev, before));
      if (!more) break;
    } else if (!m.step()) break;
  }
  // An array whose definition has not executed by the end of the run has no contents to record.
  const finalArrays: Record<string, number[]> = {};
  for (const a of c.arrays) {
    const values = m.reader.array(a.name);
    if (values !== undefined) finalArrays[a.name] = values.slice();
  }
  return {
    schema: 'isa-trace-lab/execution-trace',
    schemaVersion: SCHEMA_VERSION,
    software: { ...SOFTWARE },
    configuration: targetConfiguration(backend, options.limits),
    program: { sourceSha256: sha256Text(c.source), codeSha256: sha256(c.program.bytes) },
    args,
    outcome: m.outcome(),
    metrics: metricsOf(backend, c, m),
    truncated: m.executed > steps.length || ordinal > boundaries.length,
    steps,
    boundaries,
    finalArrays,
  };
}
