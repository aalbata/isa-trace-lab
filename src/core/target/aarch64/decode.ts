/**
 * A64 decoder. `decodeWord` recognizes a 32-bit word and extracts its fields;
 * the processor model executes from this result. `decode` adds the
 * assembly-level instruction, the preferred alias, and the bit fields.
 *
 * Words outside the implemented subset are classified with the tables of the
 * A64 encoding index: the top-level table (bits 28 to 25), the tables of the
 * four groups that contain implemented instructions (data processing with an
 * immediate, branches with exception generation and System instructions, loads
 * and stores, and data processing with registers), and the class tables within
 * them. A word in a row that these tables mark unallocated or reserved, and the
 * permanently undefined UDF, is reported as invalid, and a word in a defined
 * row outside the subset is reported as unsupported with the name of its
 * instruction or class. The rows of a class table are examined in every class
 * that contains an implemented instruction and in every class of the branch,
 * exception generation, and System group. In the other classes, and in the
 * SVE, SME, and scalar floating-point and Advanced SIMD groups, a word is
 * reported as unsupported with the name of its class or group, and the decoder
 * does not examine whether that particular word is allocated within it.
 */
import { bytesToWordLE, hex, signExtend } from '../../util/int32.ts';
import type { AsmOperand, BitField, DecodeResult, Insn } from '../types.ts';
import type { Spec } from './isa.ts';
import { COND_NAMES, SPEC_BY_MNEMONIC, decodeBitmask, regName } from './isa.ts';
import { aliasOf } from './text.ts';

export type Form = 'imm' | 'reg' | 'uimm' | 'regoff' | 'plain';

export interface Raw {
  spec: Spec;
  form: Form;
  /** 1 for the 64-bit form. For loads and stores, 1 when the transferred register is an X register. */
  sf: number;
  rd: number;
  rn: number;
  rm: number;
  ra: number;
  /**
   * imm12 (addsub), imm16 (movw, svc), immr (bitfield, logic), byte offset
   * (mem with unsigned offset, branches).
   */
  imm: number;
  /** Shift amount (addsub, logic, movw) or imms (bitfield, logic). */
  imm2: number;
  /** Shift type of a shifted register: 0 lsl, 1 lsr, 2 asr, 3 ror. */
  shift: number;
  cond: number;
  /** Value of a logical immediate. */
  value: bigint;
  /** Loads and stores: access size in bytes, extend option, and the S bit. */
  size: number;
  option: number;
  s: number;
}

export interface RawError {
  kind: 'invalid' | 'unsupported';
  message: string;
}

export const SHIFT_NAMES = ['lsl', 'lsr', 'asr', 'ror'] as const;
export const EXTEND_NAMES: Record<number, string> = { 2: 'uxtw', 3: 'lsl', 6: 'sxtw', 7: 'sxtx' };

const invalid = (message: string): RawError => ({ kind: 'invalid', message });
const unsupported = (message: string): RawError => ({ kind: 'unsupported', message });

/** Field value as the encoding tables write it: `width` binary digits. */
const binary = (value: number, width: number): string => value.toString(2).padStart(width, '0');

function raw(mnemonic: string, form: Form, sf: number, f: Partial<Raw>): Raw {
  return {
    spec: SPEC_BY_MNEMONIC.get(mnemonic)!, form, sf, rd: 0, rn: 0, rm: 0, ra: 0, imm: 0, imm2: 0, shift: 0, cond: 0, value: 0n,
    size: 0, option: 0, s: 0, ...f,
  };
}

function dataImmediate(w: number): Raw | RawError {
  const sf = w >>> 31;
  const opc = (w >>> 29) & 3;
  const rd = w & 31;
  const rn = (w >>> 5) & 31;
  const n = (w >>> 22) & 1;
  const immr = (w >>> 16) & 63;
  const imms = (w >>> 10) & 63;
  switch ((w >>> 23) & 7) {
    case 0: case 1:
      return unsupported('PC-relative address instruction (ADR or ADRP), outside the subset');
    case 2:
      return raw(['add', 'adds', 'sub', 'subs'][opc]!, 'imm', sf, { rd, rn, imm: (w >>> 10) & 0xfff, imm2: n ? 12 : 0 });
    case 3:
      return unsupported('encoding in the space of add and subtract immediate with tags (Memory Tagging Extension) and minimum and maximum immediate, outside the subset');
    case 4: {
      if (sf === 0 && n === 1) return invalid('logical immediate with N = 1 in the 32-bit form, which is unallocated');
      const value = decodeBitmask(n, immr, imms, sf ? 64 : 32);
      if (value === null) return invalid('logical immediate whose N, immr, imms combination is reserved');
      return raw(['and', 'orr', 'eor', 'ands'][opc]!, 'imm', sf, { rd, rn, imm: immr, imm2: imms, value, option: n });
    }
    case 5: {
      const hw = (w >>> 21) & 3;
      if (opc === 1) return invalid('move wide immediate with opc = 01, which is unallocated');
      if (sf === 0 && hw >= 2) return invalid('32-bit move wide immediate with a shift of 32 or 48, which is unallocated');
      return raw(opc === 0 ? 'movn' : opc === 2 ? 'movz' : 'movk', 'imm', sf, { rd, imm: (w >>> 5) & 0xffff, imm2: 16 * hw });
    }
    case 6: {
      if (opc === 3) return invalid('bitfield instruction with opc = 11, which is unallocated');
      if (n !== sf) return invalid('bitfield instruction whose N bit differs from sf, which is unallocated');
      if (sf === 0 && (immr >= 32 || imms >= 32)) return invalid('32-bit bitfield instruction with immr or imms above 31, which is unallocated');
      if (opc === 1) return unsupported('BFM (bitfield move, with its aliases BFI, BFXIL, and BFC), outside the subset');
      return raw(opc === 0 ? 'sbfm' : 'ubfm', 'imm', sf, { rd, rn, imm: immr, imm2: imms });
    }
    default:
      // Bits 30 and 29 (op0 of the group table) = 11 select the data processing (1 source immediate) class.
      if (opc === 3) return unsupported('encoding in the data processing (1 source immediate) class (AUTIASPPC and AUTIBSPPC, FEAT_PAuth_LR), outside the subset');
      return unsupported('encoding in the extract group (EXTR and its alias ROR), outside the subset');
  }
}

