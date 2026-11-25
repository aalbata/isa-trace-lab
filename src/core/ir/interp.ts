/**
 * Interpreter for the IR. It defines the meaning of each operation with
 * 32-bit JavaScript integer arithmetic and is one of the engines compared in
 * the end-to-end checks.
 */
import type { BoundaryObserver, Outcome, RunLimits, StateReader } from '../exec.ts';
import { DEFAULT_LIMITS, checkArguments, trapMessage } from '../exec.ts';
import type { IRProgram, Operand } from './ir.ts';
import { evalPred } from './ir.ts';

export interface IROutcome extends Outcome {
  finalVars: Record<string, number>;
  finalArrays: Record<string, number[]>;
  /** Number of boundary markers executed. */
  boundaries: number;
}

/**
 * Run an IR program. Throws ArgumentCountError unless `args` holds one value
 * per parameter of main; each value is reduced to 32 bits.
 */
export function interpretIR(
  p: IRProgram,
  args: readonly number[] = [],
  options: { limits?: Partial<RunLimits>; onBoundary?: BoundaryObserver } = {},
): IROutcome {
  checkArguments(p.params.map((id) => p.vars[id]!.name), args);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const onBoundary = options.onBoundary;
  const vars = new Int32Array(p.vars.length);
  const assigned = new Uint8Array(p.vars.length);
  const temps = new Int32Array(p.temps.length);
  const arrays = p.arrays.map((a) => Int32Array.from(a.image));
  const output: number[] = [];
  let steps = 0;
  let boundaries = 0;

  const varIndex = new Map<string, number>();
  p.vars.forEach((v) => varIndex.set(v.name, v.id));
  const arrayIndex = new Map<string, number>();
  p.arrays.forEach((a) => arrayIndex.set(a.name, a.id));
  /** Array defined by each defining statement. */
  const arrayDefinedBy = new Map<number, number>();
  p.arrays.forEach((a) => arrayDefinedBy.set(a.defStmt, a.id));
  /** Arrays whose definition has executed; the others do not exist yet. */
  const defined = new Uint8Array(p.arrays.length);
  const reader: StateReader = {
    variable(name) {
      const id = varIndex.get(name);
      return id === undefined || !assigned[id] ? undefined : vars[id];
    },
    array(name) {
      const id = arrayIndex.get(name);
      return id === undefined || !defined[id] ? undefined : Array.from(arrays[id]!);
    },
    outputLength: () => output.length,
  };

  p.params.forEach((id, i) => {
    vars[id] = args[i]! | 0;
    assigned[id] = 1;
  });

  const get = (o: Operand): number => (o.k === 'const' ? o.value : o.k === 'var' ? vars[o.id]! : temps[o.id]!);
  const set = (d: { k: 'temp' | 'var'; id: number }, v: number): void => {
    if (d.k === 'var') {
      vars[d.id] = v;
      assigned[d.id] = 1;
    } else temps[d.id] = v;
  };

  const finish = (base: Outcome): IROutcome => {
    const finalVars: Record<string, number> = {};
    p.vars.forEach((v) => {
      if (!v.hidden && assigned[v.id]) finalVars[v.name] = vars[v.id]!;
    });
    const finalArrays: Record<string, number[]> = {};
    p.arrays.forEach((a) => (finalArrays[a.name] = Array.from(arrays[a.id]!)));
    return { ...base, finalVars, finalArrays, boundaries };
  };

  let block = p.blocks[0]!;
  let lastBranchLine: number | null = null;
  for (;;) {
    for (const op of block.ops) {
      if (++steps > limits.maxSteps) return finish({ status: 'limit', limit: 'steps', output, steps });
      switch (op.op) {
        case 'mark': {
          boundaries++;
          if (onBoundary) onBoundary(op.stmt, reader);
          // The definition runs between this boundary and the next one, which is the first to see the array.
          const def = arrayDefinedBy.get(op.stmt);
          if (def !== undefined) defined[def] = 1;
          break;
        }
        case 'copy':
          set(op.dst, get(op.src));
          break;
        case 'un': {
          const a = get(op.a);
          set(op.dst, op.fn === 'neg' ? (0 - a) | 0 : op.fn === 'not' ? ~a : a ^ 1);
          break;
        }
        case 'bin': {
          const a = get(op.a);
          const b = get(op.b);
          let r: number;
          switch (op.fn) {
            case 'add': r = (a + b) | 0; break;
            case 'sub': r = (a - b) | 0; break;
            case 'mul': r = Math.imul(a, b); break;
            case 'and': r = a & b; break;
            case 'or': r = a | b; break;
            case 'xor': r = a ^ b; break;
            case 'shl':
            case 'sar':
              if (b < 0 || b > 31) return finish({ status: 'fault', fault: `IR invariant violated: shift count ${b}`, output, steps });
              r = op.fn === 'shl' ? a << b : a >> b;
              break;
          }
          set(op.dst, r);
          break;
        }
        case 'cmp':
          set(op.dst, evalPred(op.pred, get(op.a), get(op.b)) ? 1 : 0);
          break;
        case 'load': {
          const arr = arrays[op.array]!;
          const i = get(op.index);
          if (i < 0 || i >= arr.length) return finish({ status: 'fault', fault: `IR invariant violated: index ${i}`, output, steps });
          set(op.dst, arr[i]!);
          break;
        }
        case 'store': {
          const arr = arrays[op.array]!;
          const i = get(op.index);
          if (i < 0 || i >= arr.length) return finish({ status: 'fault', fault: `IR invariant violated: index ${i}`, output, steps });
          arr[i] = get(op.value);
          break;
        }
        case 'print':
          if (output.length >= limits.maxOutput) return finish({ status: 'limit', limit: 'output', output, steps });
          output.push(get(op.a));
          break;
      }
    }
    if (++steps > limits.maxSteps) return finish({ status: 'limit', limit: 'steps', output, steps });
    const t = block.term;
    switch (t.op) {
      case 'jump':
        block = p.blocks[t.target]!;
        break;
      case 'br':
        lastBranchLine = t.span.start.line;
        block = p.blocks[evalPred(t.pred, get(t.a), get(t.b)) ? t.then : t.else]!;
        break;
      case 'ret':
        return finish({ status: 'exited', returnValue: get(t.a), output, steps });
      case 'trap':
        return finish({ status: 'trap', trap: { code: t.code, message: trapMessage(t.code), line: lastBranchLine }, output, steps });
    }
  }
}
