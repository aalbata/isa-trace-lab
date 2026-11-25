import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../scripts/lib/corpus.ts';
import { ArgumentCountError } from '../src/core/exec.ts';
import { buildIR } from '../src/core/ir/build.ts';
import { interpretIR } from '../src/core/ir/interp.ts';
import type { IROp, IRProgram, IRTerm, Operand } from '../src/core/ir/ir.ts';
import { successors } from '../src/core/ir/ir.ts';
import { verifyIR } from '../src/core/ir/verify.ts';
import { check } from '../src/core/lang/check.ts';
import { evaluateReference } from '../src/core/lang/reference.ts';

/** Contents of an array that each engine reports at every boundary of a run. */
const arraysAtBoundaries = (source: string, name: string, args: number[] = []) => {
  const p = check(source);
  expect(p.ok).toBe(true);
  const reference: (readonly number[] | undefined)[] = [];
  evaluateReference(p, args, { onBoundary: (_stmt, state) => reference.push(state.array(name)?.slice()) });
  const ir: (readonly number[] | undefined)[] = [];
  interpretIR(buildIR(p), args, { onBoundary: (_stmt, state) => ir.push(state.array(name)?.slice()) });
  return { reference, ir };
};

describe('IR interpreter state at boundaries', () => {
  it('reports an array only after its definition has executed', () => {
    const { reference, ir } = arraysAtBoundaries('def main():\n    x = 1\n    a = [7, 8, 9]\n    return a[0] + x\n', 'a');
    expect(reference).toEqual([undefined, undefined, [7, 8, 9]]);
    expect(ir).toEqual(reference);
  });

  it('never reports an array whose definition does not execute', () => {
    const { reference, ir } = arraysAtBoundaries('def main(n):\n    if n > 0:\n        return 1\n    a = [5, 6]\n    return a[0]\n', 'a', [1]);
    expect(reference).toEqual([undefined, undefined]);
    expect(ir).toEqual(reference);
  });

  it('reports the current contents once the definition has executed', () => {
    const { reference, ir } = arraysAtBoundaries('def main(x):\n    a = [x] * 3\n    a[1] = 4\n    return a[1]\n', 'a', [2]);
    expect(reference).toEqual([undefined, [2, 2, 2], [2, 4, 2]]);
    expect(ir).toEqual(reference);
  });
});

/** IR of a program that passes the checker. */
const irOf = (source: string): IRProgram => {
  const p = check(source);
  expect(p.ok, source).toBe(true);
  return buildIR(p);
};

describe('IR interpreter arguments', () => {
  it('requires one argument for each parameter of main', () => {
    const three = irOf('def main(zeta, alpha, c):\n    print(c)\n    return zeta + alpha\n');
    // No missing parameter is filled in, and no extra argument is dropped.
    for (const args of [[], [5], [5, 6], [5, 6, 7, 8]]) {
      const run = (): unknown => interpretIR(three, args);
      expect(run, JSON.stringify(args)).toThrow(ArgumentCountError);
      expect(run, JSON.stringify(args)).toThrow(`main takes 3 parameters (zeta, alpha, c), but ${args.length} argument${args.length === 1 ? ' was' : 's were'} given`);
    }
    expect(() => interpretIR(three)).toThrow(ArgumentCountError);
    expect(interpretIR(three, [5, 6, 7])).toMatchObject({ status: 'exited', returnValue: 11, output: [7] });
    const none = irOf('def main():\n    return 3\n');
    expect(() => interpretIR(none, [1])).toThrow('main takes no parameters, but 1 argument was given');
    expect(interpretIR(none).returnValue).toBe(3);
    expect(interpretIR(none, []).returnValue).toBe(3);
  });
});

/** Operands that an operation or a terminator reads. */
const operandsOf = (op: IROp | IRTerm): Operand[] => {
  switch (op.op) {
    case 'copy': return [op.src];
    case 'un': return [op.a];
    case 'bin': case 'cmp': case 'br': return [op.a, op.b];
    case 'load': return [op.index];
    case 'store': return [op.index, op.value];
    case 'print': case 'ret': return [op.a];
    default: return [];
  }
};

interface Place {
  block: number;
  index: number;
}

