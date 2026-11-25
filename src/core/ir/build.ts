/**
 * Construction of the IR from a validated program.
 *
 * Evaluation order follows Python: operands left to right, the right-hand side
 * of an element assignment before the index of its target. Expressions have no
 * side effects on variables, so a variable operand can be referenced directly
 * without first copying it into a temporary. No optimization is applied. The
 * only clean-up is structural: unreachable blocks are removed and jumps through
 * empty blocks are redirected to their final target.
 */
import { TRAP_INDEX, TRAP_SHIFT } from '../exec.ts';
import type { BinOpKind, CmpOpKind, Expr, Stmt } from '../lang/ast.ts';
import type { CheckedProgram } from '../lang/check.ts';
import { literalInt } from '../lang/check.ts';
import type { Span } from '../util/diag.ts';
import type {
  BinFn, Dest, IRArray, IRBlock, IROp, IRProgram, IRStmtInfo, IRTerm, IRType, IRVar, Operand, Pred,
} from './ir.ts';
import { negatePred, successors } from './ir.ts';

const BINFN: Partial<Record<BinOpKind, BinFn>> = {
  Add: 'add', Sub: 'sub', Mult: 'mul', BitAnd: 'and', BitOr: 'or', BitXor: 'xor', LShift: 'shl', RShift: 'sar',
};
const PRED: Partial<Record<CmpOpKind, Pred>> = { Eq: 'eq', NotEq: 'ne', Lt: 'lt', LtE: 'le', Gt: 'gt', GtE: 'ge' };

type OpInit = IROp extends infer T ? (T extends IROp ? Omit<T, 'id' | 'node' | 'span' | 'stmt'> : never) : never;
type TermInit = IRTerm extends infer T ? (T extends IRTerm ? Omit<T, 'id' | 'node' | 'span' | 'stmt'> : never) : never;

interface WorkBlock {
  key: number;
  label: string;
  ops: IROp[];
  term: IRTerm | null;
}

interface Origin {
  node: number;
  span: Span;
}

class Builder {
  private prog: CheckedProgram;
  private vars: IRVar[] = [];
  private varByName = new Map<string, number>();
  private temps: IRType[] = [];
  private arrays: IRArray[] = [];
  private arrayByName = new Map<string, number>();
  private blocks: WorkBlock[] = [];
  private layout: WorkBlock[] = [];
  private cur!: WorkBlock;
  private stmt = -1;
  private stmts: Record<number, IRStmtInfo> = {};
  private loops: { breakTo: WorkBlock; continueTo: WorkBlock }[] = [];
  private traps = new Map<number, WorkBlock>();
  private hiddenCount = 0;
  private mainOrigin: Origin;

  constructor(prog: CheckedProgram) {
    this.prog = prog;
    const main = prog.main!;
    this.mainOrigin = { node: main.id, span: main.span };
    for (const v of prog.vars) {
      this.vars.push({ id: v.id, name: v.name, type: v.type === 'int' ? 'i32' : 'bool', isParam: v.isParam, hidden: false });
      this.varByName.set(v.name, v.id);
    }
    let offset = 0;
    for (const a of prog.arrays) {
      this.arrays.push({ id: a.id, name: a.name, length: a.length, offset, image: a.image.slice(), defStmt: a.declNode });
      this.arrayByName.set(a.name, a.id);
      offset += 4 * a.length;
    }
  }

  // ---- block and operation helpers ------------------------------------------

  private newBlock(label: string): WorkBlock {
    const b: WorkBlock = { key: this.blocks.length, label, ops: [], term: null };
    this.blocks.push(b);
    return b;
  }

  /** Append the block to the layout and make it the insertion point. */
  private place(b: WorkBlock): void {
    this.layout.push(b);
    this.cur = b;
  }

  private emit(init: OpInit, at: Origin): void {
    this.cur.ops.push({ ...init, id: -1, node: at.node, span: at.span, stmt: this.stmt } as IROp);
  }

