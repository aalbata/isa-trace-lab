/**
 * x86-64 decoder for 64-bit mode. `decodeRaw` recognizes one instruction of
 * the implemented subset in a byte sequence and extracts its operation,
 * operand size, registers, memory operand, and immediate; the processor model
 * executes from this result. For a defined instruction outside the subset it
 * reports the length that follows from the instruction format, so that a
 * listing of consecutive instructions continues at the next one. `decode` adds
 * the assembly-level instruction and the byte-level field breakdown.
 */
import { hex, hexAddress } from '../../util/int32.ts';
import type { AsmOperand, BitField, ByteField, DecodeResult, Insn } from '../types.ts';
import { ALU_BY_EXT, CC_MEANING, CC_NAMES, REG32, REG64, REG8, REG8_HIGH, SHIFT_BY_EXT } from './isa.ts';

/** Register or memory operand selected by the ModR/M byte. */
export type RM =
  | { kind: 'reg'; reg: number }
  /** `base` and `index` are register numbers, or -1 when absent; the address is base + index * scale + disp. */
  | { kind: 'mem'; base: number; index: number; scale: number; disp: number };

/**
 * Operand arrangement:
 *  rm_r      destination r/m, source register          r_rm      destination register, source r/m
 *  rm_imm    destination r/m, source immediate         acc_imm   destination eax or rax, source immediate
 *  r_imm     destination register, source immediate    r_rm_imm  destination register, sources r/m and immediate
 *  rm_cl     destination r/m, count in cl              rm        one r/m operand
 *  r         one register operand                      rel       relative branch target
 *  none      no operands
 */
export type Form = 'rm_r' | 'r_rm' | 'rm_imm' | 'acc_imm' | 'r_imm' | 'r_rm_imm' | 'rm_cl' | 'rm' | 'r' | 'rel' | 'none';

export interface Layout {
  /** Offset of the REX prefix from the start of the instruction, or -1. */
  rex: number;
  opcode: number;
  opcodeLength: number;
  modrm: number;
  sib: number;
  disp: number;
  dispLength: number;
  imm: number;
  immLength: number;
}

export interface Raw {
  /** Operation: a mnemonic of the subset, with `jcc` and `setcc` for the conditional families. */
  op: string;
  /** Condition number of jcc and setcc; -1 otherwise. */
  cc: number;
  form: Form;
  /** Operand size in bits of the register and r/m operands, except where the operation fixes another size. */
  size: 32 | 64;
  /** Register from the reg field of ModR/M or from the low three opcode bits, extended by REX. */
  reg: number;
  rm: RM | null;
  /** True when a byte-sized register operand in r/m is ah, ch, dh, or bh (`rm.reg` is then 4 to 7). */
  rmHigh: boolean;
  /** Immediate, sign-extended, or the branch offset relative to the next instruction. */
  imm: number;
  /** REX prefix byte, or 0 when absent. */
  rex: number;
  length: number;
  layout: Layout;
}

export interface RawError {
  kind: 'invalid' | 'unsupported' | 'truncated';
  message: string;
  /**
   * unsupported: the length of the instruction, or of the bytes present when they end inside it;
   * invalid: the bytes examined, at most 15; truncated: the bytes available, which end inside the instruction.
   */
  length: number;
}

class DecodeStop extends Error {
  kind: 'invalid' | 'unsupported' | 'truncated';
  constructor(kind: 'invalid' | 'unsupported' | 'truncated', message: string) {
    super(message);
    this.kind = kind;
  }
}

const h2 = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');

const LEGACY_PREFIX: Record<number, string> = {
  0x26: 'ES segment override prefix', 0x2e: 'CS segment override prefix', 0x36: 'SS segment override prefix', 0x3e: 'DS segment override prefix',
  0x64: 'FS segment override prefix', 0x65: 'GS segment override prefix',
  0x66: 'operand-size prefix (16-bit operand size, or part of a vector opcode)', 0x67: 'address-size prefix (32-bit addressing)',
  0xf0: 'LOCK prefix', 0xf2: 'REPNE prefix (or part of a vector opcode)', 0xf3: 'REP prefix (or part of a vector opcode)',
};

/** One-byte opcodes that the manual marks as invalid in 64-bit mode. */
const INVALID_64: Record<number, string> = {
  0x06: 'PUSH ES', 0x07: 'POP ES', 0x0e: 'PUSH CS', 0x16: 'PUSH SS', 0x17: 'POP SS', 0x1e: 'PUSH DS', 0x1f: 'POP DS',
  0x27: 'DAA', 0x2f: 'DAS', 0x37: 'AAA', 0x3f: 'AAS', 0x60: 'PUSHA', 0x61: 'POPA', 0x82: 'the alias of opcode 80',
  0x9a: 'far CALL with an immediate pointer', 0xce: 'INTO', 0xd4: 'AAM', 0xd5: 'AAD', 0xea: 'far JMP with an immediate pointer',
};

/** Names of defined one-byte opcodes outside the subset, for diagnostics. */
function nameOneByte(op: number): string {
  if (op < 0x40 && (op & 7) < 6) {
    const name = ALU_BY_EXT[op >> 3]!.toUpperCase();
    const k = op & 7;
    if (name === 'ADC' || name === 'SBB') return `${name} (add or subtract with carry)`;
    return k === 4 ? `${name} al, imm8 (8-bit operand)` : `${name} with 8-bit operands`;
  }
  if (op >= 0x91 && op <= 0x97) return 'XCHG with the accumulator';
  if (op >= 0xb0 && op <= 0xb7) return 'MOV r8, imm8 (8-bit operand)';
  if (op >= 0xd8 && op <= 0xdf) return 'an x87 floating-point instruction';
  if (op >= 0xe0 && op <= 0xe3) return 'LOOP, LOOPE, LOOPNE, or JRCXZ';
  const names: Record<number, string> = {
    0x62: 'the EVEX prefix of AVX-512', 0x68: 'PUSH imm32', 0x6a: 'PUSH imm8', 0x6c: 'INS', 0x6d: 'INS', 0x6e: 'OUTS', 0x6f: 'OUTS',
    0x80: 'the immediate group with 8-bit operands', 0x84: 'TEST with 8-bit operands', 0x86: 'XCHG', 0x87: 'XCHG',
    0x88: 'MOV with 8-bit operands', 0x8a: 'MOV with 8-bit operands', 0x8c: 'MOV from a segment register', 0x8e: 'MOV to a segment register',
    0x98: 'CWDE or CDQE', 0x99: 'CDQ or CQO', 0x9b: 'FWAIT', 0x9c: 'PUSHFQ', 0x9d: 'POPFQ', 0x9e: 'SAHF', 0x9f: 'LAHF',
    0xa0: 'MOV with a memory offset', 0xa1: 'MOV with a memory offset', 0xa2: 'MOV with a memory offset', 0xa3: 'MOV with a memory offset',
    0xa4: 'MOVS', 0xa5: 'MOVS', 0xa6: 'CMPS', 0xa7: 'CMPS', 0xa8: 'TEST al, imm8', 0xa9: 'TEST with an immediate',
    0xaa: 'STOS', 0xab: 'STOS', 0xac: 'LODS', 0xad: 'LODS', 0xae: 'SCAS', 0xaf: 'SCAS',
    0xc0: 'a shift or rotate with an 8-bit operand', 0xc2: 'RET imm16', 0xc4: 'the three-byte VEX prefix', 0xc5: 'the two-byte VEX prefix',
    0xc8: 'ENTER', 0xc9: 'LEAVE', 0xca: 'far RET', 0xcb: 'far RET', 0xcc: 'INT3', 0xcd: 'INT n', 0xcf: 'IRET',
    0xd0: 'a shift or rotate with an 8-bit operand', 0xd2: 'a shift or rotate with an 8-bit operand', 0xd6: 'UDB, which raises an invalid-opcode exception in 64-bit mode',
    0xd7: 'XLAT', 0xe4: 'IN', 0xe5: 'IN', 0xe6: 'OUT', 0xe7: 'OUT', 0xec: 'IN', 0xed: 'IN', 0xee: 'OUT', 0xef: 'OUT',
    0xf1: 'INT1', 0xf4: 'HLT', 0xf5: 'CMC', 0xf6: 'the unary group with an 8-bit operand', 0xf8: 'CLC', 0xf9: 'STC', 0xfa: 'CLI', 0xfb: 'STI',
    0xfc: 'CLD', 0xfd: 'STD',
  };
  return names[op] ?? '';
}

