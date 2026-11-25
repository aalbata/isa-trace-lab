/**
 * Instruction selection for RV32I.
 *
 * Conventions: variables live in s0 to s11, temporaries in t0 to t2 and a2 to
 * a5, and t3 to t6 are scratch. gp holds the start of the data region, so
 * array elements are addressed relative to gp. RV32I has no multiply
 * instruction; multiplication calls the shift-and-add helper `__mul`.
 */
import type { BinFn, IRProgram, Pred, UnFn } from '../../ir/ir.ts';
import { signExtend } from '../../util/int32.ts';
import { LAYOUT, SERVICE } from '../memory.ts';
import type { AsmOperand, Emitter, FrameInfo, Home, Insn, Src, TargetLowering } from '../types.ts';
import { expandLi } from './text.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const M = (base: string, disp: number): AsmOperand => ({ t: 'mem', base, disp });
const L = (name: string): AsmOperand => ({ t: 'label', name });
const fits12 = (v: number): boolean => v >= -2048 && v <= 2047;

const S2 = 't5';
const S3 = 't6';

function li(e: Emitter, rd: string, value: number, note?: string): void {
  e.pseudo(`li ${rd}, ${value}`, expandLi(rd, value), note);
}

function mv(e: Emitter, rd: string, rs: string, note?: string): void {
  if (rd === rs) return;
  e.pseudo(`mv ${rd}, ${rs}`, [{ mnemonic: 'addi', operands: [R(rd), R(rs), I(0)] }], note);
}

/** Register holding the operand: the register itself, x0 for zero, or `scratch` loaded with the constant. */
function regFor(e: Emitter, s: Src, scratch: string): string {
  if ('reg' in s) return s.reg;
  if (s.imm === 0) return 'zero';
  li(e, scratch, s.imm);
  return scratch;
}

/**
 * Base register and offset of a stack slot. An offset beyond the 12-bit field is split as for lui and addi:
 * t6 receives sp plus the upper part, and the sign-extended low 12 bits remain as the offset.
 */
function slotAddress(e: Emitter, offset: number): { base: string; disp: number } {
  if (fits12(offset)) return { base: 'sp', disp: offset };
  const lo = signExtend(offset & 0xfff, 12);
  e.insn('lui', [R(S3), I(((offset - lo) >>> 12) & 0xfffff)], 'upper part of the slot offset');
  e.insn('add', [R(S3), R(S3), R('sp')], 'sp plus the upper part of the slot offset');
  return { base: S3, disp: lo };
}

/** Add a constant to the stack pointer. */
function adjustStack(e: Emitter, amount: number, note: string): void {
  if (fits12(amount)) {
    e.insn('addi', [R('sp'), R('sp'), I(amount)], note);
    return;
  }
  li(e, S3, amount);
  e.insn('add', [R('sp'), R('sp'), R(S3)], note);
}

/** Base register and offset that address element `index` of an array. */
function elementAddress(e: Emitter, arrayId: number, index: Src): { base: string; disp: number } {
  const offset = e.arrayOffset(arrayId);
  if ('imm' in index) {
    const disp = offset + 4 * index.imm;
    if (fits12(disp)) return { base: 'gp', disp };
    li(e, S3, disp);
    e.insn('add', [R(S3), R(S3), R('gp')]);
    return { base: S3, disp: 0 };
  }
  e.insn('slli', [R(S2), R(index.reg), I(2)], 'index times 4');
  e.insn('add', [R(S2), R(S2), R('gp')], 'plus start of data');
  if (fits12(offset)) return { base: S2, disp: offset };
  li(e, S3, offset);
  e.insn('add', [R(S2), R(S2), R(S3)]);
  return { base: S2, disp: 0 };
}