  private terminate(init: TermInit, at: Origin): void {
    if (this.cur.term) throw new Error('block already terminated');
    this.cur.term = { ...init, id: -1, node: at.node, span: at.span, stmt: this.stmt } as IRTerm;
  }

  private jump(target: WorkBlock, at: Origin): void {
    this.terminate({ op: 'jump', target: target.key }, at);
  }

  private newTemp(type: IRType): Dest {
    this.temps.push(type);
    return { k: 'temp', id: this.temps.length - 1 };
  }

  private newHidden(name: string, type: IRType): Dest {
    const id = this.vars.length;
    this.vars.push({ id, name, type, isParam: false, hidden: true });
    return { k: 'var', id };
  }

  private varOf(name: string): Dest {
    return { k: 'var', id: this.varByName.get(name)! };
  }

  private trapBlock(code: number): WorkBlock {
    let b = this.traps.get(code);
    if (!b) {
      b = this.newBlock(code === TRAP_INDEX ? 'trap: array index out of range' : 'trap: shift count out of range');
      this.traps.set(code, b);
    }
    return b;
  }

  /** Branch to the trap block when the predicate holds; continue in a new block otherwise. */
  private guard(pred: Pred, a: Operand, b: Operand, code: number, at: Origin): void {
    const cont = this.newBlock('');
    this.terminate({ op: 'br', pred, a, b, then: this.trapBlock(code).key, else: cont.key }, at);
    this.place(cont);
  }

  // ---- expressions ----------------------------------------------------------

  /** Lower an integer expression. With `hint`, the result is written to that destination. */
  private value(e: Expr, hint?: Dest): Operand {
    const at: Origin = { node: e.id, span: e.span };
    const deliver = (src: Operand): Operand => {
      if (!hint) return src;
      this.emit({ op: 'copy', dst: hint, src }, at);
      return hint;
    };
    switch (e.kind) {
      case 'Constant':
        return deliver({ k: 'const', value: Number(BigInt.asIntN(32, e.value)) });
      case 'Name':
        return deliver(this.varOf(e.name));
      case 'UnaryOp': {
        if (e.op === 'UAdd') return this.value(e.operand, hint);
        const a = this.value(e.operand);
        const dst = hint ?? this.newTemp('i32');
        this.emit({ op: 'un', fn: e.op === 'USub' ? 'neg' : 'not', dst, a }, at);
        return dst;
      }
      case 'BinOp': {
        const a = this.value(e.left);
        const b = this.value(e.right);
        return this.binary(BINFN[e.op]!, a, b, literalInt(e.right) !== null, at, hint);
      }
      case 'Call': {
        const arr = this.arrays[this.arrayByName.get((e.args[0] as { name: string }).name)!]!;
        return deliver({ k: 'const', value: arr.length });
      }
      case 'Subscript': {
        const arr = this.arrays[this.arrayByName.get((e.value as { name: string }).name)!]!;
        const index = this.value(e.index);
        if (literalInt(e.index) === null) this.guard('geu', index, { k: 'const', value: arr.length }, TRAP_INDEX, at);
        const dst = hint ?? this.newTemp('i32');
        this.emit({ op: 'load', dst, array: arr.id, index }, at);
        return dst;
      }
      default:
        throw new Error(`cannot lower integer expression ${e.kind}`);
    }
  }

  private binary(fn: BinFn, a: Operand, b: Operand, literalCount: boolean, at: Origin, hint?: Dest): Operand {
    if ((fn === 'shl' || fn === 'sar') && !literalCount) {
      this.guard('gtu', b, { k: 'const', value: 31 }, TRAP_SHIFT, at);
    }
    const dst = hint ?? this.newTemp('i32');
    this.emit({ op: 'bin', fn, dst, a, b }, at);
    return dst;
  }

