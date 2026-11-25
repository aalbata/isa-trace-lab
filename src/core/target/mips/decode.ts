/**
 * MIPS32 decoder. `decodeWord` recognizes a 32-bit word and extracts its
 * fields; the processor model executes from this result. `decode` adds the
 * assembly-level instruction and the bit fields. A word is accepted only when
 * every field that the instruction does not use holds the value the
 * architecture requires, so each accepted word has exactly one assembly form.
 */
import { bytesToWordLE, hex, signExtend } from '../../util/int32.ts';
import type { BitField, DecodeResult, Insn } from '../types.ts';
import type { Encoding } from './isa.ts';
import { ENCODINGS, OP_REGIMM, OP_SPECIAL, OP_SPECIAL2, REG_NAMES } from './isa.ts';
import { aliasOf } from './text.ts';

export interface Raw {
  enc: Encoding;
  rs: number;
  rt: number;
  rd: number;
  /** Shift amount field, bits 10 to 6. */
  sa: number;
  /**
   * The 16-bit immediate: sign-extended for arithmetic, comparisons, loads,
   * stores, and branches (where it counts instructions from the delay slot);
   * zero-extended for andi, ori, xori, and lui. For j and jal, the 26-bit
   * instruction index. For syscall, the 20-bit code.
   */
  imm: number;
}

export interface RawError {
  kind: 'invalid' | 'unsupported';
  message: string;
}

const SPECIAL = new Map<number, Encoding>();
const SPECIAL2 = new Map<number, Encoding>();
const REGIMM = new Map<number, Encoding>();
const PRIMARY = new Map<number, Encoding>();
for (const e of ENCODINGS) {
  if (e.opcode === OP_SPECIAL) SPECIAL.set(e.funct, e);
  else if (e.opcode === OP_SPECIAL2) SPECIAL2.set(e.funct, e);
  else if (e.opcode === OP_REGIMM) REGIMM.set(e.regimm, e);
  else PRIMARY.set(e.opcode, e);
}

const unsupported = (message: string): RawError => ({ kind: 'unsupported', message });
const invalid = (message: string): RawError => ({ kind: 'invalid', message });
const bits = (v: number, n: number): string => v.toString(2).padStart(n, '0');

/**
 * Message for a word whose opcode belongs to MIPS64. The encoding tables of the
 * MIPS32 manual (MD00086, Tables A.2, A.3, and A.5) mark with the symbol beta
 * the opcodes and the SPECIAL and SPECIAL2 function codes that are valid at a
 * higher ISA level, MIPS64. A word is classified by that code alone: it is
 * outside the profile, whatever its other fields hold.
 */
const MIPS64 = 'MIPS64 instruction; the profile is MIPS32';

/**
 * Message for a word whose SPECIAL or SPECIAL2 function code belongs to MIPS64.
 * The MIPS32 manual has no instruction pages for these instructions and gives
 * no field layout for them, apart from the field values that Table A.23 lists
 * for the multiply and divide codes 011100 to 011111. The remaining fields of
 * the word are therefore not examined, and a word whose fields MIPS64 itself
 * would reject is reported in the same way.
 */
const mips64Code = (table: string, funct: number): RawError =>
  unsupported(`${table} function code ${bits(funct, 6)} belongs to MIPS64; the profile is MIPS32`);

/**
 * SPECIAL function codes that MIPS32 Release 2 or a related architecture
 * defines outside the implemented subset. A word is reported as an excluded
 * MIPS32 instruction only when the fields that the instruction requires to be
 * zero are zero. Where Release 6 gives the function code another instruction
 * with a different value of those fields, the word is reported as that Release 6
 * instruction; any other value makes the word invalid. The function codes of
 * MIPS64 are reported by the code alone.
 */