/** Names of some defined two-byte opcodes (0F xx) outside the subset, for diagnostics. */
function nameTwoByte(op: number): string {
  if (op >= 0x40 && op <= 0x4f) return `CMOV${CC_NAMES[op & 15]!.toUpperCase()} (conditional move)`;
  const names: Record<number, string> = {
    0x0b: 'UD2', 0x1f: 'the multi-byte NOP', 0x31: 'RDTSC', 0xa2: 'CPUID', 0xa3: 'BT', 0xab: 'BTS', 0xb3: 'BTR', 0xbb: 'BTC',
    0xa4: 'SHLD', 0xa5: 'SHLD', 0xac: 'SHRD', 0xad: 'SHRD', 0xb0: 'CMPXCHG', 0xb1: 'CMPXCHG', 0xb7: 'MOVZX from a 16-bit operand',
    0xbe: 'MOVSX from an 8-bit operand', 0xbf: 'MOVSX from a 16-bit operand', 0xbc: 'BSF', 0xbd: 'BSR', 0xc0: 'XADD', 0xc1: 'XADD',
    0xc8: 'BSWAP', 0xc9: 'BSWAP', 0xca: 'BSWAP', 0xcb: 'BSWAP', 0xcc: 'BSWAP', 0xcd: 'BSWAP', 0xce: 'BSWAP', 0xcf: 'BSWAP',
  };
  return names[op] ?? '';
}

/** Space-separated table cells. */
const cellsOf = (text: string): string[] => text.trim().split(/\s+/);

/**
 * Two-byte opcodes 0F 00 to 0F FF in 64-bit mode. Each cell has one character per mandatory-prefix class, in the
 * order no 66, F2, or F3 prefix; 66; F3; F2 (the F2 or F3 prefix nearest the opcode selects the class, and
 * otherwise a 66 prefix does): 'a' defined with any ModR/M byte, or without one; 'm' defined with a memory
 * operand only (ModR/M mod other than 11); 'r' defined with a register operand only (mod 11); 'g' a group whose
 * members GROUPS lists; '-' undefined. The cells follow the opcode columns of the instruction pages of Intel SDM
 * Vol. 2A and 2B: an opcode written with a 66, F2, or F3 prefix is defined only with it, a SIMD instruction only
 * with its mandatory prefixes, and an NP or NFx marking excludes the other prefixes. Other general-purpose and
 * system instructions also accept the 66, F2, and F3 prefixes, whose other uses Vol. 2A, Section 2.1.1, calls
 * reserved, except where an instruction of Vol. 2D or Vol. 3 shares its opcode with instructions that prefixes
 * select: XSAVE, XRSTOR, and XSAVEOPT (0F AE /4 to /6 with a memory operand), the VMX pointer instructions
 * (0F C7 /6 and /7 with a memory operand), WRMSRNS (0F 01 C6), and WRSSD (0F 38 F6) are undefined with a prefix
 * that no instruction there uses. 0F 18 to 0F 1F are the hint and NOP space (PREFETCHh, MPX, CLDEMOTE, CET, and
 * NOP). The AMD and VIA opcodes 0F 0E, 0F 0F, 0F A6, and 0F A7 are undefined in this profile.
 */
const MAP_0F = cellsOf(`
  gggg gggg aaaa aaaa ---- aaaa aaaa aaaa aaaa aaaa ---- aaaa ---- gggg ---- ----
  aaaa aaaa amaa mm-- aa-- aa-- ama- mm-- aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa
  aaaa aaaa aaaa aaaa ---- ---- ---- ---- aa-- aa-- aaaa mm-- aaaa aaaa aa-- aa--
  aaaa aaaa aaaa aaaa aaaa aaaa ---- aaaa aaaa ---- aaaa ---- ---- ---- ---- ----
  aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa
  rr-- aaaa a-a- a-a- aa-- aa-- aa-- aa-- aaaa aaaa aaaa aaa- aaaa aaaa aaaa aaaa
  aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- -a-- -a-- aa-- aaa-
  aaaa gg-- gg-- gg-- aa-- aa-- aa-- a--- aaaa aaaa ---- ---- -a-a -a-a aaa- aaa-
  aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa
  aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa
  aaaa aaaa aaaa aaaa aaaa aaaa ---- ---- aaaa aaaa aaaa aaaa aaaa aaaa gggg aaaa
  aaaa aaaa mmmm aaaa mmmm mmmm aaaa aaaa --a- aaaa gggg aaaa aaaa aaaa aaaa aaaa
  aaaa aaaa aaaa m--- aa-- rr-- aa-- gggg aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa
  -a-a aa-- aa-- aa-- aa-- aa-- -arr rr-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa--
  aa-- aa-- aa-- aa-- aa-- aa-- -aaa mm-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aa--
  ---m aa-- aa-- aa-- aa-- aa-- aa-- rr-- aa-- aa-- aa-- aa-- aa-- aa-- aa-- aaaa
`);

/** Cells for the opcodes `first` to `last` of a three-byte map; opcodes not listed are undefined. */
function threeByteMap(runs: readonly (readonly [number, number, string])[]): string[] {
  const map = new Array<string>(256).fill('----');
  for (const [first, last, cell] of runs) map.fill(cell, first, last + 1);
  return map;
}

/** Three-byte opcodes 0F 38 xx without a VEX or EVEX prefix, in the notation of MAP_0F. */
const MAP_0F38 = threeByteMap([
  [0x00, 0x0b, 'aa--'], [0x10, 0x10, '-a--'], [0x14, 0x15, '-a--'], [0x17, 0x17, '-a--'], [0x1c, 0x1e, 'aa--'], [0x20, 0x25, '-a--'],
  [0x28, 0x29, '-a--'], [0x2a, 0x2a, '-m--'], [0x2b, 0x2b, '-a--'], [0x30, 0x35, '-a--'], [0x37, 0x41, '-a--'], [0x80, 0x82, '-m--'],
  [0xc8, 0xcd, 'a---'], [0xcf, 0xcf, '-a--'], [0xd8, 0xd8, '--g-'], [0xdb, 0xdb, '-a--'], [0xdc, 0xdc, '-aa-'], [0xdd, 0xdf, '-am-'],
  [0xf0, 0xf1, 'mm-a'], [0xf5, 0xf5, '-m--'], [0xf6, 0xf6, 'maa-'], [0xf8, 0xf8, '-maa'], [0xf9, 0xf9, 'm---'], [0xfa, 0xfb, '--r-'],
]);