  /** Lower a Boolean expression as control flow to one of two blocks. */
  private cond(e: Expr, onTrue: WorkBlock, onFalse: WorkBlock): void {
    const at: Origin = { node: e.id, span: e.span };
    switch (e.kind) {
      case 'Constant':
        this.jump(e.value === 1n ? onTrue : onFalse, at);
        return;
      case 'Name':
        this.terminate({ op: 'br', pred: 'ne', a: this.varOf(e.name), b: { k: 'const', value: 0 }, then: onTrue.key, else: onFalse.key }, at);
        return;
      case 'UnaryOp':
        this.cond(e.operand, onFalse, onTrue);
        return;
      case 'BoolOp': {
        const last = e.values.length - 1;
        e.values.forEach((v, i) => {
          if (i === last) {
            this.cond(v, onTrue, onFalse);
            return;
          }
          const next = this.newBlock('');
          if (e.op === 'And') this.cond(v, next, onFalse);
          else this.cond(v, onTrue, next);
          this.place(next);
        });
        return;
      }
      case 'Compare': {
        const a = this.value(e.left);
        const b = this.value(e.comparators[0]!);
        this.terminate({ op: 'br', pred: PRED[e.ops[0]!]!, a, b, then: onTrue.key, else: onFalse.key }, at);
        return;
      }
      default:
        throw new Error(`cannot lower condition ${e.kind}`);
    }
  }

  /** Store the value of a Boolean expression (0 or 1) in a destination. */
  private boolValue(e: Expr, dst: Dest): void {
    const at: Origin = { node: e.id, span: e.span };
    switch (e.kind) {
      case 'Constant':
        this.emit({ op: 'copy', dst, src: { k: 'const', value: e.value === 1n ? 1 : 0 } }, at);
        return;
      case 'Name':
        this.emit({ op: 'copy', dst, src: this.varOf(e.name) }, at);
        return;
      case 'Compare': {
        const a = this.value(e.left);
        const b = this.value(e.comparators[0]!);
        this.emit({ op: 'cmp', pred: PRED[e.ops[0]!]!, dst, a, b }, at);
        return;
      }
      case 'UnaryOp':
        if (e.operand.kind === 'Name') {
          this.emit({ op: 'un', fn: 'lnot', dst, a: this.varOf(e.operand.name) }, at);
          return;
        }
        if (e.operand.kind === 'Compare') {
          const a = this.value(e.operand.left);
          const b = this.value(e.operand.comparators[0]!);
          this.emit({ op: 'cmp', pred: negatePred(PRED[e.operand.ops[0]!]!), dst, a, b }, at);
          return;
        }
        break;
      default:
        break;
    }
    // Short-circuit forms: evaluate as control flow and store 1 or 0 on each path.
    const t = this.newBlock('');
    const f = this.newBlock('');
    const join = this.newBlock('');
    this.cond(e, t, f);
    this.place(t);
    this.emit({ op: 'copy', dst, src: { k: 'const', value: 1 } }, at);
    this.jump(join, at);
    this.place(f);
    this.emit({ op: 'copy', dst, src: { k: 'const', value: 0 } }, at);
    this.jump(join, at);
    this.place(join);
  }

  // ---- statements -----------------------------------------------------------

  private mark(s: Stmt): Origin {
    this.stmt = s.id;
    const at: Origin = { node: s.id, span: s.span };
    if (!this.stmts[s.id]) this.stmts[s.id] = { id: s.id, kind: s.kind, span: s.span };
    this.emit({ op: 'mark' }, at);
    return at;
  }

  private body(stmts: Stmt[]): void {
    for (const s of stmts) this.statement(s);
  }

  /** Statements after a return, break, or continue are unreachable; they are lowered into a block that is removed later. */
  private deadBlock(): void {
    this.place(this.newBlock('unreachable'));
  }