function otherSpecial(funct: number, rs: number, rt: number, rd: number, sa: number): RawError {
  switch (funct) {
    case 0b000001: {
      const name = (rt & 1) === 0 ? 'MOVF' : 'MOVT';
      if ((rt & 2) !== 0 || sa !== 0) return invalid(`${name} encoding whose bit 17 or bits 10 to 6 are not zero; they must be zero`);
      return unsupported('MOVF or MOVT, a conditional move on a floating-point condition; conditional moves and coprocessor 1 are outside the profile');
    }
    case 0b001010: case 0b001011:
      if (sa !== 0) return invalid(`${funct === 0b001010 ? 'MOVZ' : 'MOVN'} encoding whose bits 10 to 6 are ${bits(sa, 5)}; they must be zero`);
      return unsupported('MOVZ or MOVN; conditional moves are outside the profile');
    case 0b001101: return unsupported('BREAK is outside the profile');
    case 0b001111:
      if (rs !== 0 || rt !== 0 || rd !== 0) return invalid('SYNC encoding whose bits 25 to 11 are not zero; they must be zero');
      return unsupported('SYNC is outside the profile');
    case 0b010000: case 0b010010: {
      const name = funct === 0b010000 ? 'MFHI' : 'MFLO';
      if (rs === 0 && rt === 0 && sa === 0) return unsupported('MFHI, MTHI, MFLO, or MTLO; the HI and LO registers are outside the profile');
      if (funct === 0b010000 && rt === 0 && sa === 1) {
        return unsupported('MFHI function code with bits 10 to 6 equal to 00001, which is the Release 6 instruction CLZ; MFHI requires rs, rt, and bits 10 to 6 to be zero');
      }
      return invalid(`${name} encoding whose bits 25 to 16 or 10 to 6 are not zero; they must be zero`);
    }
    case 0b010001: case 0b010011: {
      const name = funct === 0b010001 ? 'MTHI' : 'MTLO';
      if (rt === 0 && rd === 0 && sa === 0) return unsupported('MFHI, MTHI, MFLO, or MTLO; the HI and LO registers are outside the profile');
      if (funct === 0b010001 && rt === 0 && sa === 1) {
        return unsupported('MTHI function code with bits 10 to 6 equal to 00001, which is the Release 6 instruction CLO; MTHI requires rt, rd, and bits 10 to 6 to be zero');
      }
      return invalid(`${name} encoding whose bits 20 to 6 are not zero; they must be zero`);
    }
    case 0b011000: case 0b011001: case 0b011010: case 0b011011: {
      const name = ['MULT', 'MULTU', 'DIV', 'DIVU'][funct & 3]!;
      if (rd === 0 && sa === 0) return unsupported('MULT, MULTU, DIV, or DIVU (HI/LO multiply and divide), outside the profile; Release 6 reuses these function codes');
      if (sa === 0b00010 || sa === 0b00011) {
        const r6 = [['MUL', 'MUH'], ['MULU', 'MUHU'], ['DIV', 'MOD'], ['DIVU', 'MODU']][funct & 3]![sa - 2]!;
        return unsupported(`${name} function code with bits 10 to 6 equal to ${bits(sa, 5)}, which is the Release 6 instruction ${r6} (result in a general register); ${name} requires rd and bits 10 to 6 to be zero`);
      }
      return invalid(`${name} encoding whose bits 15 to 6 are not zero; they must be zero`);
    }
    case 0b110000: case 0b110001: case 0b110010: case 0b110011: case 0b110100: case 0b110110:
      return unsupported('trap instruction (TGE, TGEU, TLT, TLTU, TEQ, TNE), outside the profile');
    case 0b010100: case 0b010101: case 0b010110: case 0b010111: case 0b011100: case 0b011101: case 0b011110: case 0b011111:
    case 0b101100: case 0b101101: case 0b101110: case 0b101111: case 0b111000: case 0b111010: case 0b111011: case 0b111100:
    case 0b111110: case 0b111111:
      return mips64Code('SPECIAL', funct);
    default: return invalid(`reserved SPECIAL function code ${bits(funct, 6)} in MIPS32 Release 2`);
  }
}

/** Primary opcodes that MIPS32 Release 2 or a related architecture defines outside the implemented subset. */
function otherPrimary(opcode: number, rt: number): RawError {
  switch (opcode) {
    case 0b010000: return unsupported('coprocessor 0 (system control) instruction, outside the profile');
    case 0b010001: case 0b010011: return unsupported('floating-point instruction (coprocessor 1), outside the profile');
    case 0b010010: return unsupported('coprocessor 2 instruction, outside the profile');
    case 0b010110: case 0b010111:
      if (rt !== 0) {
        const [name, r6] = opcode === 0b010110 ? ['BLEZL', 'BLEZC, BGEZC, or BGEC'] : ['BGTZL', 'BGTZC, BLTZC, or BLTC'];
        return unsupported(`${name} opcode with a nonzero rt field, which is a Release 6 compact-branch encoding (${r6}); Release 2 requires rt to be zero`);
      }
      return unsupported('branch-likely instruction (BEQL, BNEL, BLEZL, BGTZL), outside the profile');
    case 0b010100: case 0b010101:
      return unsupported('branch-likely instruction (BEQL, BNEL, BLEZL, BGTZL), outside the profile');
    case 0b011101: return unsupported('JALX, which switches to the MIPS16e or microMIPS instruction set, outside the profile');
    case 0b011111: return unsupported('SPECIAL3 instruction of Release 2 (EXT, INS, SEB, SEH, WSBH, RDHWR), outside the profile');
    case 0b100010: case 0b100110: case 0b101010: case 0b101110:
      return unsupported('unaligned load or store (LWL, LWR, SWL, SWR), outside the profile');
    case 0b101111: case 0b110011: return unsupported('CACHE or PREF, outside the profile');
    case 0b110000: case 0b111000: return unsupported('LL or SC (atomic read-modify-write), outside the profile');
    case 0b110001: case 0b110101: case 0b111001: case 0b111101:
      return unsupported('floating-point load or store (coprocessor 1), outside the profile');
    case 0b110010: case 0b110110: case 0b111010: case 0b111110:
      return unsupported('coprocessor 2 load or store, outside the profile');
    case 0b011000: case 0b011001: case 0b011010: case 0b011011: case 0b100111: case 0b101100: case 0b101101:
    case 0b110100: case 0b110111: case 0b111100: case 0b111111:
      return unsupported(MIPS64);
    default: return invalid(`reserved opcode ${bits(opcode, 6)} in MIPS32 Release 2`);
  }
}