export const riscvLowering: TargetLowering = {
  needsLinkSave(ir: IRProgram): boolean {
    return ir.blocks.some((b) => b.ops.some((op) => op.op === 'bin' && op.fn === 'mul'));
  },

  frame(slotCount: number, saveLink: boolean): FrameInfo {
    const words = slotCount + (saveLink ? 1 : 0);
    const size = Math.ceil((4 * words) / 16) * 16;
    const slotOffsets = Array.from({ length: slotCount }, (_, i) => 4 * i);
    return { size, slotOffsets, linkOffset: saveLink ? size - 4 : null };
  },

  startup(e: Emitter): void {
    e.insn('lui', [R('gp'), I(LAYOUT.dataBase >>> 12)], 'gp = start of the data region');
    e.insn('jal', [R('ra'), L('main')], 'call main');
    li(e, 'a7', SERVICE.exit, 'exit service; a0 holds the return value');
    e.insn('ecall', []);
  },

  prologue(e: Emitter, frame: FrameInfo, params: Home[]): void {
    if (frame.size > 0) adjustStack(e, -frame.size, 'allocate the stack frame');
    if (frame.linkOffset !== null) {
      const at = slotAddress(e, frame.linkOffset);
      e.insn('sw', [R('ra'), M(at.base, at.disp)], 'save the return address');
    }
    params.forEach((h, i) => {
      const arg = `a${i}`;
      if (h.kind === 'reg') mv(e, h.reg, arg, 'parameter to its home register');
      else {
        const at = slotAddress(e, frame.slotOffsets[h.index]!);
        e.insn('sw', [R(arg), M(at.base, at.disp)], 'parameter to its stack slot');
      }
    });
  },

  ret(e: Emitter, frame: FrameInfo, value: Src): void {
    if ('imm' in value) li(e, 'a0', value.imm, 'return value');
    else mv(e, 'a0', value.reg, 'return value');
    if (frame.linkOffset !== null) {
      const at = slotAddress(e, frame.linkOffset);
      e.insn('lw', [R('ra'), M(at.base, at.disp)], 'restore the return address');
    }
    if (frame.size > 0) adjustStack(e, frame.size, 'release the stack frame');
    e.pseudo('ret', [{ mnemonic: 'jalr', operands: [R('zero'), M('ra', 0)] }], 'return to the caller');
  },

  loadSlot(e: Emitter, dst: string, offset: number): void {
    const at = slotAddress(e, offset);
    e.insn('lw', [R(dst), M(at.base, at.disp)], 'load from stack slot');
  },

  storeSlot(e: Emitter, src: string, offset: number): void {
    const at = slotAddress(e, offset);
    e.insn('sw', [R(src), M(at.base, at.disp)], 'store to stack slot');
  },

  mov(e: Emitter, dst: string, src: Src): void {
    if ('imm' in src) li(e, dst, src.imm);
    else mv(e, dst, src.reg);
  },

  un(e: Emitter, fn: UnFn, dst: string, a: string): void {
    if (fn === 'neg') e.pseudo(`neg ${dst}, ${a}`, [{ mnemonic: 'sub', operands: [R(dst), R('zero'), R(a)] }]);
    else if (fn === 'not') e.pseudo(`not ${dst}, ${a}`, [{ mnemonic: 'xori', operands: [R(dst), R(a), I(-1)] }]);
    else e.insn('xori', [R(dst), R(a), I(1)], 'Boolean negation');
  },

  bin(e: Emitter, fn: BinFn, dst: string, a: string, b: Src): void {
    if (fn === 'mul') {
      // The multiplier is moved first so that a multiplicand already in a1 cannot be overwritten; neither is a0 or a1.
      mv(e, 'a0', a, 'multiplicand');
      if ('imm' in b) li(e, 'a1', b.imm, 'multiplier');
      else mv(e, 'a1', b.reg, 'multiplier');
      e.insn('jal', [R('ra'), L('__mul')], 'call the software multiplication helper');
      mv(e, dst, 'a0', 'product');
      return;
    }
    if ('imm' in b) {
      const v = b.imm;
      switch (fn) {
        case 'add':
          if (fits12(v)) return e.insn('addi', [R(dst), R(a), I(v)]);
          break;
        case 'sub':
          if (fits12(-v) && v !== -2147483648) return e.insn('addi', [R(dst), R(a), I(-v)], `subtract ${v}`);
          break;
        case 'and':
          if (fits12(v)) return e.insn('andi', [R(dst), R(a), I(v)]);
          break;
        case 'or':
          if (fits12(v)) return e.insn('ori', [R(dst), R(a), I(v)]);
          break;
        case 'xor':
          if (fits12(v)) return e.insn('xori', [R(dst), R(a), I(v)]);
          break;
        case 'shl':
          return e.insn('slli', [R(dst), R(a), I(v)]);
        case 'sar':
          return e.insn('srai', [R(dst), R(a), I(v)]);
      }
    }
    const rb = regFor(e, b, S2);
    const mnemonic = { add: 'add', sub: 'sub', and: 'and', or: 'or', xor: 'xor', shl: 'sll', sar: 'sra' }[fn as Exclude<BinFn, 'mul'>];
    e.insn(mnemonic, [R(dst), R(a), R(rb)]);
  },

  cmpSet(e: Emitter, pred: Pred, dst: string, a: string, b: Src): void {
    const unsigned = pred.endsWith('u');
    const slt = unsigned ? 'sltu' : 'slt';
    switch (pred) {
      case 'eq':
      case 'ne': {
        let diff = a;
        if (!('imm' in b && b.imm === 0)) {
          if ('imm' in b && fits12(b.imm)) e.insn('xori', [R(S2), R(a), I(b.imm)], 'zero when equal');
          else e.insn('xor', [R(S2), R(a), R(regFor(e, b, S2))], 'zero when equal');
          diff = S2;
        }
        if (pred === 'eq') e.pseudo(`seqz ${dst}, ${diff}`, [{ mnemonic: 'sltiu', operands: [R(dst), R(diff), I(1)] }]);
        else e.pseudo(`snez ${dst}, ${diff}`, [{ mnemonic: 'sltu', operands: [R(dst), R('zero'), R(diff)] }]);
        return;
      }
      case 'lt':
      case 'ltu':
        if ('imm' in b && fits12(b.imm)) e.insn(unsigned ? 'sltiu' : 'slti', [R(dst), R(a), I(b.imm)]);
        else e.insn(slt, [R(dst), R(a), R(regFor(e, b, S2))]);
        return;
      case 'ge':
      case 'geu':
        if ('imm' in b && fits12(b.imm)) e.insn(unsigned ? 'sltiu' : 'slti', [R(dst), R(a), I(b.imm)]);
        else e.insn(slt, [R(dst), R(a), R(regFor(e, b, S2))]);
        e.insn('xori', [R(dst), R(dst), I(1)], 'invert: a >= b is not (a < b)');
        return;
      case 'gt':
      case 'gtu':
        e.insn(slt, [R(dst), R(regFor(e, b, S2)), R(a)], 'a > b is b < a');
        return;
      case 'le':
      case 'leu':
        e.insn(slt, [R(dst), R(regFor(e, b, S2)), R(a)], 'b < a');
        e.insn('xori', [R(dst), R(dst), I(1)], 'invert: a <= b is not (b < a)');
        return;
    }
  },

  branch(e: Emitter, pred: Pred, a: string, b: Src, label: string): void {
    const rb = regFor(e, b, S2);
    const t = L(label);
    switch (pred) {
      case 'eq': return e.insn('beq', [R(a), R(rb), t]);
      case 'ne': return e.insn('bne', [R(a), R(rb), t]);
      case 'lt': return e.insn('blt', [R(a), R(rb), t]);
      case 'ge': return e.insn('bge', [R(a), R(rb), t]);
      case 'gt': return e.insn('blt', [R(rb), R(a), t], 'a > b is b < a');
      case 'le': return e.insn('bge', [R(rb), R(a), t], 'a <= b is b >= a');
      case 'ltu': return e.insn('bltu', [R(a), R(rb), t]);
      case 'geu': return e.insn('bgeu', [R(a), R(rb), t]);
      case 'gtu': return e.insn('bltu', [R(rb), R(a), t], 'a > b is b < a (unsigned)');
      case 'leu': return e.insn('bgeu', [R(rb), R(a), t], 'a <= b is b >= a (unsigned)');
    }
  },

  jump(e: Emitter, label: string): void {
    e.pseudo(`j ${label}`, [{ mnemonic: 'jal', operands: [R('zero'), L(label)] }]);
  },

  load(e: Emitter, dst: string, arrayId: number, index: Src): void {
    const at = elementAddress(e, arrayId, index);
    e.insn('lw', [R(dst), M(at.base, at.disp)], 'load array element');
  },

  store(e: Emitter, value: Src, arrayId: number, index: Src): void {
    // The value register is chosen before the address is formed; a constant value uses scratch t4.
    const rv = regFor(e, value, 't4');
    const at = elementAddress(e, arrayId, index);
    e.insn('sw', [R(rv), M(at.base, at.disp)], 'store array element');
  },

  print(e: Emitter, a: Src): void {
    if ('imm' in a) li(e, 'a0', a.imm, 'value to print');
    else mv(e, 'a0', a.reg, 'value to print');
    li(e, 'a7', SERVICE.print, 'output service');
    e.insn('ecall', []);
  },

  trap(e: Emitter, code: number): void {
    li(e, 'a0', code, 'error code');
    li(e, 'a7', SERVICE.error, 'error service');
    e.insn('ecall', []);
  },

  helpers(e: Emitter, ir: IRProgram): void {
    if (!this.needsLinkSave(ir)) return;
    // a0 = low 32 bits of a0 * a1, by shift and add. The low word is the same for signed and unsigned operands.
    const one = (mnemonic: string, operands: AsmOperand[]): Insn => ({ mnemonic, operands });
    e.label('__mul');
    e.pseudo('mv t5, a0', [one('addi', [R('t5'), R('a0'), I(0)])], 'multiplicand, shifted left each round');
    e.pseudo('li a0, 0', [one('addi', [R('a0'), R('zero'), I(0)])], 'product so far');
    e.label('__mul_loop');
    e.insn('andi', [R('t6'), R('a1'), I(1)], 'lowest bit of the multiplier');
    e.pseudo('beqz t6, __mul_skip', [one('beq', [R('t6'), R('zero'), L('__mul_skip')])]);
    e.insn('add', [R('a0'), R('a0'), R('t5')], 'add the shifted multiplicand');
    e.label('__mul_skip');
    e.insn('slli', [R('t5'), R('t5'), I(1)]);
    e.insn('srli', [R('a1'), R('a1'), I(1)]);
    e.pseudo('bnez a1, __mul_loop', [one('bne', [R('a1'), R('zero'), L('__mul_loop')])], 'repeat while multiplier bits remain');
    e.pseudo('ret', [one('jalr', [R('zero'), M('ra', 0)])]);
  },
};