  private statement(s: Stmt): void {
    switch (s.kind) {
      case 'Pass':
        this.mark(s);
        return;
      case 'Break': {
        const at = this.mark(s);
        this.jump(this.loops[this.loops.length - 1]!.breakTo, at);
        this.deadBlock();
        return;
      }
      case 'Continue': {
        const at = this.mark(s);
        this.jump(this.loops[this.loops.length - 1]!.continueTo, at);
        this.deadBlock();
        return;
      }
      case 'Return': {
        const at = this.mark(s);
        const v: Operand = s.value ? this.value(s.value) : { k: 'const', value: 0 };
        this.terminate({ op: 'ret', a: v }, at);
        this.deadBlock();
        return;
      }
      case 'Expr': {
        const at = this.mark(s);
        const call = s.value as Extract<Expr, { kind: 'Call' }>;
        const v = this.value(call.args[0]!);
        this.emit({ op: 'print', a: v }, at);
        return;
      }
      case 'Assign':
        this.assign(s);
        return;
      case 'AugAssign': {
        const at = this.mark(s);
        const fn = BINFN[s.op]!;
        const literalCount = literalInt(s.value) !== null;
        if (s.target.kind === 'Subscript') {
          const arr = this.arrays[this.arrayByName.get((s.target.value as { name: string }).name)!]!;
          const tat: Origin = { node: s.target.id, span: s.target.span };
          const index = this.value(s.target.index);
          if (literalInt(s.target.index) === null) this.guard('geu', index, { k: 'const', value: arr.length }, TRAP_INDEX, tat);
          const old = this.newTemp('i32');
          this.emit({ op: 'load', dst: old, array: arr.id, index }, tat);
          const rhs = this.value(s.value);
          const result = this.binary(fn, old, rhs, literalCount, at);
          this.emit({ op: 'store', array: arr.id, index, value: result }, at);
          return;
        }
        const dst = this.varOf((s.target as { name: string }).name);
        const rhs = this.value(s.value);
        this.binary(fn, dst, rhs, literalCount, at, dst);
        return;
      }
      case 'If': {
        // An elif clause is an if statement in the else branch of the clause before it. The clauses of a
        // chain are lowered in a loop, in the order that lowering each nested statement would produce, so
        // that a long chain does not deepen the recursion. Each clause has its own join block, which
        // continues to the join block of the clause around it.
        const joins: { stmt: number; at: Origin; join: WorkBlock }[] = [];
        let clause = s;
        for (;;) {
          this.mark(clause);
          const at: Origin = { node: clause.id, span: clause.span };
          const t = this.newBlock('');
          const join = this.newBlock('');
          const f = clause.orelse.length > 0 ? this.newBlock('') : join;
          this.cond(clause.test, t, f);
          this.place(t);
          this.body(clause.body);
          this.stmt = clause.id;
          this.jump(join, at);
          joins.push({ stmt: clause.id, at, join });
          if (clause.orelse.length === 0) break;
          this.place(f);
          const next = clause.orelse.length === 1 ? clause.orelse[0]! : null;
          if (next?.kind === 'If') {
            clause = next;
            continue;
          }
          this.body(clause.orelse);
          this.stmt = clause.id;
          this.jump(join, at);
          break;
        }
        for (let k = joins.length - 1; k >= 0; k--) {
          this.place(joins[k]!.join);
          if (k === 0) break;
          const outer = joins[k - 1]!;
          this.stmt = outer.stmt;
          this.jump(outer.join, outer.at);
        }
        return;
      }
      case 'While': {
        const at: Origin = { node: s.id, span: s.span };
        const head = this.newBlock('while: condition');
        const bodyBlock = this.newBlock('');
        const exit = this.newBlock('');
        this.stmt = s.id;
        this.jump(head, at);
        this.place(head);
        this.mark(s);
        this.cond(s.test, bodyBlock, exit);
        this.place(bodyBlock);
        this.loops.push({ breakTo: exit, continueTo: head });
        this.body(s.body);
        this.loops.pop();
        this.stmt = s.id;
        this.jump(head, at);
        this.place(exit);
        return;
      }
      case 'For':
        this.forLoop(s);
        return;
      default:
        throw new Error(`cannot lower statement ${s.kind}`);
    }
  }

