/**
 * Headless API of ISA Trace Lab.
 *
 * Everything here is independent of the browser interface and runs unchanged
 * in Node.js, in a browser, and in a Web Worker. The interface, the command
 * line tool, and the experiment scripts all use these functions.
 *
 * Typical use:
 *
 *   import { compileProgram, simulate, traceProgram, compareTargets, availableBackends } from 'isa-trace-lab';
 *
 *   const result = compileProgram(source, 'riscv');
 *   if (result.ok) {
 *     const run = simulate(result.compiled, 'riscv', { args: [10] });
 *     const trace = traceProgram(result.compiled, 'riscv', { args: [10] });
 *   }
 */
import type { CompiledProgram } from './compile.ts';
import { compile, parameterNames } from './compile.ts';
import type { Outcome, RunLimits } from './exec.ts';
import { checkArguments } from './exec.ts';
import { assembleText } from './target/assemble.ts';
import type { AssembleTextResult } from './target/assemble.ts';
import { getBackend } from './target/index.ts';
import { Machine, loadCompiled } from './target/machine.ts';
import { LAYOUT } from './target/memory.ts';
import type { BitField, ByteField, TargetId } from './target/types.ts';
import type { CompiledProgramDocument, ExecutionTraceDocument, Metrics, TraceOptions } from './trace/documents.ts';
import { compiledProgramDocument, metricsOf, recordTrace } from './trace/documents.ts';
import type { Diagnostic } from './util/diag.ts';
import { bytesToHex } from './util/int32.ts';

export { VERSION, SCHEMA_VERSION, OPTIMIZATION_POLICY } from './version.ts';
export { BACKENDS, TARGET_ORDER, availableBackends, getBackend } from './target/index.ts';
export { check, LIMITS } from './lang/check.ts';
export { parse } from './lang/parser.ts';
export { dumpAst } from './lang/ast.ts';
export { evaluateReference } from './lang/reference.ts';
export { compile, compileFrontEnd, compileBackEnd, compileBackEnds, parameterNames } from './compile.ts';
export { buildIR } from './ir/build.ts';
export { verifyIR } from './ir/verify.ts';
export { interpretIR } from './ir/interp.ts';
export { formatIR, formatOp } from './ir/ir.ts';
export { assembleText, assembleItems } from './target/assemble.ts';
export { Machine, loadCompiled, newStepEvent } from './target/machine.ts';
export { LAYOUT, SERVICE, Memory } from './target/memory.ts';
export { crossCheck, crossCheckVerdict } from './trace/crosscheck.ts';
export { compareTargets, comparisonVerdict } from './trace/compare.ts';
export {
  compiledProgramDocument, metricsOf, recordTrace, sourceProgramDocument, targetConfiguration, traceStep,
} from './trace/documents.ts';
export { ArgumentCountError, DEFAULT_LIMITS, checkArguments, observable, sameOutcome, stoppedAtStepLimit, trapMessage } from './exec.ts';
export { formatDiagnostic } from './util/diag.ts';
export { generateProgram, FAMILIES, GENERATOR_VERSION } from './gen/programs.ts';
export type * from './target/types.ts';
export type * from './trace/documents.ts';
export type * from './trace/compare.ts';
export type { CrossCheck, EngineReport, MachineReport } from './trace/crosscheck.ts';
export type { CompiledProgram, FrontEnd, CompileResult } from './compile.ts';
export type { Outcome, RunLimits, RunStatus } from './exec.ts';
export type { Diagnostic } from './util/diag.ts';
export type { IRProgram } from './ir/ir.ts';

export type CompileProgramResult =
  | { ok: true; diagnostics: Diagnostic[]; compiled: CompiledProgram; document: CompiledProgramDocument }
  | { ok: false; diagnostics: Diagnostic[] };

