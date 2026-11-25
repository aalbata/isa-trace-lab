/**
 * Reference evaluator for the source language.
 *
 * The evaluator walks the validated syntax tree directly and is independent
 * of the IR and of every backend. Each arithmetic operation computes the exact
 * mathematical result with BigInt and then reduces it modulo 2^32 to the
 * signed interpretation, which is the definition of the language semantics.
 */
import type { BoundaryObserver, Outcome, RunLimits, StateReader } from '../exec.ts';
import { DEFAULT_LIMITS, TRAP_INDEX, TRAP_SHIFT, checkArguments, trapMessage } from '../exec.ts';
import type { Expr, Stmt } from './ast.ts';
import type { CheckedProgram } from './check.ts';
import { literalInt } from './check.ts';

export interface ReferenceOutcome extends Outcome {
  /**
   * True when no exact intermediate result left the signed 32-bit range, no
   * literal outside a range step was 2^31 or larger, the exact value of every
   * executed range step lay in the signed 32-bit range, and no runtime error
   * occurred. Under these conditions the program has the same output under
   * ordinary Python integers.
   */
  pythonCoincident: boolean;
  /** True when main finished without returning a value (Python returns None; the language reports 0). */
  implicitReturn: boolean;
  /** Final values of the assigned variables. */
  finalVars: Record<string, number>;
  finalArrays: Record<string, number[]>;
}

const MIN = -2147483648n;
const MAX = 2147483647n;

class Trap {
  code: number;
  line: number;
  constructor(code: number, line: number) {
    this.code = code;
    this.line = line;
  }
}
class LimitReached {
  kind: 'steps' | 'output';
  constructor(kind: 'steps' | 'output') {
    this.kind = kind;
  }
}

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

/**
 * Evaluate a validated program. Throws ArgumentCountError unless `args` holds
 * one value per parameter of main; each value is reduced to 32 bits.
 */