/** Place of the operation that defines each temporary. */
const definitions = (p: IRProgram): Map<number, Place> => {
  const defs = new Map<number, Place>();
  p.blocks.forEach((b, block) => b.ops.forEach((op, index) => {
    if ('dst' in op && op.dst.k === 'temp') defs.set(op.dst.id, { block, index });
  }));
  return defs;
};

type Dominance = (a: number, b: number) => boolean;

/**
 * Dominance between the blocks of a program by its definition, without a
 * dominator tree: block a dominates block b when no path from the entry
 * reaches b without passing through a. No path reaches an unreachable block,
 * so every block dominates it. The answer depends on the terminators only.
 */
const dominanceByPaths = (p: IRProgram): Dominance => {
  /** Blocks that a path from the entry reaches without passing through block `avoid`. */
  const reachedWithout = (avoid: number): Uint8Array => {
    const seen = new Uint8Array(p.blocks.length);
    if (avoid === 0) return seen;
    seen[0] = 1;
    const work = [0];
    while (work.length > 0) {
      for (const s of successors(p.blocks[work.pop()!]!.term)) {
        if (s !== avoid && !seen[s]) {
          seen[s] = 1;
          work.push(s);
        }
      }
    }
    return seen;
  };
  const reachable = reachedWithout(-1);
  const without = new Map<number, Uint8Array>();
  return (a, b) => {
    if (!reachable[b]) return true;
    let seen = without.get(a);
    if (!seen) without.set(a, (seen = reachedWithout(a)));
    return !seen[b];
  };
};

/**
 * The messages that the verifier owes a program in which every temporary has
 * one definition: a use must follow its definition in the same block or lie
 * in a block that the block of the definition dominates, and a dominated use
 * must not precede its definition in the layout.
 */
const expectedUseMessages = (p: IRProgram, dominates: Dominance = dominanceByPaths(p)): string[] => {
  const defs = definitions(p);
  const out: string[] = [];
  p.blocks.forEach((b, bi) => [...b.ops, b.term].forEach((op, oi) => {
    for (const u of operandsOf(op)) {
      if (u.k !== 'temp') continue;
      const d = defs.get(u.id)!;
      const where = `b${bi}.${oi} (${op.op})`;
      if (d.block === bi ? d.index >= oi : !dominates(d.block, bi)) out.push(`${where}: use of %t${u.id} is not dominated by its definition`);
      else if (d.block > bi) out.push(`${where}: temporary %t${u.id} is defined later in the layout than this use`);
    }
  }));
  return out;
};

/**
 * Messages of the verifier, and the messages owed, while the operation at
 * `from` stands at position `to.index` of block `to.block`. Moving an
 * operation leaves the dominance between blocks as it is.
 */
const verifyMoved = (p: IRProgram, from: Place, to: Place, dominates: Dominance = dominanceByPaths(p)): { messages: string[]; expected: string[] } => {
  const [op] = p.blocks[from.block]!.ops.splice(from.index, 1);
  p.blocks[to.block]!.ops.splice(to.index, 0, op!);
  try {
    return { messages: verifyIR(p), expected: expectedUseMessages(p, dominates) };
  } finally {
    p.blocks[to.block]!.ops.splice(to.index, 1);
    p.blocks[from.block]!.ops.splice(from.index, 0, op!);
  }
};

