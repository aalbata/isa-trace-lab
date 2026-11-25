/**
 * Instruction catalog of the RV32I profile: one entry per implemented
 * instruction and per accepted pseudoinstruction, with syntax, semantics,
 * operand ranges, and a worked example. The explanations are written for this
 * project; the cited sections of the specification are the normative source.
 */
import type { InsnGroup, InsnSpec, OperationExample } from '../types.ts';

const UNPRIV = 'RISC-V Unprivileged ISA (Version 20260120), RV32I';
const COMPUTATIONAL = `${UNPRIV}, Section 2.4 "Integer Computational Instructions"`;
const CONTROL = `${UNPRIV}, Section 2.5 "Control Transfer Instructions"`;
const LOADSTORE = `${UNPRIV}, Section 2.6 "Load and Store Instructions"`;
const ENVIRONMENT = `${UNPRIV}, Section 2.8 "Environment Call and Breakpoints"`;
const ASM = 'RISC-V Assembly Programmer\'s Manual, "A listing of standard RISC-V pseudoinstructions"';

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

const pseudo = (mnemonic: string, title: string, group: InsnGroup, syntax: string, expansion: string, example: string, demo?: InsnSpec['demo']): InsnSpec => {
  const s: InsnSpec = {
    mnemonic, title, group, format: 'pseudo', syntax, semantics: `Assembler shorthand for: ${expansion}`,
    operands: 'as for the instructions of the expansion', restrictions: 'not a machine instruction; the assembler emits the expansion',
    effects: 'as for the instructions of the expansion', example, reference: ASM,
    encode: true, decode: false, simulate: true, pseudo: true, expansion,
  };
  if (demo) s.demo = demo;
  return s;
};

const NO_FLAGS = 'RV32I has no condition flags.';
const R3 = 'rd, rs1, rs2: any of x0 to x31';
const I12 = 'rd, rs1: any register; imm: -2048 to 2047 (12 bits, sign-extended)';
const SH5 = 'rd, rs1: any register; shamt: 0 to 31';
const BR = 'rs1, rs2: any register; target within -4096 to +4094 bytes of the instruction, at an even offset';
const MEMOP = 'rd or rs2: any register; offset: -2048 to 2047; base rs1: any register';

const regDemo = { regs: { a1: 12, a2: 5 } };
const brDemo = { regs: { a0: 3, a1: 7 } };
const memDemo = { regs: { a0: 0x11223344, a1: 0x10000000 }, mem: [{ address: 0x10000008, value: 0x80c0ffee | 0 }] };

