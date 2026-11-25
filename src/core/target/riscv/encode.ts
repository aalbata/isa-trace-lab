/**
 * RV32I encoder. `encodeWord` validates the operands of one instruction and
 * returns its 32-bit word. Branch and jump targets are absolute addresses and
 * are converted to PC-relative offsets here.
 */
import { wordToBytesLE } from '../../util/int32.ts';
import type { AsmItem, AsmOperand, Insn, TargetAsm } from '../types.ts';
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
  if (!o || o.t !== 'mem' || o.base === null) fail(`operand ${i + 1} of '${insn.mnemonic}' must have the form offset(register)`);
  const base = regIndex(o.base);
  if (base < 0) fail(`unknown register '${o.base}'`);
  return { base, disp: o.disp };
}

/**
 * Offset from `pc` to the target address. Addresses wrap around modulo 2^32, so the offset is the difference
 * taken as a signed 32-bit value; a numeric target must be a 32-bit value, written signed or unsigned. A label
 * operand whose value is not an integer address names no label of the program.
 */
function target(insn: Insn, i: number, pc: number): number {
  const o: AsmOperand | undefined = insn.operands[i];
  if (!o || o.t !== 'addr') fail(`operand ${i + 1} of '${insn.mnemonic}' must be a label or an address`);
  if (!Number.isInteger(o.value)) fail(o.label === undefined ? `target ${o.value} is not an integer address` : `label '${o.label}' is not defined`);
  if (o.label === undefined && (o.value < -2147483648 || o.value > 4294967295)) fail(`target ${o.value} does not fit in 32 bits`);
  return (o.value - pc) | 0;
}

function count(insn: Insn, n: number): void {
  if (insn.operands.length !== n) fail(`'${insn.mnemonic}' takes ${n} operand${n === 1 ? '' : 's'}, found ${insn.operands.length}`);
}

function signed12(v: number, what: string): number {
  if (v < -2048 || v > 2047) fail(`${what} ${v} does not fit in the 12-bit signed field (-2048 to 2047)`);
  return v & 0xfff;
}

/** Word of one RV32I instruction located at address `pc`. Throws an Error that explains an invalid operand. */
export function encodeWord(insn: Insn, pc: number): number {
  const enc = ENCODING_BY_MNEMONIC.get(insn.mnemonic);
  if (!enc) fail(`'${insn.mnemonic}' is not an RV32I instruction implemented by this profile`);
  const { opcode, funct3, funct7 } = enc;
  switch (enc.format) {
    case 'R': {
      count(insn, 3);
      return ((funct7 << 25) | (reg(insn, 2) << 20) | (reg(insn, 1) << 15) | (funct3 << 12) | (reg(insn, 0) << 7) | opcode) >>> 0;
    }
    case 'I': {
      count(insn, 3);
      const v = signed12(imm(insn, 2), 'immediate');
      return ((v << 20) | (reg(insn, 1) << 15) | (funct3 << 12) | (reg(insn, 0) << 7) | opcode) >>> 0;
    }
    case 'SH': {
      count(insn, 3);
      const sh = imm(insn, 2);
      if (sh < 0 || sh > 31) fail(`shift amount ${sh} is outside 0 to 31`);
      return ((funct7 << 25) | (sh << 20) | (reg(insn, 1) << 15) | (funct3 << 12) | (reg(insn, 0) << 7) | opcode) >>> 0;
    }
    case 'L':
    case 'JR': {
      count(insn, 2);
      const m = mem(insn, 1);
      const v = signed12(m.disp, 'offset');
      return ((v << 20) | (m.base << 15) | (funct3 << 12) | (reg(insn, 0) << 7) | opcode) >>> 0;
    }
    case 'S': {
      count(insn, 2);
      const m = mem(insn, 1);
      const v = signed12(m.disp, 'offset');
      return (((v >> 5) << 25) | (reg(insn, 0) << 20) | (m.base << 15) | (funct3 << 12) | ((v & 0x1f) << 7) | opcode) >>> 0;
    }
    case 'B': {
      count(insn, 3);
      const off = target(insn, 2, pc);
      if (off % 2 !== 0) fail(`branch offset ${off} is odd; offsets are multiples of 2`);
      if (off < -4096 || off > 4094) fail(`branch target is ${off} bytes away; the 13-bit offset reaches -4096 to 4094`);
      const v = off & 0x1fff;
      return (
        (((v >> 12) & 1) << 31) | (((v >> 5) & 0x3f) << 25) | (reg(insn, 1) << 20) | (reg(insn, 0) << 15) | (funct3 << 12) |
        (((v >> 1) & 0xf) << 8) | (((v >> 11) & 1) << 7) | opcode
      ) >>> 0;
    }
    case 'U': {
      count(insn, 2);
      const v = imm(insn, 1);
      if (v < 0 || v > 0xfffff) fail(`immediate ${v} does not fit in the 20-bit field (0 to 1048575)`);
      return ((v << 12) | (reg(insn, 0) << 7) | opcode) >>> 0;
    }
    case 'J': {
      count(insn, 2);
      const off = target(insn, 1, pc);
      if (off % 2 !== 0) fail(`jump offset ${off} is odd; offsets are multiples of 2`);
      if (off < -1048576 || off > 1048574) fail(`jump target is ${off} bytes away; the 21-bit offset reaches -1048576 to 1048574`);
      const v = off & 0x1fffff;
      return (
        (((v >> 20) & 1) << 31) | (((v >> 1) & 0x3ff) << 21) | (((v >> 11) & 1) << 20) | (((v >> 12) & 0xff) << 12) |
        (reg(insn, 0) << 7) | opcode
      ) >>> 0;
    }
    case 'SYS':
      count(insn, 0);
      return opcode;
  }
}

const INVERSE: Record<string, string> = { beq: 'bne', bne: 'beq', blt: 'bge', bge: 'blt', bltu: 'bgeu', bgeu: 'bltu' };

export const riscvAsm: TargetAsm = {
  size: () => 4,
  relaxable: (insn) => insn.mnemonic in INVERSE,
  shortFits: (_insn, pc, target) => target - pc >= -4096 && target - pc <= 4094,
  /** An out-of-range conditional branch becomes the inverted branch over an unconditional jump. */
  relaxLong(insn: Insn, skip: string): AsmItem[] {
    const meta = { region: 'main' as const, irOps: [] };
    return [
      { kind: 'insn', insn: { mnemonic: INVERSE[insn.mnemonic]!, operands: [insn.operands[0]!, insn.operands[1]!, { t: 'label', name: skip }] }, meta },
      { kind: 'insn', insn: { mnemonic: 'jal', operands: [{ t: 'reg', name: 'zero' }, insn.operands[2]!] }, meta },
      { kind: 'label', name: skip },
    ];
  },
  encode: (insn, pc) => wordToBytesLE(encodeWord(insn, pc)),
};
