/**
 * Instruction catalog of the A64 subset: one entry per implemented
 * instruction and per accepted alias, with syntax, semantics, operand ranges,
 * and a worked example. The explanations are written for this project; the
 * cited sections of the Arm Architecture Reference Manual are the normative
 * source.
 */
import type { InsnGroup, InsnSpec, OperationExample } from '../types.ts';

const C6 = 'Arm ARM (DDI 0487), C6.2 Alphabetical list of A64 base instructions';
const ref = (...pages: string[]): string => `${C6}: ${pages.join('; ')}`;

const real = (
  mnemonic: string, title: string, group: InsnGroup, format: string, syntax: string, semantics: string, operands: string,
  restrictions: string, effects: string, example: string, reference: string, demo?: InsnSpec['demo'],
): InsnSpec => {
  const s: InsnSpec = {
    mnemonic, title, group, format, syntax, semantics, operands, restrictions, effects, example, reference,
    encode: true, decode: true, simulate: true,
  };
  if (demo) s.demo = demo;
  return s;
};

const alias = (
  mnemonic: string, title: string, group: InsnGroup, syntax: string, expansion: string, example: string, reference: string, demo?: InsnSpec['demo'],
): InsnSpec => {
  const s: InsnSpec = {
    mnemonic, title, group, format: 'alias', syntax, semantics: `Alias of: ${expansion}`,
    operands: 'as for the canonical instruction', restrictions: 'not a separate encoding; the assembler emits the canonical instruction, and a disassembler prints the alias when it is the preferred form',
    effects: 'as for the canonical instruction', example, reference,
    encode: true, decode: true, simulate: true, pseudo: true, expansion,
  };
  if (demo) s.demo = demo;
  return s;
};

const W = 'The W form computes in 32 bits and clears the upper 32 bits of the X register; the X form computes in 64 bits.';
const NOFLAGS = 'Flags unchanged.';
const R3 = 'Rd, Rn, Rm: w0 to w30 or wzr (all W), or x0 to x30 or xzr (all X)';
const SHIFTED = 'optional shift of Rm: lsl, lsr, or asr by 0 to 31 (W) or 0 to 63 (X)';
const ROTATED = 'optional shift of Rm: lsl, lsr, asr, or ror by 0 to 31 (W) or 0 to 63 (X)';
const IMM12 = 'imm: 0 to 4095, optionally followed by lsl #12';
const BITMASK = 'imm: a logical immediate, that is a run of ones, rotated, repeated every 2, 4, 8, 16, 32, or 64 bits; zero and all ones are not encodable';
const TARGET19 = 'target within -1048576 to +1048572 bytes of the instruction, at a multiple of 4';
const REG31 = 'Register number 31 is the stack pointer in the immediate form (Rn, and Rd unless the flags are set) and the zero register in the shifted-register form.';

const regDemo = { regs: { w1: 12, w2: 5 } };
const flagDemo = { regs: { w1: 5, w2: 7 } };
const memDemo = { regs: { w0: 0x11223344, x1: 0x10000000, w2: 2 }, mem: [{ address: 0x10000008, value: 0x80c0ffee | 0 }] };
const brDemo = { regs: { w0: 0 }, flags: { N: 0, Z: 1, C: 1, V: 0 } };