/**
 * Bits 31 to 26 are 010101: conditional branch (immediate) when bits 25 and 24
 * are 00, miscellaneous branch (immediate) when they are 01.
 */
function conditionalBranch(w: number, off19: number): Raw | RawError {
  switch ((w >>> 24) & 3) {
    case 0:
      // o0 (bit 4) selects BC.cond.
      if (((w >>> 4) & 1) === 0) return raw(`b.${COND_NAMES[w & 15]}`, 'plain', 0, { cond: w & 15, imm: off19 });
      return unsupported('BC.cond (branch consistent conditionally, FEAT_HBC), outside the subset');
    case 1: {
      const opc = (w >>> 21) & 7;
      const op2 = w & 31;
      if (opc <= 1 && op2 === 31) return unsupported(`${opc ? 'RETABSPPC' : 'RETAASPPC'} (return with pointer authentication of the return address, FEAT_PAuth_LR), outside the subset`);
      return invalid(`miscellaneous branch (immediate) with opc = ${binary(opc, 3)} and op2 = ${binary(op2, 5)}, which is unallocated`);
    }
    default:
      return invalid('bits 31 to 25 are 0101011, which the branch, exception generation, and System table marks unallocated');
  }
}

/** Exception generation: bits 31 to 24 are 11010100; opc is bits 23 to 21, op2 bits 4 to 2, and LL bits 1 and 0. */
function exceptionGeneration(w: number): Raw | RawError {
  const opc = (w >>> 21) & 7;
  const op2 = (w >>> 2) & 7;
  const ll = w & 3;
  if (op2 === 0) {
    if (opc === 0 && ll === 1) return raw('svc', 'plain', 0, { imm: (w >>> 5) & 0xffff });
    if (opc === 0 && ll !== 0) return unsupported(`${ll === 2 ? 'HVC (hypervisor call)' : 'SMC (secure monitor call)'}, outside the subset`);
    if (opc === 1 && ll === 0) return unsupported('BRK (breakpoint), outside the subset');
    if (opc === 2 && ll === 0) return unsupported('HLT (halt for an external debugger), outside the subset');
    if (opc === 5 && ll !== 0) return unsupported(`DCPS${ll} (debug change PE state), outside the subset`);
  }
  return invalid(`exception generation with opc = ${binary(opc, 3)}, op2 = ${binary(op2, 3)}, and LL = ${binary(ll, 2)}, which is unallocated`);
}

/** Unconditional branch (register): bits 31 to 25 are 1101011; opc is bits 24 to 21, op2 bits 20 to 16, op3 bits 15 to 10, and op4 bits 4 to 0. */
function branchRegister(w: number): Raw | RawError {
  const opc = (w >>> 21) & 15;
  const op2 = (w >>> 16) & 31;
  const op3 = (w >>> 10) & 63;
  const rn = (w >>> 5) & 31;
  const op4 = w & 31;
  // op3 = 00001x selects a pointer authentication form; its low bit selects key A or key B.
  const pac = op3 >>> 1 === 1;
  const key = op3 & 1 ? 'B' : 'A';
  if (op2 === 31) {
    switch (opc) {
      case 0: case 1: case 2:
        if (op3 === 0 && op4 === 0) return raw(['br', 'blr', 'ret'][opc]!, 'plain', 1, { rn });
        if (pac && opc < 2 && op4 === 31) return unsupported(`${opc ? 'BLRA' : 'BRA'}${key}Z (branch${opc ? ' with link' : ''} to a register with pointer authentication), outside the subset`);
        if (pac && opc === 2 && rn === 31) {
          if (op4 === 31) return unsupported(`RETA${key} (return with pointer authentication), outside the subset`);
          return unsupported(`RETA${key}SPPCR (return with pointer authentication of the return address, FEAT_PAuth_LR), outside the subset`);
        }
        break;
      case 4:
        if (rn === 31 && op3 === 0 && op4 === 0) return unsupported('ERET (exception return), outside the subset');
        if (rn === 31 && pac && op4 === 31) return unsupported(`ERETA${key} (exception return with pointer authentication), outside the subset`);
        break;
      case 5:
        if (rn === 31 && op3 === 0 && op4 === 0) return unsupported('DRPS (debug restore process state), outside the subset');
        break;
      case 8: case 9:
        if (pac) return unsupported(`${opc === 8 ? 'BRA' : 'BLRA'}${key} (branch${opc === 9 ? ' with link' : ''} to a register with pointer authentication and a modifier), outside the subset`);
        break;
      default:
        break;
    }
  }
  return invalid(`unconditional branch (register) with opc = ${binary(opc, 4)}, op2 = ${binary(op2, 5)}, op3 = ${binary(op3, 6)}, Rn = ${binary(rn, 5)}, and op4 = ${binary(op4, 5)}, which is unallocated`);
}

/** Named instructions of the hint space by the immediate of HINT (CRm:op2), other than NOP; the other values are HINT #imm. */
const HINT_NAMES: Record<number, string> = {
  1: 'YIELD', 2: 'WFE', 3: 'WFI', 4: 'SEV', 5: 'SEVL', 6: 'DGH', 7: 'XPACLRI', 8: 'PACIA1716', 10: 'PACIB1716', 12: 'AUTIA1716',
  14: 'AUTIB1716', 16: 'ESB', 17: 'PSB', 18: 'TSB', 19: 'GCSB', 20: 'CSDB', 22: 'CLRBHB', 24: 'PACIAZ', 25: 'PACIASP', 26: 'PACIBZ',
  27: 'PACIBSP', 28: 'AUTIAZ', 29: 'AUTIASP', 30: 'AUTIBZ', 31: 'AUTIBSP', 32: 'BTI', 34: 'BTI', 36: 'BTI', 38: 'BTI', 39: 'PACM',
  40: 'CHKFEAT', 48: 'STSHH', 49: 'STSHH',
};

