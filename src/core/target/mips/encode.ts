/**
 * MIPS32 encoder. `encodeWord` validates the operands of one instruction and
 * returns its 32-bit word. Branch and jump targets are absolute addresses. A
 * branch offset is counted in instructions from the delay slot, and the
 * 26-bit field of j and jal replaces the low 28 bits of the address of the
 * delay slot.
 */
import { hex, wordToBytesLE } from '../../util/int32.ts';
import type { AsmOperand, Insn, TargetAsm } from '../types.ts';
import { ENCODING_BY_MNEMONIC, regIndex } from './isa.ts';

function fail(message: string): never {
  throw new Error(message);
}

function reg(insn: Insn, i: number): number {
  const o = insn.operands[i];
  if (!o || o.t !== 'reg') fail(`operand ${i + 1} of '${insn.mnemonic}' must be a register`);
  const r = regIndex(o.name);
  if (r < 0) fail(`unknown register '${o.name}'`);
  return r;
}

function imm(insn: Insn, i: number): number {
  const o = insn.operands[i];
  if (!o || o.t !== 'imm') fail(`operand ${i + 1} of '${insn.mnemonic}' must be an immediate`);
  if (!Number.isInteger(o.value)) fail(`immediate ${o.value} is not an integer`);
  return o.value;
}

function mem(insn: Insn, i: number): { base: number; disp: number } {
  const o = insn.operands[i];
  if (!o || o.t !== 'mem' || o.base === null) fail(`operand ${i + 1} of '${insn.mnemonic}' must have the form offset($register)`);
  const base = regIndex(o.base);
  if (base < 0) fail(`unknown register '${o.base}'`);
  if (!Number.isInteger(o.disp)) fail(`offset ${o.disp} is not an integer`);
  return { base, disp: o.disp };
}

function target(insn: Insn, i: number): number {
  const o: AsmOperand | undefined = insn.operands[i];
  if (!o || o.t !== 'addr') fail(`operand ${i + 1} of '${insn.mnemonic}' must be a label or an address`);
  return o.value;
}

function count(insn: Insn, n: number): void {
  if (insn.operands.length !== n) fail(`'${insn.mnemonic}' takes ${n} operand${n === 1 ? '' : 's'}, found ${insn.operands.length}`);
}

function signed16(v: number, what: string): number {
  if (v < -32768 || v > 32767) fail(`${what} ${v} does not fit in the 16-bit signed field (-32768 to 32767)`);
  return v & 0xffff;
}

function unsigned16(v: number, what: string): number {
  if (v < 0 || v > 65535) fail(`${what} ${v} does not fit in the 16-bit unsigned field (0 to 65535)`);
  return v;
}

/** The 16-bit offset field of a branch at `pc` to the absolute address `to`. */
function branchField(pc: number, to: number): number {
  const off = to - (pc + 4);
  if (off % 4 !== 0) fail(`branch target ${hex(to)} is not a multiple of 4 bytes away from the delay slot`);
  if (off < -131072 || off > 131068) {
    fail(`branch target is ${off} bytes from the delay slot; the 18-bit offset reaches -131072 to 131068`);
  }
  return (off >> 2) & 0xffff;
}

/** Word of one MIPS32 instruction located at address `pc`. Throws an Error that explains an invalid operand. */
export function encodeWord(insn: Insn, pc: number): number {
  const enc = ENCODING_BY_MNEMONIC.get(insn.mnemonic);
  if (!enc) fail(`'${insn.mnemonic}' is not a MIPS32 instruction implemented by this profile`);
  const { opcode, funct } = enc;
  const word = (rs: number, rt: number, low: number): number => ((opcode << 26) | (rs << 21) | (rt << 16) | low) >>> 0;
  switch (enc.format) {
    case 'R3':
      count(insn, 3);
      return word(reg(insn, 1), reg(insn, 2), (reg(insn, 0) << 11) | funct);
    case 'SHI': {
      count(insn, 3);
      const sa = imm(insn, 2);
      if (sa < 0 || sa > 31) fail(`shift amount ${sa} is outside 0 to 31`);
      return word(0, reg(insn, 1), (reg(insn, 0) << 11) | (sa << 6) | funct);
    }
    case 'SHV':
      count(insn, 3);
      return word(reg(insn, 2), reg(insn, 1), (reg(insn, 0) << 11) | funct);
    case 'JR':
      count(insn, 1);
      return word(reg(insn, 0), 0, funct);
    case 'JALR':
      count(insn, 2);
      return word(reg(insn, 1), 0, (reg(insn, 0) << 11) | funct);
    case 'SYS': {
      if (insn.operands.length === 0) return funct;
      count(insn, 1);
      const code = imm(insn, 0);
      if (code < 0 || code > 0xfffff) fail(`code ${code} does not fit in the 20-bit field (0 to 1048575)`);
      return ((code << 6) | funct) >>> 0;
    }
    case 'I':
      count(insn, 3);
      return word(reg(insn, 1), reg(insn, 0), signed16(imm(insn, 2), 'immediate'));
    case 'IU':
      count(insn, 3);
      return word(reg(insn, 1), reg(insn, 0), unsigned16(imm(insn, 2), 'immediate'));
    case 'LUI':
      count(insn, 2);
      return word(0, reg(insn, 0), unsigned16(imm(insn, 1), 'immediate'));
    case 'M': {
      count(insn, 2);
      const m = mem(insn, 1);
      return word(m.base, reg(insn, 0), signed16(m.disp, 'offset'));
    }
    case 'B2':
      count(insn, 3);
      return word(reg(insn, 0), reg(insn, 1), branchField(pc, target(insn, 2)));
    case 'B1':
      count(insn, 2);
      return word(reg(insn, 0), enc.regimm, branchField(pc, target(insn, 1)));
    case 'J': {
      count(insn, 1);
      const to = target(insn, 0) >>> 0;
      if (to % 4 !== 0) fail(`jump target ${hex(to)} is not a multiple of 4`);
      const region = ((pc + 4) & 0xf0000000) >>> 0;
      if (((to & 0xf0000000) >>> 0) !== region) {
        fail(`jump target ${hex(to)} is outside the 256 MB region ${hex(region)} to ${hex(region + 0x0ffffffc)} that contains the delay slot`);
      }
      return ((opcode << 26) | ((to & 0x0fffffff) >>> 2)) >>> 0;
    }
  }
}

export const mipsAsm: TargetAsm = {
  size: () => 4,
  /**
   * A branch reaches 131072 bytes in either direction, which is more than the
   * 65536-byte code region, so no instruction needs a long form.
   */
  relaxable: () => false,
  shortFits: () => true,
  relaxLong: () => null,
  encode: (insn, pc) => wordToBytesLE(encodeWord(insn, pc)),
};
