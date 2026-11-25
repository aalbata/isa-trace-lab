/**
 * Instruction selection for MIPS32 Release 2.
 *
 * Conventions: variables live in $s0 to $s7, temporaries in $t0 to $t5, and
 * $t6 to $t9 are scratch. $gp holds the start of the data region, so array
 * elements are addressed relative to $gp. Only the non-trapping addu, addiu,
 * and subu are generated. Every branch and jump is followed by a nop in its
 * delay slot. $at is never used.
 */
import type { BinFn, IRProgram, Pred, UnFn } from '../../ir/ir.ts';
import { LAYOUT, SERVICE } from '../memory.ts';
import type { AsmOperand, Emitter, FrameInfo, Home, Src, TargetLowering } from '../types.ts';
import { expandB, expandBranchZero, expandLi, NOP } from './text.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const M = (base: string, disp: number): AsmOperand => ({ t: 'mem', base, disp });
const L = (name: string): AsmOperand => ({ t: 'label', name });
const fitsSigned16 = (v: number): boolean => v >= -32768 && v <= 32767;
const fitsUnsigned16 = (v: number): boolean => v >= 0 && v <= 65535;

const ZERO = '$zero';
const S1 = '$t7';
const S2 = '$t8';
const S3 = '$t9';

function li(e: Emitter, rd: string, value: number, note?: string): void {
  e.pseudo(`li ${rd}, ${value}`, expandLi(rd, value), note);
}

/** Copy a register. Clang's assembler encodes move as or with $zero, and the same encoding is used here. */
function move(e: Emitter, rd: string, rs: string, note?: string): void {
  if (rd === rs) return;
  e.pseudo(`move ${rd}, ${rs}`, [{ mnemonic: 'or', operands: [R(rd), R(rs), R(ZERO)] }], note);
}

/** Fill the delay slot of the branch or jump just emitted. */
function delaySlot(e: Emitter): void {
  e.pseudo('nop', [NOP], 'delay slot: executes before the branch or jump takes effect');
}

/** Register holding the operand: the register itself, $zero for zero, or `scratch` loaded with the constant. */
function regFor(e: Emitter, s: Src, scratch: string): string {
  if ('reg' in s) return s.reg;
  if (s.imm === 0) return ZERO;
  li(e, scratch, s.imm);
  return scratch;
}

/** Base register and offset of a stack slot; an offset beyond the 16-bit field is added in a scratch register. */
function slotAddress(e: Emitter, offset: number): { base: string; disp: number } {
  if (fitsSigned16(offset)) return { base: '$sp', disp: offset };
  li(e, S3, offset);
  e.insn('addu', [R(S3), R(S3), R('$sp')]);
  return { base: S3, disp: 0 };
}

/** Add a constant to the stack pointer. */
function adjustStack(e: Emitter, amount: number, note: string): void {
  if (fitsSigned16(amount)) {
    e.insn('addiu', [R('$sp'), R('$sp'), I(amount)], note);
    return;
  }
  li(e, S3, amount);
  e.insn('addu', [R('$sp'), R('$sp'), R(S3)], note);
}

/** Base register and offset that address element `index` of an array. */
function elementAddress(e: Emitter, arrayId: number, index: Src): { base: string; disp: number } {
  const offset = e.arrayOffset(arrayId);
  if ('imm' in index) {
    const disp = offset + 4 * index.imm;
    if (fitsSigned16(disp)) return { base: '$gp', disp };
    li(e, S3, disp);
    e.insn('addu', [R(S3), R(S3), R('$gp')]);
    return { base: S3, disp: 0 };
  }
  e.insn('sll', [R(S2), R(index.reg), I(2)], 'index times 4');
  e.insn('addu', [R(S2), R(S2), R('$gp')], 'plus start of data');
  if (fitsSigned16(offset)) return { base: S2, disp: offset };
  li(e, S3, offset);
  e.insn('addu', [R(S2), R(S2), R(S3)]);
  return { base: S2, disp: 0 };
}

/** Set dst to 1 when a < b (signed or unsigned) and to 0 otherwise, using the immediate form when the constant fits. */
function lessThan(e: Emitter, unsigned: boolean, dst: string, a: string, b: Src): void {
  if ('imm' in b && fitsSigned16(b.imm)) e.insn(unsigned ? 'sltiu' : 'slti', [R(dst), R(a), I(b.imm)]);
  else e.insn(unsigned ? 'sltu' : 'slt', [R(dst), R(a), R(regFor(e, b, S2))]);
}

