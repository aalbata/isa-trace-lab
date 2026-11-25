/**
 * MIPS32 Release 2 profile: register names, encoding table, and conventions.
 * The table lists the instructions of MIPS32 Release 2 that the encoder,
 * decoder, and processor model implement. The profile is a subset of the
 * architecture; the instruction families left out are named in `excluded`.
 */
import type { TargetProfile } from '../types.ts';

/** Software register names indexed by register number 0 to 31. */
export const REG_NAMES = [
  '$zero', '$at', '$v0', '$v1', '$a0', '$a1', '$a2', '$a3', '$t0', '$t1', '$t2', '$t3', '$t4', '$t5', '$t6', '$t7',
  '$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7', '$t8', '$t9', '$k0', '$k1', '$gp', '$sp', '$fp', '$ra',
] as const;

const REG_INDEX = new Map<string, number>();
REG_NAMES.forEach((n, i) => {
  REG_INDEX.set(n, i);
  REG_INDEX.set(`$${i}`, i);
});
REG_INDEX.set('$s8', 30);

/** Register number for a software name, a numeric name ($0 to $31), or `$s8`; -1 when the name is unknown. */
export function regIndex(name: string): number {
  return REG_INDEX.get(name.toLowerCase()) ?? -1;
}

/**
 * Assembly operand layouts. The architecture defines three encoding formats
 * (R, I, J); the names below also select the operand syntax of instructions
 * that share a format:
 *  R3    rd, rs, rt                 register arithmetic, logic, and comparison;
 *  SHI   rd, rt, sa                 shift by a 5-bit amount;
 *  SHV   rd, rt, rs                 shift by the low five bits of rs;
 *  JR    rs                         jump to register;
 *  JALR  rd, rs                     jump to register and link;
 *  SYS   optional 20-bit code       system call;
 *  I     rt, rs, signed imm16       arithmetic and comparison with a sign-extended immediate;
 *  IU    rt, rs, unsigned imm16     logic with a zero-extended immediate;
 *  LUI   rt, unsigned imm16         load upper immediate;
 *  M     rt, offset(base)           loads and stores;
 *  B2    rs, rt, target             branch comparing two registers;
 *  B1    rs, target                 branch comparing one register with zero;
 *  J     target                     jump within the current 256 MB region.
 */
export type Format = 'R3' | 'SHI' | 'SHV' | 'JR' | 'JALR' | 'SYS' | 'I' | 'IU' | 'LUI' | 'M' | 'B2' | 'B1' | 'J';

export interface Encoding {
  mnemonic: string;
  format: Format;
  /** Bits 31 to 26. */
  opcode: number;
  /** Function field (bits 5 to 0) of SPECIAL and SPECIAL2 instructions. */
  funct: number;
  /** Value of the rt field that selects the instruction within REGIMM. */
  regimm: number;
}

export const OP_SPECIAL = 0b000000;
export const OP_REGIMM = 0b000001;
export const OP_SPECIAL2 = 0b011100;

const E = (mnemonic: string, format: Format, opcode: number, funct = 0, regimm = 0): Encoding => ({
  mnemonic, format, opcode, funct, regimm,
});

