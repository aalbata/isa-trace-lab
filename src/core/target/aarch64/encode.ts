/**
 * A64 encoder. `encodeWord` validates the operands of one canonical
 * instruction and returns its 32-bit word. Register number 31 is accepted
 * only under the name that the operand position gives it (the stack pointer
 * or the zero register). Branch targets are absolute addresses and are
 * converted to PC-relative offsets here.
 */
import { wordToBytesLE } from '../../util/int32.ts';
import type { Insn, TargetAsm } from '../types.ts';
import type { RegRef } from './isa.ts';
import { SPEC_BY_MNEMONIC, condIndex, encodeBitmask, parseReg } from './isa.ts';
import { logicalImmediate } from './text.ts';

function fail(message: string): never {
  throw new Error(message);
}

const SHIFT_CODE: Record<string, number> = { lsl: 0, lsr: 1, asr: 2, ror: 3 };
const EXTEND_CODE: Record<string, number> = { uxtw: 2, lsl: 3, sxtw: 6, sxtx: 7 };

/** Register operand `i`; `r31` states which meaning of register 31 the position has. */
function reg(insn: Insn, i: number, r31: 'sp' | 'zr'): RegRef {
  const o = insn.operands[i];
  if (!o || o.t !== 'reg') fail(`operand ${i + 1} of '${insn.mnemonic}' must be a register`);
  const r = parseReg(o.name);
  if (!r) fail(`unknown register '${o.name}'`);
  if (r.kind === 'sp' && r31 === 'zr') fail(`operand ${i + 1} of '${insn.mnemonic}' cannot be the stack pointer; register 31 is the zero register in this position`);
  if (r.kind === 'zr' && r31 === 'sp') fail(`operand ${i + 1} of '${insn.mnemonic}' cannot be the zero register; register 31 is the stack pointer in this position`);
  return r;
}

function sameWidth(insn: Insn, first: RegRef, ...rest: RegRef[]): number {
  for (const r of rest) if (r.bits !== first.bits) fail(`the registers of '${insn.mnemonic}' must all be W registers or all be X registers`);
  return first.bits === 64 ? 1 : 0;
}

function imm(insn: Insn, i: number, lo: number, hi: number, what: string): number {
  const o = insn.operands[i];
  if (!o || o.t !== 'imm') fail(`operand ${i + 1} of '${insn.mnemonic}' must be an immediate`);
  if (!Number.isInteger(o.value) || o.value < lo || o.value > hi) fail(`${what} ${o.value} is outside ${lo} to ${hi}`);
  return o.value;
}

function count(insn: Insn, min: number, max: number = min): void {
  const n = insn.operands.length;
  if (n < min || n > max) fail(`'${insn.mnemonic}' takes ${min === max ? min : `${min} to ${max}`} operand${max === 1 ? '' : 's'}, found ${n}`);
}

/** Optional shift operand at position `i`: returns [type, amount]. */
function shiftOperand(insn: Insn, i: number, bits: number, allowRor: boolean): [number, number] {
  const o = insn.operands[i];
  if (!o) return [0, 0];
  if (o.t !== 'shift') fail(`operand ${i + 1} of '${insn.mnemonic}' must be a shift such as lsl #3`);
  const code = SHIFT_CODE[o.kind];
  if (code === undefined || (code === 3 && !allowRor)) fail(`shift '${o.kind}' is not available for '${insn.mnemonic}'; use lsl, lsr, ${allowRor ? 'asr, or ror' : 'or asr'}`);
  if (!Number.isInteger(o.amount) || o.amount < 0 || o.amount >= bits) fail(`shift amount ${o.amount} is outside 0 to ${bits - 1}`);
  return [code, o.amount];
}

function offset(insn: Insn, i: number, pc: number, fieldBits: number): number {
  const o = insn.operands[i];
  if (!o || o.t !== 'addr') fail(`operand ${i + 1} of '${insn.mnemonic}' must be a label or an address`);
  const off = o.value - pc;
  const reach = 2 ** (fieldBits + 1);
  if (off % 4 !== 0) fail(`branch offset ${off} is not a multiple of 4`);
  if (off < -reach || off > reach - 4) fail(`branch target is ${off} bytes away; the ${fieldBits}-bit offset reaches ${-reach} to ${reach - 4}`);
  return (off / 4) & (2 ** fieldBits - 1);
}

