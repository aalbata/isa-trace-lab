/**
 * Compilation pipeline: source text, validated syntax tree, IR, target
 * instructions, and encoded bytes with their provenance.
 */
import { buildIR } from './ir/build.ts';
import type { IRProgram } from './ir/ir.ts';
import { verifyIR } from './ir/verify.ts';
import type { CheckedProgram } from './lang/check.ts';
import { check } from './lang/check.ts';
import { assembleItems } from './target/assemble.ts';
import { lowerProgram } from './target/lower.ts';
import { LAYOUT } from './target/memory.ts';
import type { AssembledProgram, Backend, FrameInfo, Home, TargetId } from './target/types.ts';
import { AsmError } from './target/types.ts';
import type { Diagnostic, Span } from './util/diag.ts';

export interface FrontEnd {
  ok: boolean;
  diagnostics: Diagnostic[];
  checked: CheckedProgram;
  /** Present when the program has no errors. */
  ir?: IRProgram;
}

export interface VariableHome {
  name: string;
  type: 'i32' | 'bool';
  hidden: boolean;
  home: Home;
  /** Offset from the stack pointer inside main, when the home is a stack slot. */
  slotOffset?: number;
}

export interface CompiledProgram {
  target: TargetId;
  source: string;
  ir: IRProgram;
  program: AssembledProgram;
  /** Initial contents of the data region, starting at its base address. */
  dataImage: Uint8Array;
  entry: number;
  frame: FrameInfo;
  variables: VariableHome[];
  arrays: { name: string; length: number; address: number }[];
  /** Source range of each IR operation, by operation identifier. */
  opSpans: Span[];
}

/** Parse, validate, and build the IR of a program. */
export function compileFrontEnd(source: string): FrontEnd {
  const checked = check(source);
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics, checked };
  const ir = buildIR(checked);
  const problems = verifyIR(ir);
  if (problems.length > 0) {
    const diagnostics: Diagnostic[] = [
      ...checked.diagnostics,
      ...problems.map((message): Diagnostic => ({ severity: 'error', category: 'internal', code: 'ir-verifier', message: `IR verifier: ${message}` })),
    ];
    return { ok: false, diagnostics, checked };
  }
  return { ok: true, diagnostics: checked.diagnostics, checked, ir };
}

/** Names of the parameters of main, in order. */
export function parameterNames(ir: IRProgram): string[] {
  return ir.params.map((id) => ir.vars[id]!.name);
}

/**
 * Lower the IR for every target and assemble it. Returns the compiled programs
 * in the order of `backends`, or the diagnostic of the first target whose code
 * does not fit the memory layout.
 */
export function compileBackEnds(
  source: string,
  ir: IRProgram,
  backends: readonly Backend[],
): { ok: true; compiled: CompiledProgram[] } | { ok: false; diagnostic: Diagnostic } {
  const compiled: CompiledProgram[] = [];
  for (const backend of backends) {
    try {
      compiled.push(compileBackEnd(source, ir, backend));
    } catch (e) {
      if (e instanceof AsmError) {
        return { ok: false, diagnostic: { severity: 'error', category: 'limit', code: 'assembler', message: `${backend.profile.id}: ${e.message}` } };
      }
      throw e;
    }
  }
  return { ok: true, compiled };
}

/** Lower the IR for one target and assemble it at the code base address. */
export function compileBackEnd(source: string, ir: IRProgram, backend: Backend): CompiledProgram {
  const lowered = lowerProgram(ir, backend);
  const program = assembleItems(lowered.items, backend, LAYOUT.codeBase);
  const total = ir.arrays.reduce((n, a) => n + 4 * a.length, 0);
  const dataImage = new Uint8Array(total);
  const view = new DataView(dataImage.buffer);
  for (const a of ir.arrays) a.image.forEach((v, i) => view.setInt32(a.offset + 4 * i, v, true));
  const opSpans: Span[] = new Array<Span>(ir.opCount);
  for (const b of ir.blocks) for (const op of [...b.ops, b.term]) opSpans[op.id] = op.span;
  const variables: VariableHome[] = ir.vars.map((v) => {
    const home = lowered.alloc.vars[v.id]!;
    const out: VariableHome = { name: v.name, type: v.type, hidden: v.hidden, home };
    if (home.kind === 'slot') out.slotOffset = lowered.frame.slotOffsets[home.index]!;
    return out;
  });
  return {
    target: backend.profile.id,
    source,
    ir,
    program,
    dataImage,
    entry: program.symbols['_start']!,
    frame: lowered.frame,
    variables,
    arrays: ir.arrays.map((a) => ({ name: a.name, length: a.length, address: LAYOUT.dataBase + a.offset })),
    opSpans,
  };
}

export type CompileResult =
  | { ok: true; diagnostics: Diagnostic[]; front: FrontEnd; compiled: CompiledProgram }
  | { ok: false; diagnostics: Diagnostic[]; front: FrontEnd };

/** Compile source text for one target. */
export function compile(source: string, backend: Backend): CompileResult {
  const front = compileFrontEnd(source);
  if (!front.ok || !front.ir) return { ok: false, diagnostics: front.diagnostics, front };
  try {
    return { ok: true, diagnostics: front.diagnostics, front, compiled: compileBackEnd(source, front.ir, backend) };
  } catch (e) {
    if (e instanceof AsmError) {
      const d: Diagnostic = { severity: 'error', category: 'limit', code: 'assembler', message: e.message };
      return { ok: false, diagnostics: [...front.diagnostics, d], front };
    }
    throw e;
  }
}
