/**
 * AArch64 profile: register names, condition codes, the logical (bitmask)
 * immediate codec, the list of implemented A64 instructions, and conventions.
 *
 * Operand conventions of the assembly-level instruction (`Insn`):
 *  - a register operand carries the name that selects its width and, for
 *    register number 31, its meaning (`sp`/`wsp` or `xzr`/`wzr`);
 *  - a 64-bit logical immediate is carried as two immediate operands, the low
 *    and the high 32 bits, because an immediate operand holds a number;
 *  - a branch target is an absolute address; a target below address zero
 *    (the 64-bit program counter wrapped) is carried as a negative number.
 */
import type { TargetProfile } from '../types.ts';

export interface RegRef {
  /** Register number 0 to 31. */
  n: number;
  bits: 32 | 64;
  /** For number 31: the stack pointer or the zero register. */
  kind: 'gp' | 'sp' | 'zr';
}

/** Register named in assembly text; null when the name is unknown. */
export function parseReg(text: string): RegRef | null {
  const name = text.toLowerCase();
  if (name === 'sp') return { n: 31, bits: 64, kind: 'sp' };
  if (name === 'wsp') return { n: 31, bits: 32, kind: 'sp' };
  if (name === 'xzr') return { n: 31, bits: 64, kind: 'zr' };
  if (name === 'wzr') return { n: 31, bits: 32, kind: 'zr' };
  if (name === 'lr') return { n: 30, bits: 64, kind: 'gp' };
  const m = /^([xw])([0-9]|[12][0-9]|30)$/.exec(name);
  if (!m) return null;
  return { n: Number(m[2]), bits: m[1] === 'x' ? 64 : 32, kind: 'gp' };
}

/** Name of register `n` at the given width; `r31` selects the meaning of number 31. */
export function regName(n: number, bits: 32 | 64, r31: 'sp' | 'zr'): string {
  if (n === 31) return r31 === 'sp' ? (bits === 64 ? 'sp' : 'wsp') : bits === 64 ? 'xzr' : 'wzr';
  return `${bits === 64 ? 'x' : 'w'}${n}`;
}