/** Compile source text for a target and build the compiled-program document. */
export function compileProgram(source: string, target: TargetId | string): CompileProgramResult {
  const backend = getBackend(target);
  const r = compile(source, backend);
  if (!r.ok) return { ok: false, diagnostics: r.diagnostics };
  return { ok: true, diagnostics: r.diagnostics, compiled: r.compiled, document: compiledProgramDocument(backend, r.compiled) };
}

export interface SimulationResult {
  outcome: Outcome;
  metrics: Metrics;
  /** Final values of the source variables that were written. */
  variables: Record<string, number>;
  /** Final contents of the arrays whose definition has executed. */
  arrays: Record<string, number[]>;
}

/**
 * Run a compiled program on its target's simulator and report the outcome and
 * metrics. Throws ArgumentCountError unless `args` has one value per parameter
 * of main.
 */
export function simulate(
  compiled: CompiledProgram,
  target: TargetId | string = compiled.target,
  options: { args?: readonly number[]; limits?: Partial<RunLimits> } = {},
): SimulationResult {
  const backend = getBackend(target);
  checkArguments(parameterNames(compiled.ir), options.args ?? []);
  const m = loadCompiled(backend, compiled, options);
  const outcome = m.run();
  const variables: Record<string, number> = {};
  for (const v of compiled.variables) {
    if (v.hidden) continue;
    const value = m.reader.variable(v.name);
    if (value !== undefined) variables[v.name] = value;
  }
  const arrays: Record<string, number[]> = {};
  for (const a of compiled.arrays) {
    const values = m.reader.array(a.name);
    if (values !== undefined) arrays[a.name] = values.slice();
  }
  return { outcome, metrics: metricsOf(backend, compiled, m), variables, arrays };
}

/** Run a compiled program and record a trace document. Throws ArgumentCountError unless `args` has one value per parameter of main. */
export function traceProgram(compiled: CompiledProgram, target: TargetId | string = compiled.target, options: TraceOptions = {}): ExecutionTraceDocument {
  return recordTrace(getBackend(target), compiled, options);
}

/** Assemble a program written in a target's assembly syntax at the code base address. */
export function encodeAssembly(target: TargetId | string, text: string): AssembleTextResult {
  return assembleText(getBackend(target), text, LAYOUT.codeBase);
}

export interface DecodedInstruction {
  address: number;
  bytes: string;
  ok: boolean;
  /** Assembly text when decoded. */
  text?: string;
  alias?: string;
  fields?: BitField[];
  byteFields?: ByteField[];
  /** Failure kind and explanation when not decoded. */
  kind?: 'invalid' | 'unsupported' | 'truncated';
  message?: string;
}

/**
 * Decode consecutive instructions from a byte sequence located at `address`.
 * Decoding continues after an invalid or unsupported instruction of known
 * length and stops at a truncated one.
 */
export function decodeBytes(target: TargetId | string, bytes: Uint8Array, address: number = LAYOUT.codeBase): DecodedInstruction[] {
  const backend = getBackend(target);
  const out: DecodedInstruction[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const pc = address + offset;
    const d = backend.decode(bytes, offset, pc);
    const length = Math.max(1, Math.min(d.length, bytes.length - offset));
    const hex = bytesToHex(bytes.subarray(offset, offset + length), '');
    if (d.ok) {
      const item: DecodedInstruction = { address: pc, bytes: hex, ok: true, text: backend.format(d.insn), fields: d.fields };
      if (d.alias) item.alias = d.alias;
      if (d.byteFields) item.byteFields = d.byteFields;
      out.push(item);
    } else {
      out.push({ address: pc, bytes: hex, ok: false, kind: d.kind, message: d.message });
      if (d.kind === 'truncated') break;
    }
    offset += length;
  }
  return out;
}

/** Load raw code bytes into a new machine, for programs entered as assembly or as bytes. */
export function machineFromBytes(
  target: TargetId | string,
  code: Uint8Array,
  options: { entry?: number; args?: readonly number[]; limits?: Partial<RunLimits> } = {},
): Machine {
  return new Machine(getBackend(target), { code, entry: options.entry ?? LAYOUT.codeBase }, options);
}