  private assign(s: Extract<Stmt, { kind: 'Assign' }>): void {
    const at = this.mark(s);
    const def = this.prog.arrayDefs.get(s.id);
    if (def) {
      const arr = this.arrays[def.id]!;
      if (s.value.kind === 'List') {
        // Literal elements are already in the data image; the others are stored by code.
        s.value.elts.forEach((elt, i) => {
          if (literalInt(elt) !== null) return;
          const v = this.value(elt);
          this.emit({ op: 'store', array: arr.id, index: { k: 'const', value: i }, value: v }, { node: elt.id, span: elt.span });
        });
        return;
      }
      const elt = ((s.value as Extract<Expr, { kind: 'BinOp' }>).left as Extract<Expr, { kind: 'List' }>).elts[0]!;
      if (literalInt(elt) !== null) return;
      // [e] * n with a computed element: evaluate e once, then store it n times.
      const n = ++this.hiddenCount;
      const fill = this.newHidden(`$fill${n}.value`, 'i32');
      const k = this.newHidden(`$fill${n}.index`, 'i32');
      this.value(elt, fill);
      this.emit({ op: 'copy', dst: k, src: { k: 'const', value: 0 } }, at);
      const loop = this.newBlock('array fill');
      const exit = this.newBlock('');
      this.jump(loop, at);
      this.place(loop);
      this.emit({ op: 'store', array: arr.id, index: k, value: fill }, at);
      this.emit({ op: 'bin', fn: 'add', dst: k, a: k, b: { k: 'const', value: 1 } }, at);
      this.terminate({ op: 'br', pred: 'lt', a: k, b: { k: 'const', value: arr.length }, then: loop.key, else: exit.key }, at);
      this.place(exit);
      return;
    }
    if (s.target.kind === 'Subscript') {
      const arr = this.arrays[this.arrayByName.get((s.target.value as { name: string }).name)!]!;
      const tat: Origin = { node: s.target.id, span: s.target.span };
      const v = this.value(s.value);
      const index = this.value(s.target.index);
      if (literalInt(s.target.index) === null) this.guard('geu', index, { k: 'const', value: arr.length }, TRAP_INDEX, tat);
      this.emit({ op: 'store', array: arr.id, index, value: v }, at);
      return;
    }
    const dst = this.varOf((s.target as { name: string }).name);
    if (this.prog.exprType.get(s.value.id) === 'bool') this.boolValue(s.value, dst);
    else this.value(s.value, dst);
  }

  /**
   * for v in range(start, stop, step), with exact Python semantics for every
   * 32-bit bound. A hidden counter holds the current element. After the body,
   * the loop continues only when the unsigned distance to `stop` exceeds the
   * magnitude of the step, so the counter never overflows.
   */
  private forLoop(s: Extract<Stmt, { kind: 'For' }>): void {
    const info = this.prog.forInfo.get(s.id)!;
    const at = this.mark(s);
    const n = ++this.hiddenCount;
    const counter = this.newHidden(`$for${n}.next`, 'i32');
    const stop = this.newHidden(`$for${n}.stop`, 'i32');
    const up = info.step > 0;
    if (info.start) this.value(info.start, counter);
    else this.emit({ op: 'copy', dst: counter, src: { k: 'const', value: 0 } }, at);
    this.value(info.stop, stop);
    const head = this.newBlock('for: next element');
    const latch = this.newBlock('for: advance');
    const inc = this.newBlock('');
    const exit = this.newBlock('');
    this.stmt = s.id;
    this.terminate({ op: 'br', pred: up ? 'lt' : 'gt', a: counter, b: stop, then: head.key, else: exit.key }, at);
    this.place(head);
    this.emit({ op: 'copy', dst: this.varOf((s.target as { name: string }).name), src: counter }, { node: s.target.id, span: s.target.span });
    this.loops.push({ breakTo: exit, continueTo: latch });
    this.body(s.body);
    this.loops.pop();
    this.stmt = s.id;
    this.jump(latch, at);
    this.place(latch);
    this.mark(s);
    const distance = this.newTemp('i32');
    this.emit({ op: 'bin', fn: 'sub', dst: distance, a: up ? stop : counter, b: up ? counter : stop }, at);
    const magnitude = up ? info.step : (0 - info.step) | 0;
    this.terminate({ op: 'br', pred: 'gtu', a: distance, b: { k: 'const', value: magnitude }, then: inc.key, else: exit.key }, at);
    this.place(inc);
    this.emit({ op: 'bin', fn: 'add', dst: counter, a: counter, b: { k: 'const', value: info.step } }, at);
    this.jump(head, at);
    this.place(exit);
  }