export const INSTRUCTIONS: InsnSpec[] = [
  real('add', 'Add', 'arithmetic', 'add/subtract (immediate or shifted register)', 'add Rd, Rn, #imm [, lsl #12]  |  add Rd, Rn, Rm [, shift #amount]',
    'Rd = Rn + operand2', `${R3}; ${IMM12}; ${SHIFTED}`, `${REG31} The extended-register form is outside the subset. ${W}`, `Writes Rd. ${NOFLAGS}`,
    'add w0, w1, w2', ref('ADD (immediate)', 'ADD (shifted register)'), regDemo),
  real('adds', 'Add, setting flags', 'arithmetic', 'add/subtract (immediate or shifted register)', 'adds Rd, Rn, #imm [, lsl #12]  |  adds Rd, Rn, Rm [, shift #amount]',
    'Rd = Rn + operand2; N, Z, C, V from the addition', `${R3}; ${IMM12}; ${SHIFTED}`, `Rd = 31 is the zero register, which gives the alias cmn. ${W}`,
    'Writes Rd. N = sign of the result, Z = result is zero, C = unsigned carry out, V = signed overflow.', 'adds w0, w1, w2', ref('ADDS (immediate)', 'ADDS (shifted register)'), { regs: { w1: -1, w2: 1 } }),
  real('sub', 'Subtract', 'arithmetic', 'add/subtract (immediate or shifted register)', 'sub Rd, Rn, #imm [, lsl #12]  |  sub Rd, Rn, Rm [, shift #amount]',
    'Rd = Rn - operand2', `${R3}; ${IMM12}; ${SHIFTED}`, `${REG31} ${W}`, `Writes Rd. ${NOFLAGS}`, 'sub w0, w1, w2', ref('SUB (immediate)', 'SUB (shifted register)'), regDemo),
  real('subs', 'Subtract, setting flags', 'arithmetic', 'add/subtract (immediate or shifted register)', 'subs Rd, Rn, #imm [, lsl #12]  |  subs Rd, Rn, Rm [, shift #amount]',
    'Rd = Rn - operand2, computed as Rn + NOT(operand2) + 1; N, Z, C, V from that addition', `${R3}; ${IMM12}; ${SHIFTED}`,
    `Rd = 31 is the zero register, which gives the alias cmp. The carry flag is the carry of the addition, so C = 1 means that no borrow occurred (Rn >= operand2, unsigned). ${W}`,
    'Writes Rd. N = sign of the result, Z = result is zero, C = no borrow, V = signed overflow.', 'subs w0, w1, w2', ref('SUBS (immediate)', 'SUBS (shifted register)'), flagDemo),
  real('and', 'Bitwise AND', 'logic', 'logical (immediate or shifted register)', 'and Rd, Rn, #imm  |  and Rd, Rn, Rm [, shift #amount]', 'Rd = Rn AND operand2',
    `${R3}; ${BITMASK}; ${ROTATED}`, `In the immediate form Rd = 31 is the stack pointer. ${W}`, `Writes Rd. ${NOFLAGS}`, 'and w0, w1, #0xff', ref('AND (immediate)', 'AND (shifted register)'), regDemo),
  real('orr', 'Bitwise OR', 'logic', 'logical (immediate or shifted register)', 'orr Rd, Rn, #imm  |  orr Rd, Rn, Rm [, shift #amount]', 'Rd = Rn OR operand2',
    `${R3}; ${BITMASK}; ${ROTATED}`, `With Rn = 31 (zero register) the instruction copies operand2, which gives the alias mov. ${W}`, `Writes Rd. ${NOFLAGS}`,
    'orr w0, w1, w2', ref('ORR (immediate)', 'ORR (shifted register)'), regDemo),
  real('eor', 'Bitwise exclusive OR', 'logic', 'logical (immediate or shifted register)', 'eor Rd, Rn, #imm  |  eor Rd, Rn, Rm [, shift #amount]', 'Rd = Rn XOR operand2',
    `${R3}; ${BITMASK}; ${ROTATED}`, W, `Writes Rd. ${NOFLAGS}`, 'eor w0, w1, #0x1', ref('EOR (immediate)', 'EOR (shifted register)'), regDemo),
  real('ands', 'Bitwise AND, setting flags', 'logic', 'logical (immediate or shifted register)', 'ands Rd, Rn, #imm  |  ands Rd, Rn, Rm [, shift #amount]',
    'Rd = Rn AND operand2; N and Z from the result; C = 0; V = 0', `${R3}; ${BITMASK}; ${ROTATED}`, `Rd = 31 is the zero register, which gives the alias tst. ${W}`,
    'Writes Rd. N = sign of the result, Z = result is zero, C and V cleared.', 'ands w0, w1, #0xf', ref('ANDS (immediate)', 'ANDS (shifted register)'), regDemo),
  real('orn', 'Bitwise OR NOT', 'logic', 'logical (shifted register)', 'orn Rd, Rn, Rm [, shift #amount]', 'Rd = Rn OR NOT(shifted Rm)', `${R3}; ${ROTATED}`,
    `With Rn = 31 (zero register) the instruction complements Rm, which gives the alias mvn. ${W}`, `Writes Rd. ${NOFLAGS}`, 'orn w0, w1, w2', ref('ORN (shifted register)'), regDemo),
  real('bic', 'Bit clear', 'logic', 'logical (shifted register)', 'bic Rd, Rn, Rm [, shift #amount]', 'Rd = Rn AND NOT(shifted Rm)', `${R3}; ${ROTATED}`, W,
    `Writes Rd. ${NOFLAGS}`, 'bic w0, w1, w2', ref('BIC (shifted register)'), regDemo),
  real('movz', 'Move wide with zero', 'move', 'move wide (immediate)', 'movz Rd, #imm16 [, lsl #shift]', 'Rd = imm16 << shift; every other bit is zero',
    'Rd: any register or the zero register; imm16: 0 to 65535; shift: 0 or 16 (W), or 0, 16, 32, or 48 (X)', W, `Writes Rd. ${NOFLAGS}`, 'movz w0, #0x1234, lsl #16',
    ref('MOVZ', 'MOV (wide immediate)')),
  real('movn', 'Move wide with NOT', 'move', 'move wide (immediate)', 'movn Rd, #imm16 [, lsl #shift]', 'Rd = NOT(imm16 << shift)',
    'Rd: any register or the zero register; imm16: 0 to 65535; shift: 0 or 16 (W), or 0, 16, 32, or 48 (X)', `Loads constants that are mostly ones, such as small negative numbers. ${W}`,
    `Writes Rd. ${NOFLAGS}`, 'movn w0, #0x4', ref('MOVN', 'MOV (inverted wide immediate)')),
  real('movk', 'Move wide with keep', 'move', 'move wide (immediate)', 'movk Rd, #imm16 [, lsl #shift]', 'bits shift+15 to shift of Rd = imm16; the other bits keep their value',
    'Rd: any register or the zero register; imm16: 0 to 65535; shift: 0 or 16 (W), or 0, 16, 32, or 48 (X)', `Follows movz to build a constant 16 bits at a time. ${W}`,
    `Reads and writes Rd. ${NOFLAGS}`, 'movk w0, #0x5678', ref('MOVK'), { regs: { w0: 0x12340000 } }),
  real('lslv', 'Logical shift left by register', 'shift', 'data processing (2 source)', 'lslv Rd, Rn, Rm', 'Rd = Rn << (Rm mod 32), or mod 64 for X', R3,
    `Only the low five (W) or six (X) bits of Rm are used. The preferred spelling is lsl Rd, Rn, Rm. ${W}`, `Writes Rd. ${NOFLAGS}`, 'lslv w0, w1, w2', ref('LSLV', 'LSL (register)'), regDemo),
  real('lsrv', 'Logical shift right by register', 'shift', 'data processing (2 source)', 'lsrv Rd, Rn, Rm', 'Rd = Rn >>u (Rm mod 32), or mod 64 for X, zeros shifted in', R3,
    `Only the low five (W) or six (X) bits of Rm are used. The preferred spelling is lsr Rd, Rn, Rm. ${W}`, `Writes Rd. ${NOFLAGS}`, 'lsrv w0, w1, w2', ref('LSRV', 'LSR (register)'), { regs: { w1: -64, w2: 4 } }),
  real('asrv', 'Arithmetic shift right by register', 'shift', 'data processing (2 source)', 'asrv Rd, Rn, Rm', 'Rd = Rn >>s (Rm mod 32), or mod 64 for X, sign bit shifted in', R3,
    `Only the low five (W) or six (X) bits of Rm are used. The preferred spelling is asr Rd, Rn, Rm. ${W}`, `Writes Rd. ${NOFLAGS}`, 'asrv w0, w1, w2', ref('ASRV', 'ASR (register)'), { regs: { w1: -64, w2: 4 } }),
  real('ubfm', 'Unsigned bitfield move', 'shift', 'bitfield', 'ubfm Rd, Rn, #immr, #imms',
    'if imms >= immr: Rd = bits imms to immr of Rn, at bit 0; otherwise Rd = bits imms to 0 of Rn, at bit (size - immr); the other bits are zero',
    'Rd, Rn: registers of one width; immr, imms: 0 to 31 (W) or 0 to 63 (X)', `The shifts by a constant are aliases: lsl by s is ubfm with immr = (size - s) mod size and imms = size - 1 - s; lsr by s is immr = s, imms = size - 1. ${W}`,
    `Writes Rd. ${NOFLAGS}`, 'ubfm w0, w1, #30, #29', ref('UBFM', 'LSL (immediate)', 'LSR (immediate)', 'UBFIZ', 'UBFX', 'UXTB', 'UXTH'), regDemo),
  real('sbfm', 'Signed bitfield move', 'shift', 'bitfield', 'sbfm Rd, Rn, #immr, #imms',
    'as ubfm, but the bits above the moved field are copies of its most significant bit',
    'Rd, Rn: registers of one width; immr, imms: 0 to 31 (W) or 0 to 63 (X)', `asr by s is sbfm with immr = s and imms = size - 1. ${W}`,
    `Writes Rd. ${NOFLAGS}`, 'sbfm w0, w1, #2, #31', ref('SBFM', 'ASR (immediate)', 'SBFIZ', 'SBFX', 'SXTB', 'SXTH', 'SXTW'), { regs: { w1: -64 } }),
  real('madd', 'Multiply and add', 'arithmetic', 'data processing (3 source)', 'madd Rd, Rn, Rm, Ra', 'Rd = Ra + Rn * Rm, low 32 (W) or 64 (X) bits',
    'Rd, Rn, Rm, Ra: registers of one width, or the zero register', `With Ra = 31 (zero register) the instruction is a multiplication, which gives the alias mul. ${W}`,
    `Writes Rd. ${NOFLAGS}`, 'madd w0, w1, w2, wzr', ref('MADD', 'MUL'), regDemo),
  real('msub', 'Multiply and subtract', 'arithmetic', 'data processing (3 source)', 'msub Rd, Rn, Rm, Ra', 'Rd = Ra - Rn * Rm, low 32 (W) or 64 (X) bits',
    'Rd, Rn, Rm, Ra: registers of one width, or the zero register', `With Ra = 31 (zero register) the result is the negated product, which gives the alias mneg. ${W}`,
    `Writes Rd. ${NOFLAGS}`, 'msub w0, w1, w2, wzr', ref('MSUB', 'MNEG'), regDemo),
  real('csel', 'Conditional select', 'compare', 'conditional select', 'csel Rd, Rn, Rm, cond', 'Rd = Rn if cond holds, else Rm',
    `${R3}; cond: eq, ne, hs (cs), lo (cc), mi, pl, vs, vc, hi, ls, ge, lt, gt, le, al, nv`, `The conditions al and nv always hold. ${W}`, 'Reads N, Z, C, V. Writes Rd.',
    'csel w0, w1, w2, eq', ref('CSEL'), { regs: { w1: 12, w2: 5 }, flags: { N: 0, Z: 1, C: 1, V: 0 } }),
  real('csinc', 'Conditional select increment', 'compare', 'conditional select', 'csinc Rd, Rn, Rm, cond', 'Rd = Rn if cond holds, else Rm + 1',
    `${R3}; cond: as for csel`, `With Rn = Rm = 31 (zero register) the result is 0 when cond holds and 1 otherwise, which gives the alias cset with the inverse condition. ${W}`,
    'Reads N, Z, C, V. Writes Rd.', 'csinc w0, wzr, wzr, ne', ref('CSINC', 'CSET', 'CINC'), { flags: { N: 0, Z: 1, C: 1, V: 0 } }),
  real('b', 'Branch', 'control', 'unconditional branch (immediate)', 'b target', 'pc = target', 'target within -134217728 to +134217724 bytes of the instruction, at a multiple of 4',
    'The offset is relative to the branch itself.', `No register changes. ${NOFLAGS}`, 'b 0x00400010', ref('B')),
  real('bl', 'Branch with link', 'control', 'unconditional branch (immediate)', 'bl target', 'x30 = pc + 4; pc = target', 'target within -134217728 to +134217724 bytes of the instruction, at a multiple of 4',
    'The return address goes to x30; memory is not accessed.', `Writes x30. ${NOFLAGS}`, 'bl 0x00400010', ref('BL')),
  real('b.cond', 'Conditional branch', 'control', 'conditional branch (immediate)', 'b.cond target', 'if cond holds then pc = target else pc = pc + 4',
    `cond: eq, ne, hs (cs), lo (cc), mi, pl, vs, vc, hi, ls, ge, lt, gt, le, al, nv; ${TARGET19}`,
    'eq: Z = 1. ne: Z = 0. hs: C = 1. lo: C = 0. mi: N = 1. pl: N = 0. vs: V = 1. vc: V = 0. hi: C = 1 and Z = 0. ls: C = 0 or Z = 1. ge: N = V. lt: N != V. gt: Z = 0 and N = V. le: Z = 1 or N != V. al and nv: always.',
    'Reads N, Z, C, V. No register changes.', 'b.eq 0x00400010', ref('B.cond'), brDemo),
  real('cbz', 'Compare and branch on zero', 'control', 'compare and branch (immediate)', 'cbz Rt, target', 'if Rt == 0 then pc = target else pc = pc + 4',
    `Rt: any W or X register, or the zero register; ${TARGET19}`, 'The W form tests the low 32 bits only. The flags are neither read nor written.', `No register changes. ${NOFLAGS}`,
    'cbz w0, 0x00400010', ref('CBZ'), brDemo),
  real('cbnz', 'Compare and branch on nonzero', 'control', 'compare and branch (immediate)', 'cbnz Rt, target', 'if Rt != 0 then pc = target else pc = pc + 4',
    `Rt: any W or X register, or the zero register; ${TARGET19}`, 'The W form tests the low 32 bits only. The flags are neither read nor written.', `No register changes. ${NOFLAGS}`,
    'cbnz w0, 0x00400010', ref('CBNZ'), brDemo),
  real('br', 'Branch to register', 'control', 'unconditional branch (register)', 'br Xn', 'pc = Xn', 'Xn: x0 to x30 or xzr',
    'An address that is not a multiple of 4 raises a PC alignment fault when the instruction at that address is fetched.', `No register changes. ${NOFLAGS}`, 'br x1', ref('BR'), { regs: { x1: 0x00400020 } }),
  real('blr', 'Branch with link to register', 'control', 'unconditional branch (register)', 'blr Xn', 'target = Xn; x30 = pc + 4; pc = target', 'Xn: x0 to x30 or xzr',
    'The target is read before x30 is written, so blr x30 jumps to the old value of x30.', `Writes x30. ${NOFLAGS}`, 'blr x1', ref('BLR'), { regs: { x1: 0x00400020 } }),
  real('ret', 'Return from subroutine', 'control', 'unconditional branch (register)', 'ret [Xn]', 'pc = Xn (x30 when omitted)', 'Xn: x0 to x30 or xzr; default x30',
    'Same effect as br; the separate encoding tells the processor that the branch is a subroutine return.', `No register changes. ${NOFLAGS}`, 'ret x30', ref('RET'), { regs: { x30: 0x00400020 } }),
  real('ldr', 'Load register', 'memory', 'load/store (unsigned offset or register offset)', 'ldr Rt, [Xn, #offset]  |  ldr Rt, [Xn, Rm, extend [#amount]]',
    'Rt = mem32[address] (W) or mem64[address] (X); address = Xn + offset, or Xn + (extended Rm << amount)',
    'Rt: W or X register, or the zero register; Xn: x0 to x30 or sp; offset: a multiple of 4 from 0 to 16380 (W) or of 8 from 0 to 32760 (X); extend: uxtw or sxtw with a W index, lsl or sxtx with an X index; amount: 0, or 2 (W) or 3 (X)',
    'Negative and unscaled offsets, pre-indexing, post-indexing, and literal addressing are outside the subset. The address need not be aligned.',
    `Reads four or eight bytes, least significant first. Writes Rt; a W load clears the upper 32 bits. ${NOFLAGS}`, 'ldr w0, [x1, w2, uxtw #2]', ref('LDR (immediate)', 'LDR (register)'), memDemo),
  real('str', 'Store register', 'memory', 'load/store (unsigned offset or register offset)', 'str Rt, [Xn, #offset]  |  str Rt, [Xn, Rm, extend [#amount]]',
    'mem32[address] = Rt (W) or mem64[address] = Rt (X); address as for ldr', 'as for ldr',
    'The code region is read-only in this environment. The address need not be aligned.', `Writes four or eight bytes, least significant first. No register changes. ${NOFLAGS}`,
    'str w0, [x1, #8]', ref('STR (immediate)', 'STR (register)'), memDemo),
  real('ldrb', 'Load byte', 'memory', 'load/store (unsigned offset or register offset)', 'ldrb Wt, [Xn, #offset]  |  ldrb Wt, [Xn, Rm, extend [#0]]', 'Wt = zero-extended mem8[address]',
    'Wt: W register or wzr; Xn: x0 to x30 or sp; offset: 0 to 4095; extend as for ldr, amount 0 only', 'The sign-extending load ldrsb is outside the subset.',
    `Reads one byte. Writes Wt and clears the upper 32 bits. ${NOFLAGS}`, 'ldrb w0, [x1, #11]', ref('LDRB (immediate)', 'LDRB (register)'), memDemo),
  real('ldrh', 'Load halfword', 'memory', 'load/store (unsigned offset or register offset)', 'ldrh Wt, [Xn, #offset]  |  ldrh Wt, [Xn, Rm, extend [#amount]]', 'Wt = zero-extended mem16[address]',
    'Wt: W register or wzr; Xn: x0 to x30 or sp; offset: an even number from 0 to 8190; extend as for ldr, amount 0 or 1', 'The sign-extending load ldrsh is outside the subset.',
    `Reads two bytes. Writes Wt and clears the upper 32 bits. ${NOFLAGS}`, 'ldrh w0, [x1, #8]', ref('LDRH (immediate)', 'LDRH (register)'), memDemo),
  real('strb', 'Store byte', 'memory', 'load/store (unsigned offset or register offset)', 'strb Wt, [Xn, #offset]  |  strb Wt, [Xn, Rm, extend [#0]]', 'mem8[address] = Wt[7:0]',
    'as for ldrb', 'The code region is read-only in this environment.', `Writes one byte. No register changes. ${NOFLAGS}`, 'strb w0, [x1, #8]', ref('STRB (immediate)', 'STRB (register)'), memDemo),
  real('strh', 'Store halfword', 'memory', 'load/store (unsigned offset or register offset)', 'strh Wt, [Xn, #offset]  |  strh Wt, [Xn, Rm, extend [#amount]]', 'mem16[address] = Wt[15:0]',
    'as for ldrh', 'The code region is read-only in this environment.', `Writes two bytes. No register changes. ${NOFLAGS}`, 'strh w0, [x1, #8]', ref('STRH (immediate)', 'STRH (register)'), memDemo),
  real('svc', 'Supervisor call', 'system', 'exception generation', 'svc #imm16', 'request a service from the execution environment', 'imm16: 0 to 65535',
    'In this environment w8 selects the service (1 print, 2 exit, 3 runtime error), w0 carries its argument, and the immediate is not examined. These are not Linux system calls. The exception entry of the architecture (saved program status and return address in system registers) is not modelled.',
    'No register changes.', 'svc #0', ref('SVC'), { regs: { w8: 1, w0: 42 } }),
  real('nop', 'No operation', 'system', 'hint', 'nop', 'pc = pc + 4', 'no operands', 'NOP is hint number 0; the other hints are outside the subset.', 'No register or flag changes.', 'nop', ref('NOP')),

  alias('mov', 'Move register or constant', 'move', 'mov Rd, Rm  |  mov Rd, #imm  |  mov Rd, sp',
    'orr Rd, zr, Rm for two general registers; add Rd, Rn, #0 when either is the stack pointer; for a constant, the first that fits of movz, movn, and orr Rd, zr, #imm',
    'mov w0, w1', ref('MOV (register)', 'MOV (to/from SP)', 'MOV (wide immediate)', 'MOV (inverted wide immediate)', 'MOV (bitmask immediate)'), regDemo),
  alias('mvn', 'Bitwise NOT', 'logic', 'mvn Rd, Rm [, shift #amount]', 'orn Rd, zr, Rm [, shift #amount]', 'mvn w0, w1', ref('MVN'), regDemo),
  alias('neg', 'Negate', 'arithmetic', 'neg Rd, Rm [, shift #amount]', 'sub Rd, zr, Rm [, shift #amount]', 'neg w0, w1', ref('NEG (shifted register)'), regDemo),
  alias('negs', 'Negate, setting flags', 'arithmetic', 'negs Rd, Rm [, shift #amount]', 'subs Rd, zr, Rm [, shift #amount]', 'negs w0, w1', ref('NEGS'), regDemo),
  alias('cmp', 'Compare', 'compare', 'cmp Rn, #imm [, lsl #12]  |  cmp Rn, Rm [, shift #amount]', 'subs zr, Rn, operand2 (the result is discarded; only the flags change)',
    'cmp w1, w2', ref('CMP (immediate)', 'CMP (shifted register)'), flagDemo),
  alias('cmn', 'Compare negative', 'compare', 'cmn Rn, #imm [, lsl #12]  |  cmn Rn, Rm [, shift #amount]', 'adds zr, Rn, operand2 (the result is discarded; only the flags change)',
    'cmn w1, #5', ref('CMN (immediate)', 'CMN (shifted register)'), { regs: { w1: -5 } }),
  alias('tst', 'Test bits', 'compare', 'tst Rn, #imm  |  tst Rn, Rm [, shift #amount]', 'ands zr, Rn, operand2 (the result is discarded; only the flags change)',
    'tst w1, #0xf', ref('TST (immediate)', 'TST (shifted register)'), regDemo),
  alias('mul', 'Multiply', 'arithmetic', 'mul Rd, Rn, Rm', 'madd Rd, Rn, Rm, zr', 'mul w0, w1, w2', ref('MUL'), regDemo),
  alias('mneg', 'Multiply and negate', 'arithmetic', 'mneg Rd, Rn, Rm', 'msub Rd, Rn, Rm, zr', 'mneg w0, w1, w2', ref('MNEG'), regDemo),
  alias('lsl', 'Logical shift left', 'shift', 'lsl Rd, Rn, #shift  |  lsl Rd, Rn, Rm', 'ubfm Rd, Rn, #((size - shift) mod size), #(size - 1 - shift) for a constant; lslv Rd, Rn, Rm for a register',
    'lsl w0, w1, #2', ref('LSL (immediate)', 'LSL (register)'), regDemo),
  alias('lsr', 'Logical shift right', 'shift', 'lsr Rd, Rn, #shift  |  lsr Rd, Rn, Rm', 'ubfm Rd, Rn, #shift, #(size - 1) for a constant; lsrv Rd, Rn, Rm for a register',
    'lsr w0, w1, #2', ref('LSR (immediate)', 'LSR (register)'), { regs: { w1: -64 } }),
  alias('asr', 'Arithmetic shift right', 'shift', 'asr Rd, Rn, #shift  |  asr Rd, Rn, Rm', 'sbfm Rd, Rn, #shift, #(size - 1) for a constant; asrv Rd, Rn, Rm for a register',
    'asr w0, w1, #2', ref('ASR (immediate)', 'ASR (register)'), { regs: { w1: -64 } }),
  alias('cset', 'Conditional set', 'compare', 'cset Rd, cond', 'csinc Rd, zr, zr, inverse of cond (Rd = 1 when cond holds, else 0)', 'cset w0, eq', ref('CSET'), { flags: { N: 0, Z: 1, C: 1, V: 0 } }),
  alias('cinc', 'Conditional increment', 'compare', 'cinc Rd, Rn, cond', 'csinc Rd, Rn, Rn, inverse of cond (Rd = Rn + 1 when cond holds, else Rn)', 'cinc w0, w1, eq', ref('CINC'),
    { regs: { w1: 12 }, flags: { N: 0, Z: 1, C: 1, V: 0 } }),
  alias('ubfiz', 'Unsigned bitfield insert in zeros', 'shift', 'ubfiz Rd, Rn, #lsb, #width', 'ubfm Rd, Rn, #((size - lsb) mod size), #(width - 1)', 'ubfiz w0, w1, #4, #8', ref('UBFIZ'), regDemo),
  alias('ubfx', 'Unsigned bitfield extract', 'shift', 'ubfx Rd, Rn, #lsb, #width', 'ubfm Rd, Rn, #lsb, #(lsb + width - 1)', 'ubfx w0, w1, #2, #4', ref('UBFX'), regDemo),
  alias('sbfiz', 'Signed bitfield insert in zeros', 'shift', 'sbfiz Rd, Rn, #lsb, #width', 'sbfm Rd, Rn, #((size - lsb) mod size), #(width - 1)', 'sbfiz w0, w1, #4, #8', ref('SBFIZ'), regDemo),
  alias('sbfx', 'Signed bitfield extract', 'shift', 'sbfx Rd, Rn, #lsb, #width', 'sbfm Rd, Rn, #lsb, #(lsb + width - 1)', 'sbfx w0, w1, #2, #4', ref('SBFX'), regDemo),
  alias('uxtb', 'Zero-extend byte', 'move', 'uxtb Wd, Wn', 'ubfm Wd, Wn, #0, #7', 'uxtb w0, w1', ref('UXTB'), { regs: { w1: 0x1234 } }),
  alias('uxth', 'Zero-extend halfword', 'move', 'uxth Wd, Wn', 'ubfm Wd, Wn, #0, #15', 'uxth w0, w1', ref('UXTH'), { regs: { w1: 0x12345678 } }),
  alias('sxtb', 'Sign-extend byte', 'move', 'sxtb Rd, Wn', 'sbfm Rd, Rn, #0, #7', 'sxtb w0, w1', ref('SXTB'), { regs: { w1: 0x80 } }),
  alias('sxth', 'Sign-extend halfword', 'move', 'sxth Rd, Wn', 'sbfm Rd, Rn, #0, #15', 'sxth w0, w1', ref('SXTH'), { regs: { w1: 0x8000 } }),
  alias('sxtw', 'Sign-extend word', 'move', 'sxtw Xd, Wn', 'sbfm Xd, Xn, #0, #31', 'sxtw x0, w1', ref('SXTW'), { regs: { w1: -2 } }),
];

