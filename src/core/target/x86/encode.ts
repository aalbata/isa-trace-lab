/**
 * x86-64 encoder. `encodeInsn` validates the operands of one instruction and
 * returns its bytes: REX prefix when needed, opcode, ModR/M, SIB,
 * displacement, and immediate. Where several encodings exist, the one chosen
 * is the one that Clang's integrated assembler chooses for the same text.
 * Jump and call targets are absolute addresses and are converted to offsets
 * relative to the end of the instruction here.
 */
import type { AsmOperand, Insn, TargetAsm } from '../types.ts';
import type { RegRef } from './isa.ts';
import { ALU_EXT, ccNumber, isReg16, regRef, SHIFT_EXT, UNARY } from './isa.ts';

function fail(message: string): never {
  throw new Error(message);
}

type MemOperand = Extract<AsmOperand, { t: 'mem' }>;

const fits8 = (v: number): boolean => v >= -128 && v <= 127;

/** Instruction under construction. */
interface Parts {
  /** REX.W: 64-bit operand size. */
  w: boolean;
  opcode: number[];
  /** Value of the ModR/M reg field (register number or opcode extension), or -1 when there is no ModR/M byte. */
  reg: number;
  rm: AsmOperand | null;
  /** Register number added to the last opcode byte, or -1. */
  plus: number;
  /** Immediate bytes that follow the operands. */
  tail: number[];
  /** A byte register that needs a REX prefix (spl, bpl, sil, dil) is used. */
  needRex: boolean;
  /** A byte register that cannot be used with a REX prefix (ah, ch, dh, bh) is used. */
  noRex: boolean;
}

const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function count(insn: Insn, n: number): void {
  if (insn.operands.length !== n) fail(`'${insn.mnemonic}' takes ${n} operand${n === 1 ? '' : 's'}, found ${insn.operands.length}`);
}

function regOf(o: AsmOperand | undefined): RegRef | null {
  if (!o || o.t !== 'reg') return null;
  const r = regRef(o.name);
  if (!r) fail(isReg16(o.name) ? `'${o.name}' is a 16-bit register; the subset has 8-bit, 32-bit, and 64-bit registers only` : `unknown register '${o.name}'`);
  return r;
}

function isMem(o: AsmOperand | undefined): o is MemOperand {
  return o !== undefined && o.t === 'mem';
}

function immOf(insn: Insn, i: number): number {
  const o = insn.operands[i];
  if (!o || o.t !== 'imm') fail(`operand ${i + 1} of '${insn.mnemonic}' must be an immediate`);
  if (!Number.isInteger(o.value)) fail(`immediate ${o.value} is not an integer`);
  return o.value;
}

/** Immediate of an instruction with the given operand size, as a signed 32-bit value. */
function imm32For(v: number, size: 32 | 64): number {
  if (size === 32) {
    if (v < -2147483648 || v > 4294967295) fail(`immediate ${v} does not fit in 32 bits`);
    return v | 0;
  }
  if (v < -2147483648 || v > 2147483647) fail(`immediate ${v} does not fit in the 32-bit field, which is sign-extended to 64 bits (-2147483648 to 2147483647)`);
  return v;
}

/** ModR/M, SIB, and displacement bytes for an r/m operand, with the REX extension bits it needs. */
function encodeRm(regField: number, o: AsmOperand): { bytes: number[]; x: number; b: number } {
  if (o.t === 'reg') {
    const r = regRef(o.name)!;
    const num = r.high ? r.num + 4 : r.num;
    return { bytes: [0xc0 | ((regField & 7) << 3) | (num & 7)], x: 0, b: num >> 3 };
  }
  if (o.t !== 'mem') fail('operand must be a register or a memory operand');
  const addrReg = (name: string, what: string): number => {
    const r = regRef(name);
    if (!r) fail(`unknown register '${name}'`);
    if (r.size !== 64) fail(`${what} register '${name}' must be a 64-bit register`);
    return r.num;
  };
  const disp = o.disp;
  if (!Number.isInteger(disp) || disp < -2147483648 || disp > 2147483647) fail(`displacement ${disp} does not fit in 32 signed bits`);
  const base = o.base === null ? -1 : addrReg(o.base, 'base');
  const index = o.index === undefined ? -1 : addrReg(o.index, 'index');
  const scale = o.scale ?? 1;
  if (index === 4) fail('rsp cannot be an index register');
  if (index >= 0 && ![1, 2, 4, 8].includes(scale)) fail(`scale ${scale} is not 1, 2, 4, or 8`);
  const regBits = (regField & 7) << 3;
  if (base < 0) {
    // No base register: SIB with base 101 and mod 00, always followed by a 32-bit displacement.
    const sib = index < 0 ? 0x25 : (Math.log2(scale) << 6) | ((index & 7) << 3) | 5;
    return { bytes: [regBits | 4, sib, ...le32(disp)], x: index < 0 ? 0 : index >> 3, b: 0 };
  }
  // rbp and r13 as base have no encoding without a displacement.
  const mod = disp === 0 && (base & 7) !== 5 ? 0 : fits8(disp) ? 1 : 2;
  const dispBytes = mod === 0 ? [] : mod === 1 ? [disp & 0xff] : le32(disp);
  if (index < 0 && (base & 7) !== 4) return { bytes: [(mod << 6) | regBits | (base & 7), ...dispBytes], x: 0, b: base >> 3 };
  // An index register, or rsp or r12 as base, needs the SIB byte.
  const sib = index < 0 ? 0x20 | (base & 7) : (Math.log2(scale) << 6) | ((index & 7) << 3) | (base & 7);
  return { bytes: [(mod << 6) | regBits | 4, sib, ...dispBytes], x: index < 0 ? 0 : index >> 3, b: base >> 3 };
}

