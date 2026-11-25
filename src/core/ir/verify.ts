/**
 * Structural verifier for the IR. It checks the invariants that the
 * interpreter and the backends rely on and returns a list of violations.
 */
import type { Dest, IROp, IRProgram, IRTerm, IRType, Operand } from './ir.ts';
import { successors } from './ir.ts';

export function verifyIR(p: IRProgram): string[] {
  const errors: string[] = [];
  const n = p.blocks.length;
  const err = (where: string, msg: string): void => {
    errors.push(`${where}: ${msg}`);
  };
  if (n === 0) return ['program has no blocks'];

  const typeOf = (o: Operand | Dest, where: string): IRType | null => {
    switch (o.k) {
      case 'temp':
        if (o.id < 0 || o.id >= p.temps.length) {
          err(where, `unknown temporary %t${o.id}`);
          return null;
        }
        return p.temps[o.id]!;
      case 'var':
        if (o.id < 0 || o.id >= p.vars.length) {
          err(where, `unknown variable ${o.id}`);
          return null;
        }
        return p.vars[o.id]!.type;
      case 'const':
        if (!Number.isInteger(o.value) || o.value < -2147483648 || o.value > 2147483647) {
          err(where, `constant ${o.value} is not a signed 32-bit integer`);
        }
        return null;
    }
  };
  const want = (o: Operand | Dest, t: IRType, where: string): void => {
    const got = typeOf(o, where);
    if (got !== null && got !== t) err(where, `expected ${t} but found ${got}`);
    if (o.k === 'const' && t === 'bool' && o.value !== 0 && o.value !== 1) err(where, `Boolean constant must be 0 or 1`);
  };

  // Identifier uniqueness, block structure, and types.
  const seenIds = new Set<number>();
  const tempDef = new Map<number, { block: number; index: number }>();
  p.blocks.forEach((b, bi) => {
    if (b.id !== bi) err(`b${bi}`, `block id ${b.id} does not match its position`);
    const all: (IROp | IRTerm)[] = [...b.ops, b.term];
    all.forEach((op, oi) => {
      const where = `b${bi}.${oi} (${op.op})`;
      if (seenIds.has(op.id)) err(where, `duplicate operation id ${op.id}`);
      seenIds.add(op.id);
      if (op.id < 0 || op.id >= p.opCount) err(where, `operation id ${op.id} out of range`);
      const def = (d: Dest): void => {
        if (d.k === 'temp') {
          if (tempDef.has(d.id)) err(where, `temporary %t${d.id} is defined more than once`);
          tempDef.set(d.id, { block: bi, index: oi });
        }
      };
      switch (op.op) {
        case 'mark':
          if (!p.stmts[op.stmt]) err(where, `marker refers to unknown statement ${op.stmt}`);
          break;
        case 'copy': {
          const t = typeOf(op.dst, where);
          if (t) want(op.src, t, where);
          def(op.dst);
          break;
        }
        case 'un':
          if (op.fn === 'lnot') {
            want(op.a, 'bool', where);
            want(op.dst, 'bool', where);
          } else {
            want(op.a, 'i32', where);
            want(op.dst, 'i32', where);
          }
          def(op.dst);
          break;
        case 'bin':
          want(op.a, 'i32', where);
          want(op.b, 'i32', where);
          want(op.dst, 'i32', where);
          if ((op.fn === 'shl' || op.fn === 'sar') && op.b.k === 'const' && (op.b.value < 0 || op.b.value > 31)) {
            err(where, `constant shift count ${op.b.value} outside 0 to 31`);
          }
          def(op.dst);
          break;
        case 'cmp':
          want(op.a, 'i32', where);
          want(op.b, 'i32', where);
          want(op.dst, 'bool', where);
          def(op.dst);
          break;
        case 'load':
        case 'store': {
          const arr = p.arrays[op.array];
          if (!arr) err(where, `unknown array ${op.array}`);
          want(op.index, 'i32', where);
          if (arr && op.index.k === 'const' && (op.index.value < 0 || op.index.value >= arr.length)) {
            err(where, `constant index ${op.index.value} outside array ${arr.name}`);
          }
          if (op.op === 'load') {
            want(op.dst, 'i32', where);
            def(op.dst);
          } else want(op.value, 'i32', where);
          break;
        }
        case 'print':
          want(op.a, 'i32', where);
          break;
        case 'jump':
          if (op.target < 0 || op.target >= n) err(where, `jump to unknown block ${op.target}`);
          break;
        case 'br': {
          if (op.then < 0 || op.then >= n || op.else < 0 || op.else >= n) err(where, 'branch to unknown block');
          const ta = typeOf(op.a, where);
          const tb = typeOf(op.b, where);
          if (ta && tb && ta !== tb) err(where, 'branch compares operands of different types');
          break;
        }
        case 'ret':
          want(op.a, 'i32', where);
          break;
        case 'trap':
          break;
      }
    });
  });
  if (seenIds.size !== p.opCount) err('program', `opCount ${p.opCount} does not match ${seenIds.size} operations`);

  // Control-flow graph by block position. Every table below holds a fixed number of entries per block or
  // per edge, so the memory of the verifier grows linearly with the program.
  const succs: number[][] = p.blocks.map((b) => successors(b.term).filter((s) => s >= 0 && s < n));
  const preds: number[][] = p.blocks.map(() => []);
  succs.forEach((targets, bi) => targets.forEach((s) => preds[s]!.push(bi)));

  // Depth-first search from the entry, with an explicit stack. `order` lists the reachable blocks in
  // postorder, and post[b] is the position of block b in it, or -1 when b is unreachable.
  const post = new Int32Array(n).fill(-1);
  const order: number[] = [];
  const visited = new Uint8Array(n);
  const path = [0];
  const nextSucc = [0];
  visited[0] = 1;
  while (path.length > 0) {
    const b = path[path.length - 1]!;
    const k = nextSucc[nextSucc.length - 1]!;
    if (k < succs[b]!.length) {
      nextSucc[nextSucc.length - 1] = k + 1;
      const s = succs[b]![k]!;
      if (!visited[s]) {
        visited[s] = 1;
        path.push(s);
        nextSucc.push(0);
      }
    } else {
      post[b] = order.length;
      order.push(b);
      path.pop();
      nextSucc.pop();
    }
  }
  for (let i = 0; i < n; i++) if (post[i]! < 0) err(`b${i}`, 'block is unreachable');
  if (preds[0]!.length > 0) err('b0', 'the entry block has a predecessor');

  // Immediate dominators by the iterative algorithm of Cooper, Harvey, and Kennedy: the reachable blocks
  // are visited in reverse postorder until no immediate dominator changes. The entry is its own immediate
  // dominator, and idom[b] stays -1 for an unreachable block.
  const idom = new Int32Array(n).fill(-1);
  idom[0] = 0;
  /** Nearest common ancestor of two blocks in the dominator tree built so far. */
  const commonDominator = (x: number, y: number): number => {
    let a = x;
    let b = y;
    while (a !== b) {
      while (post[a]! < post[b]!) a = idom[a]!;
      while (post[b]! < post[a]!) b = idom[b]!;
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    // The entry is last in postorder and keeps itself.
    for (let k = order.length - 2; k >= 0; k--) {
      const b = order[k]!;
      let best = -1;
      for (const q of preds[b]!) {
        // A predecessor without an immediate dominator is unreachable or has not been visited yet.
        if (idom[q]! < 0) continue;
        best = best < 0 ? q : commonDominator(q, best);
      }
      if (idom[b] !== best) {
        idom[b] = best;
        changed = true;
      }
    }
  }

  // Preorder numbers of the dominator tree. The immediate dominator of a block comes after it in postorder,
  // so one pass in postorder gives the size of every subtree, and one pass in reverse postorder gives every
  // block the next unused number of its parent. The subtree of block a then holds exactly the numbers
  // first[a] to first[a] + size[a] - 1.
  const size = new Int32Array(n);
  const first = new Int32Array(n);
  const unused = new Int32Array(n);
  for (const b of order) {
    size[b] = size[b]! + 1;
    if (b !== 0) size[idom[b]!] = size[idom[b]!]! + size[b]!;
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const b = order[k]!;
    if (b !== 0) {
      const parent = idom[b]!;
      first[b] = unused[parent]!;
      unused[parent] = unused[parent]! + size[b]!;
    }
    unused[b] = first[b]! + 1;
  }
  /**
   * True when block a dominates block b: every path from the entry to b passes through a. No path reaches
   * an unreachable block, so every block dominates it, and an unreachable block dominates no reachable one.
   */
  const dominates = (a: number, b: number): boolean =>
    post[b]! < 0 || (post[a]! >= 0 && first[a]! <= first[b]! && first[b]! < first[a]! + size[a]!);

  // Every use of a temporary is dominated by its single definition.
  p.blocks.forEach((b, bi) => {
    const allOps: (IROp | IRTerm)[] = [...b.ops, b.term];
    allOps.forEach((op, oi) => {
      const uses: Operand[] = [];
      switch (op.op) {
        case 'copy': uses.push(op.src); break;
        case 'un': uses.push(op.a); break;
        case 'bin': case 'cmp': case 'br': uses.push(op.a, op.b); break;
        case 'load': uses.push(op.index); break;
        case 'store': uses.push(op.index, op.value); break;
        case 'print': case 'ret': uses.push(op.a); break;
        default: break;
      }
      for (const u of uses) {
        if (u.k !== 'temp') continue;
        const d = tempDef.get(u.id);
        const where = `b${bi}.${oi} (${op.op})`;
        if (!d) err(where, `temporary %t${u.id} is used but never defined`);
        else if (d.block === bi ? d.index >= oi : !dominates(d.block, bi)) {
          err(where, `use of %t${u.id} is not dominated by its definition`);
        } else if (d.block > bi) {
          err(where, `temporary %t${u.id} is defined later in the layout than this use`);
        }
      }
    });
  });

  return errors;
}