export const mipsLowering: TargetLowering = {
  needsLinkSave(): boolean {
    return false;
  },

  frame(slotCount: number, saveLink: boolean): FrameInfo {
    const words = slotCount + (saveLink ? 1 : 0);
    const size = Math.ceil((4 * words) / 8) * 8;
    const slotOffsets = Array.from({ length: slotCount }, (_, i) => 4 * i);
    return { size, slotOffsets, linkOffset: saveLink ? size - 4 : null };
  },

  startup(e: Emitter): void {
    e.insn('lui', [R('$gp'), I(LAYOUT.dataBase >>> 16)], '$gp = start of the data region');
    e.insn('jal', [L('main')], 'call main; $ra = address after the delay slot');
    delaySlot(e);
    move(e, '$a0', '$v0', 'return value of main becomes the service argument');
    li(e, '$v0', SERVICE.exit, 'exit service');
    e.insn('syscall', []);
  },

  prologue(e: Emitter, frame: FrameInfo, params: Home[]): void {
    if (frame.size > 0) adjustStack(e, -frame.size, 'allocate the stack frame');
    if (frame.linkOffset !== null) e.insn('sw', [R('$ra'), M('$sp', frame.linkOffset)], 'save the return address');
    params.forEach((h, i) => {
      const arg = `$a${i}`;
      if (h.kind === 'reg') move(e, h.reg, arg, 'parameter to its home register');
      else {
        const at = slotAddress(e, frame.slotOffsets[h.index]!);
        e.insn('sw', [R(arg), M(at.base, at.disp)], 'parameter to its stack slot');
      }
    });
  },

  ret(e: Emitter, frame: FrameInfo, value: Src): void {
    if ('imm' in value) li(e, '$v0', value.imm, 'return value');
    else move(e, '$v0', value.reg, 'return value');
    if (frame.linkOffset !== null) e.insn('lw', [R('$ra'), M('$sp', frame.linkOffset)], 'restore the return address');
    if (frame.size > 0) adjustStack(e, frame.size, 'release the stack frame');
    e.insn('jr', [R('$ra')], 'return to the caller');
    delaySlot(e);
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
    else move(e, dst, src.reg);
  },

  un(e: Emitter, fn: UnFn, dst: string, a: string): void {
    if (fn === 'neg') e.pseudo(`negu ${dst}, ${a}`, [{ mnemonic: 'subu', operands: [R(dst), R(ZERO), R(a)] }]);
    else if (fn === 'not') e.pseudo(`not ${dst}, ${a}`, [{ mnemonic: 'nor', operands: [R(dst), R(a), R(ZERO)] }]);
    else e.insn('xori', [R(dst), R(a), I(1)], 'Boolean negation');
  },

  bin(e: Emitter, fn: BinFn, dst: string, a: string, b: Src): void {
    if ('imm' in b) {
      const v = b.imm;
      switch (fn) {
        case 'add':
          if (fitsSigned16(v)) return e.insn('addiu', [R(dst), R(a), I(v)]);
          break;
        case 'sub':
          if (fitsSigned16(-v)) return e.insn('addiu', [R(dst), R(a), I(-v)], `subtract ${v}`);
          break;
        case 'and':
          if (fitsUnsigned16(v)) return e.insn('andi', [R(dst), R(a), I(v)]);
          break;
        case 'or':
          if (fitsUnsigned16(v)) return e.insn('ori', [R(dst), R(a), I(v)]);
          break;
        case 'xor':
          if (fitsUnsigned16(v)) return e.insn('xori', [R(dst), R(a), I(v)]);
          break;
        case 'shl':
          return e.insn('sll', [R(dst), R(a), I(v)]);
        case 'sar':
          return e.insn('sra', [R(dst), R(a), I(v)]);
      }
    }
    const rb = regFor(e, b, S2);
    switch (fn) {
      case 'add': return e.insn('addu', [R(dst), R(a), R(rb)]);
      case 'sub': return e.insn('subu', [R(dst), R(a), R(rb)]);
      case 'mul': return e.insn('mul', [R(dst), R(a), R(rb)], 'low 32 bits of the product');
      case 'and': return e.insn('and', [R(dst), R(a), R(rb)]);
      case 'or': return e.insn('or', [R(dst), R(a), R(rb)]);
      case 'xor': return e.insn('xor', [R(dst), R(a), R(rb)]);
      // The variable shifts take the value first and the count register last.
      case 'shl': return e.insn('sllv', [R(dst), R(a), R(rb)]);
      case 'sar': return e.insn('srav', [R(dst), R(a), R(rb)]);
    }
  },

  cmpSet(e: Emitter, pred: Pred, dst: string, a: string, b: Src): void {
    const unsigned = pred.endsWith('u');
    const slt = unsigned ? 'sltu' : 'slt';
    switch (pred) {
      case 'eq':
      case 'ne': {
        let diff = a;
        if (!('imm' in b && b.imm === 0)) {
          if ('imm' in b && fitsUnsigned16(b.imm)) e.insn('xori', [R(S2), R(a), I(b.imm)], 'zero when equal');
          else e.insn('xor', [R(S2), R(a), R(regFor(e, b, S2))], 'zero when equal');
          diff = S2;
        }
        if (pred === 'eq') e.insn('sltiu', [R(dst), R(diff), I(1)], '1 when the value is zero');
        else e.insn('sltu', [R(dst), R(ZERO), R(diff)], '1 when the value is not zero');
        return;
      }
      case 'lt':
      case 'ltu':
        lessThan(e, unsigned, dst, a, b);
        return;
      case 'ge':
      case 'geu':
        lessThan(e, unsigned, dst, a, b);
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
    const t = L(label);
    const unsigned = pred.endsWith('u');
    const slt = unsigned ? 'sltu' : 'slt';
    const zero = 'imm' in b && b.imm === 0;
    /** Branch on the comparison result held in S2, with the assembler's expansion of bnez or beqz. */
    const onResult = (whenSet: boolean, note: string): void => {
      const pseudo = whenSet ? 'bnez' : 'beqz';
      e.pseudo(`${pseudo} ${S2}, ${label}`, expandBranchZero(pseudo, R(S2), t), note);
    };
    switch (pred) {
      case 'eq':
        e.insn('beq', [R(a), R(regFor(e, b, S2)), t]);
        break;
      case 'ne':
        e.insn('bne', [R(a), R(regFor(e, b, S2)), t]);
        break;
      case 'lt':
      case 'ltu':
        if (zero && !unsigned) e.insn('bltz', [R(a), t]);
        else {
          lessThan(e, unsigned, S2, a, b);
          onResult(true, 'taken when a < b');
        }
        break;
      case 'ge':
      case 'geu':
        if (zero && !unsigned) e.insn('bgez', [R(a), t]);
        else {
          lessThan(e, unsigned, S2, a, b);
          onResult(false, 'taken when not (a < b)');
        }
        break;
      case 'gt':
      case 'gtu':
        if (zero && !unsigned) e.insn('bgtz', [R(a), t]);
        else {
          e.insn(slt, [R(S2), R(regFor(e, b, S2)), R(a)], 'b < a');
          onResult(true, 'taken when a > b');
        }
        break;
      case 'le':
      case 'leu':
        if (zero && !unsigned) e.insn('blez', [R(a), t]);
        else {
          e.insn(slt, [R(S2), R(regFor(e, b, S2)), R(a)], 'b < a');
          onResult(false, 'taken when not (b < a)');
        }
        break;
    }
    delaySlot(e);
  },

  jump(e: Emitter, label: string): void {
    e.pseudo(`b ${label}`, expandB(L(label)));
    delaySlot(e);
  },

  load(e: Emitter, dst: string, arrayId: number, index: Src): void {
    const at = elementAddress(e, arrayId, index);
    e.insn('lw', [R(dst), M(at.base, at.disp)], 'load array element');
  },

  store(e: Emitter, value: Src, arrayId: number, index: Src): void {
    // The value register is chosen before the address is formed; a constant value uses scratch $t7.
    const rv = regFor(e, value, S1);
    const at = elementAddress(e, arrayId, index);
    e.insn('sw', [R(rv), M(at.base, at.disp)], 'store array element');
  },

  print(e: Emitter, a: Src): void {
    if ('imm' in a) li(e, '$a0', a.imm, 'value to print');
    else move(e, '$a0', a.reg, 'value to print');
    li(e, '$v0', SERVICE.print, 'output service');
    e.insn('syscall', []);
  },

  trap(e: Emitter, code: number): void {
    li(e, '$a0', code, 'error code');
    li(e, '$v0', SERVICE.error, 'error service');
    e.insn('syscall', []);
  },

  helpers(_e: Emitter, _ir: IRProgram): void {
    // MIPS32 has a multiply instruction, so no runtime helper is needed.
  },
};