/** Three-byte opcodes 0F 3A xx without a VEX or EVEX prefix, in the notation of MAP_0F; each takes an 8-bit immediate. */
const MAP_0F3A = threeByteMap([
  [0x08, 0x0e, '-a--'], [0x0f, 0x0f, 'aa--'], [0x14, 0x17, '-a--'], [0x20, 0x22, '-a--'], [0x40, 0x42, '-a--'], [0x44, 0x44, '-a--'],
  [0x60, 0x63, '-a--'], [0xcc, 0xcc, 'a---'], [0xce, 0xcf, '-a--'], [0xdf, 0xdf, '-a--'], [0xf0, 0xf0, '--g-'],
]);

/**
 * Members of the group opcodes by the ModR/M reg field /0 to /7, in the notation of MAP_0F: SLDT, STR, LLDT, LTR,
 * VERR, VERW, LKGS (0F 00); SGDT, SIDT, LGDT, LIDT, SMSW, RSTORSSP, LMSW, INVLPG (0F 01 with a memory operand);
 * PREFETCHW and PREFETCHWT1 (0F 0D); the shifts by an immediate (0F 71 to 0F 73); FXSAVE, FXRSTOR, LDMXCSR,
 * STMXCSR, XSAVE, XRSTOR, XSAVEOPT, CLFLUSH and their prefixed and register forms (0F AE); BT, BTS, BTR, BTC
 * (0F BA); CMPXCHG8B, XRSTORS, XSAVEC, XSAVES, the VMX pointer instructions, RDRAND, RDSEED, SENDUIPI, RDPID
 * (0F C7); the wide Key Locker instructions (0F 38 D8).
 */
const GROUPS: Record<string, string[]> = {
  '0F 00': cellsOf('aaaa aaaa aaaa aaaa aaaa aaaa ---a ----'),
  '0F 01': cellsOf('mmmm mmmm mmmm mmmm mmmm --m- mmmm mmmm'),
  '0F 0D': cellsOf('---- mmmm mmmm ---- ---- ---- ---- ----'),
  '0F 71': cellsOf('---- ---- rr-- ---- rr-- ---- rr-- ----'),
  '0F 72': cellsOf('---- ---- rr-- ---- rr-- ---- rr-- ----'),
  '0F 73': cellsOf('---- ---- rr-- -r-- ---- ---- rr-- -r--'),
  '0F AE': cellsOf('m-r- m-r- m-r- m-r- m-a- a-r- aaar am--'),
  '0F BA': cellsOf('---- ---- ---- ---- aaaa aaaa aaaa aaaa'),
  '0F C7': cellsOf('---- mmmm ---- mmmm mmmm mmmm aaa- arr-'),
  '0F 38 D8': cellsOf('--m- --m- --m- --m- ---- ---- ---- ----'),
};

/**
 * Register forms of group 7, ModR/M bytes C0 to FF of 0F 01, one cell each in the notation of MAP_0F: ENCLV,
 * VMCALL, VMLAUNCH, VMRESUME, VMXOFF, PCONFIG, WRMSRNS (F3 WRMSRLIST, F2 RDMSRLIST), PBNDKB; MONITOR, MWAIT, CLAC
 * (F2 ERETS, F3 ERETU), STAC, ENCLS; XGETBV, XSETBV, VMFUNC, XEND, XTEST, ENCLU; SMSW; SERIALIZE (F3 SETSSBSY,
 * F2 XSUSLDTRK), F2 XRESLDTRK, F3 SAVEPREVSSP, F3 UIRET, F3 TESTUI, RDPKRU (F3 CLUI), WRPKRU (F3 STUI); LMSW;
 * SWAPGS, RDTSCP. D8 to DF and FA to FF hold AMD instructions.
 */
const GROUP7_REGISTER = cellsOf(`
  aaaa aaaa aaaa aaaa aaaa a--- a-aa a--- aaaa aaaa a-aa a--- ---- ---- ---- aaaa
  aaaa aaaa ---- ---- aaaa aaaa aaaa aaaa ---- ---- ---- ---- ---- ---- ---- ----
  aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa a-aa ---a --a- ---- --a- --a- a-a- aaaa
  aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa ---- ---- ---- ---- ---- ----
`);

const MANDATORY_PREFIX = ['', '66 ', 'F3 ', 'F2 '];