function build(p: Parts): number[] {
  let r = 0;
  let x = 0;
  let b = 0;
  let body: number[] = [];
  const opcode = p.opcode.slice();
  if (p.plus >= 0) {
    opcode[opcode.length - 1]! += p.plus & 7;
    b = p.plus >> 3;
  }
  if (p.reg >= 0 && p.rm) {
    const m = encodeRm(p.reg, p.rm);
    body = m.bytes;
    r = p.reg >> 3;
    x = m.x;
    b = m.b;
  }
  const rex = 0x40 | (p.w ? 8 : 0) | (r << 2) | (x << 1) | b;
  const out: number[] = [];
  if (rex !== 0x40 || p.needRex) {
    if (p.noRex) fail('ah, ch, dh, and bh cannot be used in an instruction that needs a REX prefix');
    out.push(rex);
  }
  out.push(...opcode, ...body, ...p.tail);
  return out;
}

const parts = (opcode: number[], o: Partial<Parts> = {}): Parts => ({ w: false, opcode, reg: -1, rm: null, plus: -1, tail: [], needRex: false, noRex: false, ...o });

/** Operand size of a register or sized memory operand; 0 when a memory operand carries no size. */
function sizeOf(o: AsmOperand): number {
  if (o.t === 'reg') return regOf(o)!.size;
  if (o.t === 'mem') return o.size ?? 0;
  return 0;
}

/** Common operand size of a register-or-memory pair, which must be 32 or 64 bits. */
function pairSize(insn: Insn, a: AsmOperand, b: AsmOperand): 32 | 64 {
  const sa = sizeOf(a);
  const sb = sizeOf(b);
  const size = sa || sb;
  if (sa && sb && sa !== sb) fail(`operands of '${insn.mnemonic}' have different sizes (${sa} and ${sb} bits)`);
  if (size !== 32 && size !== 64) fail(`'${insn.mnemonic}' is implemented for 32-bit and 64-bit operands only`);
  return size;
}

/** Operand size of a single r/m operand; a memory operand must state it. */
function rmSize(insn: Insn, o: AsmOperand): 32 | 64 {
  const s = sizeOf(o);
  if (isMem(o) && s === 0) fail(`the operand size of '${insn.mnemonic}' is ambiguous; write dword ptr or qword ptr before the memory operand`);
  if (s !== 32 && s !== 64) fail(`'${insn.mnemonic}' is implemented for 32-bit and 64-bit operands only`);
  return s;
}

function needRm(insn: Insn, i: number): AsmOperand {
  const o = insn.operands[i];
  if (!o || (o.t !== 'reg' && o.t !== 'mem')) fail(`operand ${i + 1} of '${insn.mnemonic}' must be a register or a memory operand`);
  if (o.t === 'reg') regOf(o);
  return o;
}

function needReg(insn: Insn, i: number): RegRef {
  const r = regOf(insn.operands[i]);
  if (!r) fail(`operand ${i + 1} of '${insn.mnemonic}' must be a register`);
  return r;
}

/** Marks for a byte-sized operand: registers 4 to 7 need a REX prefix, the high-byte registers forbid one. */
function byteMarks(o: AsmOperand): { needRex: boolean; noRex: boolean } {
  const r = o.t === 'reg' ? regRef(o.name) : null;
  if (!r) return { needRex: false, noRex: false };
  return { needRex: !r.high && r.num >= 4 && r.num <= 7, noRex: r.high };
}

/** True when the long (rel32) form of a jump is used. A numeric target is always encoded in the long form. */
function useLong(o: AsmOperand, long: boolean): boolean {
  return long || (o.t === 'addr' && o.label === undefined);
}

