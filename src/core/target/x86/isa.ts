/**
 * x86-64 profile: register names, condition codes, operation tables, and
 * conventions. The profile is a subset of the integer instructions of 64-bit
 * mode: 32-bit operand size for the arithmetic of the source language and
 * 64-bit operand size for the stack pointer and for addresses.
 */
import type { TargetProfile } from '../types.ts';

/** 64-bit register names indexed by register number 0 to 15. */
export const REG64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'] as const;
/** Names of the low 32 bits of each register. */
export const REG32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'] as const;
/** Names of the low 8 bits of each register. Numbers 4 to 7 need a REX prefix. */
export const REG8 = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'] as const;
/** Bits 15 to 8 of rax, rcx, rdx, and rbx: encodings 4 to 7 of a byte register when no REX prefix is present. */
export const REG8_HIGH = ['ah', 'ch', 'dh', 'bh'] as const;

const REG16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'];

export interface RegRef {
  /** Register number 0 to 15. For a high-byte register, the number of the containing register (0 to 3). */
  num: number;
  size: 8 | 32 | 64;
  /** True for ah, ch, dh, and bh. */
  high: boolean;
}

const REG_TABLE = new Map<string, RegRef>();
REG64.forEach((n, i) => REG_TABLE.set(n, { num: i, size: 64, high: false }));
REG32.forEach((n, i) => REG_TABLE.set(n, { num: i, size: 32, high: false }));
REG8.forEach((n, i) => REG_TABLE.set(n, { num: i, size: 8, high: false }));
REG8_HIGH.forEach((n, i) => REG_TABLE.set(n, { num: i, size: 8, high: true }));

/** Register for a name of any supported width, or null when the name is unknown. */
export function regRef(name: string): RegRef | null {
  return REG_TABLE.get(name.toLowerCase()) ?? null;
}

/** True for the names of 16-bit registers, which the profile does not include. */
export function isReg16(name: string): boolean {
  return REG16.includes(name.toLowerCase());
}

/** Name of register `num` at the given operand size. */
export function regName(num: number, size: 8 | 32 | 64): string {
  return size === 64 ? REG64[num]! : size === 32 ? REG32[num]! : REG8[num]!;
}

/** Condition-code suffixes indexed by the four-bit condition number of Jcc and SETcc. */
export const CC_NAMES = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'] as const;

/** Flag expression tested by each condition number. */
export const CC_MEANING = [
  'OF = 1', 'OF = 0', 'CF = 1', 'CF = 0', 'ZF = 1', 'ZF = 0', 'CF = 1 or ZF = 1', 'CF = 0 and ZF = 0',
  'SF = 1', 'SF = 0', 'PF = 1', 'PF = 0', 'SF != OF', 'SF = OF', 'ZF = 1 or SF != OF', 'ZF = 0 and SF = OF',
] as const;

/** Other spellings of the condition suffixes that assemblers accept. */
const CC_ALIASES: Record<string, string> = {
  c: 'b', nae: 'b', nc: 'ae', nb: 'ae', z: 'e', nz: 'ne', na: 'be', nbe: 'a', pe: 'p', po: 'np', nge: 'l', nl: 'ge', ng: 'le', nle: 'g',
};

/** Condition number for a suffix such as `e`, `nz`, or `ge`; -1 when the suffix is not a condition. */
export function ccNumber(suffix: string): number {
  const s = CC_ALIASES[suffix] ?? suffix;
  return (CC_NAMES as readonly string[]).indexOf(s);
}

/**
 * Arithmetic and logic operations that share one encoding pattern. `ext` is
 * the number that selects the operation: it is bits 5 to 3 of the opcodes
 * 00 to 3F and the reg field of the immediate group (opcodes 81 and 83).
 */
export const ALU_EXT: Record<string, number> = { add: 0, or: 1, and: 4, sub: 5, xor: 6, cmp: 7 };
export const ALU_BY_EXT = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'] as const;