export function decodeWord(word: number): Raw | RawError {
  const opcode = word >>> 26;
  const rs = (word >>> 21) & 31;
  const rt = (word >>> 16) & 31;
  const rd = (word >>> 11) & 31;
  const sa = (word >>> 6) & 31;
  const funct = word & 63;
  const low16 = word & 0xffff;

  if (opcode === OP_SPECIAL) {
    const enc = SPECIAL.get(funct);
    if (!enc) return otherSpecial(funct, rs, rt, rd, sa);
    switch (enc.format) {
      case 'SHI':
        if (rs === 1 && enc.mnemonic === 'srl') return unsupported('ROTR (rotate right, Release 2), outside the profile');
        if (rs !== 0) return invalid(`'${enc.mnemonic}' encoding whose rs field is ${bits(rs, 5)}; it must be zero`);
        return { enc, rs, rt, rd, sa, imm: 0 };
      case 'SHV':
        if (sa === 1 && enc.mnemonic === 'srlv') return unsupported('ROTRV (rotate right variable, Release 2), outside the profile');
        if (sa !== 0) return invalid(`'${enc.mnemonic}' encoding whose bits 10 to 6 are ${bits(sa, 5)}; they must be zero`);
        return { enc, rs, rt, rd, sa, imm: 0 };
      case 'JR':
        if (rt === 0 && rd === 0 && sa === 0b10000) return unsupported('JR.HB (jump with hazard barrier, Release 2), outside the profile');
        if (rt !== 0 || rd !== 0 || sa !== 0) return invalid(`'jr' encoding whose bits 20 to 6 are not zero`);
        return { enc, rs, rt, rd, sa, imm: 0 };
      case 'JALR':
        if (rt === 0 && sa === 0b10000) return unsupported('JALR.HB (jump and link with hazard barrier, Release 2), outside the profile');
        if (rt !== 0 || sa !== 0) return invalid(`'jalr' encoding whose rt or hint field is not zero`);
        return { enc, rs, rt, rd, sa, imm: 0 };
      case 'SYS':
        return { enc, rs: 0, rt: 0, rd: 0, sa: 0, imm: (word >>> 6) & 0xfffff };
      default:
        if (sa !== 0) return invalid(`'${enc.mnemonic}' encoding whose bits 10 to 6 are ${bits(sa, 5)}; they must be zero`);
        return { enc, rs, rt, rd, sa, imm: 0 };
    }
  }
  if (opcode === OP_SPECIAL2) {
    const enc = SPECIAL2.get(funct);
    if (!enc) {
      // MADD to MSUBU, CLZ, and CLO are named only when the fields that they require to be zero are zero.
      // The MIPS64 function codes 100100 and 100101 are reported by the code alone.
      if (funct === 0b000000 || funct === 0b000001 || funct === 0b000100 || funct === 0b000101) {
        const name = ['MADD', 'MADDU', '', '', 'MSUB', 'MSUBU'][funct]!;
        if (rd !== 0 || sa !== 0) return invalid(`${name} encoding whose bits 15 to 6 are not zero; they must be zero`);
        return unsupported('MADD, MADDU, MSUB, or MSUBU (multiply-accumulate into HI/LO), outside the profile');
      }
      if (funct === 0b100000 || funct === 0b100001) {
        if (sa !== 0) return invalid(`${funct === 0b100000 ? 'CLZ' : 'CLO'} encoding whose bits 10 to 6 are ${bits(sa, 5)}; they must be zero`);
        return unsupported('CLZ or CLO (count leading bits), outside the profile');
      }
      if (funct === 0b100100 || funct === 0b100101) return mips64Code('SPECIAL2', funct);
      if (funct === 0b111111) return unsupported('SDBBP (debug breakpoint), outside the profile');
      return invalid(`reserved SPECIAL2 function code ${bits(funct, 6)} in MIPS32 Release 2`);
    }
    if (sa !== 0) return invalid(`'mul' encoding whose bits 10 to 6 are ${bits(sa, 5)}; they must be zero`);
    return { enc, rs, rt, rd, sa, imm: 0 };
  }
  if (opcode === OP_REGIMM) {
    const enc = REGIMM.get(rt);
    if (enc) return { enc, rs, rt, rd: 0, sa: 0, imm: signExtend(low16, 16) };
    if (rt === 0b00010 || rt === 0b00011 || rt === 0b10010 || rt === 0b10011) {
      return unsupported('branch-likely instruction (BLTZL, BGEZL, BLTZALL, BGEZALL), outside the profile');
    }
    if (rt === 0b10000 || rt === 0b10001) return unsupported('linking branch (BLTZAL, BGEZAL, BAL), outside the profile');
    if ((rt >= 0b01000 && rt <= 0b01100) || rt === 0b01110) return unsupported('trap instruction with an immediate (TGEI, TGEIU, TLTI, TLTIU, TEQI, TNEI), outside the profile');
    if (rt === 0b11111) return unsupported('SYNCI (Release 2), outside the profile');
    return invalid(`reserved REGIMM code ${bits(rt, 5)} in MIPS32 Release 2`);
  }
  const enc = PRIMARY.get(opcode);
  if (!enc) return otherPrimary(opcode, rt);
  switch (enc.format) {
    case 'J':
      return { enc, rs: 0, rt: 0, rd: 0, sa: 0, imm: word & 0x3ffffff };
    case 'B1':
      if (rt !== 0) return unsupported(`'${enc.mnemonic}' opcode with a nonzero rt field, which is a Release 6 compact-branch encoding; Release 2 requires rt to be zero`);
      return { enc, rs, rt, rd: 0, sa: 0, imm: signExtend(low16, 16) };
    case 'LUI':
      if (rs !== 0) return unsupported('LUI opcode with a nonzero rs field, which is the Release 6 instruction AUI; Release 2 requires rs to be zero');
      return { enc, rs, rt, rd: 0, sa: 0, imm: low16 };
    case 'IU':
      return { enc, rs, rt, rd: 0, sa: 0, imm: low16 };
    default:
      return { enc, rs, rt, rd: 0, sa: 0, imm: signExtend(low16, 16) };
  }
}