/** Condition mnemonics indexed by the 4-bit condition field. */
export const COND_NAMES = ['eq', 'ne', 'hs', 'lo', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv'] as const;

/** Condition field for a mnemonic; `cs` and `cc` are the other spellings of `hs` and `lo`. Returns -1 when unknown. */
export function condIndex(name: string): number {
  const n = name.toLowerCase();
  if (n === 'cs') return 2;
  if (n === 'cc') return 3;
  return (COND_NAMES as readonly string[]).indexOf(n);
}

/** Whether the condition holds for the given flags. Conditions 14 and 15 always hold. */
export function condHolds(cond: number, n: number, z: number, c: number, v: number): boolean {
  let r: boolean;
  switch (cond >> 1) {
    case 0: r = z === 1; break;
    case 1: r = c === 1; break;
    case 2: r = n === 1; break;
    case 3: r = v === 1; break;
    case 4: r = c === 1 && z === 0; break;
    case 5: r = n === v; break;
    case 6: r = n === v && z === 0; break;
    default: return true;
  }
  return cond & 1 ? !r : r;
}

// ---- logical (bitmask) immediates ---------------------------------------------

export interface BitmaskFields {
  n: number;
  immr: number;
  imms: number;
}

/**
 * Fields N, immr, imms of a logical immediate, or null when the value is not a
 * rotated run of ones replicated across the register. Zero and all ones are
 * not encodable.
 */
export function encodeBitmask(value: bigint, bits: 32 | 64): BitmaskFields | null {
  const mask = (1n << BigInt(bits)) - 1n;
  const v = value & mask;
  if (v === 0n || v === mask) return null;
  // Smallest element size whose replication gives the value.
  let size: number = bits;
  while (size > 2) {
    const half = BigInt(size / 2);
    const hm = (1n << half) - 1n;
    if ((v & hm) !== ((v >> half) & hm)) break;
    size /= 2;
  }
  const em = (1n << BigInt(size)) - 1n;
  const elem = v & em;
  for (let r = 0; r < size; r++) {
    // Rotating the element left by r undoes a right rotation by r of a run of ones that starts at bit 0.
    const rot = ((elem << BigInt(r)) | (elem >> BigInt(size - r))) & em;
    if ((rot & (rot + 1n)) !== 0n) continue;
    const ones = rot.toString(2).length;
    return { n: size === 64 ? 1 : 0, immr: r, imms: (((~(size - 1)) << 1) | (ones - 1)) & 0x3f };
  }
  return null;
}

/** Value of a logical immediate, or null when the field combination is reserved. */
export function decodeBitmask(n: number, immr: number, imms: number, bits: 32 | 64): bigint | null {
  const combined = (n << 6) | (~imms & 0x3f);
  if (combined < 2) return null;
  const len = 31 - Math.clz32(combined);
  const size = 1 << len;
  if (size > bits) return null;
  const levels = size - 1;
  const s = imms & levels;
  const r = immr & levels;
  if (s === levels) return null;
  const em = (1n << BigInt(size)) - 1n;
  const run = (1n << BigInt(s + 1)) - 1n;
  const elem = r === 0 ? run : ((run >> BigInt(r)) | (run << BigInt(size - r))) & em;
  let out = 0n;
  for (let i = 0; i < bits; i += size) out |= elem << BigInt(i);
  return out;
}

// ---- instruction list -----------------------------------------------------------

/**
 * Operand classes of the implemented instructions:
 *  addsub   add, sub, adds, subs: immediate (optionally shifted left by 12) or shifted register;
 *  logic    and, orr, eor, ands: bitmask immediate or shifted register;
 *  logicn   orn, bic: shifted register with the second operand inverted;
 *  movw     movz, movn, movk: 16-bit immediate placed at bit 0, 16, 32, or 48;
 *  shiftv   lslv, lsrv, asrv: shift by a register;
 *  bitfield ubfm, sbfm;
 *  mul      madd, msub;
 *  csel     csel, csinc;
 *  b        b, bl; bcond b.cond; cb cbz, cbnz; breg br, blr, ret;
 *  mem      ldr, str, ldrb, ldrh, strb, strh;
 *  svc, nop.
 */
export type Klass =
  | 'addsub' | 'logic' | 'logicn' | 'movw' | 'shiftv' | 'bitfield' | 'mul' | 'csel' | 'b' | 'bcond' | 'cb' | 'breg' | 'mem' | 'svc' | 'nop';

export interface Spec {
  mnemonic: string;
  klass: Klass;
  /** Operation selector within the class (the opc, op, or S field values, as used by the encoder). */
  code: number;
}

const S = (mnemonic: string, klass: Klass, code = 0): Spec => ({ mnemonic, klass, code });

export const SPECS: Spec[] = [
  // code = op:S
  S('add', 'addsub', 0b00), S('adds', 'addsub', 0b01), S('sub', 'addsub', 0b10), S('subs', 'addsub', 0b11),
  // code = opc
  S('and', 'logic', 0b00), S('orr', 'logic', 0b01), S('eor', 'logic', 0b10), S('ands', 'logic', 0b11),
  S('bic', 'logicn', 0b00), S('orn', 'logicn', 0b01),
  S('movn', 'movw', 0b00), S('movz', 'movw', 0b10), S('movk', 'movw', 0b11),
  S('lslv', 'shiftv', 0b00), S('lsrv', 'shiftv', 0b01), S('asrv', 'shiftv', 0b10),
  S('sbfm', 'bitfield', 0b00), S('ubfm', 'bitfield', 0b10),
  S('madd', 'mul', 0), S('msub', 'mul', 1),
  S('csel', 'csel', 0), S('csinc', 'csel', 1),
  S('b', 'b', 0), S('bl', 'b', 1),
  ...COND_NAMES.map((c, i) => S(`b.${c}`, 'bcond', i)),
  S('cbz', 'cb', 0), S('cbnz', 'cb', 1),
  S('br', 'breg', 0), S('blr', 'breg', 1), S('ret', 'breg', 2),
  // code = size:load
  S('strb', 'mem', 0b000), S('ldrb', 'mem', 0b001), S('strh', 'mem', 0b010), S('ldrh', 'mem', 0b011),
  S('str', 'mem', 0b100), S('ldr', 'mem', 0b101),
  S('svc', 'svc'), S('nop', 'nop'),
];

export const SPEC_BY_MNEMONIC = new Map<string, Spec>(SPECS.map((s) => [s.mnemonic, s]));

const role = (i: number): string => {
  if (i <= 3) return i === 0 ? 'first argument, return value, and service argument' : `argument ${i + 1}`;
  if (i === 8) return 'service number';
  if (i >= 9 && i <= 13) return 'expression temporary';
  if (i >= 14 && i <= 15) return 'code-generator scratch (operands)';
  if (i === 16) return 'code-generator scratch (constants)';
  if (i === 17) return 'code-generator scratch (array addresses)';
  if (i >= 19 && i <= 28) return 'home of a source variable';
  if (i === 29) return 'frame pointer in the procedure call standard; unused';
  if (i === 30) return 'link register: return address written by bl and blr';
  return 'unused';
};

export const PROFILE: TargetProfile = {
  id: 'aarch64',
  name: 'Arm AArch64 (A64)',
  isa: 'Armv8-A AArch64 state, A64 instruction set, integer subset without floating point, Advanced SIMD, or system registers',
  registerBits: 64,
  operationBits: 32,
  endianness: 'little',
  instructionLength: { min: 4, max: 4, description: 'every instruction is one 32-bit word, stored least significant byte first' },
  registers: [
    ...Array.from({ length: 31 }, (_, i) => ({
      name: `x${i}`,
      aliases: i === 30 ? ['w30', 'lr'] : [`w${i}`],
      bits: 64 as const,
      role: role(i),
    })),
    { name: 'sp', aliases: ['wsp'], bits: 64 as const, role: 'stack pointer', generalPurpose: false },
  ],
  flags: [
    { name: 'N', description: 'negative: bit 31 (or 63) of the result' },
    { name: 'Z', description: 'zero: the result is zero' },
    { name: 'C', description: 'carry: unsigned overflow of an addition; for a subtraction, 1 when no borrow occurred' },
    { name: 'V', description: 'overflow: signed overflow of the addition or subtraction' },
  ],
  pcName: 'pc',
  excluded: [
    'floating point and Advanced SIMD', 'SVE and SME', 'system registers and system instructions other than SVC and NOP',
    'load and store pair, pre-indexed, post-indexed, unscaled, and literal addressing', 'exclusive and atomic memory instructions',
    'add and subtract with extended register or carry', 'conditional compare', 'divide', 'pointer authentication and memory tagging',
  ],
  references: [
    {
      title: 'Arm Architecture Reference Manual for A-profile architecture',
      version: 'ARM DDI 0487, issue M.d, 30 September 2026',
      url: 'https://developer.arm.com/documentation/ddi0487/latest',
      sections: 'C1.2 Structure of the A64 assembler language; C3 A64 Instruction Set Overview; C4.1 A64 instruction set encoding; C6.2 Alphabetical list of A64 base instructions; B1.3 Process state, PSTATE',
    },
    {
      title: 'Procedure Call Standard for the Arm 64-bit Architecture (AArch64)',
      version: '2026Q3, 3 November 2026',
      url: 'https://github.com/ARM-software/abi-aa/releases/tag/2026Q3',
      sections: '6.1.1 General-purpose Registers',
    },
  ],
  conventions: {
    args: ['w0', 'w1', 'w2', 'w3'],
    result: 'w0',
    stackPointer: 'sp',
    link: 'x30',
    varRegs: ['w19', 'w20', 'w21', 'w22', 'w23', 'w24', 'w25', 'w26', 'w27', 'w28'],
    tempRegs: ['w9', 'w10', 'w11', 'w12', 'w13'],
    scratch: ['w14', 'w15', 'w16', 'w17'],
    serviceInsn: 'svc #0',
    serviceNumber: 'w8',
    serviceArg: 'w0',
    serviceClobbers: [],
    notes: [
      'Register roles follow the Procedure Call Standard (arguments in w0 to w3, result in w0, callee-saved x19 to x28 as variable homes), but main does not save the registers x19 to x28 that it uses, because the startup stub does not depend on them.',
      'main is a leaf function, so x30 is not saved. A stack frame is allocated only when variables or temporaries need stack slots, in multiples of 16 bytes.',
      'Service numbers in w8 belong to this execution environment and are not Linux system-call numbers. The processor model returns to the instruction after svc without changing any register.',
      'Checking of stack-pointer alignment is not modelled: sp may hold any value and may be used as a base address when it is not a multiple of 16.',
      'Unaligned data accesses are permitted. An instruction fetch from an address that is not a multiple of 4, which only br, blr, or ret can cause, raises a PC alignment fault.',
      'Source arithmetic is 32-bit and uses the W registers; a write to a W register clears the upper 32 bits of the X register.',
    ],
  },
  commentChars: ['//'],
  overview: [
    '31 general-purpose registers of 64 bits (x0 to x30), each with a 32-bit view (w0 to w30), and a separate stack pointer.',
    'Register number 31 means the stack pointer or the zero register, depending on the instruction and the operand position.',
    'Fixed 32-bit instructions; the same operation usually exists in a 32-bit and a 64-bit form selected by one bit.',
    'Four condition flags (N, Z, C, V), set only by the flag-setting instructions and read by conditional branches and selects.',
    'Many assembly mnemonics are aliases: mov, cmp, mul, lsl, and cset are other spellings of orr, subs, madd, ubfm, and csinc.',
    'Loads and stores are the only instructions that access memory; an address can be a base plus a scaled register index.',
  ],
};