/** Word of one A64 instruction located at address `pc`. Throws an Error that explains an invalid operand. */
export function encodeWord(insn: Insn, pc: number): number {
  const spec = SPEC_BY_MNEMONIC.get(insn.mnemonic);
  if (!spec) fail(`'${insn.mnemonic}' is not an A64 instruction implemented by this profile`);
  const m = insn.mnemonic;
  const o = insn.operands;
  const code = spec.code;
  switch (spec.klass) {
    case 'addsub': {
      count(insn, 3, 4);
      const flags = (code & 1) === 1;
      if (o[2]?.t === 'imm') {
        const rd = reg(insn, 0, flags ? 'zr' : 'sp');
        const rn = reg(insn, 1, 'sp');
        const sf = sameWidth(insn, rd, rn);
        const v = imm(insn, 2, 0, 4095, 'immediate');
        let sh = 0;
        const s = o[3];
        if (s) {
          if (s.t !== 'shift' || s.kind !== 'lsl' || (s.amount !== 0 && s.amount !== 12)) fail(`the immediate of '${m}' may only be shifted by lsl #12`);
          sh = s.amount === 12 ? 1 : 0;
        }
        return (0x11000000 | (sf << 31) | (code << 29) | (sh << 22) | (v << 10) | (rn.n << 5) | rd.n) >>> 0;
      }
      for (const i of [0, 1]) {
        const x = o[i];
        if (x?.t === 'reg' && parseReg(x.name)?.kind === 'sp') {
          fail(`'${m}' with the stack pointer and a register operand needs the extended-register form, which is outside the subset`);
        }
      }
      const rd = reg(insn, 0, 'zr');
      const rn = reg(insn, 1, 'zr');
      const rm = reg(insn, 2, 'zr');
      const sf = sameWidth(insn, rd, rn, rm);
      const [type, amount] = shiftOperand(insn, 3, rd.bits, false);
      return (0x0b000000 | (sf << 31) | (code << 29) | (type << 22) | (rm.n << 16) | (amount << 10) | (rn.n << 5) | rd.n) >>> 0;
    }
    case 'logic':
    case 'logicn': {
      if (spec.klass === 'logic' && o[2]?.t === 'imm') {
        count(insn, 3, 4);
        const rd = reg(insn, 0, m === 'ands' ? 'zr' : 'sp');
        const rn = reg(insn, 1, 'zr');
        const sf = sameWidth(insn, rd, rn);
        if (o[3] && (o[3].t !== 'imm' || !sf)) fail(`'${m}' with an immediate takes 3 operands`);
        const value = logicalImmediate(insn)!;
        if (!sf && o[2].value !== o[2].value >>> 0) fail(`immediate ${o[2].value} of '${m}' must be given as an unsigned 32-bit value`);
        const f = encodeBitmask(value, rd.bits);
        if (!f) {
          fail(`0x${value.toString(16)} is not a logical immediate: the value must be a rotated run of ones repeated every 2, 4, 8, 16, 32, or 64 bits, and not zero or all ones`);
        }
        return (0x12000000 | (sf << 31) | (code << 29) | (f.n << 22) | (f.immr << 16) | (f.imms << 10) | (rn.n << 5) | rd.n) >>> 0;
      }
      count(insn, 3, 4);
      const rd = reg(insn, 0, 'zr');
      const rn = reg(insn, 1, 'zr');
      const rm = reg(insn, 2, 'zr');
      const sf = sameWidth(insn, rd, rn, rm);
      const [type, amount] = shiftOperand(insn, 3, rd.bits, true);
      const inverted = spec.klass === 'logicn' ? 1 : 0;
      return (0x0a000000 | (sf << 31) | (code << 29) | (type << 22) | (inverted << 21) | (rm.n << 16) | (amount << 10) | (rn.n << 5) | rd.n) >>> 0;
    }
    case 'movw': {
      count(insn, 2, 3);
      const rd = reg(insn, 0, 'zr');
      const sf = rd.bits === 64 ? 1 : 0;
      const v = imm(insn, 1, 0, 65535, 'immediate');
      let hw = 0;
      const s = o[2];
      if (s) {
        if (s.t !== 'shift' || s.kind !== 'lsl' || s.amount % 16 !== 0 || s.amount < 0 || s.amount >= rd.bits) {
          fail(`the immediate of '${m}' may be shifted by lsl #0${sf ? ', #16, #32, or #48' : ' or #16'}`);
        }
        hw = s.amount / 16;
      }
      return (0x12800000 | (sf << 31) | (code << 29) | (hw << 21) | (v << 5) | rd.n) >>> 0;
    }
    case 'shiftv': {
      count(insn, 3);
      const rd = reg(insn, 0, 'zr');
      const rn = reg(insn, 1, 'zr');
      const rm = reg(insn, 2, 'zr');
      const sf = sameWidth(insn, rd, rn, rm);
      return (0x1ac02000 | (sf << 31) | (rm.n << 16) | (code << 10) | (rn.n << 5) | rd.n) >>> 0;
    }
    case 'bitfield': {
      count(insn, 4);
      const rd = reg(insn, 0, 'zr');
      const rn = reg(insn, 1, 'zr');
      const sf = sameWidth(insn, rd, rn);
      const immr = imm(insn, 2, 0, rd.bits - 1, 'immr');
      const imms = imm(insn, 3, 0, rd.bits - 1, 'imms');
      return (0x13000000 | (sf << 31) | (code << 29) | (sf << 22) | (immr << 16) | (imms << 10) | (rn.n << 5) | rd.n) >>> 0;
    }
    case 'mul': {
      count(insn, 4);
      const rd = reg(insn, 0, 'zr');
      const rn = reg(insn, 1, 'zr');
      const rm = reg(insn, 2, 'zr');
      const ra = reg(insn, 3, 'zr');
      const sf = sameWidth(insn, rd, rn, rm, ra);
      return (0x1b000000 | (sf << 31) | (rm.n << 16) | (code << 15) | (ra.n << 10) | (rn.n << 5) | rd.n) >>> 0;
    }
    case 'csel': {
      count(insn, 4);
      const rd = reg(insn, 0, 'zr');
      const rn = reg(insn, 1, 'zr');
      const rm = reg(insn, 2, 'zr');
      const sf = sameWidth(insn, rd, rn, rm);
      const c = o[3];
      if (!c || c.t !== 'cond' || condIndex(c.name) < 0) fail(`operand 4 of '${m}' must be a condition such as eq, ne, lt, or hs`);
      return (0x1a800000 | (sf << 31) | (rm.n << 16) | (condIndex(c.name) << 12) | (code << 10) | (rn.n << 5) | rd.n) >>> 0;
    }
    case 'b':
      count(insn, 1);
      return (0x14000000 | (code << 31) | offset(insn, 0, pc, 26)) >>> 0;
    case 'bcond':
      count(insn, 1);
      return (0x54000000 | (offset(insn, 0, pc, 19) << 5) | code) >>> 0;
    case 'cb': {
      count(insn, 2);
      const rt = reg(insn, 0, 'zr');
      return (0x34000000 | ((rt.bits === 64 ? 1 : 0) << 31) | (code << 24) | (offset(insn, 1, pc, 19) << 5) | rt.n) >>> 0;
    }
    case 'breg': {
      count(insn, 1);
      const rn = reg(insn, 0, 'zr');
      if (rn.bits !== 64) fail(`'${m}' takes an X register`);
      return (0xd61f0000 | (code << 21) | (rn.n << 5)) >>> 0;
    }
    case 'mem': {
      count(insn, 2);
      const rt = reg(insn, 0, 'zr');
      const size = code >> 1;
      const bytes = size === 2 && rt.bits === 64 ? 8 : 1 << size;
      if (size < 2 && rt.bits !== 32) fail(`'${m}' transfers a W register`);
      const a = o[1];
      if (!a || a.t !== 'mem' || a.base === null) fail(`operand 2 of '${m}' must be a memory operand such as [x1, #8] or [x1, w2, uxtw #2]`);
      const base = parseReg(a.base);
      if (!base || base.bits !== 64 || base.kind === 'zr') fail(`the base register '${a.base}' must be an X register or sp`);
      const head = ((Math.log2(bytes) << 30) | ((code & 1) << 22) | (base.n << 5) | rt.n) >>> 0;
      if (a.index === undefined) {
        const d = a.disp;
        if (!Number.isInteger(d) || d < 0 || d % bytes !== 0 || d > 4095 * bytes) {
          fail(`offset ${d} is not encodable: the unsigned offset form takes a multiple of ${bytes} from 0 to ${4095 * bytes}; the unscaled forms (ldur, stur) are outside the subset`);
        }
        return (0x39000000 | head | ((d / bytes) << 10)) >>> 0;
      }
      if (a.disp !== 0) fail(`a memory operand with an index register cannot also have an offset`);
      const index = parseReg(a.index);
      const option = EXTEND_CODE[a.ext ?? 'lsl'];
      if (!index || index.kind === 'sp') fail(`'${a.index}' is not an index register`);
      if (option === undefined) fail(`extend '${a.ext}' is not available; use lsl, uxtw, sxtw, or sxtx`);
      if ((option & 1 ? 64 : 32) !== index.bits) fail(`the index of '${a.ext ?? 'lsl'}' must be ${option & 1 ? 'an X' : 'a W'} register`);
      let s = 0;
      if (a.shift !== undefined) {
        const full = Math.log2(bytes);
        if (a.shift !== full && a.shift !== 0) fail(`the index of a ${bytes}-byte access may be shifted by ${full === 0 ? '0' : `0 or ${full}`}, not ${a.shift}`);
        s = a.shift === full ? 1 : 0;
      }
      return (0x38200800 | head | (index.n << 16) | (option << 13) | (s << 12)) >>> 0;
    }
    case 'svc':
      count(insn, 1);
      return (0xd4000001 | (imm(insn, 0, 0, 65535, 'immediate') << 5)) >>> 0;
    case 'nop':
      count(insn, 0);
      return 0xd503201f;
  }
}

export const aarch64Asm: TargetAsm = {
  size: () => 4,
  // Conditional branches reach 1 MiB in each direction, more than the 64 KiB code region, so no branch needs a long form.
  relaxable: () => false,
  shortFits: () => true,
  relaxLong: () => null,
  encode: (insn, pc) => wordToBytesLE(encodeWord(insn, pc)),
};