/** Target address of a decoded branch located at `pc`: the offset counts instructions from the delay slot. */
export function branchTarget(raw: Raw, pc: number): number {
  return (pc + 4 + raw.imm * 4) >>> 0;
}

/** Target address of a decoded j or jal located at `pc`: the index replaces the low 28 bits of the delay-slot address. */
export function jumpTarget(raw: Raw, pc: number): number {
  return ((((pc + 4) & 0xf0000000) >>> 0) + raw.imm * 4) >>> 0;
}

/** Assembly-level instruction for a decoded word at address `pc`. */
export function toInsn(raw: Raw, pc: number): Insn {
  const r = (n: number) => ({ t: 'reg' as const, name: REG_NAMES[n]! });
  const m = raw.enc.mnemonic;
  switch (raw.enc.format) {
    case 'R3':
      return { mnemonic: m, operands: [r(raw.rd), r(raw.rs), r(raw.rt)] };
    case 'SHI':
      return { mnemonic: m, operands: [r(raw.rd), r(raw.rt), { t: 'imm', value: raw.sa }] };
    case 'SHV':
      return { mnemonic: m, operands: [r(raw.rd), r(raw.rt), r(raw.rs)] };
    case 'JR':
      return { mnemonic: m, operands: [r(raw.rs)] };
    case 'JALR':
      return { mnemonic: m, operands: [r(raw.rd), r(raw.rs)] };
    case 'SYS':
      return { mnemonic: m, operands: raw.imm === 0 ? [] : [{ t: 'imm', value: raw.imm }] };
    case 'I':
    case 'IU':
      return { mnemonic: m, operands: [r(raw.rt), r(raw.rs), { t: 'imm', value: raw.imm }] };
    case 'LUI':
      return { mnemonic: m, operands: [r(raw.rt), { t: 'imm', value: raw.imm }] };
    case 'M':
      return { mnemonic: m, operands: [r(raw.rt), { t: 'mem', base: REG_NAMES[raw.rs]!, disp: raw.imm }] };
    case 'B2':
      return { mnemonic: m, operands: [r(raw.rs), r(raw.rt), { t: 'addr', value: branchTarget(raw, pc) }] };
    case 'B1':
      return { mnemonic: m, operands: [r(raw.rs), { t: 'addr', value: branchTarget(raw, pc) }] };
    case 'J':
      return { mnemonic: m, operands: [{ t: 'addr', value: jumpTarget(raw, pc) }] };
  }
}