export const INSTRUCTIONS: InsnSpec[] = [
  real('add', 'Add', 'arithmetic', 'R', 'add rd, rs1, rs2', 'rd = (rs1 + rs2) mod 2^32', R3,
    'Overflow is ignored; no exception is raised.', `Writes rd. ${NO_FLAGS}`, 'add a0, a1, a2', COMPUTATIONAL, regDemo),
  real('sub', 'Subtract', 'arithmetic', 'R', 'sub rd, rs1, rs2', 'rd = (rs1 - rs2) mod 2^32', R3,
    'Overflow is ignored. There is no subtract-immediate; use addi with a negative immediate.', `Writes rd. ${NO_FLAGS}`, 'sub a0, a1, a2', COMPUTATIONAL, regDemo),
  real('addi', 'Add immediate', 'arithmetic', 'I', 'addi rd, rs1, imm', 'rd = (rs1 + sext(imm)) mod 2^32', I12,
    'The immediate is sign-extended from 12 bits. Larger constants need lui followed by addi.', `Writes rd. ${NO_FLAGS}`, 'addi a0, a1, -3', COMPUTATIONAL, regDemo),
  real('lui', 'Load upper immediate', 'move', 'U', 'lui rd, imm20', 'rd = imm20 << 12', 'rd: any register; imm20: 0 to 1048575 (20 bits)',
    'The low 12 bits of rd become zero.', `Writes rd. ${NO_FLAGS}`, 'lui a0, 0x12345', COMPUTATIONAL),
  real('auipc', 'Add upper immediate to pc', 'move', 'U', 'auipc rd, imm20', 'rd = pc + (imm20 << 12)', 'rd: any register; imm20: 0 to 1048575 (20 bits)',
    'pc is the address of the auipc instruction itself.', `Writes rd. ${NO_FLAGS}`, 'auipc a0, 1', COMPUTATIONAL),
  real('and', 'Bitwise AND', 'logic', 'R', 'and rd, rs1, rs2', 'rd = rs1 & rs2', R3, 'None.', `Writes rd. ${NO_FLAGS}`, 'and a0, a1, a2', COMPUTATIONAL, regDemo),
  real('or', 'Bitwise OR', 'logic', 'R', 'or rd, rs1, rs2', 'rd = rs1 | rs2', R3, 'None.', `Writes rd. ${NO_FLAGS}`, 'or a0, a1, a2', COMPUTATIONAL, regDemo),
  real('xor', 'Bitwise exclusive OR', 'logic', 'R', 'xor rd, rs1, rs2', 'rd = rs1 ^ rs2', R3, 'None.', `Writes rd. ${NO_FLAGS}`, 'xor a0, a1, a2', COMPUTATIONAL, regDemo),
  real('andi', 'AND immediate', 'logic', 'I', 'andi rd, rs1, imm', 'rd = rs1 & sext(imm)', I12,
    'The immediate is sign-extended, so a negative immediate has all upper bits set.', `Writes rd. ${NO_FLAGS}`, 'andi a0, a1, 7', COMPUTATIONAL, regDemo),
  real('ori', 'OR immediate', 'logic', 'I', 'ori rd, rs1, imm', 'rd = rs1 | sext(imm)', I12, 'The immediate is sign-extended.', `Writes rd. ${NO_FLAGS}`, 'ori a0, a1, 0x30', COMPUTATIONAL, regDemo),
  real('xori', 'XOR immediate', 'logic', 'I', 'xori rd, rs1, imm', 'rd = rs1 ^ sext(imm)', I12,
    'xori rd, rs1, -1 complements every bit (the pseudoinstruction not).', `Writes rd. ${NO_FLAGS}`, 'xori a0, a1, -1', COMPUTATIONAL, regDemo),
  real('sll', 'Shift left logical', 'shift', 'R', 'sll rd, rs1, rs2', 'rd = rs1 << (rs2 & 31)', R3,
    'Only the low five bits of rs2 are used as the shift amount.', `Writes rd. ${NO_FLAGS}`, 'sll a0, a1, a2', COMPUTATIONAL, regDemo),
  real('srl', 'Shift right logical', 'shift', 'R', 'srl rd, rs1, rs2', 'rd = rs1 >>u (rs2 & 31), zeros shifted in', R3,
    'Only the low five bits of rs2 are used as the shift amount.', `Writes rd. ${NO_FLAGS}`, 'srl a0, a1, a2', COMPUTATIONAL, { regs: { a1: -64, a2: 4 } }),
  real('sra', 'Shift right arithmetic', 'shift', 'R', 'sra rd, rs1, rs2', 'rd = rs1 >>s (rs2 & 31), sign bit shifted in', R3,
    'Only the low five bits of rs2 are used as the shift amount.', `Writes rd. ${NO_FLAGS}`, 'sra a0, a1, a2', COMPUTATIONAL, { regs: { a1: -64, a2: 4 } }),
  real('slli', 'Shift left logical immediate', 'shift', 'I (shift)', 'slli rd, rs1, shamt', 'rd = rs1 << shamt', SH5,
    'The upper seven bits of the immediate field must be 0000000.', `Writes rd. ${NO_FLAGS}`, 'slli a0, a1, 2', COMPUTATIONAL, regDemo),
  real('srli', 'Shift right logical immediate', 'shift', 'I (shift)', 'srli rd, rs1, shamt', 'rd = rs1 >>u shamt', SH5,
    'The upper seven bits of the immediate field must be 0000000.', `Writes rd. ${NO_FLAGS}`, 'srli a0, a1, 2', COMPUTATIONAL, { regs: { a1: -64 } }),
  real('srai', 'Shift right arithmetic immediate', 'shift', 'I (shift)', 'srai rd, rs1, shamt', 'rd = rs1 >>s shamt', SH5,
    'The upper seven bits of the immediate field must be 0100000.', `Writes rd. ${NO_FLAGS}`, 'srai a0, a1, 2', COMPUTATIONAL, { regs: { a1: -64 } }),
  real('slt', 'Set if less than (signed)', 'compare', 'R', 'slt rd, rs1, rs2', 'rd = 1 if rs1 <s rs2 else 0', R3, 'Signed comparison.', `Writes rd with 0 or 1. ${NO_FLAGS}`, 'slt a0, a1, a2', COMPUTATIONAL, { regs: { a1: -1, a2: 5 } }),
  real('sltu', 'Set if less than (unsigned)', 'compare', 'R', 'sltu rd, rs1, rs2', 'rd = 1 if rs1 <u rs2 else 0', R3,
    'Unsigned comparison. sltu rd, x0, rs2 sets rd when rs2 is nonzero (snez).', `Writes rd with 0 or 1. ${NO_FLAGS}`, 'sltu a0, a1, a2', COMPUTATIONAL, { regs: { a1: -1, a2: 5 } }),
  real('slti', 'Set if less than immediate (signed)', 'compare', 'I', 'slti rd, rs1, imm', 'rd = 1 if rs1 <s sext(imm) else 0', I12, 'Signed comparison.', `Writes rd with 0 or 1. ${NO_FLAGS}`, 'slti a0, a1, 20', COMPUTATIONAL, regDemo),
  real('sltiu', 'Set if less than immediate (unsigned)', 'compare', 'I', 'sltiu rd, rs1, imm', 'rd = 1 if rs1 <u sext(imm) else 0', I12,
    'The immediate is sign-extended first and then compared as unsigned. sltiu rd, rs1, 1 sets rd when rs1 is zero (seqz).', `Writes rd with 0 or 1. ${NO_FLAGS}`, 'sltiu a0, a1, 1', COMPUTATIONAL, regDemo),
  real('lw', 'Load word', 'memory', 'I', 'lw rd, offset(rs1)', 'rd = mem32[rs1 + sext(offset)]', MEMOP,
    'This environment requires the address to be a multiple of 4.', `Reads four bytes, least significant first. Writes rd. ${NO_FLAGS}`, 'lw a0, 8(a1)', LOADSTORE, memDemo),
  real('lh', 'Load halfword (signed)', 'memory', 'I', 'lh rd, offset(rs1)', 'rd = sext(mem16[rs1 + sext(offset)])', MEMOP,
    'This environment requires an even address.', `Reads two bytes and sign-extends. Writes rd. ${NO_FLAGS}`, 'lh a0, 8(a1)', LOADSTORE, memDemo),
  real('lhu', 'Load halfword (unsigned)', 'memory', 'I', 'lhu rd, offset(rs1)', 'rd = zext(mem16[rs1 + sext(offset)])', MEMOP,
    'This environment requires an even address.', `Reads two bytes and zero-extends. Writes rd. ${NO_FLAGS}`, 'lhu a0, 8(a1)', LOADSTORE, memDemo),
  real('lb', 'Load byte (signed)', 'memory', 'I', 'lb rd, offset(rs1)', 'rd = sext(mem8[rs1 + sext(offset)])', MEMOP, 'None.', `Reads one byte and sign-extends. Writes rd. ${NO_FLAGS}`, 'lb a0, 11(a1)', LOADSTORE, memDemo),
  real('lbu', 'Load byte (unsigned)', 'memory', 'I', 'lbu rd, offset(rs1)', 'rd = zext(mem8[rs1 + sext(offset)])', MEMOP, 'None.', `Reads one byte and zero-extends. Writes rd. ${NO_FLAGS}`, 'lbu a0, 11(a1)', LOADSTORE, memDemo),
  real('sw', 'Store word', 'memory', 'S', 'sw rs2, offset(rs1)', 'mem32[rs1 + sext(offset)] = rs2', MEMOP,
    'This environment requires the address to be a multiple of 4. The code region is read-only.', `Writes four bytes, least significant first. No register changes. ${NO_FLAGS}`, 'sw a0, 8(a1)', LOADSTORE, memDemo),
  real('sh', 'Store halfword', 'memory', 'S', 'sh rs2, offset(rs1)', 'mem16[rs1 + sext(offset)] = rs2[15:0]', MEMOP,
    'This environment requires an even address.', `Writes two bytes. No register changes. ${NO_FLAGS}`, 'sh a0, 8(a1)', LOADSTORE, memDemo),
  real('sb', 'Store byte', 'memory', 'S', 'sb rs2, offset(rs1)', 'mem8[rs1 + sext(offset)] = rs2[7:0]', MEMOP, 'None.', `Writes one byte. No register changes. ${NO_FLAGS}`, 'sb a0, 8(a1)', LOADSTORE, memDemo),
  real('beq', 'Branch if equal', 'control', 'B', 'beq rs1, rs2, target', 'if rs1 == rs2 then pc = target else pc = pc + 4', BR,
    'The offset is relative to the branch itself. A taken branch to an address that is not a multiple of 4 faults.', `No register changes. ${NO_FLAGS}`, 'beq a0, a1, 0x00400010', CONTROL, brDemo),
  real('bne', 'Branch if not equal', 'control', 'B', 'bne rs1, rs2, target', 'if rs1 != rs2 then pc = target else pc = pc + 4', BR,
    'The offset is relative to the branch itself.', `No register changes. ${NO_FLAGS}`, 'bne a0, a1, 0x00400010', CONTROL, brDemo),
  real('blt', 'Branch if less than (signed)', 'control', 'B', 'blt rs1, rs2, target', 'if rs1 <s rs2 then pc = target else pc = pc + 4', BR,
    'Signed comparison. There is no bgt instruction; swap the operands.', `No register changes. ${NO_FLAGS}`, 'blt a0, a1, 0x00400010', CONTROL, brDemo),
  real('bge', 'Branch if greater or equal (signed)', 'control', 'B', 'bge rs1, rs2, target', 'if rs1 >=s rs2 then pc = target else pc = pc + 4', BR,
    'Signed comparison. There is no ble instruction; swap the operands.', `No register changes. ${NO_FLAGS}`, 'bge a0, a1, 0x00400010', CONTROL, brDemo),
  real('bltu', 'Branch if less than (unsigned)', 'control', 'B', 'bltu rs1, rs2, target', 'if rs1 <u rs2 then pc = target else pc = pc + 4', BR,
    'Unsigned comparison.', `No register changes. ${NO_FLAGS}`, 'bltu a0, a1, 0x00400010', CONTROL, brDemo),
  real('bgeu', 'Branch if greater or equal (unsigned)', 'control', 'B', 'bgeu rs1, rs2, target', 'if rs1 >=u rs2 then pc = target else pc = pc + 4', BR,
    'Unsigned comparison. One bgeu against the length checks an array index for both negative and too-large values.', `No register changes. ${NO_FLAGS}`, 'bgeu a0, a1, 0x00400010', CONTROL, brDemo),
  real('jal', 'Jump and link', 'control', 'J', 'jal rd, target', 'rd = pc + 4; pc = target', 'rd: any register; target within -1048576 to +1048574 bytes, at an even offset',
    'With rd = x0 the return address is discarded (the pseudoinstruction j).', `Writes rd with the address of the next instruction. ${NO_FLAGS}`, 'jal ra, 0x00400010', CONTROL),
  real('jalr', 'Jump and link register', 'control', 'I', 'jalr rd, offset(rs1)', 'target = (rs1 + sext(offset)) with bit 0 cleared; rd = pc + 4; pc = target', 'rd, rs1: any register; offset: -2048 to 2047',
    'The least significant bit of the computed address is cleared. The target is computed from rs1 before rd is written, so jalr ra, 0(ra) jumps to the old value of ra. jalr x0, 0(ra) returns from a call (ret).', `Writes rd with the address of the next instruction. ${NO_FLAGS}`, 'jalr zero, 0(ra)', CONTROL, { regs: { ra: 0x00400020 } }),
  real('ecall', 'Environment call', 'system', 'I', 'ecall', 'request a service from the execution environment', 'no operands',
    'In this environment a7 selects the service (1 print, 2 exit, 3 runtime error) and a0 carries its argument. These are not Linux system calls.', 'No register changes.', 'ecall', ENVIRONMENT, { regs: { a7: 1, a0: 42 } }),

  pseudo('nop', 'No operation', 'move', 'nop', 'addi x0, x0, 0', 'nop'),
  pseudo('li', 'Load immediate', 'move', 'li rd, imm', 'addi rd, x0, imm when imm fits in 12 signed bits; otherwise lui rd, hi followed by addi rd, rd, lo when lo is nonzero', 'li a0, 100000'),
  pseudo('mv', 'Copy register', 'move', 'mv rd, rs', 'addi rd, rs, 0', 'mv a0, a1', regDemo),
  pseudo('not', 'Bitwise complement', 'logic', 'not rd, rs', 'xori rd, rs, -1', 'not a0, a1', regDemo),
  pseudo('neg', 'Negate', 'arithmetic', 'neg rd, rs', 'sub rd, x0, rs', 'neg a0, a1', regDemo),
  pseudo('seqz', 'Set if zero', 'compare', 'seqz rd, rs', 'sltiu rd, rs, 1', 'seqz a0, a1', regDemo),
  pseudo('snez', 'Set if not zero', 'compare', 'snez rd, rs', 'sltu rd, x0, rs', 'snez a0, a1', regDemo),
  pseudo('sltz', 'Set if negative', 'compare', 'sltz rd, rs', 'slt rd, rs, x0', 'sltz a0, a1', regDemo),
  pseudo('sgtz', 'Set if positive', 'compare', 'sgtz rd, rs', 'slt rd, x0, rs', 'sgtz a0, a1', regDemo),
  pseudo('beqz', 'Branch if zero', 'control', 'beqz rs, target', 'beq rs, x0, target', 'beqz a0, 0x00400010', brDemo),
  pseudo('bnez', 'Branch if not zero', 'control', 'bnez rs, target', 'bne rs, x0, target', 'bnez a0, 0x00400010', brDemo),
  pseudo('bgez', 'Branch if not negative', 'control', 'bgez rs, target', 'bge rs, x0, target', 'bgez a0, 0x00400010', brDemo),
  pseudo('bltz', 'Branch if negative', 'control', 'bltz rs, target', 'blt rs, x0, target', 'bltz a0, 0x00400010', brDemo),
  pseudo('blez', 'Branch if not positive', 'control', 'blez rs, target', 'bge x0, rs, target', 'blez a0, 0x00400010', brDemo),
  pseudo('bgtz', 'Branch if positive', 'control', 'bgtz rs, target', 'blt x0, rs, target', 'bgtz a0, 0x00400010', brDemo),
  pseudo('bgt', 'Branch if greater than (signed)', 'control', 'bgt rs, rt, target', 'blt rt, rs, target', 'bgt a0, a1, 0x00400010', brDemo),
  pseudo('ble', 'Branch if less or equal (signed)', 'control', 'ble rs, rt, target', 'bge rt, rs, target', 'ble a0, a1, 0x00400010', brDemo),
  pseudo('bgtu', 'Branch if greater than (unsigned)', 'control', 'bgtu rs, rt, target', 'bltu rt, rs, target', 'bgtu a0, a1, 0x00400010', brDemo),
  pseudo('bleu', 'Branch if less or equal (unsigned)', 'control', 'bleu rs, rt, target', 'bgeu rt, rs, target', 'bleu a0, a1, 0x00400010', brDemo),
  pseudo('j', 'Jump', 'control', 'j target', 'jal x0, target', 'j 0x00400010'),
  pseudo('jr', 'Jump to register', 'control', 'jr rs', 'jalr x0, 0(rs)', 'jr ra', { regs: { ra: 0x00400020 } }),
  pseudo('ret', 'Return from call', 'control', 'ret', 'jalr x0, 0(ra)', 'ret', { regs: { ra: 0x00400020 } }),
];