/** Shift operations and the reg field that selects them in the shift group (opcodes C1, D1, D3). */
export const SHIFT_EXT: Record<string, number> = { shl: 4, shr: 5, sar: 7 };
export const SHIFT_BY_EXT = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'] as const;

/** One-operand operations of opcode F7 (not, neg) and opcode FF (inc, dec) with their reg field. */
export const UNARY: Record<string, { opcode: number; ext: number }> = {
  not: { opcode: 0xf7, ext: 2 },
  neg: { opcode: 0xf7, ext: 3 },
  inc: { opcode: 0xff, ext: 0 },
  dec: { opcode: 0xff, ext: 1 },
};

/** Mnemonics without a condition suffix that the encoder, decoder, and processor model implement. */
export const BASE_MNEMONICS = [
  'mov', 'movzx', 'movsxd', 'lea', 'add', 'sub', 'and', 'or', 'xor', 'cmp', 'test', 'imul', 'neg', 'not', 'inc', 'dec',
  'shl', 'sar', 'shr', 'jmp', 'call', 'ret', 'push', 'pop', 'syscall', 'nop',
] as const;

const roles: Record<string, string> = {
  rax: 'return value, service number, and code-generator scratch (eax)',
  rcx: 'fourth argument; shift count (cl); overwritten by syscall with the address of the next instruction',
  rdx: 'third argument and code-generator scratch (edx)',
  rbx: 'home of a source variable (ebx)',
  rsp: 'stack pointer',
  rbp: 'home of a source variable (ebp); not used as a frame pointer',
  rsi: 'second argument; expression temporary (esi)',
  rdi: 'first argument and service argument; expression temporary (edi)',
  r8: 'expression temporary (r8d)',
  r9: 'expression temporary (r9d)',
  r10: 'expression temporary (r10d)',
  r11: 'code-generator scratch (r11d); overwritten by syscall with the flags',
  r12: 'home of a source variable (r12d)',
  r13: 'home of a source variable (r13d)',
  r14: 'home of a source variable (r14d)',
  r15: 'home of a source variable (r15d)',
};

const SDM = 'Intel 64 and IA-32 Architectures Software Developer\'s Manual';