function bitFields(word: number, raw: Raw, pc: number): BitField[] {
  const f = (name: string, hi: number, lo: number, text: string): BitField => ({
    name, hi, lo, value: (word >>> lo) & (2 ** (hi - lo + 1) - 1), text,
  });
  const regText = (n: number) => `${REG_NAMES[n]} ($${n})`;
  const m = raw.enc.mnemonic;
  const opcode = f('opcode', 31, 26, raw.enc.opcode === OP_SPECIAL ? 'SPECIAL' : raw.enc.opcode === OP_SPECIAL2 ? 'SPECIAL2' : raw.enc.opcode === OP_REGIMM ? 'REGIMM' : m);
  const rs = (text = regText(raw.rs)) => f('rs', 25, 21, text);
  const rt = (text = regText(raw.rt)) => f('rt', 20, 16, text);
  const rd = (text = regText(raw.rd)) => f('rd', 15, 11, text);
  const sa = (text = 'must be zero') => f('sa', 10, 6, text);
  const funct = f('function', 5, 0, m);
  const zero = 'must be zero';
  switch (raw.enc.format) {
    case 'R3':
      return [opcode, rs(), rt(), rd(), sa(), funct];
    case 'SHI':
      return [opcode, rs(zero), rt(), rd(), sa(`shift by ${raw.sa}`), funct];
    case 'SHV':
      return [opcode, rs(`${regText(raw.rs)}, shift count`), rt(), rd(), sa(), funct];
    case 'JR':
      return [opcode, rs(`${regText(raw.rs)}, target address`), f('zero', 20, 11, zero), f('hint', 10, 6, zero), funct];
    case 'JALR':
      return [opcode, rs(`${regText(raw.rs)}, target address`), rt(zero), rd(`${regText(raw.rd)}, receives the return address`), f('hint', 10, 6, zero), funct];
    case 'SYS':
      return [opcode, f('code', 25, 6, `${raw.imm}, available to the exception handler`), funct];
    case 'I':
      return [opcode, rs(), rt(), f('immediate', 15, 0, `${raw.imm} (sign-extended)`)];
    case 'IU':
      return [opcode, rs(), rt(), f('immediate', 15, 0, `${raw.imm} (zero-extended)`)];
    case 'LUI':
      return [opcode, rs(zero), rt(), f('immediate', 15, 0, `${hex((raw.imm << 16) >>> 0)} after the shift by 16`)];
    case 'M':
      return [opcode, f('base', 25, 21, regText(raw.rs)), rt(), f('offset', 15, 0, `${raw.imm} (sign-extended)`)];
    case 'B2':
      return [opcode, rs(), rt(), f('offset', 15, 0, `${raw.imm} instructions from the delay slot, target ${hex(branchTarget(raw, pc))}`)];
    case 'B1':
      return [
        opcode, rs(), rt(raw.enc.opcode === OP_REGIMM ? m : zero),
        f('offset', 15, 0, `${raw.imm} instructions from the delay slot, target ${hex(branchTarget(raw, pc))}`),
      ];
    case 'J':
      return [opcode, f('instr_index', 25, 0, `target ${hex(jumpTarget(raw, pc))}: the index times 4 replaces the low 28 bits of the delay-slot address`)];
  }
}

export function decode(bytes: Uint8Array, offset: number, pc: number): DecodeResult {
  const available = bytes.length - offset;
  if (available < 4) {
    return { ok: false, kind: 'truncated', message: `a MIPS32 instruction is 4 bytes; only ${Math.max(available, 0)} available`, length: Math.max(available, 0) };
  }
  const word = bytesToWordLE(bytes, offset);
  const raw = decodeWord(word);
  if ('kind' in raw) return { ok: false, kind: raw.kind, message: `${hex(word)}: ${raw.message}`, length: 4 };
  const insn = toInsn(raw, pc);
  const result: DecodeResult = { ok: true, insn, length: 4, fields: bitFields(word, raw, pc) };
  const alias = aliasOf(insn);
  if (alias !== null) result.alias = alias;
  return result;
}