/** Equivalent sequences for the operations compared across targets. */
export const OPERATIONS: OperationExample[] = [
  { key: 'add-registers', assembly: ['add a0, a1, a2'], notes: 'Three-operand form: the destination is separate from both sources. No flags exist, so nothing else changes.' },
  { key: 'add-constant', assembly: ['addi a0, a1, 100'], notes: 'The constant is a 12-bit signed field of the instruction.' },
  { key: 'load-constant-32', assembly: ['lui a0, 0x12345', 'addi a0, a0, 0x678'], notes: 'A 32-bit constant needs two instructions: the upper 20 bits, then the lower 12. When bit 11 of the constant is set, the upper part is increased by one because addi sign-extends.' },
  { key: 'subtract-registers', assembly: ['sub a0, a1, a2'], notes: 'There is no subtract-immediate; addi with a negative constant is used instead.' },
  { key: 'multiply', assembly: ['mv a0, a1', 'mv a1, a2', 'jal ra, __mul'], notes: 'RV32I has no multiply instruction (it belongs to the M extension). The compiler calls a shift-and-add helper of nine instructions that loops once per bit of the multiplier.' },
  { key: 'shift-left-constant', assembly: ['slli a0, a1, 3'], notes: 'The shift amount is a 5-bit field.' },
  { key: 'shift-right-arithmetic', assembly: ['sra a0, a1, a2'], notes: 'Only the low five bits of the count register are used.' },
  { key: 'bitwise-and-constant', assembly: ['andi a0, a1, 0xff'], notes: 'The immediate is sign-extended from 12 bits, so masks up to 0x7ff fit directly.' },
  { key: 'compare-set', assembly: ['slt a0, a1, a2'], notes: 'A comparison result is produced directly in a register as 0 or 1.' },
  { key: 'branch-less-than', assembly: ['blt a1, a2, target'], notes: 'Compare and branch are one instruction; no flags are involved.' },
  { key: 'branch-equal-zero', assembly: ['beq a0, zero, target'], notes: 'Comparison with zero uses the hard-wired zero register.' },
  { key: 'load-array-element', assembly: ['slli t5, a1, 2', 'add t5, t5, gp', 'lw a0, 0(t5)'], notes: 'The address is computed explicitly: index times four plus the base. A load accepts only base plus constant offset.' },
  { key: 'store-array-element', assembly: ['slli t5, a1, 2', 'add t5, t5, gp', 'sw a0, 0(t5)'], notes: 'As for the load, with sw.' },
  { key: 'call-return', assembly: ['jal ra, target', 'jalr zero, 0(ra)'], notes: 'The return address goes to the link register ra; memory is not touched. The callee returns with jalr through ra.' },
  { key: 'service-call', assembly: ['addi a7, zero, 1', 'ecall'], notes: 'The service number is passed in a7 and the argument in a0.' },
];