describe('IR verifier', () => {
  it('accepts the IR of every corpus program', () => {
    const corpus = loadCorpus();
    expect(corpus.length).toBeGreaterThan(1000);
    for (const c of corpus) expect(verifyIR(irOf(c.source)), c.name).toEqual([]);
  });

  it('rejects a use of a temporary that its definition does not dominate', () => {
    // b0: br a > 0 ? b1 : b3     b1: %t0 = add a, 1; br i >=u 3 ? b4 : b2     b2: %t1 = load x[i]; a = mul %t0, %t1; jump b3
    // b3: %t2 = sub a, 2; %t3 = add a, 3; %t4 = mul %t2, %t3; ret %t4       b4: trap
    const p = irOf('def main(a, i):\n    x = [1, 2, 3]\n    if a > 0:\n        a = (a + 1) * x[i]\n    return (a - 2) * (a + 3)\n');
    expect(p.blocks.map((b) => [...b.ops.map((op) => op.op), b.term.op].join(' '))).toEqual([
      'mark mark br', 'mark bin br', 'load bin jump', 'mark bin bin bin ret', 'trap',
    ]);
    const undominated = (where: string, temp: number): string => `${where}: use of %t${temp} is not dominated by its definition`;
    const cases: [from: Place, to: Place, messages: string[]][] = [
      // The product, moved before both of its operands in the same block.
      [{ block: 3, index: 3 }, { block: 3, index: 1 }, [undominated('b3.1 (bin)', 2), undominated('b3.1 (bin)', 3)]],
      // The product, moved to the start of the entry block; the return in b3 still follows it on every path.
      [{ block: 3, index: 3 }, { block: 0, index: 0 }, [undominated('b0.0 (bin)', 2), undominated('b0.0 (bin)', 3)]],
      // The definition of %t0, moved behind its use in the next block.
      [{ block: 1, index: 1 }, { block: 2, index: 2 }, [undominated('b2.1 (bin)', 0)]],
      // The definition of %t0, moved to the block where the two branches join, which b2 does not pass through.
      [{ block: 1, index: 1 }, { block: 3, index: 0 }, [undominated('b2.1 (bin)', 0)]],
      // The use of %t0 and %t1, moved to the join block, which is also reached without passing through b1 or b2.
      [{ block: 2, index: 1 }, { block: 3, index: 0 }, [undominated('b3.0 (bin)', 0), undominated('b3.0 (bin)', 1)]],
      // The definition of %t0, moved to the entry block, through which every path passes.
      [{ block: 1, index: 1 }, { block: 0, index: 0 }, []],
      // The load, moved up to the block of the bounds check: its result is still defined before its use in b2.
      [{ block: 2, index: 0 }, { block: 1, index: 2 }, []],
    ];
    for (const [from, to, messages] of cases) {
      const moved = verifyMoved(p, from, to);
      expect(moved.messages, JSON.stringify([from, to])).toEqual(messages);
      expect(moved.expected, JSON.stringify([from, to])).toEqual(messages);
    }
    expect(verifyIR(p)).toEqual([]);
    // An edge from the entry to b2 gives a path to the use of %t0 that does not pass through its definition in b1.
    const entry = p.blocks[0]!.term as Extract<IRTerm, { op: 'br' }>;
    entry.else = 2;
    expect(verifyIR(p)).toEqual([undominated('b2.1 (bin)', 0)]);
    expect(expectedUseMessages(p)).toEqual([undominated('b2.1 (bin)', 0)]);
    entry.else = 3;
    // In a loop, the block of the condition dominates the body, and the block after the loop does not.
    const loop = irOf('def main(a, i):\n    x = [1, 2, 3]\n    t = 0\n    while t < a:\n        t += (a + 1) * x[i]\n    return t\n');
    expect(loop.blocks.map((b) => [...b.ops.map((op) => op.op), b.term.op].join(' '))).toEqual([
      'mark mark copy jump', 'mark br', 'mark bin br', 'load bin bin jump', 'mark ret', 'trap',
    ]);
    expect(verifyMoved(loop, { block: 2, index: 1 }, { block: 1, index: 0 }).messages).toEqual([]);
    expect(verifyMoved(loop, { block: 2, index: 1 }, { block: 4, index: 0 }).messages).toEqual([undominated('b3.1 (bin)', 0)]);
  });

  it('finds the dominators of a loop with two entries, and treats unreachable blocks as before', () => {
    // b0 -> b1, b2;  b1 -> b3;  b2 -> b4;  b3 -> b4;  b4 -> b3, b5;  b5 returns;  b6 -> b5 is unreachable.
    // The loop of b3 and b4 is entered at b3 from b1 and at b4 from b2, so of b0, b1, and b2 only b0
    // dominates b3 and b4. One pass over the blocks in reverse postorder leaves b1 as the dominator of b3.
    const at = { node: 0, stmt: 0, span: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 1, offset: 1 } } };
    const one: Operand = { k: 'const', value: 1 };
    let id = 0;
    const define = (temp: number): IROp => ({ op: 'copy', dst: { k: 'temp', id: temp }, src: one, id: id++, ...at });
    const use = (temp: number): IROp => ({ op: 'print', a: { k: 'temp', id: temp }, id: id++, ...at });
    const jump = (target: number): IRTerm => ({ op: 'jump', target, id: id++, ...at });
    const branch = (then: number, otherwise: number): IRTerm => ({ op: 'br', pred: 'eq', a: one, b: one, then, else: otherwise, id: id++, ...at });
    const blocks: [IROp[], IRTerm][] = [
      [[define(0)], branch(1, 2)],
      [[define(1)], jump(3)],
      [[define(2)], jump(4)],
      [[use(0), use(1)], jump(4)],
      [[use(0), use(2)], branch(3, 5)],
      [[use(0), use(3)], { op: 'ret', a: one, id: id++, ...at }],
      [[define(3), use(1), use(2)], jump(5)],
    ];
    const p: IRProgram = {
      name: 'main', params: [], vars: [], temps: ['i32', 'i32', 'i32', 'i32'], arrays: [], stmts: {}, opCount: id,
      blocks: blocks.map(([ops, term], k) => ({ id: k, label: '', ops, term })),
    };
    const messages = [
      'b6: block is unreachable',
      'b3.1 (print): use of %t1 is not dominated by its definition',
      'b4.1 (print): use of %t2 is not dominated by its definition',
      // No path reaches b6, so nothing is owed for its uses; its own definition reaches no other block.
      'b5.1 (print): use of %t3 is not dominated by its definition',
    ];
    expect(verifyIR(p)).toEqual(messages);
    expect(expectedUseMessages(p)).toEqual(messages.slice(1));
    // With the second entry removed, b1 dominates the loop.
    (p.blocks[2]!.term as Extract<IRTerm, { op: 'jump' }>).target = 5;
    expect(verifyIR(p)).toEqual([messages[0], 'b4.1 (print): use of %t2 is not dominated by its definition', messages[3]]);
    expect(expectedUseMessages(p)).toEqual(verifyIR(p).slice(1));
  });

  it('decides every moved use and moved definition of the corpus as the definition of dominance does', () => {
    let moves = 0;
    let accepted = 0;
    let usesBeforeDefinitions = 0;
    let dominates: Dominance = () => false;
    const expectMoved = (p: IRProgram, name: string, from: Place, to: Place): string[] => {
      const moved = verifyMoved(p, from, to, dominates);
      expect(moved.messages, `${name} ${JSON.stringify([from, to])}`).toEqual(moved.expected);
      moves++;
      if (moved.messages.length === 0) accepted++;
      return moved.messages;
    };
    for (const c of loadCorpus()) {
      const p = irOf(c.source);
      const defs = definitions(p);
      dominates = dominanceByPaths(p);
      p.blocks.forEach((b, block) => {
        for (let index = 0; index < b.ops.length; index++) {
          const op = b.ops[index]!;
          for (const u of operandsOf(op)) {
            if (u.k !== 'temp') continue;
            // The use, moved to the position of the definition, which then follows it.
            const d = defs.get(u.id)!;
            const messages = expectMoved(p, c.name, { block, index }, d);
            expect(messages, c.name).toContain(`b${d.block}.${d.index} (${op.op}): use of %t${u.id} is not dominated by its definition`);
            usesBeforeDefinitions++;
            // The use, moved to the start of the entry block and to the end of each block that leads to its own.
            expectMoved(p, c.name, { block, index }, { block: 0, index: 0 });
            p.blocks.forEach((q, pred) => {
              if (pred !== block && successors(q.term).includes(block)) expectMoved(p, c.name, { block, index }, { block: pred, index: q.ops.length });
            });
          }
          // A definition, moved to the end of each block that its own block leads to, and to the end of the layout.
          if ('dst' in op && op.dst.k === 'temp') {
            const last = p.blocks.length - 1;
            for (const s of new Set([...successors(b.term), last])) {
              if (s !== block) expectMoved(p, c.name, { block, index }, { block: s, index: p.blocks[s]!.ops.length });
            }
          }
        }
      });
      expect(verifyIR(p), c.name).toEqual([]);
    }
    // Both verdicts occur: every use moved before its definition is rejected, and other moves are accepted.
    expect(usesBeforeDefinitions).toBeGreaterThan(10000);
    expect(moves - accepted).toBeGreaterThan(usesBeforeDefinitions);
    expect(accepted).toBeGreaterThan(1000);
  });
});