export const ENCODINGS: Encoding[] = [
  E('sll', 'SHI', OP_SPECIAL, 0b000000),
  E('srl', 'SHI', OP_SPECIAL, 0b000010),
  E('sra', 'SHI', OP_SPECIAL, 0b000011),
  E('sllv', 'SHV', OP_SPECIAL, 0b000100),
  E('srlv', 'SHV', OP_SPECIAL, 0b000110),
  E('srav', 'SHV', OP_SPECIAL, 0b000111),
  E('jr', 'JR', OP_SPECIAL, 0b001000),
  E('jalr', 'JALR', OP_SPECIAL, 0b001001),
  E('syscall', 'SYS', OP_SPECIAL, 0b001100),
  E('add', 'R3', OP_SPECIAL, 0b100000),
  E('addu', 'R3', OP_SPECIAL, 0b100001),
  E('sub', 'R3', OP_SPECIAL, 0b100010),
  E('subu', 'R3', OP_SPECIAL, 0b100011),
  E('and', 'R3', OP_SPECIAL, 0b100100),
  E('or', 'R3', OP_SPECIAL, 0b100101),
  E('xor', 'R3', OP_SPECIAL, 0b100110),
  E('nor', 'R3', OP_SPECIAL, 0b100111),
  E('slt', 'R3', OP_SPECIAL, 0b101010),
  E('sltu', 'R3', OP_SPECIAL, 0b101011),
  E('mul', 'R3', OP_SPECIAL2, 0b000010),
  E('bltz', 'B1', OP_REGIMM, 0, 0b00000),
  E('bgez', 'B1', OP_REGIMM, 0, 0b00001),
  E('j', 'J', 0b000010),
  E('jal', 'J', 0b000011),
  E('beq', 'B2', 0b000100),
  E('bne', 'B2', 0b000101),
  E('blez', 'B1', 0b000110),
  E('bgtz', 'B1', 0b000111),
  E('addi', 'I', 0b001000),
  E('addiu', 'I', 0b001001),
  E('slti', 'I', 0b001010),
  E('sltiu', 'I', 0b001011),
  E('andi', 'IU', 0b001100),
  E('ori', 'IU', 0b001101),
  E('xori', 'IU', 0b001110),
  E('lui', 'LUI', 0b001111),
  E('lb', 'M', 0b100000),
  E('lh', 'M', 0b100001),
  E('lw', 'M', 0b100011),
  E('lbu', 'M', 0b100100),
  E('lhu', 'M', 0b100101),
  E('sb', 'M', 0b101000),
  E('sh', 'M', 0b101001),
  E('sw', 'M', 0b101011),
];

export const ENCODING_BY_MNEMONIC = new Map<string, Encoding>(ENCODINGS.map((e) => [e.mnemonic, e]));

/** Instructions that transfer control after the instruction in their delay slot. */
export function isControlTransfer(format: Format): boolean {
  return format === 'B1' || format === 'B2' || format === 'J' || format === 'JR' || format === 'JALR';
}

const roles: Record<string, string> = {
  $zero: 'always reads as zero; writes are discarded',
  $at: 'assembler temporary; never used by the compiler, and the reference assembler runs with .set noat',
  $v0: 'return value of main and service number',
  $v1: 'unused',
  $a0: 'first argument and service argument',
  $a1: 'second argument',
  $a2: 'third argument',
  $a3: 'fourth argument',
  $t0: 'expression temporary',
  $t1: 'expression temporary',
  $t2: 'expression temporary',
  $t3: 'expression temporary',
  $t4: 'expression temporary',
  $t5: 'expression temporary',
  $t6: 'code-generator scratch',
  $t7: 'code-generator scratch',
  $t8: 'code-generator scratch',
  $t9: 'code-generator scratch',
  $k0: 'reserved for an operating-system kernel; unused',
  $k1: 'reserved for an operating-system kernel; unused',
  $gp: 'global pointer; holds the start of the data region',
  $sp: 'stack pointer',
  $fp: 'frame pointer; unused',
  $ra: 'return address (link register)',
};

