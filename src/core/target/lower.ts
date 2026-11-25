/**
 * Target-independent lowering driver.
 *
 * The driver walks the IR in layout order, resolves each operand to a register
 * or an immediate (loading spilled values into scratch registers), and calls
 * the target's instruction-selection hooks. It records, for every emitted
 * instruction, the IR operations it implements and the part of the image it
 * belongs to. Fall-through jumps are omitted and branches are inverted when
 * the taken target is the next block.
 */
import type { Dest, IRProgram, Operand } from '../ir/ir.ts';
import { negatePred, swapPred } from '../ir/ir.ts';
import type { Allocation } from './alloc.ts';
import { allocate } from './alloc.ts';
import { LAYOUT } from './memory.ts';
import type { AsmItem, AsmOperand, Backend, CodeRegion, Emitter, FrameInfo, Home, Insn, InsnMeta, Src } from './types.ts';

export interface LoweredProgram {
  items: AsmItem[];
  frame: FrameInfo;
  alloc: Allocation;
}

const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor']);

export function blockLabel(id: number): string {
  return `.Lb${id}`;
}

export function lowerProgram(ir: IRProgram, backend: Backend): LoweredProgram {
  const { lowering, profile } = backend;
  const conv = profile.conventions;
  const alloc = allocate(ir, conv.varRegs, conv.tempRegs);
  const frame = lowering.frame(alloc.slotCount, lowering.needsLinkSave(ir));
  const [s0, s1] = conv.scratch;

  const items: AsmItem[] = [];
  let region: CodeRegion = 'startup';
  let irOps: number[] = [];
  let note: string | undefined;
  /** True while a boundary marker has been emitted with no instruction after it. */
  let pendingMark = false;

  const meta = (extra?: string): InsnMeta => {
    const m: InsnMeta = { region, irOps: irOps.slice() };
    const n = extra ?? note;
    if (n) m.note = n;
    return m;
  };
  const e: Emitter = {
    insn(mnemonic: string, operands: AsmOperand[], n?: string) {
      items.push({ kind: 'insn', insn: { mnemonic, operands }, meta: meta(n) });
      pendingMark = false;
    },
    pseudo(text: string, expansion: Insn[], n?: string) {
      expansion.forEach((insn, index) => {
        const m = meta(n);
        m.pseudo = { text, index, count: expansion.length };
        items.push({ kind: 'insn', insn, meta: m });
      });
      if (expansion.length > 0) pendingMark = false;
    },
    label(name: string) {
      items.push({ kind: 'label', name });
    },
    arrayAddress: (id: number) => LAYOUT.dataBase + ir.arrays[id]!.offset,
    arrayOffset: (id: number) => ir.arrays[id]!.offset,
  };

  const homeOf = (o: Dest): Home => (o.k === 'var' ? alloc.vars[o.id]! : alloc.temps[o.id]!);
  const src = (o: Operand, scratch: string): Src => {
    if (o.k === 'const') return { imm: o.value };
    const h = homeOf(o);
    if (h.kind === 'reg') return { reg: h.reg };
    lowering.loadSlot(e, scratch, frame.slotOffsets[h.index]!);
    return { reg: scratch };
  };
  const reg = (o: Operand, scratch: string): string => {
    const s = src(o, scratch);
    if ('reg' in s) return s.reg;
    lowering.mov(e, scratch, s);
    return scratch;
  };
  /** Run `compute` with the register that receives the result, then store it when the home is a slot. */
  const into = (d: Dest, compute: (r: string) => void): void => {
    const h = homeOf(d);
    if (h.kind === 'reg') compute(h.reg);
    else {
      compute(s0);
      lowering.storeSlot(e, s0, frame.slotOffsets[h.index]!);
    }
  };

  // Startup stub.
  region = 'startup';
  note = undefined;
  e.label('_start');
  lowering.startup(e);

  // Entry function.
  region = 'main';
  note = 'prologue';
  e.label('main');
  lowering.prologue(e, frame, ir.params.map((id) => alloc.vars[id]!));
  note = undefined;

  const referenced = new Set<number>();
  for (const b of ir.blocks) {
    if (b.term.op === 'jump') referenced.add(b.term.target);
    else if (b.term.op === 'br') {
      referenced.add(b.term.then);
      referenced.add(b.term.else);
    }
  }

  ir.blocks.forEach((b, bi) => {
    region = b.term.op === 'trap' ? 'trap' : 'main';
    if (referenced.has(b.id)) e.label(blockLabel(b.id));
    pendingMark = false;
    for (const op of b.ops) {
      irOps = [op.id];
      switch (op.op) {
        case 'mark':
          items.push({ kind: 'mark', stmt: op.stmt });
          pendingMark = true;
          break;
        case 'copy': {
          const h = homeOf(op.dst);
          const s = src(op.src, s0);
          if (h.kind === 'reg') {
            if (!('reg' in s) || s.reg !== h.reg) lowering.mov(e, h.reg, s);
          } else if ('reg' in s) {
            lowering.storeSlot(e, s.reg, frame.slotOffsets[h.index]!);
          } else {
            lowering.mov(e, s0, s);
            lowering.storeSlot(e, s0, frame.slotOffsets[h.index]!);
          }
          break;
        }
        case 'un': {
          const a = reg(op.a, s0);
          into(op.dst, (r) => lowering.un(e, op.fn, r, a));
          break;
        }
        case 'bin': {
          let { a, b: bb } = op;
          if (a.k === 'const' && bb.k !== 'const' && COMMUTATIVE.has(op.fn)) [a, bb] = [bb, a];
          const ar = reg(a, s0);
          const bs = src(bb, s1);
          into(op.dst, (r) => lowering.bin(e, op.fn, r, ar, bs));
          break;
        }
        case 'cmp': {
          let { a, b: bb, pred } = op;
          if (a.k === 'const' && bb.k !== 'const') {
            [a, bb] = [bb, a];
            pred = swapPred(pred);
          }
          const ar = reg(a, s0);
          const bs = src(bb, s1);
          into(op.dst, (r) => lowering.cmpSet(e, pred, r, ar, bs));
          break;
        }
        case 'load': {
          const index = src(op.index, s0);
          into(op.dst, (r) => lowering.load(e, r, op.array, index));
          break;
        }
        case 'store': {
          const index = src(op.index, s0);
          const value = src(op.value, s1);
          lowering.store(e, value, op.array, index);
          break;
        }
        case 'print':
          lowering.print(e, src(op.a, s0));
          break;
      }
    }
    const t = b.term;
    irOps = [t.id];
    const next = bi + 1 < ir.blocks.length ? ir.blocks[bi + 1]!.id : -1;
    switch (t.op) {
      case 'jump':
        // A block whose marker has no instruction after it keeps its jump, so the marker has an address of its own.
        if (t.target !== next || pendingMark) lowering.jump(e, blockLabel(t.target));
        break;
      case 'br': {
        let { a, b: bb, pred } = t;
        if (a.k === 'const' && bb.k !== 'const') {
          [a, bb] = [bb, a];
          pred = swapPred(pred);
        }
        const ar = reg(a, s0);
        const bs = src(bb, s1);
        if (t.then === next) lowering.branch(e, negatePred(pred), ar, bs, blockLabel(t.else));
        else {
          lowering.branch(e, pred, ar, bs, blockLabel(t.then));
          if (t.else !== next) lowering.jump(e, blockLabel(t.else));
        }
        break;
      }
      case 'ret':
        lowering.ret(e, frame, src(t.a, s0));
        break;
      case 'trap':
        note = 'runtime error';
        lowering.trap(e, t.code);
        note = undefined;
        break;
    }
  });

  region = 'helper';
  irOps = [];
  note = undefined;
  lowering.helpers(e, ir);

  // Keep only the labels that an instruction refers to, plus the entry points.
  const used = new Set<string>(['_start', 'main']);
  for (const it of items) {
    if (it.kind === 'insn') for (const o of it.insn.operands) if (o.t === 'label') used.add(o.name);
  }
  return { items: items.filter((it) => it.kind !== 'label' || used.has(it.name)), frame, alloc };
}