  // ---- finalization ---------------------------------------------------------

  build(): IRProgram {
    const main = this.prog.main!;
    this.place(this.newBlock('entry'));
    this.body(main.body);
    this.stmt = main.id;
    // Reaching the end of main returns 0.
    this.terminate({ op: 'ret', a: { k: 'const', value: 0 } }, this.mainOrigin);
    for (const [code, b] of [...this.traps.entries()].sort((x, y) => x[0] - y[0])) {
      this.place(b);
      this.stmt = main.id;
      this.terminate({ op: 'trap', code }, this.mainOrigin);
    }

    const byKey = new Map<number, WorkBlock>();
    for (const b of this.blocks) byKey.set(b.key, b);

    // Redirect edges that pass through blocks containing only a jump.
    const forward = (key: number): number => {
      const seen = new Set<number>();
      let k = key;
      for (;;) {
        const b = byKey.get(k)!;
        if (b.ops.length > 0 || !b.term || b.term.op !== 'jump' || seen.has(k)) return k;
        seen.add(k);
        k = b.term.target;
      }
    };
    for (const b of this.layout) {
      const t = b.term!;
      if (t.op === 'jump') t.target = forward(t.target);
      else if (t.op === 'br') {
        t.then = forward(t.then);
        t.else = forward(t.else);
      }
    }

    // Keep the blocks reachable from the entry, in layout order.
    const reachable = new Set<number>();
    const stack = [this.layout[0]!.key];
    while (stack.length > 0) {
      const k = stack.pop()!;
      if (reachable.has(k)) continue;
      reachable.add(k);
      for (const s of successors(byKey.get(k)!.term!)) stack.push(s);
    }
    const kept = this.layout.filter((b) => reachable.has(b.key));
    const renumber = new Map<number, number>();
    kept.forEach((b, i) => renumber.set(b.key, i));

    let nextId = 0;
    const blocks: IRBlock[] = kept.map((b, i) => {
      for (const op of b.ops) op.id = nextId++;
      const t = b.term!;
      t.id = nextId++;
      if (t.op === 'jump') t.target = renumber.get(t.target)!;
      else if (t.op === 'br') {
        t.then = renumber.get(t.then)!;
        t.else = renumber.get(t.else)!;
      }
      return { id: i, label: b.label, ops: b.ops, term: t };
    });

    // Drop statement records whose markers were all in removed blocks.
    const live = new Set<number>();
    for (const b of blocks) for (const op of b.ops) if (op.op === 'mark') live.add(op.stmt);
    const stmts: Record<number, IRStmtInfo> = {};
    for (const id of Object.keys(this.stmts)) if (live.has(Number(id))) stmts[Number(id)] = this.stmts[Number(id)]!;

    return {
      name: 'main',
      params: this.vars.filter((v) => v.isParam).map((v) => v.id),
      vars: this.vars,
      temps: this.temps,
      arrays: this.arrays,
      blocks,
      stmts,
      opCount: nextId,
    };
  }
}

/** Build the IR of a validated program. */
export function buildIR(prog: CheckedProgram): IRProgram {
  if (!prog.ok || !prog.main) throw new Error('buildIR requires a program without errors');
  return new Builder(prog).build();
}