export function evaluateReference(
  prog: CheckedProgram,
  args: readonly number[] = [],
  options: { limits?: Partial<RunLimits>; onBoundary?: BoundaryObserver } = {},
): ReferenceOutcome {
  if (!prog.ok || !prog.main) throw new Error('evaluateReference requires a program without errors');
  checkArguments(prog.main.params.map((p) => p.name), args);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const onBoundary = options.onBoundary;
  const ints = new Map<string, bigint>();
  const bools = new Map<string, boolean>();
  const arrays = new Map<string, bigint[]>();
  const output: number[] = [];
  let steps = 0;
  let coincident = true;
  let returnValue = 0n;
  let implicitReturn = true;

  const reader: StateReader = {
    variable(name) {
      const i = ints.get(name);
      if (i !== undefined) return Number(i);
      const b = bools.get(name);
      return b === undefined ? undefined : b ? 1 : 0;
    },
    array(name) {
      return arrays.get(name)?.map(Number);
    },
    outputLength: () => output.length,
  };

  const wrap = (z: bigint): bigint => {
    if (z < MIN || z > MAX) {
      coincident = false;
      return BigInt.asIntN(32, z);
    }
    return z;
  };

  const boundary = (s: Stmt): void => {
    steps++;
    if (steps > limits.maxSteps) throw new LimitReached('steps');
    if (onBoundary) onBoundary(s.id, reader);
  };

  const evalInt = (e: Expr): bigint => {
    switch (e.kind) {
      case 'Constant':
        return wrap(e.value);
      case 'Name':
        return ints.get(e.name)!;
      case 'UnaryOp': {
        const v = evalInt(e.operand);
        if (e.op === 'USub') return wrap(-v);
        if (e.op === 'Invert') return wrap(-v - 1n);
        return v;
      }
      case 'BinOp': {
        const a = evalInt(e.left);
        const b = evalInt(e.right);
        switch (e.op) {
          case 'Add': return wrap(a + b);
          case 'Sub': return wrap(a - b);
          case 'Mult': return wrap(a * b);
          case 'BitAnd': return wrap(a & b);
          case 'BitOr': return wrap(a | b);
          case 'BitXor': return wrap(a ^ b);
          case 'LShift':
            if (b < 0n || b > 31n) throw new Trap(TRAP_SHIFT, e.span.start.line);
            return wrap(a * (1n << b));
          case 'RShift':
            if (b < 0n || b > 31n) throw new Trap(TRAP_SHIFT, e.span.start.line);
            return wrap(a >> b);
          default:
            throw new Error(`unsupported operator ${e.op}`);
        }
      }
      case 'Call':
        // len(array)
        return BigInt(arrays.get((e.args[0] as { name: string }).name)!.length);
      case 'Subscript': {
        const arr = arrays.get((e.value as { name: string }).name)!;
        const idx = evalInt(e.index);
        if (idx < 0n || idx >= BigInt(arr.length)) throw new Trap(TRAP_INDEX, e.span.start.line);
        return arr[Number(idx)]!;
      }
      default:
        throw new Error(`unexpected integer expression ${e.kind}`);
    }
  };

  const evalBool = (e: Expr): boolean => {
    switch (e.kind) {
      case 'Constant':
        return e.value === 1n;
      case 'Name':
        return bools.get(e.name)!;
      case 'UnaryOp':
        return !evalBool(e.operand);
      case 'BoolOp':
        if (e.op === 'And') {
          for (const v of e.values) if (!evalBool(v)) return false;
          return true;
        }
        for (const v of e.values) if (evalBool(v)) return true;
        return false;
      case 'Compare': {
        const a = evalInt(e.left);
        const b = evalInt(e.comparators[0]!);
        switch (e.ops[0]) {
          case 'Eq': return a === b;
          case 'NotEq': return a !== b;
          case 'Lt': return a < b;
          case 'LtE': return a <= b;
          case 'Gt': return a > b;
          case 'GtE': return a >= b;
          default: throw new Error('unsupported comparison');
        }
      }
      default:
        throw new Error(`unexpected Boolean expression ${e.kind}`);
    }
  };

  const apply = (op: string, a: bigint, b: bigint, line: number): bigint => {
    switch (op) {
      case 'Add': return wrap(a + b);
      case 'Sub': return wrap(a - b);
      case 'Mult': return wrap(a * b);
      case 'BitAnd': return wrap(a & b);
      case 'BitOr': return wrap(a | b);
      case 'BitXor': return wrap(a ^ b);
      case 'LShift':
        if (b < 0n || b > 31n) throw new Trap(TRAP_SHIFT, line);
        return wrap(a * (1n << b));
      case 'RShift':
        if (b < 0n || b > 31n) throw new Trap(TRAP_SHIFT, line);
        return wrap(a >> b);
      default:
        throw new Error(`unsupported operator ${op}`);
    }
  };

  const execBlock = (stmts: Stmt[]): number => {
    for (const s of stmts) {
      const c = exec(s);
      if (c !== NORMAL) return c;
    }
    return NORMAL;
  };

  const exec = (s: Stmt): number => {
    switch (s.kind) {
      case 'Pass':
        boundary(s);
        return NORMAL;
      case 'Break':
        boundary(s);
        return BREAK;
      case 'Continue':
        boundary(s);
        return CONTINUE;
      case 'Return':
        boundary(s);
        if (s.value) {
          returnValue = evalInt(s.value);
          implicitReturn = false;
        } else returnValue = 0n;
        return RETURN;
      case 'Expr': {
        boundary(s);
        const call = s.value as Extract<Expr, { kind: 'Call' }>;
        const v = evalInt(call.args[0]!);
        if (output.length >= limits.maxOutput) throw new LimitReached('output');
        output.push(Number(v));
        return NORMAL;
      }
      case 'Assign': {
        boundary(s);
        const def = prog.arrayDefs.get(s.id);
        if (def) {
          let values: bigint[];
          if (s.value.kind === 'List') values = s.value.elts.map(evalInt);
          else {
            const rep = s.value as Extract<Expr, { kind: 'BinOp' }>;
            const v = evalInt((rep.left as Extract<Expr, { kind: 'List' }>).elts[0]!);
            values = new Array<bigint>(def.length).fill(v);
          }
          arrays.set(def.name, values);
          return NORMAL;
        }
        if (s.target.kind === 'Subscript') {
          // Python evaluates the right-hand side before the subscript of the target.
          const v = evalInt(s.value);
          const arr = arrays.get((s.target.value as { name: string }).name)!;
          const idx = evalInt(s.target.index);
          if (idx < 0n || idx >= BigInt(arr.length)) throw new Trap(TRAP_INDEX, s.target.span.start.line);
          arr[Number(idx)] = v;
          return NORMAL;
        }
        const name = (s.target as { name: string }).name;
        if (prog.exprType.get(s.value.id) === 'bool') bools.set(name, evalBool(s.value));
        else ints.set(name, evalInt(s.value));
        return NORMAL;
      }
      case 'AugAssign': {
        boundary(s);
        if (s.target.kind === 'Subscript') {
          const arr = arrays.get((s.target.value as { name: string }).name)!;
          const idx = evalInt(s.target.index);
          if (idx < 0n || idx >= BigInt(arr.length)) throw new Trap(TRAP_INDEX, s.target.span.start.line);
          const old = arr[Number(idx)]!;
          const rhs = evalInt(s.value);
          arr[Number(idx)] = apply(s.op, old, rhs, s.span.start.line);
          return NORMAL;
        }
        const name = (s.target as { name: string }).name;
        const old = ints.get(name)!;
        const rhs = evalInt(s.value);
        ints.set(name, apply(s.op, old, rhs, s.span.start.line));
        return NORMAL;
      }
      case 'If': {
        // An elif clause is an if statement in the else branch of the clause before it; a chain is followed
        // in a loop, so that a long chain does not deepen the recursion.
        let clause = s;
        for (;;) {
          boundary(clause);
          if (evalBool(clause.test)) return execBlock(clause.body);
          const next = clause.orelse.length === 1 ? clause.orelse[0]! : null;
          if (next?.kind !== 'If') return execBlock(clause.orelse);
          clause = next;
        }
      }
      case 'While':
        for (;;) {
          boundary(s);
          if (!evalBool(s.test)) return NORMAL;
          const c = execBlock(s.body);
          if (c === BREAK) return NORMAL;
          if (c === RETURN) return RETURN;
        }
      case 'For': {
        boundary(s);
        const info = prog.forInfo.get(s.id)!;
        const start = info.start ? evalInt(info.start) : 0n;
        const stop = evalInt(info.stop);
        const step = BigInt(info.step);
        // Python steps by the exact value of the literal, the language by its 32-bit value.
        const stepArg = (s.iter as Extract<Expr, { kind: 'Call' }>).args[2];
        if (stepArg && literalInt(stepArg)! !== step) coincident = false;
        const name = (s.target as { name: string }).name;
        // The counter is an exact integer, so the iteration matches Python's range for every 32-bit bound.
        for (let i = start; step > 0n ? i < stop : i > stop; i += step) {
          ints.set(name, i);
          const c = execBlock(s.body);
          if (c === BREAK) return NORMAL;
          if (c === RETURN) return RETURN;
          boundary(s);
        }
        return NORMAL;
      }
      default:
        throw new Error(`unexpected statement ${s.kind}`);
    }
  };

  const finish = (base: Outcome): ReferenceOutcome => {
    const finalVars: Record<string, number> = {};
    for (const [k, v] of ints) finalVars[k] = Number(v);
    for (const [k, v] of bools) finalVars[k] = v ? 1 : 0;
    const finalArrays: Record<string, number[]> = {};
    for (const [k, v] of arrays) finalArrays[k] = v.map(Number);
    return { ...base, pythonCoincident: coincident && base.status === 'exited', implicitReturn, finalVars, finalArrays };
  };

  const main = prog.main;
  main.params.forEach((p, i) => ints.set(p.name, BigInt(args[i]! | 0)));
  try {
    execBlock(main.body);
    return finish({ status: 'exited', returnValue: Number(returnValue), output, steps });
  } catch (e) {
    if (e instanceof Trap) {
      return finish({ status: 'trap', output, steps, trap: { code: e.code, message: trapMessage(e.code), line: e.line } });
    }
    if (e instanceof LimitReached) return finish({ status: 'limit', limit: e.kind, output, steps });
    throw e;
  }
}
