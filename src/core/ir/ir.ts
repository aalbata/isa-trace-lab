/**
 * Intermediate representation shared by all backends.
 *
 * A program is one function made of basic blocks. Each block holds a list of
 * operations and ends in exactly one terminator. Values are 32-bit integers
 * (`i32`) or Booleans (`bool`, stored as 0 or 1). Operands are constants,
 * named variables (mutable, with a home chosen by the backend), or temporaries
 * (defined exactly once). Array bounds checks and shift-count checks are
 * explicit conditional branches to trap blocks, so every backend lowers the
 * same checks. Every operation records the syntax-tree node and source range
 * it was generated from and the statement it belongs to.
 */
import type { Span } from '../util/diag.ts';

export type IRType = 'i32' | 'bool';

export type Operand =
  | { k: 'temp'; id: number }
  | { k: 'var'; id: number }
  | { k: 'const'; value: number };

export type Dest = { k: 'temp'; id: number } | { k: 'var'; id: number };

/** add, sub, mul wrap modulo 2^32; shl and sar require a count in [0, 31]. */
export type BinFn = 'add' | 'sub' | 'mul' | 'and' | 'or' | 'xor' | 'shl' | 'sar';
/** neg: two's-complement negation; not: bitwise complement; lnot: Boolean negation. */
export type UnFn = 'neg' | 'not' | 'lnot';
/** Signed predicates and the unsigned predicates used by range checks and loop control. */
export type Pred = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'ltu' | 'leu' | 'gtu' | 'geu';

interface OpBase {
  /** Stable identifier, unique within the program, assigned in layout order. */
  id: number;
  /** Identifier of the syntax-tree node that produced the operation. */
  node: number;
  span: Span;
  /** Identifier of the enclosing statement node. */
  stmt: number;
}

export type IROp =
  /** Boundary marker: the statement `stmt` is about to execute. Emits no machine code. */
  | (OpBase & { op: 'mark' })
  | (OpBase & { op: 'copy'; dst: Dest; src: Operand })
  | (OpBase & { op: 'un'; fn: UnFn; dst: Dest; a: Operand })
  | (OpBase & { op: 'bin'; fn: BinFn; dst: Dest; a: Operand; b: Operand })
  /** dst = 1 when the predicate holds, else 0. */
  | (OpBase & { op: 'cmp'; pred: Pred; dst: Dest; a: Operand; b: Operand })
  /** dst = array[index]; the index has been range-checked by a preceding branch. */
  | (OpBase & { op: 'load'; dst: Dest; array: number; index: Operand })
  | (OpBase & { op: 'store'; array: number; index: Operand; value: Operand })
  /** Write one signed integer through the output service. */
  | (OpBase & { op: 'print'; a: Operand });

export type IRTerm =
  | (OpBase & { op: 'jump'; target: number })
  | (OpBase & { op: 'br'; pred: Pred; a: Operand; b: Operand; then: number; else: number })
  | (OpBase & { op: 'ret'; a: Operand })
  /** End the program with a runtime error code. */
  | (OpBase & { op: 'trap'; code: number });

export interface IRBlock {
  /** Index of the block in layout order; block 0 is the entry. */
  id: number;
  label: string;
  ops: IROp[];
  term: IRTerm;
}

export interface IRVar {
  id: number;
  name: string;
  type: IRType;
  isParam: boolean;
  /** Compiler-created variable (loop counter, loop bound, fill value). */
  hidden: boolean;
}

export interface IRArray {
  id: number;
  name: string;
  length: number;
  /** Byte offset of element 0 from the start of the data region. */
  offset: number;
  /** Initial contents of the data image (signed 32-bit values). */
  image: number[];
  /** Statement that defines the array; the array exists once this statement has executed. */
  defStmt: number;
}

export interface IRStmtInfo {
  id: number;
  kind: string;
  span: Span;
}

export interface IRProgram {
  name: string;
  /** Variable identifiers of the parameters, in order. */
  params: number[];
  vars: IRVar[];
  /** Type of each temporary, indexed by temporary identifier. */
  temps: IRType[];
  arrays: IRArray[];
  blocks: IRBlock[];
  /** Statements that own a boundary marker, by statement identifier. */
  stmts: Record<number, IRStmtInfo>;
  /** Total number of operations and terminators; identifiers are 0 .. opCount - 1. */
  opCount: number;
}