/** Equivalent sequences for the operations compared across targets. */
export const OPERATIONS: OperationExample[] = [
  { key: 'add-registers', assembly: ['add w0, w1, w2'], notes: 'Three-operand form. The flags change only when the flag-setting variant adds is used.' },
  { key: 'add-constant', assembly: ['add w0, w1, #100'], notes: 'The constant is a 12-bit unsigned field, optionally shifted left by 12. A negative constant is added with sub.' },
  { key: 'load-constant-32', assembly: ['movz w0, #0x5678', 'movk w0, #0x1234, lsl #16'], notes: 'A general 32-bit constant needs two instructions, 16 bits each. Constants with one nonzero 16-bit half, their complements, and bitmask patterns need one.' },
  { key: 'subtract-registers', assembly: ['sub w0, w1, w2'], notes: 'A subtract-immediate form exists as well, with the same 12-bit field as add.' },
  { key: 'multiply', assembly: ['madd w0, w1, w2, wzr'], notes: 'One instruction, written mul w0, w1, w2: multiply-add with the zero register as the addend.' },
  { key: 'shift-left-constant', assembly: ['ubfm w0, w1, #29, #28'], notes: 'Written lsl w0, w1, #3. A shift by a constant is a case of the bitfield move instruction.' },
  { key: 'shift-right-arithmetic', assembly: ['asrv w0, w1, w2'], notes: 'Written asr w0, w1, w2. Only the low five bits of the count register are used in the 32-bit form.' },
  { key: 'bitwise-and-constant', assembly: ['and w0, w1, #0xff'], notes: 'The constant must be a bitmask immediate: a rotated run of ones, repeated across the register. Other masks are loaded into a register first.' },
  { key: 'compare-set', assembly: ['subs wzr, w1, w2', 'csinc w0, wzr, wzr, ge'], notes: 'Written cmp w1, w2 and cset w0, lt. The comparison sets the flags; the conditional select turns a condition into 0 or 1.' },
  { key: 'branch-less-than', assembly: ['subs wzr, w1, w2', 'b.lt target'], notes: 'Written cmp w1, w2 and b.lt target. Compare and branch are two instructions that communicate through the flags.' },
  { key: 'branch-equal-zero', assembly: ['cbz w0, target'], notes: 'Compare-and-branch against zero is one instruction and does not use the flags.' },
  { key: 'load-array-element', assembly: ['movz x17, #0x1000, lsl #16', 'ldr w0, [x17, w1, uxtw #2]'], notes: 'The address of the array is loaded into a register; the load adds the index, zero-extended and multiplied by four, in its addressing mode.' },
  { key: 'store-array-element', assembly: ['movz x17, #0x1000, lsl #16', 'str w0, [x17, w1, uxtw #2]'], notes: 'As for the load, with str.' },
  { key: 'call-return', assembly: ['bl target', 'ret x30'], notes: 'The return address goes to the link register x30; memory is not touched. The callee returns with ret, a branch to x30.' },
  { key: 'service-call', assembly: ['movz w8, #0x1', 'svc #0'], notes: 'The service number is passed in w8 and the argument in w0.' },
];
