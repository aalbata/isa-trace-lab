/**
 * Assignment of IR values to registers and stack slots.
 *
 * The policy is deliberately simple so that listings are easy to follow:
 *  - each variable receives a home for the whole function, taken in order of
 *    declaration from the target's variable registers and then from stack slots;
 *  - each temporary receives a register from the target's temporary registers
 *    for the span from its definition to its last use, or a stack slot when
 *    none is free.
 * Temporaries are defined once and all control flow inside a statement is
 * forward in layout order, so the span between definition and last use in
 * layout order covers every path on which the temporary is live.
 */
import type { IROp, IRProgram, IRTerm, Operand } from '../ir/ir.ts';
import type { Home } from './types.ts';

export interface Allocation {
  vars: Home[];
  temps: Home[];
  slotCount: number;
}

function uses(op: IROp | IRTerm): Operand[] {
  switch (op.op) {
    case 'copy': return [op.src];
    case 'un': return [op.a];
    case 'bin': case 'cmp': case 'br': return [op.a, op.b];
    case 'load': return [op.index];
    case 'store': return [op.index, op.value];
    case 'print': case 'ret': return [op.a];
    default: return [];
  }
}

export function allocate(ir: IRProgram, varRegs: readonly string[], tempRegs: readonly string[]): Allocation {
  let slotCount = 0;
  const vars: Home[] = ir.vars.map((_, i) => (i < varRegs.length ? { kind: 'reg', reg: varRegs[i]! } : { kind: 'slot', index: slotCount++ }));

  const lastUse = new Array<number>(ir.temps.length).fill(-1);
  const defAt = new Array<number>(ir.temps.length).fill(-1);
  for (const b of ir.blocks) {
    for (const op of [...b.ops, b.term]) {
      for (const u of uses(op)) if (u.k === 'temp') lastUse[u.id] = Math.max(lastUse[u.id]!, op.id);
      if ('dst' in op && op.dst.k === 'temp') defAt[op.dst.id] = op.id;
    }
  }

  const temps: Home[] = new Array<Home>(ir.temps.length);
  const free = tempRegs.slice();
  const active: { temp: number; reg: string; end: number }[] = [];
  for (const b of ir.blocks) {
    for (const op of [...b.ops, b.term]) {
      // Registers of temporaries whose last use is this operation become available to its result.
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i]!.end <= op.id) {
          free.unshift(active[i]!.reg);
          active.splice(i, 1);
        }
      }
      if ('dst' in op && op.dst.k === 'temp') {
        const t = op.dst.id;
        const reg = free.shift();
        if (reg === undefined) temps[t] = { kind: 'slot', index: slotCount++ };
        else {
          temps[t] = { kind: 'reg', reg };
          active.push({ temp: t, reg, end: Math.max(lastUse[t]!, defAt[t]!) });
        }
      }
    }
  }
  for (let t = 0; t < temps.length; t++) if (!temps[t]) temps[t] = { kind: 'slot', index: slotCount++ };
  return { vars, temps, slotCount };
}
