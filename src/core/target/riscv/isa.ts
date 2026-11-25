/**
 * RISC-V RV32I profile: register names, encoding table, and conventions.
 * The table lists every instruction of the RV32I base integer instruction set
 * that the encoder, decoder, and processor model implement.
 */
import type { TargetProfile } from '../types.ts';

/** ABI register names indexed by register number x0 to x31. */
export const REG_NAMES = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
] as const;

const REG_INDEX = new Map<string, number>();
REG_NAMES.forEach((n, i) => {
  REG_INDEX.set(n, i);
  REG_INDEX.set(`x${i}`, i);
});
REG_INDEX.set('fp', 8);

/** Register number for an ABI name, an x-name, or `fp`; -1 when the name is unknown. */
export function regIndex(name: string): number {
  return REG_INDEX.get(name.toLowerCase()) ?? -1;
}

/**
 * Encoding formats. R, I, S, B, U, and J are the base formats of the
 * specification. The remaining names select the assembly operand syntax of
 * instructions that share the I format:
 *  SH  shift by a 5-bit amount, with funct7 in the upper immediate bits;
 *  L   load, written rd, offset(rs1);
 *  JR  jalr, written rd, offset(rs1);
 *  SYS no operands.
 */
export type Format = 'R' | 'I' | 'S' | 'B' | 'U' | 'J' | 'SH' | 'L' | 'JR' | 'SYS';

export interface Encoding {
  mnemonic: string;
  format: Format;
  opcode: number;
  funct3: number;
  funct7: number;
}

const E = (mnemonic: string, format: Format, opcode: number, funct3 = 0, funct7 = 0): Encoding => ({
  mnemonic, format, opcode, funct3, funct7,
});

export const ENCODINGS: Encoding[] = [
  E('lui', 'U', 0b0110111),
  E('auipc', 'U', 0b0010111),
  E('jal', 'J', 0b1101111),
  E('jalr', 'JR', 0b1100111, 0b000),
  E('beq', 'B', 0b1100011, 0b000),
  E('bne', 'B', 0b1100011, 0b001),
  E('blt', 'B', 0b1100011, 0b100),
  E('bge', 'B', 0b1100011, 0b101),
  E('bltu', 'B', 0b1100011, 0b110),
  E('bgeu', 'B', 0b1100011, 0b111),
  E('lb', 'L', 0b0000011, 0b000),
  E('lh', 'L', 0b0000011, 0b001),
  E('lw', 'L', 0b0000011, 0b010),
  E('lbu', 'L', 0b0000011, 0b100),
  E('lhu', 'L', 0b0000011, 0b101),
  E('sb', 'S', 0b0100011, 0b000),
  E('sh', 'S', 0b0100011, 0b001),
  E('sw', 'S', 0b0100011, 0b010),
  E('addi', 'I', 0b0010011, 0b000),
  E('slti', 'I', 0b0010011, 0b010),
  E('sltiu', 'I', 0b0010011, 0b011),
  E('xori', 'I', 0b0010011, 0b100),
  E('ori', 'I', 0b0010011, 0b110),
  E('andi', 'I', 0b0010011, 0b111),
  E('slli', 'SH', 0b0010011, 0b001, 0b0000000),
  E('srli', 'SH', 0b0010011, 0b101, 0b0000000),
  E('srai', 'SH', 0b0010011, 0b101, 0b0100000),
  E('add', 'R', 0b0110011, 0b000, 0b0000000),
  E('sub', 'R', 0b0110011, 0b000, 0b0100000),
  E('sll', 'R', 0b0110011, 0b001, 0b0000000),
  E('slt', 'R', 0b0110011, 0b010, 0b0000000),
  E('sltu', 'R', 0b0110011, 0b011, 0b0000000),
  E('xor', 'R', 0b0110011, 0b100, 0b0000000),
  E('srl', 'R', 0b0110011, 0b101, 0b0000000),
  E('sra', 'R', 0b0110011, 0b101, 0b0100000),
  E('or', 'R', 0b0110011, 0b110, 0b0000000),
  E('and', 'R', 0b0110011, 0b111, 0b0000000),
  E('ecall', 'SYS', 0b1110011),
];

export const ENCODING_BY_MNEMONIC = new Map<string, Encoding>(ENCODINGS.map((e) => [e.mnemonic, e]));