/** Barrier instructions by op2. op2 = 001 is DSB with the nXS qualifier only when CRm<1:0> = 10; op2 = 000 and 011 are unallocated. */
const BARRIER_NAMES = [
  '', 'DSB (data synchronization barrier, nXS form, FEAT_XS)', 'CLREX (clear the exclusive monitor)', '', 'DSB (data synchronization barrier)',
  'DMB (data memory barrier)', 'ISB (instruction synchronization barrier)', 'SB (speculation barrier, FEAT_SB)',
];

/**
 * System instructions: bits 31 to 24 are 11010101. Bits 23 and 22 are 00 for the single-register forms and 01 for the
 * register-pair forms; L is bit 21, op0 bits 20 and 19, op1 bits 18 to 16, CRn bits 15 to 12, CRm bits 11 to 8, op2 bits
 * 7 to 5, and Rt bits 4 to 0.
 */
function system(w: number): Raw | RawError {
  const pair = (w >>> 22) & 3;
  const l = (w >>> 21) & 1;
  const op0 = (w >>> 19) & 3;
  const op1 = (w >>> 16) & 7;
  const crn = (w >>> 12) & 15;
  const crm = (w >>> 8) & 15;
  const op2 = (w >>> 5) & 7;
  const rt = w & 31;
  const unallocatedRow = (fields: string): RawError =>
    invalid(`System encoding with ${fields}, which the branch, exception generation, and System table marks unallocated`);
  if (pair >= 2) return unallocatedRow('bits 23 and 22 = 1x');
  if (op0 >= 2) {
    if (pair) return unsupported(`${l ? 'MRRS (move from' : 'MSRR (move to'} a 128-bit system register, FEAT_SYSREG128), outside the subset`);
    return unsupported(`${l ? 'MRS (move from' : 'MSR (move to'} a system register), outside the subset`);
  }
  if (op0 === 1) {
    if (pair === 0) return unsupported(`${l ? 'SYSL' : 'SYS'} (system instruction, with aliases such as AT, DC, IC, and TLBI), outside the subset`);
    if (l === 0) return unsupported('SYSP (128-bit system instruction, with aliases such as TLBIP, FEAT_SYSINSTR128), outside the subset');
    return invalid('System pair instruction with L = 1, which is unallocated');
  }
  if (pair) return unallocatedRow('bits 23 and 22 = 01 and op0 = 00');
  if (l) return unallocatedRow('L = 1 and op0 = 00');
  // op0 = 00 and L = 0: CRn = 0100 is the PSTATE class; with op1 = 011, CRn = 0001 to 0011 select WFET and WFIT, hints, and barriers.
  if (crn === 4) {
    if (rt !== 31) return invalid(`PSTATE instruction with Rt = ${binary(rt, 5)}, which is unallocated`);
    const flags = ['CFINV (invert the carry flag, FEAT_FlagM)', 'XAFLAG (convert the condition flags from an external format, FEAT_FlagM2)',
      'AXFLAG (convert the condition flags to an external format, FEAT_FlagM2)'];
    return unsupported(`${op1 === 0 && op2 <= 2 ? flags[op2] : 'MSR (immediate) (write a PSTATE field)'}, outside the subset`);
  }
  if (op1 !== 3 || crn === 0 || crn > 3) return unallocatedRow(`op0 = 00, op1 = ${binary(op1, 3)}, and CRn = ${binary(crn, 4)}`);
  if (crn === 1) {
    if (crm === 0 && op2 <= 1) return unsupported(`${op2 ? 'WFIT (wait for interrupt' : 'WFET (wait for event'} with a timeout, FEAT_WFxT), outside the subset`);
    return invalid(`System instruction with a register argument with CRm = ${binary(crm, 4)} and op2 = ${binary(op2, 3)}, which is unallocated`);
  }
  if (crn === 2) {
    // Hints: every value of CRm:op2 is HINT #imm; the encoding requires Rt = 11111.
    if (rt !== 31) return unallocatedRow(`the hint row and Rt = ${binary(rt, 5)}`);
    const imm = (crm << 3) | op2;
    if (imm === 0) return raw('nop', 'plain', 0, {});
    const name = HINT_NAMES[imm];
    return unsupported(`${name === undefined ? `HINT #${imm} (hint without a named instruction` : `${name} (hint instruction HINT #${imm}`}), outside the subset`);
  }
  const barrier = rt === 31 && (op2 !== 1 || (crm & 3) === 2) ? BARRIER_NAMES[op2]! : '';
  if (barrier === '') return invalid(`barrier with CRm = ${binary(crm, 4)}, op2 = ${binary(op2, 3)}, and Rt = ${binary(rt, 5)}, which is unallocated`);
  return unsupported(`${barrier}, outside the subset`);
}

/**
 * Compare and branch encodings whose bits 30 and 29 are 11 (FEAT_CMPBR). Bits 25 and 24 select the register (00) and
 * immediate (01) forms; in the register form bits 15 and 14 select the operand size, and in the immediate form bit 14
 * is 0. cc is bits 23 to 21.
 */
function compareBranch(w: number): RawError {
  const sf = w >>> 31;
  const form = (w >>> 24) & 3;
  const b1514 = (w >>> 14) & 3;
  const cc = (w >>> 21) & 7;
  let family: [string, string] | null = null;
  if (form === 0 && b1514 === 0) family = ['CB<cc>', 'compare registers and branch'];
  else if (form === 0 && b1514 >= 2 && sf === 0) family = b1514 === 2 ? ['CBB<cc>', 'compare bytes and branch'] : ['CBH<cc>', 'compare halfwords and branch'];
  else if (form === 1 && (b1514 & 1) === 0) family = ['CB<cc>', 'compare a register with an immediate and branch'];
  if (family === null) {
    return invalid(`compare and branch encoding with sf = ${sf}, bits 25 and 24 = ${binary(form, 2)}, and bits 15 and 14 = ${binary(b1514, 2)}, which the branch, exception generation, and System table marks unallocated`);
  }
  const [name, what] = family;
  if (cc >>> 1 === 2) return invalid(`${name} with cc = ${binary(cc, 3)}, which is unallocated`);
  return unsupported(`${name} (${what}, FEAT_CMPBR), outside the subset`);
}

function branchSystem(w: number): Raw | RawError {
  const top = w >>> 29;
  const off26 = signExtend(w & 0x3ffffff, 26) * 4;
  const off19 = signExtend((w >>> 5) & 0x7ffff, 19) * 4;
  switch (top) {
    case 0: return raw('b', 'plain', 0, { imm: off26 });
    case 4: return raw('bl', 'plain', 0, { imm: off26 });
    case 1: case 5:
      if ((w >>> 25) & 1) return unsupported('test bit and branch (TBZ or TBNZ), outside the subset');
      return raw((w >>> 24) & 1 ? 'cbnz' : 'cbz', 'plain', w >>> 31, { rd: w & 31, imm: off19 });
    case 2:
      return conditionalBranch(w, off19);
    case 6:
      if (((w >>> 24) & 3) === 0) return exceptionGeneration(w);
      if (((w >>> 24) & 3) === 1) return system(w);
      return branchRegister(w);
    default:
      return compareBranch(w);
  }
}

/** Instruction of a data processing (2 source) row outside the subset, or null when the row is unallocated. */
function twoSourceFamily(sf: number, s: number, opcode: number): string | null {
  if (s === 1) return sf === 1 && opcode === 0 ? 'SUBPS (subtract pointer, setting the flags, FEAT_MTE)' : null;
  if (opcode === 2 || opcode === 3) return `${opcode === 2 ? 'UDIV (unsigned' : 'SDIV (signed'} divide)`;
  // opcode = 0110xx: maximum and minimum.
  if (opcode >>> 2 === 6) return `${['SMAX (signed maximum', 'UMAX (unsigned maximum', 'SMIN (signed minimum', 'UMIN (unsigned minimum'][opcode & 3]} of two registers, FEAT_CSSC)`;
  // opcode = 010Cxx: CRC32 and CRC32C, where the 64-bit form takes the doubleword size xx = 11 and the 32-bit form the others.
  if (opcode >>> 3 === 2 && ((opcode & 3) === 3) === (sf === 1)) return `CRC32${opcode & 4 ? 'C' : ''}${'BHWX'[opcode & 3]} (cyclic redundancy check, FEAT_CRC32)`;
  if (sf === 1) {
    if (opcode === 0) return 'SUBP (subtract pointer, FEAT_MTE)';
    if (opcode === 4) return 'IRG (insert random tag, FEAT_MTE)';
    if (opcode === 5) return 'GMI (tag mask insert, FEAT_MTE)';
    if (opcode === 12) return 'PACGA (pointer authentication code with the generic key)';
  }
  return null;
}

function dataRegister(w: number): Raw | RawError {
  const sf = w >>> 31;
  const rd = w & 31;
  const rn = (w >>> 5) & 31;
  const rm = (w >>> 16) & 31;
  const imm6 = (w >>> 10) & 63;
  const shift = (w >>> 22) & 3;
  if (((w >>> 28) & 1) === 0) {
    const opc = (w >>> 29) & 3;
    if (((w >>> 24) & 1) === 0) {
      // Logical (shifted register).
      if (sf === 0 && imm6 >= 32) return invalid('32-bit logical (shifted register) instruction with a shift amount above 31, which is unallocated');
      const inverted = (w >>> 21) & 1;
      if (inverted && opc >= 2) return unsupported(`${opc === 2 ? 'EON' : 'BICS'} (logical shifted register with inverted operand), outside the subset`);
      const mnemonic = inverted ? ['bic', 'orn'][opc]! : ['and', 'orr', 'eor', 'ands'][opc]!;
      return raw(mnemonic, 'reg', sf, { rd, rn, rm, shift, imm2: imm6 });
    }
    if ((w >>> 21) & 1) return unsupported('add or subtract with an extended register operand, outside the subset');
    if (shift === 3) return invalid('add or subtract (shifted register) with shift type 11, which is unallocated');
    if (sf === 0 && imm6 >= 32) return invalid('32-bit add or subtract (shifted register) with a shift amount above 31, which is unallocated');
    return raw(['add', 'adds', 'sub', 'subs'][opc]!, 'reg', sf, { rd, rn, rm, shift, imm2: imm6 });
  }
  const op2 = (w >>> 21) & 15;
  if (op2 >= 8) {
    // Data processing (3 source): op54 is bits 30 and 29, op31 bits 23 to 21, and o0 bit 15.
    const op54 = (w >>> 29) & 3;
    const op31 = (w >>> 21) & 7;
    const o0 = (w >>> 15) & 1;
    if (op54 === 0 && op31 === 0) return raw(o0 ? 'msub' : 'madd', 'reg', sf, { rd, rn, rm, ra: (w >>> 10) & 31 });
    if (op54 === 0 && sf === 1) {
      if (op31 === 1 || op31 === 5) {
        return unsupported(`${op31 === 1 ? 'S' : 'U'}M${o0 ? 'SUB' : 'ADD'}L (${op31 === 1 ? 'signed' : 'unsigned'} multiply-${o0 ? 'subtract' : 'add'} long), outside the subset`);
      }
      if ((op31 === 2 || op31 === 6) && o0 === 0) return unsupported(`${op31 === 2 ? 'SMULH (signed' : 'UMULH (unsigned'} multiply high), outside the subset`);
      if (op31 === 3) return unsupported(`${o0 ? 'MSUBPT (multiply-subtract' : 'MADDPT (multiply-add'} checked pointer, FEAT_CPA), outside the subset`);
    }
    return invalid(`data processing (3 source) with sf = ${sf}, op54 = ${binary(op54, 2)}, op31 = ${binary(op31, 3)}, and o0 = ${o0}, which is unallocated`);
  }
  if (op2 === 4) {
    // Conditional select.
    if ((w >>> 29) & 1) return invalid('conditional select with S = 1, which is unallocated');
    if ((w >>> 11) & 1) return invalid('conditional select with op2 = 1x, which is unallocated');
    if ((w >>> 30) & 1) return unsupported(`${(w >>> 10) & 1 ? 'CSNEG' : 'CSINV'} (conditional select), outside the subset`);
    return raw((w >>> 10) & 1 ? 'csinc' : 'csel', 'reg', sf, { rd, rn, rm, cond: (w >>> 12) & 15 });
  }
  if (op2 === 6) {
    if ((w >>> 30) & 1) return unsupported('encoding in the data processing (1 source) group (for example RBIT, REV, CLZ, CLS), outside the subset');
    // Data processing (2 source): S is bit 29 and opcode bits 15 to 10.
    const s = (w >>> 29) & 1;
    const opcode = (w >>> 10) & 63;
    if (s === 0 && opcode >>> 2 === 2) {
      // opcode = 0010xx: shift or rotate by a register.
      if (opcode === 11) return unsupported('RORV (rotate right by a register), outside the subset');
      return raw(['lslv', 'lsrv', 'asrv'][opcode & 3]!, 'reg', sf, { rd, rn, rm });
    }
    const family = twoSourceFamily(sf, s, opcode);
    if (family !== null) return unsupported(`${family}, outside the subset`);
    return invalid(`data processing (2 source) with sf = ${sf}, S = ${s}, and opcode = ${binary(opcode, 6)}, which is unallocated`);
  }
  if (op2 === 2) return unsupported(`conditional compare (${(w >>> 11) & 1 ? 'immediate' : 'register'}) (CCMN or CCMP), outside the subset`);
  if (op2 === 0) {
    // op3 (bits 15 to 10) selects the class.
    const op3 = (w >>> 10) & 63;
    if (op3 === 0) return unsupported('add or subtract with carry (ADC, ADCS, SBC, or SBCS), outside the subset');
    if (op3 >>> 3 === 1) return unsupported('add or subtract checked pointer (ADDPT or SUBPT, FEAT_CPA), outside the subset');
    if ((op3 & 31) === 1) return unsupported('rotate right into flags (RMIF, FEAT_FlagM), outside the subset');
    if ((op3 & 15) === 2) return unsupported('evaluate into flags (SETF8 or SETF16, FEAT_FlagM), outside the subset');
    return invalid(`data processing (register) with op2 = 0000 and op3 = ${binary(op3, 6)}, which the group table marks unallocated`);
  }
  // op2 = 0xx1.
  return invalid(`data processing (register) with bit 28 = 1 and op2 = ${binary(op2, 4)}, which the group table marks unallocated`);
}

/** Invalid result for a load and store word in a row that the load and store table marks unallocated. */
const unallocatedLoadStore = (w: number, fp: number): RawError =>
  invalid(`load and store encoding with op0 = ${binary(w >>> 28, 4)}, V = ${fp}, and op2 = ${binary((w >>> 10) & 0x7fff, 15)} (bits 24 to 10), which the load and store table marks unallocated`);

/**
 * Load and store encodings whose bits 29 and 28 are 00 (op0 = xx00 in the load and store table). The subset implements
 * none of them; the rows are selected by op0 (bits 31 to 28), V (bit 26), and bits 24, 23, 21, and 20 to 16.
 */
function loadStoreOp0xx00(w: number, fp: number): RawError {
  const top = w >>> 31;
  const b24 = (w >>> 24) & 1;
  const b23 = (w >>> 23) & 1;
  const b21 = (w >>> 21) & 1;
  if (fp === 0) {
    if (b24 === 0) {
      if (b23 === 1) return unsupported(b21 ? 'compare and swap (CAS, CASB, CASH, and related forms, FEAT_LSE), outside the subset' : 'load-acquire or store-release register (LDAR, STLR, and related forms), outside the subset');
      if (b21 === 0) return unsupported('load or store exclusive register (LDXR, STXR, and related forms), outside the subset');
      return unsupported(top ? 'load or store exclusive pair (LDXP, STXP, and related forms), outside the subset' : 'compare and swap pair (CASP and related forms, FEAT_LSE), outside the subset');
    }
    if (b21 === 0 && top === 1) {
      return unsupported(b23 ? 'unprivileged compare and swap (CAST and related forms, FEAT_LSUI), outside the subset' : 'unprivileged load or store exclusive register (LDTXR, STTXR, and related forms, FEAT_LSUI), outside the subset');
    }
    if (b21 === 0 && b23 === 1) return unsupported('unprivileged compare and swap pair (CASPT and related forms, FEAT_LSUI), outside the subset');
    return unallocatedLoadStore(w, fp);
  }
  // Advanced SIMD load and store structures: bit 31 is 0, and bits 20 to 16 hold the register of the post-indexed forms.
  const b2016 = (w >>> 16) & 31;
  if (top === 0 && b24 === 0 && b21 === 0 && (b23 === 1 || b2016 === 0)) {
    return unsupported(`Advanced SIMD load or store of multiple structures${b23 ? ' with post-indexing' : ''} (LD1 to LD4 and ST1 to ST4), outside the subset`);
  }
  if (top === 0 && b24 === 1 && (b23 === 1 || b2016 >>> 1 === 0)) {
    const forms = b23 ? ' with post-indexing (LD1 to LD4, LD1R to LD4R, and ST1 to ST4)' : ' (LD1 to LD4, LD1R to LD4R, ST1 to ST4, and LDAP1 and STL1 of FEAT_LRCPC3)';
    return unsupported(`Advanced SIMD load or store of a single structure${forms}, outside the subset`);
  }
  return unallocatedLoadStore(w, fp);
}

/**
 * Load and store encodings whose bits 29 and 28 are 01 (op0 = xx01 in the load and store table). The subset implements
 * none of them; the rows are selected by op0 (bits 31 to 28), V (bit 26), and op2 (bits 24 to 10), whose low two bits
 * are op4.
 */
function loadStoreOp0xx01(w: number, fp: number): RawError {
  if (((w >>> 24) & 1) === 0) return unsupported('load register (literal) (LDR, LDRSW, or PRFM with a PC-relative address), outside the subset');
  const op0 = w >>> 28;
  const b23 = (w >>> 23) & 1;
  const op3hi = (w >>> 21) & 1;
  const op4 = (w >>> 10) & 3;
  if (op3hi === 0 && op4 === 1) return unsupported('memory copy or memory set instruction (CPY and SET forms, FEAT_MOPS), outside the subset');
  if (fp === 1) {
    if (op3hi === 0 && op4 === 2) {
      return unsupported('load-acquire RCpc or store-release SIMD and floating-point register with an unscaled offset (LDAPUR and STLUR, FEAT_LRCPC3), outside the subset');
    }
    return unallocatedLoadStore(w, fp);
  }
  if (op3hi === 0) {
    if (op4 === 0) return unsupported('load-acquire RCpc or store-release register with an unscaled offset (LDAPUR, STLUR, and related forms, FEAT_LRCPC2), outside the subset');
    if (op4 === 2 && b23 === 0) return unsupported('load-acquire RCpc or store-release register pair (LDIAPP and STILP, FEAT_LRCPC3), outside the subset');
    // Writeback forms require bits 20 to 12 to be zero.
    if (op4 === 2 && ((w >>> 12) & 0x1ff) === 0) return unsupported('load-acquire RCpc or store-release register with writeback (LDAPR and STLR, FEAT_LRCPC3), outside the subset');
    // Guarded Control Stack stores: op0 = 1101, bits 23 and 22 = 00, and bits 20 to 15 = 111110.
    if (op4 === 3 && op0 === 13 && ((w >>> 22) & 3) === 0 && ((w >>> 15) & 63) === 62) {
      return unsupported('Guarded Control Stack store (GCSSTR and GCSSTTR, FEAT_GCS), outside the subset');
    }
    return unallocatedLoadStore(w, fp);
  }
  if (op0 === 13) return unsupported('load or store of allocation tags (STG, LDG, and related forms, FEAT_MTE), outside the subset');
  if (op0 >>> 3 === 1) return unallocatedLoadStore(w, fp);
  if (op4 === 0) {
    return unsupported('128-bit atomic memory operation (LDCLRP, LDSETP, and SWPP, FEAT_LSE128, or RCWCLRP, RCWSETP, RCWSWPP, and related forms, FEAT_THE), outside the subset');
  }
  if (op4 === 1) return unsupported('unprivileged atomic memory operation (LDTADD, LDTCLR, LDTSET, SWPT, and related forms, FEAT_LSUI), outside the subset');
  // Read-check-write compare and swap: bits 15 to 10 are 000010, or 000011 for the pair form.
  const b1510 = (w >>> 10) & 63;
  if (b1510 === 2) return unsupported('read-check-write compare and swap (RCWCAS, RCWSCAS, and related forms, FEAT_THE), outside the subset');
  if (b1510 === 3) return unsupported('read-check-write compare and swap pair (RCWCASP, RCWSCASP, and related forms, FEAT_THE), outside the subset');
  return unallocatedLoadStore(w, fp);
}

function loadStore(w: number): Raw | RawError {
  const size = w >>> 30;
  const opc = (w >>> 22) & 3;
  const fp = (w >>> 26) & 1;
  const rt = w & 31;
  const rn = (w >>> 5) & 31;
  if (((w >>> 27) & 7) !== 7) {
    switch ((w >>> 28) & 3) {
      case 0: return loadStoreOp0xx00(w, fp);
      case 1: return loadStoreOp0xx01(w, fp);
      case 2: return unsupported('load or store of a register pair (LDP, STP, and related forms), outside the subset');
      default: break;
    }
  }
  const unsignedOffset = ((w >>> 24) & 1) === 1;
  const registerOffset = !unsignedOffset && ((w >>> 21) & 1) === 1 && ((w >>> 10) & 3) === 2;
  if (!unsignedOffset && !registerOffset) {
    if (((w >>> 21) & 1) === 0) return unsupported('load or store with an unscaled, pre-indexed, post-indexed, or unprivileged offset (LDUR, STUR, and related forms), outside the subset');
    return unsupported('encoding in the atomic memory operation or pointer-authenticated load groups, outside the subset');
  }
  // Load/store register (unsigned immediate) and (register offset): the rows are selected by size, V (fp), and opc.
  const option = (w >>> 13) & 7;
  if (registerOffset && (option & 2) === 0) return invalid('load or store (register offset) with option<1> = 0, which is unallocated');
  if (fp) {
    if (size !== 0 && opc >= 2) return invalid(`SIMD and floating-point load or store register with size = ${binary(size, 2)} and opc = ${binary(opc, 2)}, which is unallocated`);
    return unsupported('load or store of a SIMD and floating-point register, outside the subset');
  }
  if (opc >= 2) {
    if (size >= 2 && opc === 3) return invalid(`load or store register with size = ${binary(size, 2)} and opc = 11, which is unallocated`);
    if (size === 3) {
      // In the register offset form, Rt<4:3> = 11 selects RPRFM.
      return unsupported(registerOffset && rt >>> 3 === 3 ? 'RPRFM (range prefetch memory, FEAT_RPRFM), outside the subset' : 'PRFM (prefetch memory), outside the subset');
    }
    return unsupported(`${['LDRSB (load register signed byte)', 'LDRSH (load register signed halfword)', 'LDRSW (load register signed word)'][size]}, outside the subset`);
  }
  const mnemonic = (opc ? 'ldr' : 'str') + ['b', 'h', '', ''][size]!;
  const bytes = 1 << size;
  const sf = size === 3 ? 1 : 0;
  if (unsignedOffset) return raw(mnemonic, 'uimm', sf, { rd: rt, rn, imm: ((w >>> 10) & 0xfff) * bytes, size: bytes });
  return raw(mnemonic, 'regoff', sf, { rd: rt, rn, rm: (w >>> 16) & 31, option, s: (w >>> 12) & 1, size: bytes });
}

export function decodeWord(w: number): Raw | RawError {
  const group = (w >>> 25) & 15;
  switch (group) {
    case 0:
      if (w >>> 31) return unsupported('encoding in the Scalable Matrix Extension (SME) group, outside the subset');
      if (w >>> 16 === 0) return invalid('UDF, the permanently undefined instruction');
      return invalid('bits 28 to 25 are 0000 with bit 31 clear, a reserved part of the encoding space');
    case 1: case 3:
      return invalid(`bits 28 to 25 are ${group === 1 ? '0001' : '0011'}, which the top-level A64 encoding table marks unallocated`);
    case 2:
      return unsupported('encoding in the Scalable Vector Extension (SVE) group, outside the subset');
    case 8: case 9:
      return dataImmediate(w);
    case 10: case 11:
      return branchSystem(w);
    case 5: case 13:
      return dataRegister(w);
    case 7: case 15:
      return unsupported('encoding in the scalar floating-point and Advanced SIMD group, outside the subset');
    default:
      return loadStore(w);
  }
}

const REG = (n: number, bits: 32 | 64, r31: 'sp' | 'zr'): AsmOperand => ({ t: 'reg', name: regName(n, bits, r31) });
const IMM = (value: number): AsmOperand => ({ t: 'imm', value });

/** Assembly-level instruction for a decoded word at address `pc`. */
export function toInsn(r: Raw, pc: number): Insn {
  const m = r.spec.mnemonic;
  const bits: 32 | 64 = r.sf ? 64 : 32;
  const shiftOp = (): AsmOperand[] =>
    r.shift === 0 && r.imm2 === 0 ? [] : [{ t: 'shift', kind: SHIFT_NAMES[r.shift]!, amount: r.imm2 }];
  switch (r.spec.klass) {
    case 'addsub': {
      const setsFlags = (r.spec.code & 1) === 1;
      if (r.form === 'imm') {
        const ops: AsmOperand[] = [REG(r.rd, bits, setsFlags ? 'zr' : 'sp'), REG(r.rn, bits, 'sp'), IMM(r.imm)];
        if (r.imm2 !== 0) ops.push({ t: 'shift', kind: 'lsl', amount: 12 });
        return { mnemonic: m, operands: ops };
      }
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), REG(r.rm, bits, 'zr'), ...shiftOp()] };
    }
    case 'logic':
      if (r.form === 'imm') {
        const ops: AsmOperand[] = [REG(r.rd, bits, m === 'ands' ? 'zr' : 'sp'), REG(r.rn, bits, 'zr'), IMM(Number(r.value & 0xffffffffn))];
        if (r.sf) ops.push(IMM(Number(r.value >> 32n)));
        return { mnemonic: m, operands: ops };
      }
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), REG(r.rm, bits, 'zr'), ...shiftOp()] };
    case 'logicn':
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), REG(r.rm, bits, 'zr'), ...shiftOp()] };
    case 'movw': {
      const ops: AsmOperand[] = [REG(r.rd, bits, 'zr'), IMM(r.imm)];
      if (r.imm2 !== 0) ops.push({ t: 'shift', kind: 'lsl', amount: r.imm2 });
      return { mnemonic: m, operands: ops };
    }
    case 'shiftv':
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), REG(r.rm, bits, 'zr')] };
    case 'bitfield':
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), IMM(r.imm), IMM(r.imm2)] };
    case 'mul':
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), REG(r.rm, bits, 'zr'), REG(r.ra, bits, 'zr')] };
    case 'csel':
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), REG(r.rn, bits, 'zr'), REG(r.rm, bits, 'zr'), { t: 'cond', name: COND_NAMES[r.cond]! }] };
    case 'b':
    case 'bcond':
      return { mnemonic: m, operands: [{ t: 'addr', value: pc + r.imm }] };
    case 'cb':
      return { mnemonic: m, operands: [REG(r.rd, bits, 'zr'), { t: 'addr', value: pc + r.imm }] };
    case 'breg':
      return { mnemonic: m, operands: [REG(r.rn, 64, 'zr')] };
    case 'mem': {
      const rt = REG(r.rd, bits, 'zr');
      const base = regName(r.rn, 64, 'sp');
      if (r.form === 'uimm') return { mnemonic: m, operands: [rt, { t: 'mem', base, disp: r.imm }] };
      const index = regName(r.rm, r.option & 1 ? 64 : 32, 'zr');
      const mem: AsmOperand = { t: 'mem', base, disp: 0, index, ext: EXTEND_NAMES[r.option]! };
      if (r.s) mem.shift = Math.log2(r.size);
      return { mnemonic: m, operands: [rt, mem] };
    }
    case 'svc':
      return { mnemonic: m, operands: [IMM(r.imm)] };
    case 'nop':
      return { mnemonic: m, operands: [] };
  }
}