/**
 * Bytes of one instruction located at address `pc`. `long` selects the rel32
 * form of jmp and jcc. With `sizing`, branch targets may still be labels and
 * distances are not checked, so the result has the right length only.
 */
export function encodeInsn(insn: Insn, pc: number, long: boolean, sizing = false): number[] {
  const m = insn.mnemonic;
  const ops = insn.operands;

  const branch = (i: number, length: number, short: boolean): number => {
    const o = ops[i];
    if (!o || (o.t !== 'addr' && !(sizing && o.t === 'label'))) fail(`operand ${i + 1} of '${m}' must be a label or an address`);
    if (o.t !== 'addr') return 0;
    const off = o.value - (pc + length);
    if (sizing) return 0;
    if (short && !fits8(off)) fail(`the target of '${m}' is ${off} bytes from the next instruction; the 8-bit offset reaches -128 to 127`);
    if (off < -2147483648 || off > 2147483647) fail(`the target of '${m}' is ${off} bytes away; the 32-bit offset reaches -2147483648 to 2147483647`);
    return off;
  };

  if (m in ALU_EXT) {
    count(insn, 2);
    const ext = ALU_EXT[m]!;
    const dst = needRm(insn, 0);
    const src = ops[1]!;
    if (src.t === 'imm') {
      const size = rmSize(insn, dst);
      const v = imm32For(immOf(insn, 1), size);
      const w = size === 64;
      if (fits8(v)) return build(parts([0x83], { w, reg: ext, rm: dst, tail: [v & 0xff] }));
      // The accumulator has a form without ModR/M, one byte shorter.
      if (dst.t === 'reg' && regOf(dst)!.num === 0) return build(parts([(ext << 3) | 5], { w, tail: le32(v) }));
      return build(parts([0x81], { w, reg: ext, rm: dst, tail: le32(v) }));
    }
    const s = needRm(insn, 1);
    const size = pairSize(insn, dst, s);
    if (isMem(dst) && isMem(s)) fail(`'${m}' cannot have two memory operands`);
    if (s.t === 'reg') return build(parts([(ext << 3) | 1], { w: size === 64, reg: regOf(s)!.num, rm: dst }));
    return build(parts([(ext << 3) | 3], { w: size === 64, reg: regOf(dst)!.num, rm: s }));
  }

  if (m in SHIFT_EXT) {
    count(insn, 2);
    const ext = SHIFT_EXT[m]!;
    const dst = needRm(insn, 0);
    const w = rmSize(insn, dst) === 64;
    const c = ops[1]!;
    if (c.t === 'reg') {
      if (c.name.toLowerCase() !== 'cl') fail(`the shift count of '${m}' must be an immediate or the register cl`);
      return build(parts([0xd3], { w, reg: ext, rm: dst }));
    }
    const v = immOf(insn, 1);
    if (v < 0 || v > 255) fail(`shift count ${v} is outside 0 to 255 (the processor uses the low ${w ? 6 : 5} bits)`);
    if (v === 1) return build(parts([0xd1], { w, reg: ext, rm: dst }));
    return build(parts([0xc1], { w, reg: ext, rm: dst, tail: [v] }));
  }

  if (m in UNARY) {
    count(insn, 1);
    const u = UNARY[m]!;
    const dst = needRm(insn, 0);
    return build(parts([u.opcode], { w: rmSize(insn, dst) === 64, reg: u.ext, rm: dst }));
  }

  if (m.startsWith('set') && ccNumber(m.slice(3)) >= 0) {
    count(insn, 1);
    const dst = needRm(insn, 0);
    const s = sizeOf(dst);
    if (s !== 8 && !(isMem(dst) && s === 0)) fail(`the operand of '${m}' must be an 8-bit register or a byte in memory`);
    return build(parts([0x0f, 0x90 | ccNumber(m.slice(3))], { reg: 0, rm: dst, ...byteMarks(dst) }));
  }

  if (m.startsWith('j') && m !== 'jmp' && ccNumber(m.slice(1)) >= 0) {
    count(insn, 1);
    const cc = ccNumber(m.slice(1));
    if (useLong(ops[0]!, long)) return [0x0f, 0x80 | cc, ...le32(branch(0, 6, false))];
    return [0x70 | cc, branch(0, 2, true) & 0xff];
  }

  switch (m) {
    case 'mov': {
      count(insn, 2);
      const dst = needRm(insn, 0);
      const src = ops[1]!;
      if (src.t === 'imm') {
        const size = rmSize(insn, dst);
        const raw = immOf(insn, 1);
        if (size === 64 && (raw < -2147483648 || raw > 2147483647)) {
          fail(`immediate ${raw} needs MOV with a 64-bit immediate, which is outside the subset; MOV to a 64-bit operand takes a sign-extended 32-bit immediate`);
        }
        const v = imm32For(raw, size);
        if (dst.t === 'reg' && size === 32) return build(parts([0xb8], { plus: regOf(dst)!.num, tail: le32(v) }));
        return build(parts([0xc7], { w: size === 64, reg: 0, rm: dst, tail: le32(v) }));
      }
      const s = needRm(insn, 1);
      const size = pairSize(insn, dst, s);
      if (isMem(dst) && isMem(s)) fail(`'mov' cannot have two memory operands`);
      if (s.t === 'reg') return build(parts([0x89], { w: size === 64, reg: regOf(s)!.num, rm: dst }));
      return build(parts([0x8b], { w: size === 64, reg: regOf(dst)!.num, rm: s }));
    }
    case 'movzx': {
      count(insn, 2);
      const dst = needReg(insn, 0);
      const src = needRm(insn, 1);
      if (dst.size !== 32) fail(`the destination of 'movzx' must be a 32-bit register in this subset`);
      const s = sizeOf(src);
      if (s !== 8) fail(isMem(src) && s === 0 ? `write byte ptr before the memory operand of 'movzx'` : `the source of 'movzx' must be an 8-bit register or a byte in memory`);
      return build(parts([0x0f, 0xb6], { reg: dst.num, rm: src, ...byteMarks(src) }));
    }
    case 'movsxd': {
      count(insn, 2);
      const dst = needReg(insn, 0);
      const src = needRm(insn, 1);
      if (dst.size !== 64) fail(`the destination of 'movsxd' must be a 64-bit register`);
      const s = sizeOf(src);
      if (s !== 32 && !(isMem(src) && s === 0)) fail(`the source of 'movsxd' must be a 32-bit register or a doubleword in memory`);
      return build(parts([0x63], { w: true, reg: dst.num, rm: src }));
    }
    case 'lea': {
      count(insn, 2);
      const dst = needReg(insn, 0);
      const src = ops[1];
      if (dst.size === 8) fail(`the destination of 'lea' must be a 32-bit or 64-bit register`);
      if (!isMem(src)) fail(`the source of 'lea' must be a memory operand`);
      return build(parts([0x8d], { w: dst.size === 64, reg: dst.num, rm: src }));
    }
    case 'test': {
      count(insn, 2);
      const dst = needRm(insn, 0);
      const src = needReg(insn, 1);
      const size = pairSize(insn, dst, ops[1]!);
      return build(parts([0x85], { w: size === 64, reg: src.num, rm: dst }));
    }
    case 'imul': {
      if (ops.length !== 2 && ops.length !== 3) fail(`'imul' takes 2 or 3 operands in this subset, found ${ops.length}`);
      const dst = needReg(insn, 0);
      const src = needRm(insn, 1);
      const size = pairSize(insn, ops[0]!, src);
      const w = size === 64;
      if (ops.length === 2) return build(parts([0x0f, 0xaf], { w, reg: dst.num, rm: src }));
      const v = imm32For(immOf(insn, 2), size);
      if (fits8(v)) return build(parts([0x6b], { w, reg: dst.num, rm: src, tail: [v & 0xff] }));
      return build(parts([0x69], { w, reg: dst.num, rm: src, tail: le32(v) }));
    }
    case 'push':
    case 'pop': {
      count(insn, 1);
      const r = needReg(insn, 0);
      if (r.size !== 64) fail(`'${m}' takes a 64-bit register in 64-bit mode`);
      return build(parts([m === 'push' ? 0x50 : 0x58], { plus: r.num }));
    }
    case 'jmp':
      count(insn, 1);
      if (useLong(ops[0]!, long)) return [0xe9, ...le32(branch(0, 5, false))];
      return [0xeb, branch(0, 2, true) & 0xff];
    case 'call':
      count(insn, 1);
      return [0xe8, ...le32(branch(0, 5, false))];
    case 'ret':
      count(insn, 0);
      return [0xc3];
    case 'syscall':
      count(insn, 0);
      return [0x0f, 0x05];
    case 'nop':
      count(insn, 0);
      return [0x90];
    default:
      return fail(`'${m}' is not an instruction of the implemented x86-64 subset`);
  }
}

export const x86Asm: TargetAsm = {
  size: (insn, long) => encodeInsn(insn, 0, long, true).length,
  relaxable: (insn) => insn.mnemonic === 'jmp' || (insn.mnemonic.startsWith('j') && ccNumber(insn.mnemonic.slice(1)) >= 0),
  /** The short forms of jmp and jcc are two bytes; the 8-bit offset is relative to the next instruction. */
  shortFits: (_insn, pc, target) => target - (pc + 2) >= -128 && target - (pc + 2) <= 127,
  relaxLong: () => null,
  encode: (insn, pc, long) => Uint8Array.from(encodeInsn(insn, pc, long)),
};