const roles: Record<string, string> = {
  zero: 'always reads as zero; writes are discarded',
  ra: 'return address (link register)',
  sp: 'stack pointer',
  gp: 'global pointer; holds the start of the data region',
  tp: 'thread pointer; unused',
  a0: 'first argument, return value, and service argument',
  a1: 'second argument',
  a2: 'third argument; expression temporary',
  a3: 'fourth argument; expression temporary',
  a4: 'expression temporary',
  a5: 'expression temporary',
  a6: 'unused',
  a7: 'service number',
  t0: 'expression temporary',
  t1: 'expression temporary',
  t2: 'expression temporary',
  t3: 'code-generator scratch',
  t4: 'code-generator scratch',
  t5: 'code-generator scratch; software multiplication',
  t6: 'code-generator scratch; software multiplication',
};

export const PROFILE: TargetProfile = {
  id: 'riscv',
  name: 'RISC-V RV32I',
  isa: 'RV32I base integer instruction set, version 2.1, except FENCE and EBREAK, without extensions',
  registerBits: 32,
  operationBits: 32,
  endianness: 'little',
  instructionLength: { min: 4, max: 4, description: 'every instruction is one 32-bit word, stored least significant byte first' },
  registers: REG_NAMES.map((name, i) => ({
    name,
    aliases: name === 's0' ? [`x${i}`, 'fp'] : [`x${i}`],
    bits: 32,
    role: roles[name] ?? (name.startsWith('s') ? 'home of a source variable' : ''),
  })),
  flags: [],
  pcName: 'pc',
  excluded: [
    'FENCE (with FENCE.TSO and PAUSE) and EBREAK, which belong to the RV32I base',
    'M (integer multiply and divide)', 'A (atomics)', 'F and D (floating point)', 'C (compressed 16-bit encodings)',
    'Zicsr (control and status registers)', 'Zifencei',
  ],
  references: [
    {
      title: 'The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture',
      version: 'Version 20260120, ratified; Chapter 2 "RV32I Base Integer Instruction Set, Version 2.1"',
      url: 'https://docs.riscv.org/reference/isa/v20260120/_attachments/riscv-unprivileged.pdf',
      sections: 'Section 1.5 "Base Instruction-Length Encoding"; Section 2.2 "Base Instruction Formats"; Section 2.3 "Immediate Encoding Variants"; Section 2.4 "Integer Computational Instructions"; Section 2.5 "Control Transfer Instructions"; Section 2.6 "Load and Store Instructions"; Section 2.8 "Environment Call and Breakpoints"',
    },
    {
      title: 'RISC-V ABIs Specification',
      version: 'Document Version 1.0, November 2022, ratified',
      url: 'https://github.com/riscv-non-isa/riscv-elf-psabi-doc/releases/download/v1.0/riscv-abi.pdf',
      sections: 'Section 1.1 "Integer Register Convention", Table 1 (register names)',
    },
    {
      title: 'RISC-V Assembly Programmer\'s Manual',
      version: 'no numbered release; main branch',
      url: 'https://github.com/riscv-non-isa/riscv-asm-manual/blob/main/src/asm-manual.adoc',
      sections: 'Section "A listing of standard RISC-V pseudoinstructions"',
    },
  ],
  conventions: {
    args: ['a0', 'a1', 'a2', 'a3'],
    result: 'a0',
    stackPointer: 'sp',
    link: 'ra',
    varRegs: ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'],
    tempRegs: ['t0', 't1', 't2', 'a2', 'a3', 'a4', 'a5'],
    scratch: ['t3', 't4', 't5', 't6'],
    serviceInsn: 'ecall',
    serviceNumber: 'a7',
    serviceArg: 'a0',
    serviceClobbers: [],
    notes: [
      'Register roles follow the names of the RISC-V integer calling convention, but main does not save the s registers it uses, because the startup stub does not depend on them.',
      'main saves ra on the stack only when it calls the software multiplication helper.',
      'Service numbers in a7 belong to this execution environment and are not Linux system-call numbers.',
    ],
  },
  commentChars: ['#', '//'],
  overview: [
    '32 general-purpose registers of 32 bits (x0 to x31); x0 always reads as zero.',
    'Fixed 32-bit instructions in six formats (R, I, S, B, U, J).',
    'No condition flags: branches compare two registers directly.',
    'No multiply instruction in the base set; the compiler calls a shift-and-add helper.',
    'Loads and stores are the only instructions that access memory.',
  ],
};