export const PROFILE: TargetProfile = {
  id: 'x86',
  name: 'x86-64',
  isa: 'Intel 64 (x86-64) in 64-bit mode, a subset of the general-purpose integer instructions with 32-bit and 64-bit operand size',
  registerBits: 64,
  operationBits: 32,
  endianness: 'little',
  instructionLength: {
    min: 1, max: 15,
    description: 'instructions are 1 to 15 bytes long: optional prefixes, one, two, or three opcode bytes, an optional ModR/M byte, an optional SIB byte, an optional displacement, and an optional immediate; the subset uses one-byte opcodes and two-byte opcodes that begin with 0F',
  },
  registers: REG64.map((name, i) => ({
    name,
    aliases: [REG32[i]!, REG8[i]!, ...(i < 4 ? [REG8_HIGH[i]!] : [])],
    bits: 64 as const,
    role: roles[name]!,
  })),
  flags: [
    { name: 'OF', description: 'overflow: the signed result does not fit in the operand size' },
    { name: 'SF', description: 'sign: most significant bit of the result' },
    { name: 'ZF', description: 'zero: the result is zero' },
    { name: 'AF', description: 'auxiliary carry: carry or borrow between bits 3 and 4' },
    { name: 'PF', description: 'parity: the low byte of the result has an even number of one bits' },
    { name: 'CF', description: 'carry: carry out of, or borrow into, the most significant bit (unsigned overflow)' },
  ],
  pcName: 'rip',
  excluded: [
    '8-bit and 16-bit arithmetic (only MOVZX reads and SETcc writes a byte)', 'ADC, SBB, MUL, DIV, IDIV, one-operand IMUL, rotates, and bit instructions',
    'MOV with a 64-bit immediate, CMOVcc, XCHG, string instructions', 'indirect jumps and calls, PUSH and POP with a memory or immediate operand',
    'RIP-relative addressing, segment overrides, the operand-size and address-size prefixes, LOCK and REP',
    'x87, MMX, SSE, AVX, and all other vector and floating-point extensions', 'privileged and system instructions other than SYSCALL',
  ],
  references: [
    {
      title: `${SDM}, Volume 1: Basic Architecture`,
      version: 'Order Number 253665-093US, September 2026',
      url: 'https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html',
      sections: 'Section 3.4.1.1 General-Purpose Registers in 64-Bit Mode; Section 3.4.3 EFLAGS Register; Section 3.4.3.1 Status Flags',
    },
    {
      title: `${SDM}, Volume 2A: Instruction Set Reference, A-L`,
      version: 'Order Number 253666-093US, September 2026',
      url: 'https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html',
      sections: 'Chapter 2 Instruction Format (Sections 2.1 and 2.2, REX prefixes in Section 2.2.1); Chapter 3 Instructions (A-L)',
    },
    {
      title: `${SDM}, Volume 2B: Instruction Set Reference, M-U`,
      version: 'Order Number 253667-093US, September 2026',
      url: 'https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html',
      sections: 'Chapter 4 Instructions (M-U)',
    },
    {
      title: 'System V Application Binary Interface, AMD64 Architecture Processor Supplement',
      version: 'Version 1.0, draft of March 12, 2025',
      url: 'https://gitlab.com/x86-psABIs/x86-64-ABI',
      sections: 'Section 3.2 Function Calling Sequence; Figure 3.4 Register Usage',
    },
  ],
  conventions: {
    args: ['edi', 'esi', 'edx', 'ecx'],
    result: 'eax',
    stackPointer: 'rsp',
    link: 'stack (call pushes the return address)',
    varRegs: ['ebx', 'ebp', 'r12d', 'r13d', 'r14d', 'r15d'],
    tempRegs: ['r8d', 'r9d', 'r10d', 'esi', 'edi'],
    scratch: ['eax', 'edx', 'ecx', 'r11d'],
    serviceInsn: 'syscall',
    serviceNumber: 'eax',
    serviceArg: 'edi',
    serviceClobbers: ['rcx', 'r11'],
    notes: [
      'Argument and result registers follow the System V AMD64 calling convention, and the variable homes are registers that the convention preserves across calls, but main does not save them, because the startup stub does not depend on them.',
      'Service numbers in eax belong to this execution environment and are not Linux system-call numbers.',
      'SYSCALL copies the address of the next instruction to rcx and the flags to r11. The execution environment then performs the service and resumes at the next instruction with the flags unchanged. Generated code keeps no value in rcx or r11 across a service request.',
      'When main needs stack slots, its prologue subtracts a multiple of 16 plus 8 from rsp, so rsp is a multiple of 16 inside main; slot offsets are relative to rsp after the prologue.',
      'rbp is an ordinary variable register; no frame pointer is kept.',
    ],
  },
  commentChars: ['#', ';'],
  overview: [
    '16 general-purpose registers of 64 bits. Each has a 32-bit name (eax, r8d) and an 8-bit name (al, r8b) for its low part.',
    'Writing a 32-bit register clears the upper 32 bits of the 64-bit register; writing an 8-bit register leaves the other bits unchanged.',
    'Variable-length instructions of 1 to 15 bytes. A REX prefix selects 64-bit operand size and the registers r8 to r15.',
    'Two-operand instructions: the destination is also the first source, so a three-address operation needs a move first.',
    'Six status flags (CF, PF, AF, ZF, SF, OF) are written by arithmetic instructions and read by conditional jumps and SETcc.',
    'Most instructions accept a memory operand with base, scaled index, and displacement, so an array element is addressed in one instruction.',
    'CALL pushes the return address on the stack and RET pops it; there is no link register.',
  ],
};