export const PRED_SYMBOL: Record<Pred, string> = {
  eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=', ltu: '<u', leu: '<=u', gtu: '>u', geu: '>=u',
};

export function negatePred(p: Pred): Pred {
  switch (p) {
    case 'eq': return 'ne';
    case 'ne': return 'eq';
    case 'lt': return 'ge';
    case 'ge': return 'lt';
    case 'gt': return 'le';
    case 'le': return 'gt';
    case 'ltu': return 'geu';
    case 'geu': return 'ltu';
    case 'gtu': return 'leu';
    case 'leu': return 'gtu';
  }
}

/** The predicate q such that (a p b) equals (b q a). */
export function swapPred(p: Pred): Pred {
  switch (p) {
    case 'eq': return 'eq';
    case 'ne': return 'ne';
    case 'lt': return 'gt';
    case 'gt': return 'lt';
    case 'le': return 'ge';
    case 'ge': return 'le';
    case 'ltu': return 'gtu';
    case 'gtu': return 'ltu';
    case 'leu': return 'geu';
    case 'geu': return 'leu';
  }
}

export function evalPred(p: Pred, a: number, b: number): boolean {
  switch (p) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'lt': return a < b;
    case 'le': return a <= b;
    case 'gt': return a > b;
    case 'ge': return a >= b;
    case 'ltu': return a >>> 0 < b >>> 0;
    case 'leu': return a >>> 0 <= b >>> 0;
    case 'gtu': return a >>> 0 > b >>> 0;
    case 'geu': return a >>> 0 >= b >>> 0;
  }
}

export function formatOperand(p: IRProgram, o: Operand | Dest): string {
  switch (o.k) {
    case 'temp':
      return `%t${o.id}`;
    case 'var':
      return p.vars[o.id]!.name;
    case 'const':
      return String(o.value);
  }
}

export function formatOp(p: IRProgram, op: IROp | IRTerm): string {
  const f = (o: Operand | Dest): string => formatOperand(p, o);
  switch (op.op) {
    case 'mark':
      return `mark s${op.stmt}`;
    case 'copy':
      return `${f(op.dst)} = ${f(op.src)}`;
    case 'un':
      return `${f(op.dst)} = ${op.fn} ${f(op.a)}`;
    case 'bin':
      return `${f(op.dst)} = ${op.fn} ${f(op.a)}, ${f(op.b)}`;
    case 'cmp':
      return `${f(op.dst)} = cmp ${op.pred} ${f(op.a)}, ${f(op.b)}`;
    case 'load':
      return `${f(op.dst)} = load ${p.arrays[op.array]!.name}[${f(op.index)}]`;
    case 'store':
      return `store ${p.arrays[op.array]!.name}[${f(op.index)}] = ${f(op.value)}`;
    case 'print':
      return `print ${f(op.a)}`;
    case 'jump':
      return `jump b${op.target}`;
    case 'br':
      return `br ${op.pred} ${f(op.a)}, ${f(op.b)} ? b${op.then} : b${op.else}`;
    case 'ret':
      return `ret ${f(op.a)}`;
    case 'trap':
      return `trap ${op.code}`;
  }
}

/** Textual form of a program, one operation per line, with source line annotations. */
export function formatIR(p: IRProgram): string {
  const lines: string[] = [];
  const params = p.params.map((id) => `${p.vars[id]!.name}: i32`).join(', ');
  lines.push(`func ${p.name}(${params}) -> i32`);
  for (const v of p.vars) {
    if (!v.isParam) lines.push(`  var ${v.name}: ${v.type}${v.hidden ? '  ; compiler-created' : ''}`);
  }
  for (const a of p.arrays) lines.push(`  array ${a.name}[${a.length}] at data+${a.offset}`);
  for (const b of p.blocks) {
    lines.push(`b${b.id}:${b.label ? '  ; ' + b.label : ''}`);
    for (const op of [...b.ops, b.term]) {
      lines.push(`  ${formatOp(p, op).padEnd(36)} ; line ${op.span.start.line}`);
    }
  }
  return lines.join('\n');
}

export function successors(t: IRTerm): number[] {
  if (t.op === 'jump') return [t.target];
  if (t.op === 'br') return t.then === t.else ? [t.then] : [t.then, t.else];
  return [];
}