function bitFields(word: number, r: Raw, pc: number): BitField[] {
  const f = (name: string, hi: number, lo: number, text: string): BitField => ({
    name, hi, lo, value: (word >>> lo) & (2 ** (hi - lo + 1) - 1), text,
  });
  const bits: 32 | 64 = r.sf ? 64 : 32;
  const sf = f('sf', 31, 31, r.sf ? '64-bit form (X registers)' : '32-bit form (W registers)');
  const reg = (name: string, hi: number, n: number, r31: 'sp' | 'zr', width: 32 | 64 = bits): BitField =>
    f(name, hi, hi - 4, regName(n, width, r31));
  const fixed = (hi: number, lo: number, text = 'fixed bits of the encoding'): BitField => f('opcode', hi, lo, text);
  const m = r.spec.mnemonic;
  const target = (): string => `target ${hex(pc + r.imm)}`;
  switch (r.spec.klass) {
    case 'addsub': {
      const flags = (r.spec.code & 1) === 1;
      const op = f('op', 30, 30, r.spec.code & 2 ? 'subtract' : 'add');
      const s = f('S', 29, 29, flags ? 'sets N, Z, C, V' : 'flags unchanged');
      if (r.form === 'imm') {
        return [sf, op, s, fixed(28, 23, 'add or subtract immediate'), f('sh', 22, 22, r.imm2 ? 'immediate shifted left by 12' : 'no shift'),
          f('imm12', 21, 10, `${r.imm}`), reg('Rn', 9, r.rn, 'sp'), reg('Rd', 4, r.rd, flags ? 'zr' : 'sp')];
      }
      return [sf, op, s, fixed(28, 24, 'add or subtract shifted register'), f('shift', 23, 22, SHIFT_NAMES[r.shift]!), fixed(21, 21, 'shifted register form'),
        reg('Rm', 20, r.rm, 'zr'), f('imm6', 15, 10, `shift amount ${r.imm2}`), reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, 'zr')];
    }
    case 'logic':
    case 'logicn':
      if (r.form === 'imm') {
        return [sf, f('opc', 30, 29, m), fixed(28, 23, 'logical immediate'), f('N', 22, 22, 'with imms, selects the element size'),
          f('immr', 21, 16, 'right rotation of the element'), f('imms', 15, 10, `run length; value 0x${r.value.toString(16)}`),
          reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, m === 'ands' ? 'zr' : 'sp')];
      }
      return [sf, f('opc', 30, 29, m), fixed(28, 24, 'logical shifted register'), f('shift', 23, 22, SHIFT_NAMES[r.shift]!),
        f('N', 21, 21, r.spec.klass === 'logicn' ? 'second operand inverted' : 'second operand not inverted'), reg('Rm', 20, r.rm, 'zr'),
        f('imm6', 15, 10, `shift amount ${r.imm2}`), reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, 'zr')];
    case 'movw':
      return [sf, f('opc', 30, 29, m), fixed(28, 23, 'move wide immediate'), f('hw', 22, 21, `immediate placed at bit ${r.imm2}`),
        f('imm16', 20, 5, `0x${r.imm.toString(16)}`), reg('Rd', 4, r.rd, 'zr')];
    case 'bitfield':
      return [sf, f('opc', 30, 29, m), fixed(28, 23, 'bitfield'), f('N', 22, 22, 'equals sf'), f('immr', 21, 16, `${r.imm}`),
        f('imms', 15, 10, `${r.imm2}`), reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, 'zr')];
    case 'shiftv':
      return [sf, fixed(30, 21, 'data processing, 2 source'), reg('Rm', 20, r.rm, 'zr'), f('opcode2', 15, 10, m), reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, 'zr')];
    case 'mul':
      return [sf, fixed(30, 21, 'data processing, 3 source'), reg('Rm', 20, r.rm, 'zr'), f('o0', 15, 15, m === 'msub' ? 'subtract the product' : 'add the product'),
        reg('Ra', 14, r.ra, 'zr'), reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, 'zr')];
    case 'csel':
      return [sf, fixed(30, 21, 'conditional select'), reg('Rm', 20, r.rm, 'zr'), f('cond', 15, 12, COND_NAMES[r.cond]!), fixed(11, 11),
        f('o2', 10, 10, m === 'csinc' ? 'increment the second source' : 'second source unchanged'), reg('Rn', 9, r.rn, 'zr'), reg('Rd', 4, r.rd, 'zr')];
    case 'b':
      return [f('op', 31, 31, m === 'bl' ? 'branch with link' : 'branch'), fixed(30, 26, 'unconditional branch immediate'), f('imm26', 25, 0, `offset ${r.imm}, ${target()}`)];
    case 'bcond':
      return [fixed(31, 24, 'conditional branch'), f('imm19', 23, 5, `offset ${r.imm}, ${target()}`), fixed(4, 4), f('cond', 3, 0, COND_NAMES[r.cond]!)];
    case 'cb':
      return [sf, fixed(30, 25, 'compare and branch'), f('op', 24, 24, m === 'cbnz' ? 'branch when not zero' : 'branch when zero'),
        f('imm19', 23, 5, `offset ${r.imm}, ${target()}`), reg('Rt', 4, r.rd, 'zr')];
    case 'breg':
      return [fixed(31, 23, 'unconditional branch to register'), f('opc', 22, 21, m), fixed(20, 10), reg('Rn', 9, r.rn, 'zr', 64), fixed(4, 0)];
    case 'mem': {
      const size = f('size', 31, 30, `${r.size}-byte access`);
      const opc = f('opc', 23, 22, m.startsWith('ldr') ? 'load' : 'store');
      if (r.form === 'uimm') {
        return [size, fixed(29, 24, 'load or store, unsigned offset'), opc, f('imm12', 21, 10, `offset ${r.imm} (field times ${r.size})`),
          reg('Rn', 9, r.rn, 'sp', 64), reg('Rt', 4, r.rd, 'zr')];
      }
      return [size, fixed(29, 24, 'load or store, register offset'), opc, fixed(21, 21), reg('Rm', 20, r.rm, 'zr', r.option & 1 ? 64 : 32),
        f('option', 15, 13, EXTEND_NAMES[r.option]!), f('S', 12, 12, r.s ? `index shifted left by ${Math.log2(r.size)}` : 'index not shifted'),
        fixed(11, 10), reg('Rn', 9, r.rn, 'sp', 64), reg('Rt', 4, r.rd, 'zr')];
    }
    case 'svc':
      return [fixed(31, 21, 'exception generation'), f('imm16', 20, 5, `${r.imm}`), fixed(4, 0, 'SVC')];
    case 'nop':
      return [fixed(31, 0, 'NOP (hint 0)')];
  }
}

export function decode(bytes: Uint8Array, offset: number, pc: number): DecodeResult {
  const available = bytes.length - offset;
  if (available < 4) {
    return { ok: false, kind: 'truncated', message: `an A64 instruction is 4 bytes; only ${Math.max(available, 0)} available`, length: Math.max(available, 0) };
  }
  const word = bytesToWordLE(bytes, offset);
  const r = decodeWord(word);
  if ('kind' in r) return { ok: false, kind: r.kind, message: `${hex(word)}: ${r.message}`, length: 4 };
  const insn = toInsn(r, pc);
  const result: DecodeResult = { ok: true, insn, length: 4, fields: bitFields(word, r, pc) };
  const alias = aliasOf(insn);
  if (alias !== null) result.alias = alias;
  return result;
}