export const PROFILE: TargetProfile = {
  id: 'mips',
  name: 'MIPS32 Release 2',
  isa: 'MIPS32 Release 2 integer subset, little-endian, with architectural branch delay slots; no Release 6 encodings',
  registerBits: 32,
  operationBits: 32,
  endianness: 'little',
  instructionLength: { min: 4, max: 4, description: 'every instruction is one 32-bit word, stored least significant byte first in this little-endian profile' },
  registers: REG_NAMES.map((name, i) => ({
    name,
    aliases: name === '$fp' ? [`$${i}`, '$s8'] : [`$${i}`],
    bits: 32,
    role: roles[name] ?? 'home of a source variable',
  })),
  flags: [],
  pcName: 'pc',
  excluded: [
    'branch-likely instructions (beql, bnel, blezl, bgtzl, bltzl, bgezl, bltzall, bgezall)',
    'linking branches (bal, bgezal, bltzal)',
    'HI/LO multiply and divide (mult, multu, div, divu, mfhi, mflo, mthi, mtlo, madd, maddu, msub, msubu)',
    'conditional moves (movn, movz, movf, movt)',
    'count leading zeros and ones (clz, clo)',
    'trap instructions, break, and the software debug breakpoint sdbbp',
    'Release 2 bit-field, rotate, byte, and hardware-register instructions (ext, ins, rotr, rotrv, seb, seh, wsbh, rdhwr)',
    'jumps with hazard barrier (jr.hb, jalr.hb)',
    'memory synchronization, prefetch, and cache instructions (sync, synci, pref, cache)',
    'unaligned and atomic memory access (lwl, lwr, swl, swr, ll, sc)',
    'coprocessor and floating-point instructions',
    'Release 6 encodings, MIPS16e and microMIPS (with jalx, which switches to them), and MIPS64',
  ],
  references: [
    {
      title: 'MIPS Architecture for Programmers Volume II-A: The MIPS32 Instruction Set Manual (document MD00086)',
      version: 'Revision 6.06, December 15, 2016; the Release 2 behaviour is the behaviour the manual labels pre-Release 6',
      url: 'https://web.archive.org/web/20260730143747/https://s3-eu-west-1.amazonaws.com/downloads-mips/documents/MD00086-2B-MIPS32BIS-AFP-6.06.pdf',
      sections: 'Section 3.2 "Alphabetical List of Instructions"; Appendix A "Instruction Bit Encodings"',
    },
    {
      title: 'MIPS Architecture For Programmers Volume I-A: Introduction to the MIPS32 Architecture (document MD00082)',
      version: 'Revision 6.01, August 20, 2014',
      url: 'https://web.archive.org/web/20260217134140/https://s3-eu-west-1.amazonaws.com/downloads-mips/documents/MD00082-2B-MIPS32INT-AFP-06.01.pdf',
      sections: 'Section 4.3.1 "CPU General-Purpose Registers"; Section 5.3.2 "Branch Delay Slots and Branch Likely versus Compact Branches and Forbidden Slots"; Section 5.7 "CPU Instruction Formats"',
    },
    {
      title: 'MIPS32 Instruction Set Quick Reference (document MD00565)',
      version: 'Revision 01.01',
      url: 'https://web.archive.org/web/20250813222203/https://s3-eu-west-1.amazonaws.com/downloads-mips/documents/MD00565-2B-MIPS32-QRC-01.01.pdf',
      sections: 'Table "REGISTERS" (software register names)',
    },
  ],
  conventions: {
    args: ['$a0', '$a1', '$a2', '$a3'],
    result: '$v0',
    stackPointer: '$sp',
    link: '$ra',
    varRegs: ['$s0', '$s1', '$s2', '$s3', '$s4', '$s5', '$s6', '$s7'],
    tempRegs: ['$t0', '$t1', '$t2', '$t3', '$t4', '$t5'],
    scratch: ['$t6', '$t7', '$t8', '$t9'],
    serviceInsn: 'syscall',
    serviceNumber: '$v0',
    serviceArg: '$a0',
    serviceClobbers: [],
    notes: [
      'Register roles follow the names of the o32 calling convention, but main does not save the s registers it uses, reserves no argument area on the stack, and does not set $t9 to its own address, because the startup stub does not depend on them.',
      '$gp holds the start of the data region, set once by the startup stub; it is not the o32 global pointer of position-independent code.',
      'Every branch and jump is followed by its delay slot. The compiler fills each delay slot with nop; the reference assembler runs with .set noreorder, so nothing is moved into or out of a delay slot.',
      'A branch or jump placed in a delay slot is UNPREDICTABLE in the architecture; the processor model stops with a fault. jalr with the same register as destination and target is UNPREDICTABLE as well and also faults.',
      'A syscall placed in a delay slot performs the service and execution continues at the target of the branch, which is the address at which an exception handler that honours the branch-delay indication resumes the program.',
      'Service numbers in $v0 belong to this execution environment and are not Linux or SPIM system-call numbers.',
      'The registers HI and LO are not modelled. mul leaves them UNPREDICTABLE in the architecture, and the profile has no instruction that reads them.',
    ],
  },
  commentChars: ['#'],
  overview: [
    '32 general-purpose registers of 32 bits ($0 to $31); $zero always reads as zero.',
    'Fixed 32-bit instructions in three formats (R, I, J).',
    'No condition flags: beq and bne compare two registers, the other branches compare one register with zero, and slt produces 0 or 1 in a register.',
    'Delayed control transfer: the instruction after a branch or jump (the delay slot) executes before control moves to the target, whether or not the branch is taken.',
    'add, addi, and sub raise the Integer Overflow exception; addu, addiu, and subu wrap, and the compiler uses only these.',
    'Loads and stores are the only instructions that access memory; words and halfwords must be naturally aligned.',
  ],
};