/** The mandatory-prefix classes for which a cell of MAP_0F defines an instruction, as text. */
function prefixesOf(cell: string): string {
  const names = [...cell].flatMap((c, i) => (c === '-' ? [] : [i === 0 ? 'no mandatory prefix' : `the ${MANDATORY_PREFIX[i]}prefix`]));
  return names.length < 3 ? names.join(' or ') : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

/**
 * Why the ModR/M byte `m` makes the legacy-map opcode `name` (for example '0F AE' or '0F 38 F0') undefined with
 * the mandatory-prefix class `cls` (0 none, 1 66, 2 F3, 3 F2), whose character in the opcode's cell is `c`, or
 * null when the combination is defined.
 */
function undefinedLegacyForm(name: string, cls: number, c: string, m: number): string | null {
  const reg = m >> 6 === 3;
  const operand = reg ? 'a register operand (ModR/M mod = 11)' : 'a memory operand';
  const spec = `${MANDATORY_PREFIX[cls]}${name}`;
  if (c === 'm' || c === 'r') return (c === 'r') === reg ? null : `opcode ${spec} with ${operand} is an undefined opcode`;
  if (c !== 'g') return null;
  if (name === '0F 01' && reg) return GROUP7_REGISTER[m - 0xc0]![cls] === 'a' ? null : `opcode ${spec} ${h2(m)} is an undefined opcode`;
  // HRESET is F3 0F 3A F0 C0 ib: the ModR/M byte is part of the opcode.
  if (name === '0F 3A F0') return m === 0xc0 ? null : `opcode ${spec} ${h2(m)} is an undefined opcode; F3 0F 3A F0 is defined only with the ModR/M byte C0 (HRESET)`;
  const ext = (m >> 3) & 7;
  const d = GROUPS[name]![ext]![cls]!;
  return d === 'a' || (d === 'm' && !reg) || (d === 'r' && reg) ? null : `opcode ${spec} /${ext} with ${operand} is an undefined opcode`;
}

/** Two-byte opcodes (0F xx) that are not followed by a ModR/M byte. */
const NO_MODRM_0F = new Set([
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x37, 0x77, 0xa0, 0xa1, 0xa2, 0xa8, 0xa9, 0xaa,
  ...Array.from({ length: 16 }, (_, i) => 0x80 + i), ...Array.from({ length: 8 }, (_, i) => 0xc8 + i),
]);

/** Opcodes of the 0F map that take an 8-bit immediate, with or without a VEX or EVEX prefix. */
const IMM8_0F = new Set([0x70, 0x71, 0x72, 0x73, 0xc2, 0xc4, 0xc5, 0xc6]);

/** True when a one-byte opcode outside the subset is followed by a ModR/M byte. */
function oneByteModrm(op: number): boolean {
  if (op < 0x40) return (op & 7) < 4;
  return op === 0x63 || op === 0x69 || op === 0x6b || (op >= 0x80 && op <= 0x8f) || op === 0xc0 || op === 0xc1 || op === 0xc6 || op === 0xc7
    || (op >= 0xd0 && op <= 0xd3) || (op >= 0xd8 && op <= 0xdf) || op === 0xf6 || op === 0xf7 || op === 0xfe || op === 0xff;
}

/**
 * Bytes of immediate data, relative offset, or memory offset that follow a one-byte opcode and its ModR/M
 * byte. `ext` is the reg field of ModR/M; `z` is the size of an immediate of the operand size (2 bytes with
 * the 66 prefix and without REX.W, otherwise 4); `w` is REX.W; `a32` is true when the 67 prefix selects
 * 32-bit addresses.
 */
function oneByteImmediate(op: number, ext: number, z: number, w: boolean, a32: boolean): number {
  if (op < 0x40) return (op & 7) === 4 ? 1 : (op & 7) === 5 ? z : 0;
  if ((op >= 0x70 && op <= 0x7f) || (op >= 0xb0 && op <= 0xb7) || (op >= 0xe0 && op <= 0xe7)) return 1;
  if (op >= 0xb8 && op <= 0xbf) return w ? 8 : z;
  // MOV with a memory offset: the offset has the address size, 64 bits unless the 67 prefix selects 32 bits.
  if (op >= 0xa0 && op <= 0xa3) return a32 ? 4 : 8;
  switch (op) {
    case 0x6a: case 0x6b: case 0x80: case 0x83: case 0xa8: case 0xc0: case 0xc1: case 0xc6: case 0xcd: case 0xeb:
      return 1;
    case 0x68: case 0x69: case 0x81: case 0xa9: case 0xc7:
      return z;
    case 0xc2: case 0xca:
      return 2;
    case 0xc8:
      return 3;
    // The relative offset of a near CALL or JMP is 32 bits in 64-bit mode, whatever the operand-size prefix.
    case 0xe8: case 0xe9:
      return 4;
    case 0xf6:
      return ext < 2 ? 1 : 0;
    case 0xf7:
      return ext < 2 ? z : 0;
    default:
      return 0;
  }
}

/**
 * Why the ModR/M byte `m` makes a one-byte opcode undefined, or null when the combination is defined. The
 * groups define only these members: 8F /0 (POP); C6 /0 (MOV) and the ModR/M byte F8 (XABORT); C7 /0 (MOV)
 * and the ModR/M byte F8 (XBEGIN); FE /0 and /1 (INC and DEC); FF /0 to /6, where /3 and /5 (far CALL and
 * far JMP) take a memory operand only. LEA (8D) takes a memory operand only. The reg field of MOV to and from
 * a segment register (8C, 8E) selects ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, or GS = 5 (Vol. 2A, Section 3.1.1.3).
 */
function undefinedForm(op: number, m: number): string | null {
  const ext = (m >> 3) & 7;
  const reg = m >> 6 === 3;
  switch (op) {
    case 0x8c:
    case 0x8e:
      return ext > 5 ? `opcode ${h2(op)} /${ext} is an undefined opcode; the reg field selects a segment register, 0 (ES) to 5 (GS)` : null;
    case 0x8d:
      return reg ? 'LEA with a register as its source operand (ModR/M mod = 11) is an undefined opcode' : null;
    case 0x8f:
      return ext !== 0 ? `opcode 8F /${ext} is an undefined opcode; 8F defines only /0 (POP)` : null;
    case 0xc6:
    case 0xc7:
      return ext !== 0 && m !== 0xf8
        ? `opcode ${h2(op)} /${ext} is an undefined opcode; ${h2(op)} defines only /0 (MOV) and the ModR/M byte F8 (${op === 0xc6 ? 'XABORT' : 'XBEGIN'})`
        : null;
    case 0xfe:
      return ext > 1 ? `opcode FE /${ext} is an undefined opcode; FE defines only /0 (INC) and /1 (DEC)` : null;
    case 0xff:
      if (ext === 7) return 'opcode FF /7 is an undefined opcode';
      return (ext === 3 || ext === 5) && reg
        ? `opcode FF /${ext} (far ${ext === 3 ? 'CALL' : 'JMP'}) with a register operand (ModR/M mod = 11) is an undefined opcode`
        : null;
    default:
      return null;
  }
}

/**
 * Length of an instruction outside the subset, from its format (Intel SDM Vol. 2A, Section 2.1 and
 * Figure 2-1): legacy prefixes and a REX prefix; one, two, or three opcode bytes, or a VEX or EVEX prefix and
 * one opcode byte; ModR/M, SIB, and displacement when the opcode takes a ModR/M byte; and the immediate. When
 * the bytes end inside the instruction, the length of the bytes present is returned. The result is a
 * failure of kind 'invalid' instead, with the length of the bytes examined, when 64-bit mode leaves the
 * encoding undefined or when the instruction would be longer than 15 bytes (Vol. 2A, Sections 2.2.1 and 2.3.11).
 */
function lengthOutside(bytes: Uint8Array, offset: number): number | RawError {
  const end = Math.min(bytes.length, offset + 15);
  let p = offset;
  const take = (n: number): number => {
    if (p + n > end) throw new DecodeStop('truncated', 'the instruction would be longer than 15 bytes');
    p += n;
    return bytes[p - n]!;
  };
  const invalid = (message: string): never => {
    throw new DecodeStop('invalid', message);
  };
  try {
    // A REX prefix takes effect only directly before the opcode; elsewhere it is ignored (Section 2.2.1).
    let o16 = false;
    let a32 = false;
    let rex = 0;
    // The F2 or F3 prefix nearest the opcode, or 0.
    let rep = 0;
    // A LOCK, 66, F2, F3, or REX prefix before a VEX or EVEX prefix makes the instruction undefined (Sections 2.3.2 to 2.3.4).
    let beforeVex = '';
    let b = take(1);
    for (;;) {
      if (LEGACY_PREFIX[b] !== undefined) {
        if (b === 0x66) o16 = true;
        if (b === 0x67) a32 = true;
        if (b === 0xf2 || b === 0xf3) rep = b;
        if (!beforeVex && (b === 0x66 || b === 0xf0 || b === 0xf2 || b === 0xf3)) beforeVex = h2(b);
        rex = 0;
      } else if ((b & 0xf0) === 0x40) {
        rex = b;
        if (!beforeVex) beforeVex = `REX ${h2(b)}`;
      } else break;
      b = take(1);
    }
    const w = (rex & 8) !== 0;
    const z = o16 && !w ? 2 : 4;
    // Mandatory-prefix class of the legacy opcode maps: 0 none, 1 66, 2 F3, 3 F2.
    const cls = rep === 0xf3 ? 2 : rep === 0xf2 ? 3 : o16 ? 1 : 0;
    let modrm = true;
    // MOV to and from control and debug registers (0F 20 to 0F 23) ignore the mod field: no SIB or displacement follows.
    let addressing = true;
    let imm = 0;
    let one = -1;
    // Name and table character of a 0F, 0F 38, or 0F 3A opcode, whose ModR/M byte is checked against the table.
    let legacy = '';
    let legacyCell = '';
    // A VEX map 7 instruction, whose ModR/M byte must be 11:000:bbb.
    let map7 = false;
    if (b === 0xc4 || b === 0xc5 || b === 0x62) {
      const name = b === 0x62 ? 'EVEX' : 'VEX';
      if (beforeVex) invalid(`a ${name} prefix after the ${beforeVex} prefix is undefined; LOCK, 66, F2, F3, and REX prefixes must not precede it`);
      let map = 1;
      let fields = 0;
      if (b === 0xc5) take(1);
      else if (b === 0xc4) {
        map = take(1) & 0x1f;
        // Vol. 2B defines RDMSR, URDMSR, and UWRMSR with an immediate in VEX map 7, and Vol. 2D defines WRMSRNS
        // there, although Vol. 2A, Table 2-10, lists maps 4 to 31 as reserved.
        if (map < 1 || (map > 3 && map !== 7)) invalid(`VEX opcode map ${map} is reserved`);
        fields = take(1);
      } else {
        const p0 = take(1);
        map = p0 & 7;
        if (map === 0 || map === 4 || map === 7) invalid(`EVEX opcode map ${map} is reserved`);
        // Opcode-independent conditions of Vol. 2A, Table 2-40: P[3] must be 0 and P[10] must be 1.
        if (p0 & 8) invalid('EVEX bit P[3] is reserved and must be 0');
        if (!(take(1) & 4)) invalid('EVEX bit P[10] must be 1');
        take(1);
      }
      const op = take(1);
      if (map === 7) {
        // VEX.128.F2.MAP7:W0.F6 11:000:bbb id (RDMSR) and the F3 form (WRMSRNS); opcode F8 with F2 (URDMSR) and F3 (UWRMSR).
        if (op !== 0xf6 && op !== 0xf8) invalid(`VEX map 7 opcode ${h2(op)} is an undefined opcode; the map defines only F6 and F8`);
        if ((fields & 0xfc) !== 0x78 || (fields & 3) < 2) {
          invalid(`VEX map 7 opcode ${h2(op)} is defined only with VEX.L = 0, VEX.W = 0, VEX.vvvv = 1111b, and the F2 or F3 implied prefix`);
        }
        map7 = true;
        imm = 4;
      } else {
        modrm = b === 0x62 || map !== 1 || op !== 0x77;
        imm = map === 3 || (map === 1 && IMM8_0F.has(op)) ? 1 : 0;
      }
    } else if (b === 0x0f) {
      const op = take(1);
      let cell: string;
      if (op === 0x38 || op === 0x3a) {
        const op3 = take(1);
        imm = op === 0x3a ? 1 : 0;
        legacy = `0F ${h2(op)} ${h2(op3)}`;
        cell = (op === 0x38 ? MAP_0F38 : MAP_0F3A)[op3]!;
        if (cell === '----') invalid(`three-byte opcode ${legacy} is an undefined opcode`);
      } else {
        legacy = `0F ${h2(op)}`;
        cell = MAP_0F[op]!;
        if (cell === '----') invalid(`two-byte opcode ${legacy} is an undefined opcode`);
        modrm = !NO_MODRM_0F.has(op);
        addressing = op < 0x20 || op > 0x23;
        imm = op >= 0x80 && op <= 0x8f ? 4 : IMM8_0F.has(op) || op === 0xa4 || op === 0xac || op === 0xba ? 1 : 0;
      }
      legacyCell = cell[cls]!;
      if (legacyCell === '-') invalid(`opcode ${MANDATORY_PREFIX[cls]}${legacy} is an undefined opcode; ${legacy} requires ${prefixesOf(cell)}`);
    } else {
      if (INVALID_64[b] !== undefined) invalid(`opcode ${h2(b)} (${INVALID_64[b]}) is not valid in 64-bit mode`);
      one = b;
      modrm = oneByteModrm(b);
    }
    let m = 0;
    if (modrm) {
      m = take(1);
      const why = one >= 0 ? undefinedForm(one, m)
        : legacy ? undefinedLegacyForm(legacy, cls, legacyCell, m)
        : map7 && (m & 0xf8) !== 0xc0 ? 'VEX map 7 instructions require ModR/M mod = 11 and reg = 000' : null;
      if (why) invalid(why);
      const mod = m >> 6;
      if (addressing && mod !== 3) {
        if ((m & 7) === 4) {
          const sib = take(1);
          if (mod === 0 && (sib & 7) === 5) take(4);
        } else if (mod === 0 && (m & 7) === 5) take(4);
        if (mod === 1) take(1);
        else if (mod === 2) take(4);
      }
    }
    if (one >= 0) imm = oneByteImmediate(one, (m >> 3) & 7, z, w, a32);
    if (imm > 0) take(imm);
    return p - offset;
  } catch (e) {
    if (!(e instanceof DecodeStop)) throw e;
    if (e.kind === 'invalid') return { kind: 'invalid', message: e.message, length: p - offset };
    // The bytes end inside the instruction: the bytes present belong to it.
    if (bytes.length < offset + 15) return end - offset;
    // Fifteen bytes are present and the instruction needs more: it is not a valid encoding.
    return { kind: 'invalid', message: e.message, length: end - offset };
  }
}

/**
 * Recognize the instruction that starts at `offset`. At most 15 bytes are
 * examined. The result is either the decoded instruction or the reason why
 * the bytes are not an instruction of the subset.
 */
export function decodeRaw(bytes: Uint8Array, offset: number): Raw | RawError {
  let p = offset;
  const end = Math.min(bytes.length, offset + 15);
  // The instructions of the subset are at most 13 bytes long, so only the end of the bytes stops one of them.
  const need = (n: number): void => {
    if (p + n > end) throw new DecodeStop('truncated', `the instruction needs more than the ${Math.max(bytes.length - offset, 0)} byte(s) available`);
  };
  const u8 = (): number => {
    need(1);
    return bytes[p++]!;
  };
  const s8 = (): number => {
    const v = u8();
    return (v << 24) >> 24;
  };
  const s32 = (): number => {
    need(4);
    const v = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16) | (bytes[p + 3]! << 24);
    p += 4;
    return v;
  };
  const unsupported = (what: string): never => {
    throw new DecodeStop('unsupported', what);
  };
  const layout: Layout = { rex: -1, opcode: 0, opcodeLength: 1, modrm: -1, sib: -1, disp: -1, dispLength: 0, imm: -1, immLength: 0 };

  try {
    let b = u8();
    if (LEGACY_PREFIX[b] !== undefined) unsupported(`${h2(b)} is the ${LEGACY_PREFIX[b]}; prefixed instructions are outside the subset`);
    let rex = 0;
    if ((b & 0xf0) === 0x40) {
      rex = b;
      layout.rex = 0;
      b = u8();
      if ((b & 0xf0) === 0x40 || LEGACY_PREFIX[b] !== undefined) {
        unsupported(`REX prefix ${h2(rex)} is followed by another prefix (${h2(b)}); a REX prefix takes effect only directly before the opcode, and such sequences are outside the subset`);
      }
    }
    const W = (rex & 8) !== 0;
    const R = (rex & 4) << 1;
    const X = (rex & 2) << 2;
    const B = (rex & 1) << 3;
    layout.opcode = p - 1 - offset;
    const size: 32 | 64 = W ? 64 : 32;

    let reg = 0;
    let rm: RM | null = null;
    let ext = 0;
    /** Read ModR/M, and SIB and displacement when present. */
    const modrm = (): void => {
      layout.modrm = p - offset;
      const m = u8();
      const mod = m >> 6;
      ext = (m >> 3) & 7;
      reg = ext | R;
      const low = m & 7;
      if (mod === 3) {
        rm = { kind: 'reg', reg: low | B };
        return;
      }
      let base = low | B;
      let index = -1;
      let scale = 1;
      let dispSize = mod === 1 ? 1 : mod === 2 ? 4 : 0;
      if (low === 4) {
        layout.sib = p - offset;
        const s = u8();
        scale = 1 << (s >> 6);
        const idx = ((s >> 3) & 7) | X;
        // Index encoding 100 without REX.X means that there is no index register; the scale bits are then ignored.
        index = idx === 4 ? -1 : idx;
        if (index < 0) scale = 1;
        base = (s & 7) | B;
        if ((s & 7) === 5 && mod === 0) {
          base = -1;
          dispSize = 4;
        }
      } else if (low === 5 && mod === 0) {
        unsupported('ModR/M with mod = 00 and r/m = 101 selects RIP-relative addressing, which is outside the subset');
      }
      let disp = 0;
      if (dispSize > 0) {
        layout.disp = p - offset;
        layout.dispLength = dispSize;
        disp = dispSize === 1 ? s8() : s32();
      }
      rm = { kind: 'mem', base, index, scale, disp };
    };
    const imm8 = (): number => {
      layout.imm = p - offset;
      layout.immLength = 1;
      return s8();
    };
    const imm32 = (): number => {
      layout.imm = p - offset;
      layout.immLength = 4;
      return s32();
    };
    /** Shift count byte of opcode C1, read as an unsigned value. */
    const u8Imm = (): number => {
      layout.imm = p - offset;
      layout.immLength = 1;
      return u8();
    };
    const done = (op: string, form: Form, o: { cc?: number; imm?: number; size?: 32 | 64; rmHigh?: boolean } = {}): Raw => ({
      op, form, cc: o.cc ?? -1, size: o.size ?? size, reg, rm, rmHigh: o.rmHigh ?? false, imm: o.imm ?? 0, rex, length: p - offset, layout,
    });
    /** True when a byte-register r/m operand names ah, ch, dh, or bh: encodings 4 to 7 without a REX prefix. */
    const highByte = (): boolean => rm !== null && rm.kind === 'reg' && rex === 0 && rm.reg >= 4 && rm.reg <= 7;
    const isReg = (): boolean => rm !== null && rm.kind === 'reg';
    /**
     * The ModR/M byte that follows the one-byte opcode `b`, without reading it; stops after the byte when it makes
     * the opcode undefined, before any SIB byte or displacement.
     */
    const checkForm = (): number => {
      need(1);
      const m = bytes[p]!;
      const why = undefinedForm(b, m);
      if (why) {
        p++;
        throw new DecodeStop('invalid', why);
      }
      return m;
    };

    if (INVALID_64[b] !== undefined) throw new DecodeStop('invalid', `opcode ${h2(b)} (${INVALID_64[b]}) is not valid in 64-bit mode`);

    // Arithmetic and logic block 00 to 3F.
    if (b < 0x40 && (b & 7) < 6) {
      const name = ALU_BY_EXT[b >> 3]!;
      const k = b & 7;
      if (name === 'adc' || name === 'sbb' || k === 0 || k === 2 || k === 4) unsupported(`opcode ${h2(b)} is ${nameOneByte(b)}, outside the subset`);
      if (k === 5) {
        reg = 0;
        return done(name, 'acc_imm', { imm: imm32() });
      }
      modrm();
      return done(name, k === 1 ? 'rm_r' : 'r_rm');
    }
    if (b >= 0x50 && b <= 0x5f) {
      reg = (b & 7) | B;
      return done(b < 0x58 ? 'push' : 'pop', 'r', { size: 64 });
    }
    if (b >= 0x70 && b <= 0x7f) return done('jcc', 'rel', { cc: b & 15, imm: imm8() });
    if (b >= 0xb8 && b <= 0xbf) {
      if (W) unsupported(`REX.W with opcode ${h2(b)} is MOV r64, imm64 (a 64-bit immediate), outside the subset`);
      reg = (b & 7) | B;
      return done('mov', 'r_imm', { imm: imm32() });
    }

    switch (b) {
      case 0x0f: {
        layout.opcodeLength = 2;
        const b2 = u8();
        if (b2 === 0x05) return done('syscall', 'none');
        if (b2 >= 0x80 && b2 <= 0x8f) return done('jcc', 'rel', { cc: b2 & 15, imm: imm32() });
        if (b2 >= 0x90 && b2 <= 0x9f) {
          modrm();
          return done('setcc', 'rm', { cc: b2 & 15, rmHigh: highByte() });
        }
        if (b2 === 0xaf) {
          modrm();
          return done('imul', 'r_rm');
        }
        if (b2 === 0xb6) {
          if (W) unsupported('REX.W with opcode 0F B6 is MOVZX r64, r/m8; the subset has MOVZX r32, r/m8 only');
          modrm();
          return done('movzx', 'r_rm', { rmHigh: highByte() });
        }
        // lengthOutside reports the opcodes and forms that the opcode maps leave undefined as invalid.
        if (b2 === 0x38 || b2 === 0x3a) unsupported(`opcode bytes 0F ${h2(b2)} begin a three-byte opcode, outside the subset`);
        const name = nameTwoByte(b2);
        return unsupported(name ? `opcode 0F ${h2(b2)} is ${name}, outside the subset` : `two-byte opcode 0F ${h2(b2)} is outside the subset`);
      }
      case 0x63:
        if (!W) unsupported('opcode 63 without REX.W is MOVSXD with a 32-bit destination; the subset has MOVSXD r64, r/m32 only');
        modrm();
        return done('movsxd', 'r_rm');
      case 0x69:
        modrm();
        return done('imul', 'r_rm_imm', { imm: imm32() });
      case 0x6b:
        modrm();
        return done('imul', 'r_rm_imm', { imm: imm8() });
      case 0x81:
      case 0x83: {
        modrm();
        const name = ALU_BY_EXT[ext]!;
        if (name === 'adc' || name === 'sbb') unsupported(`opcode ${h2(b)} /${ext} is ${name.toUpperCase()} (add or subtract with carry), outside the subset`);
        return done(name, 'rm_imm', { imm: b === 0x81 ? imm32() : imm8() });
      }
      case 0x85:
        modrm();
        return done('test', 'rm_r');
      case 0x89:
        modrm();
        return done('mov', 'rm_r');
      case 0x8b:
        modrm();
        return done('mov', 'r_rm');
      case 0x8d:
        checkForm();
        modrm();
        return done('lea', 'r_rm');
      case 0x8f:
        checkForm();
        modrm();
        if (!isReg()) unsupported('POP with a memory operand is outside the subset');
        return done('pop', 'rm', { size: 64 });
      case 0x90:
        if (B) unsupported('opcode 90 with REX.B is XCHG r8, rax, outside the subset');
        return done('nop', 'none');
      case 0xc1:
      case 0xd1:
      case 0xd3: {
        modrm();
        const name = SHIFT_BY_EXT[ext]!;
        if (name !== 'shl' && name !== 'shr' && name !== 'sar') {
          unsupported(ext === 6 ? `opcode ${h2(b)} /6 is an undocumented alias of SHL, outside the subset` : `opcode ${h2(b)} /${ext} is ${name.toUpperCase()} (rotate), outside the subset`);
        }
        if (b === 0xd3) return done(name, 'rm_cl');
        return done(name, 'rm_imm', { imm: b === 0xc1 ? u8Imm() : 1 });
      }
      case 0xc3:
        return done('ret', 'none');
      // C6 and FE are outside the subset in every form; the message names the instruction, RIP-relative forms included.
      case 0xc6:
        return unsupported(((checkForm() >> 3) & 7) === 0 ? 'opcode C6 /0 is MOV r/m8, imm8 (8-bit operand), outside the subset' : 'opcode C6 F8 is XABORT, outside the subset');
      case 0xc7:
        checkForm();
        modrm();
        if (ext !== 0) unsupported('opcode C7 F8 is XBEGIN, outside the subset');
        return done('mov', 'rm_imm', { imm: imm32() });
      case 0xe8:
        return done('call', 'rel', { imm: imm32() });
      case 0xe9:
        return done('jmp', 'rel', { imm: imm32() });
      case 0xeb:
        return done('jmp', 'rel', { imm: imm8() });
      case 0xf7:
        modrm();
        if (ext === 2) return done('not', 'rm');
        if (ext === 3) return done('neg', 'rm');
        return unsupported(`opcode F7 /${ext} is ${['TEST with an immediate', 'TEST with an immediate (alias)', '', '', 'MUL', 'one-operand IMUL', 'DIV', 'IDIV'][ext]}, outside the subset`);
      case 0xfe: {
        const x = (checkForm() >> 3) & 7;
        return unsupported(`opcode FE /${x} is ${x === 0 ? 'INC' : 'DEC'} with an 8-bit operand, outside the subset`);
      }
      case 0xff:
        checkForm();
        modrm();
        if (ext === 0) return done('inc', 'rm');
        if (ext === 1) return done('dec', 'rm');
        if (ext === 6) {
          if (!isReg()) unsupported('PUSH with a memory operand is outside the subset');
          return done('push', 'rm', { size: 64 });
        }
        return unsupported(`opcode FF /${ext} is ${['', '', 'an indirect CALL', 'a far CALL', 'an indirect JMP', 'a far JMP'][ext]}, outside the subset`);
      default: {
        const name = nameOneByte(b);
        return unsupported(name ? `opcode ${h2(b)} is ${name}, outside the subset` : `opcode ${h2(b)} is outside the subset`);
      }
    }
  } catch (e) {
    if (!(e instanceof DecodeStop)) throw e;
    if (e.kind === 'unsupported') {
      // The length of an instruction outside the subset follows from its format, unless 64-bit mode leaves the encoding undefined.
      const length = lengthOutside(bytes, offset);
      return typeof length === 'number' ? { kind: 'unsupported', message: e.message, length } : length;
    }
    return { kind: e.kind, message: e.message, length: e.kind === 'truncated' ? Math.max(end - offset, 0) : p - offset };
  }
}

/** Assembly operand for the r/m operand of a decoded instruction at the given operand size; 0 omits the size keyword. */
function rmOperand(raw: Raw, size: 0 | 8 | 32 | 64): AsmOperand {
  const rm = raw.rm!;
  if (rm.kind === 'reg') {
    if (size === 8) return { t: 'reg', name: raw.rmHigh ? REG8_HIGH[rm.reg - 4]! : REG8[rm.reg]! };
    return { t: 'reg', name: size === 64 ? REG64[rm.reg]! : REG32[rm.reg]! };
  }
  const o: AsmOperand = { t: 'mem', base: rm.base < 0 ? null : REG64[rm.base]!, disp: rm.disp };
  if (rm.index >= 0) {
    o.index = REG64[rm.index]!;
    o.scale = rm.scale;
  }
  if (size !== 0) o.size = size;
  return o;
}

/** Assembly-level instruction for a decoded instruction located at address `pc`. */
export function toInsn(raw: Raw, pc: number): Insn {
  const size = raw.size;
  const r = (n: number, s: 32 | 64 = size): AsmOperand => ({ t: 'reg', name: s === 64 ? REG64[n]! : REG32[n]! });
  const imm = (): AsmOperand => ({ t: 'imm', value: raw.imm });
  switch (raw.op) {
    case 'jcc':
      // The target is pc + length + offset in the 64-bit address space; below zero it stays negative.
      return { mnemonic: `j${CC_NAMES[raw.cc]}`, operands: [{ t: 'addr', value: pc + raw.length + raw.imm }] };
    case 'jmp':
    case 'call':
      return { mnemonic: raw.op, operands: [{ t: 'addr', value: pc + raw.length + raw.imm }] };
    case 'setcc':
      return { mnemonic: `set${CC_NAMES[raw.cc]}`, operands: [rmOperand(raw, 8)] };
    case 'movzx':
      return { mnemonic: 'movzx', operands: [r(raw.reg, 32), rmOperand(raw, 8)] };
    case 'movsxd':
      return { mnemonic: 'movsxd', operands: [r(raw.reg, 64), rmOperand(raw, 32)] };
    case 'lea':
      return { mnemonic: 'lea', operands: [r(raw.reg), rmOperand(raw, 0)] };
  }
  switch (raw.form) {
    case 'rm_r':
      return { mnemonic: raw.op, operands: [rmOperand(raw, size), r(raw.reg)] };
    case 'r_rm':
      return { mnemonic: raw.op, operands: [r(raw.reg), rmOperand(raw, size)] };
    case 'rm_imm':
      return { mnemonic: raw.op, operands: [rmOperand(raw, size), imm()] };
    case 'acc_imm':
    case 'r_imm':
      return { mnemonic: raw.op, operands: [r(raw.reg), imm()] };
    case 'r_rm_imm':
      return { mnemonic: raw.op, operands: [r(raw.reg), rmOperand(raw, size), imm()] };
    case 'rm_cl':
      return { mnemonic: raw.op, operands: [rmOperand(raw, size), { t: 'reg', name: 'cl' }] };
    case 'rm':
      return { mnemonic: raw.op, operands: [rmOperand(raw, size)] };
    case 'r':
      return { mnemonic: raw.op, operands: [r(raw.reg)] };
    default:
      return { mnemonic: raw.op, operands: [] };
  }
}

const bit = (byte: number, name: string, hi: number, lo: number, text: string): BitField => ({
  name, hi, lo, value: (byte >> lo) & ((1 << (hi - lo + 1)) - 1), text,
});

/** Byte-level components of a decoded instruction: REX, opcode, ModR/M, SIB, displacement, and immediate. */
function byteFields(bytes: Uint8Array, offset: number, raw: Raw, insn: Insn, pc: number): ByteField[] {
  const out: ByteField[] = [];
  const L = raw.layout;
  const at = (i: number): number => bytes[offset + i]!;
  const hasModrm = L.modrm >= 0;
  const hasSib = L.sib >= 0;
  const regIsExt = raw.form === 'rm_imm' || raw.form === 'rm' || raw.form === 'rm_cl';
  // With mod = 00, SIB base field 101 selects a 32-bit displacement and no base register; decodeRaw then sets base to -1.
  const noBase = raw.rm !== null && raw.rm.kind === 'mem' && raw.rm.base < 0;
  if (L.rex >= 0) {
    const b = at(L.rex);
    // Operand sizes that REX.W does not change (Intel SDM Vol. 2A, Sections 2.2.1.2 and 2.2.1.7; Vol. 2B, SETcc).
    const fixedSize = raw.op === 'setcc' ? 'SETcc always writes one byte'
      : raw.op === 'push' || raw.op === 'pop' ? 'PUSH and POP use 64-bit operands without REX.W'
      : raw.op === 'jmp' || raw.op === 'jcc' || raw.op === 'call' || raw.op === 'ret' ? 'near branches use 64-bit operands without REX.W'
      : raw.op === 'nop' || raw.op === 'syscall' ? 'the instruction has no operand size to select' : '';
    const regUse = !hasModrm ? 'unused by this instruction'
      : raw.op === 'setcc' ? 'ignored: SETcc does not use the ModR/M reg field'
      : regIsExt ? 'ignored: the ModR/M reg field holds an opcode extension'
      : 'extends the ModR/M reg field';
    const baseUse = noBase ? 'not decoded: with mod = 00, SIB base field 101 selects no base register'
      : hasSib ? 'extends the SIB base field' : hasModrm ? 'extends the ModR/M r/m field' : raw.form === 'r' || raw.form === 'r_imm' ? 'extends the register in the opcode' : 'unused by this instruction';
    out.push({
      name: 'REX', offset: L.rex, length: 1,
      text: `REX prefix ${h2(b)}: ${fixedSize ? `REX.W has no effect (${fixedSize})` : `64-bit operand size ${b & 8 ? 'selected' : 'not selected'}`}; gives access to r8 to r15 and to spl, bpl, sil, dil`,
      bits: [
        bit(b, '0100', 7, 4, 'fixed pattern of a REX prefix'),
        bit(b, 'W', 3, 3, fixedSize ? `no effect: ${fixedSize}` : b & 8 ? '64-bit operand size' : 'default operand size'),
        bit(b, 'R', 2, 2, regUse),
        bit(b, 'X', 1, 1, hasSib ? 'extends the SIB index field' : 'unused by this instruction'),
        bit(b, 'B', 0, 0, baseUse),
      ],
    });
  }
  const opBytes = Array.from({ length: L.opcodeLength }, (_, i) => h2(at(L.opcode + i))).join(' ');
  let opText = `opcode ${opBytes}: ${insn.mnemonic}`;
  // CMP and TEST only set the flags; neither operand is written.
  const writesOperand = raw.op !== 'cmp' && raw.op !== 'test';
  if (raw.form === 'r' || raw.form === 'r_imm') opText += `; the low three bits select the register ${(insn.operands[0] as { name: string }).name}`;
  if (raw.op === 'jcc' || raw.op === 'setcc') opText += `; the low four bits select the condition ${CC_NAMES[raw.cc]} (${CC_MEANING[raw.cc]})`;
  if (raw.form === 'rm_r') opText += writesOperand ? '; the r/m operand is the destination' : '; no operand is written, only the flags';
  if (raw.form === 'r_rm' && raw.op !== 'lea') opText += writesOperand ? '; the reg operand is the destination' : '; no operand is written, only the flags';
  if (L.opcodeLength === 2) opText += '; 0F is the escape byte of the two-byte opcode map';
  out.push({ name: 'opcode', offset: L.opcode, length: L.opcodeLength, text: opText });
  if (hasModrm) {
    const b = at(L.modrm);
    const mod = b >> 6;
    const regSize: 32 | 64 = raw.op === 'movzx' ? 32 : raw.op === 'movsxd' ? 64 : raw.size;
    const regText = raw.op === 'setcc' ? 'not used by SETcc' : regIsExt ? `opcode extension /${(b >> 3) & 7}: selects ${raw.op}` : `register ${regSize === 64 ? REG64[raw.reg] : REG32[raw.reg]}`;
    const modText = noBase
      ? 'memory operand without a base register; the SIB base field 101 selects a 32-bit displacement'
      : ['memory operand without displacement', 'memory operand with an 8-bit displacement', 'memory operand with a 32-bit displacement', 'register operand'][mod]!;
    let rmText: string;
    if (raw.rm!.kind === 'reg') {
      const o = insn.operands.find((x, i) => x.t === 'reg' && (raw.form === 'r_rm' || raw.form === 'r_rm_imm' ? i === 1 : i === 0)) as { name: string } | undefined;
      rmText = `register ${o ? o.name : ''}`;
    } else if (hasSib) rmText = 'a SIB byte follows';
    else rmText = `base register ${REG64[raw.rm!.base]}`;
    out.push({
      name: 'ModR/M', offset: L.modrm, length: 1, text: `ModR/M ${h2(b)}: ${modText}`,
      bits: [bit(b, 'mod', 7, 6, modText), bit(b, 'reg', 5, 3, regText), bit(b, 'r/m', 2, 0, rmText)],
    });
  }
  if (hasSib && raw.rm!.kind === 'mem') {
    const b = at(L.sib);
    const m = raw.rm!;
    const indexText = m.index < 0 ? 'no index register' : `index register ${REG64[m.index]}`;
    const baseText = m.base < 0 ? 'no base register; a 32-bit displacement follows' : `base register ${REG64[m.base]}`;
    out.push({
      name: 'SIB', offset: L.sib, length: 1, text: `SIB ${h2(b)}: ${baseText}, ${indexText}${m.index < 0 ? '' : ` times ${m.scale}`}`,
      bits: [bit(b, 'scale', 7, 6, m.index < 0 ? 'ignored without an index register' : `index is multiplied by ${m.scale}`), bit(b, 'index', 5, 3, indexText), bit(b, 'base', 2, 0, baseText)],
    });
  }
  if (L.disp >= 0 && raw.rm!.kind === 'mem') {
    const d = raw.rm!.disp;
    out.push({ name: 'displacement', offset: L.disp, length: L.dispLength, text: `${L.dispLength * 8}-bit displacement ${d}${L.dispLength === 1 ? ', sign-extended' : ''}, least significant byte first` });
  }
  if (L.imm >= 0) {
    const bitsText = `${L.immLength * 8}-bit`;
    const text = raw.form === 'rel'
      ? `${bitsText} offset ${raw.imm}, relative to the next instruction at ${hexAddress(pc + raw.length)}; target ${hexAddress(pc + raw.length + raw.imm)}`
      : `${bitsText} immediate ${raw.imm}${L.immLength === 1 && raw.form !== 'rm_imm' ? ', sign-extended' : L.immLength === 1 && SHIFT_BY_EXT.includes(raw.op as 'shl') ? ' (shift count)' : L.immLength === 1 ? ', sign-extended to the operand size' : raw.size === 64 ? ', sign-extended to 64 bits' : ''}${L.immLength > 1 ? ', least significant byte first' : ''}`;
    out.push({ name: raw.form === 'rel' ? 'offset' : 'immediate', offset: L.imm, length: L.immLength, text });
  }
  return out;
}

export function decode(bytes: Uint8Array, offset: number, pc: number): DecodeResult {
  const raw = decodeRaw(bytes, offset);
  if ('kind' in raw) {
    const shown = Array.from(bytes.subarray(offset, offset + Math.max(raw.length, 1)), h2).join(' ');
    return { ok: false, kind: raw.kind, message: `${shown}: ${raw.message}`, length: raw.length };
  }
  const insn = toInsn(raw, pc);
  return { ok: true, insn, length: raw.length, fields: [], byteFields: byteFields(bytes, offset, raw, insn, pc) };
}
