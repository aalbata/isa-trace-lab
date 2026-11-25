/**
 * Instruction catalog of the MIPS32 Release 2 profile: one entry per
 * implemented instruction and per accepted pseudoinstruction, with syntax,
 * semantics, operand ranges, and a worked example. The explanations are
 * written for this project; the cited instruction pages of the manual are the
 * normative source.
 */
import type { InsnGroup, InsnSpec, OperationExample } from '../types.ts';

const MANUAL = 'MIPS32 Instruction Set Manual (MD00086, Revision 6.06), Section 3.2 "Alphabetical List of Instructions"';
/** Reference to the page of one instruction; the manual orders the pages by mnemonic. */
const page = (title: string): string => `${MANUAL}, page of ${title.split(' ')[0]}`;
const ASM = 'Assembler shorthand as expanded by Clang\'s integrated assembler; see the instruction pages of the expansion in the MIPS32 Instruction Set Manual (MD00086, Revision 6.06)';

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

const pseudo = (mnemonic: string, title: string, group: InsnGroup, syntax: string, expansion: string, restrictions: string, example: string, demo?: InsnSpec['demo']): InsnSpec => {
  const s: InsnSpec = {
    mnemonic, title, group, format: 'pseudo', syntax, semantics: `Assembler shorthand for: ${expansion}`,
    operands: 'as for the instructions of the expansion', restrictions,
    effects: 'as for the instructions of the expansion', example, reference: ASM,
    encode: true, decode: false, simulate: true, pseudo: true, expansion,
  };
  if (demo) s.demo = demo;
  return s;
};

const NO_FLAGS = 'MIPS32 has no condition flags.';
const NOT_MACHINE = 'Not a machine instruction; the assembler emits the expansion.';
const R3 = 'rd, rs, rt: any of $0 to $31';
const I16 = 'rt, rs: any register; imm: -32768 to 32767 (16 bits, sign-extended)';
const U16 = 'rt, rs: any register; imm: 0 to 65535 (16 bits, zero-extended)';
const SH5 = 'rd, rt: any register; sa: 0 to 31';
const SHV = 'rd, rt, rs: any register';
const MEMOP = 'rt: any register; offset: -32768 to 32767; base: any register';
const BR = 'target within -131072 to +131068 bytes of the delay slot, at a multiple of 4';
const DELAY = 'The next instruction (the delay slot) executes before control moves to the target. A branch or jump in the delay slot is UNPREDICTABLE; this simulator stops with a fault.';
const DELAY_COND = 'The next instruction (the delay slot) executes whether or not the branch is taken. A branch or jump in the delay slot is UNPREDICTABLE; this simulator stops with a fault.';
const OVERFLOW = 'If the exact result is outside the signed 32-bit range, the Integer Overflow exception occurs and the destination is not modified; this simulator stops with a fault. The compiler never generates this instruction.';
const WRAP = 'The result wraps modulo 2^32; no exception occurs. Despite the name, the operands are not treated as unsigned.';

const regDemo = { regs: { $t1: 12, $t2: 5 } };
const shiftDemo = { regs: { $t1: -64, $t2: 4 } };
const brDemo = { regs: { $t0: 3, $t1: 7 } };
const memDemo = { regs: { $t0: 0x11223344, $t1: 0x10000000 }, mem: [{ address: 0x10000008, value: 0x80c0ffee | 0 }] };
const jumpDemo = { regs: { $ra: 0x00400020, $t9: 0x00400020 } };

export const INSTRUCTIONS: InsnSpec[] = [
  real('addu', 'Add without overflow exception', 'arithmetic', 'R', 'addu rd, rs, rt', 'rd = (rs + rt) mod 2^32', R3,
    WRAP, `Writes rd. ${NO_FLAGS}`, 'addu $t0, $t1, $t2', page('ADDU Add Unsigned Word'), regDemo),
  real('addiu', 'Add immediate without overflow exception', 'arithmetic', 'I', 'addiu rt, rs, imm', 'rt = (rs + sext(imm)) mod 2^32', I16,
    `${WRAP} The immediate is sign-extended, so addiu also subtracts. Larger constants need lui followed by ori.`, `Writes rt. ${NO_FLAGS}`, 'addiu $t0, $t1, -3', page('ADDIU Add Immediate Unsigned Word'), regDemo),
  real('subu', 'Subtract without overflow exception', 'arithmetic', 'R', 'subu rd, rs, rt', 'rd = (rs - rt) mod 2^32', R3,
    `${WRAP} There is no subtract-immediate; use addiu with a negative immediate.`, `Writes rd. ${NO_FLAGS}`, 'subu $t0, $t1, $t2', page('SUBU Subtract Unsigned Word'), regDemo),
  real('add', 'Add with overflow exception', 'arithmetic', 'R', 'add rd, rs, rt', 'rd = rs + rt, when the sum is representable in 32 signed bits', R3,
    OVERFLOW, `Writes rd unless the exception occurs. ${NO_FLAGS}`, 'add $t0, $t1, $t2', page('ADD Add Word'), regDemo),
  real('addi', 'Add immediate with overflow exception', 'arithmetic', 'I', 'addi rt, rs, imm', 'rt = rs + sext(imm), when the sum is representable in 32 signed bits', I16,
    OVERFLOW, `Writes rt unless the exception occurs. ${NO_FLAGS}`, 'addi $t0, $t1, -3', page('ADDI Add Immediate Word'), regDemo),
  real('sub', 'Subtract with overflow exception', 'arithmetic', 'R', 'sub rd, rs, rt', 'rd = rs - rt, when the difference is representable in 32 signed bits', R3,
    OVERFLOW, `Writes rd unless the exception occurs. ${NO_FLAGS}`, 'sub $t0, $t1, $t2', page('SUB Subtract Word'), regDemo),
  real('mul', 'Multiply to a general register', 'arithmetic', 'R (SPECIAL2)', 'mul rd, rs, rt', 'rd = low 32 bits of rs * rt', R3,
    'The low word is the same for signed and unsigned operands. The architecture leaves the registers HI and LO UNPREDICTABLE after mul; this profile does not model them. Removed in Release 6.',
    `Writes rd. ${NO_FLAGS}`, 'mul $t0, $t1, $t2', page('MUL Multiply Word to GPR'), regDemo),
  real('lui', 'Load upper immediate', 'move', 'I', 'lui rt, imm', 'rt = imm << 16', 'rt: any register; imm: 0 to 65535 (16 bits)',
    'The low 16 bits of rt become zero. The rs field of the encoding must be zero.', `Writes rt. ${NO_FLAGS}`, 'lui $t0, 0x1234', page('LUI Load Upper Immediate')),
  real('and', 'Bitwise AND', 'logic', 'R', 'and rd, rs, rt', 'rd = rs & rt', R3, 'None.', `Writes rd. ${NO_FLAGS}`, 'and $t0, $t1, $t2', page('AND and'), regDemo),
  real('or', 'Bitwise OR', 'logic', 'R', 'or rd, rs, rt', 'rd = rs | rt', R3, 'or rd, rs, $zero copies a register (the pseudoinstruction move).', `Writes rd. ${NO_FLAGS}`, 'or $t0, $t1, $t2', page('OR Or'), regDemo),
  real('xor', 'Bitwise exclusive OR', 'logic', 'R', 'xor rd, rs, rt', 'rd = rs ^ rt', R3, 'None.', `Writes rd. ${NO_FLAGS}`, 'xor $t0, $t1, $t2', page('XOR Exclusive OR'), regDemo),
  real('nor', 'Bitwise NOR', 'logic', 'R', 'nor rd, rs, rt', 'rd = ~(rs | rt)', R3, 'nor rd, rs, $zero complements every bit (the pseudoinstruction not).', `Writes rd. ${NO_FLAGS}`, 'nor $t0, $t1, $t2', page('NOR Not Or'), regDemo),
  real('andi', 'AND immediate', 'logic', 'I', 'andi rt, rs, imm', 'rt = rs & zext(imm)', U16,
    'The immediate is zero-extended, so the upper 16 bits of the result are zero.', `Writes rt. ${NO_FLAGS}`, 'andi $t0, $t1, 0x7', page('ANDI And Immediate'), regDemo),
  real('ori', 'OR immediate', 'logic', 'I', 'ori rt, rs, imm', 'rt = rs | zext(imm)', U16,
    'The immediate is zero-extended. After lui, ori supplies the low half of a 32-bit constant.', `Writes rt. ${NO_FLAGS}`, 'ori $t0, $t1, 0x30', page('ORI Or Immediate'), regDemo),
  real('xori', 'XOR immediate', 'logic', 'I', 'xori rt, rs, imm', 'rt = rs ^ zext(imm)', U16,
    'The immediate is zero-extended, so xori cannot complement the upper half; use nor for a full complement.', `Writes rt. ${NO_FLAGS}`, 'xori $t0, $t1, 0x1', page('XORI Exclusive OR Immediate'), regDemo),
  real('sll', 'Shift left logical', 'shift', 'R', 'sll rd, rt, sa', 'rd = rt << sa', SH5,
    'The rs field of the encoding must be zero. sll $zero, $zero, 0 is the all-zero word and is the no-operation instruction.', `Writes rd. ${NO_FLAGS}`, 'sll $t0, $t1, 2', page('SLL Shift Word Left Logical'), regDemo),
  real('srl', 'Shift right logical', 'shift', 'R', 'srl rd, rt, sa', 'rd = rt >>u sa, zeros shifted in', SH5,
    'The rs field of the encoding must be zero; with rs = 1 the word is the Release 2 instruction rotr, which is outside the profile.', `Writes rd. ${NO_FLAGS}`, 'srl $t0, $t1, 2', page('SRL Shift Word Right Logical'), shiftDemo),
  real('sra', 'Shift right arithmetic', 'shift', 'R', 'sra rd, rt, sa', 'rd = rt >>s sa, sign bit shifted in', SH5,
    'The rs field of the encoding must be zero.', `Writes rd. ${NO_FLAGS}`, 'sra $t0, $t1, 2', page('SRA Shift Word Right Arithmetic'), shiftDemo),
  real('sllv', 'Shift left logical variable', 'shift', 'R', 'sllv rd, rt, rs', 'rd = rt << (rs & 31)', SHV,
    'The value is the second operand and the count register the third. Only the low five bits of rs are used.', `Writes rd. ${NO_FLAGS}`, 'sllv $t0, $t1, $t2', page('SLLV Shift Word Left Logical Variable'), regDemo),
  real('srlv', 'Shift right logical variable', 'shift', 'R', 'srlv rd, rt, rs', 'rd = rt >>u (rs & 31), zeros shifted in', SHV,
    'Only the low five bits of rs are used. Bits 10 to 6 of the encoding must be zero; with bit 6 set the word is rotrv, which is outside the profile.', `Writes rd. ${NO_FLAGS}`, 'srlv $t0, $t1, $t2', page('SRLV Shift Word Right Logical Variable'), shiftDemo),
  real('srav', 'Shift right arithmetic variable', 'shift', 'R', 'srav rd, rt, rs', 'rd = rt >>s (rs & 31), sign bit shifted in', SHV,
    'Only the low five bits of rs are used.', `Writes rd. ${NO_FLAGS}`, 'srav $t0, $t1, $t2', page('SRAV Shift Word Right Arithmetic Variable'), shiftDemo),
  real('slt', 'Set on less than (signed)', 'compare', 'R', 'slt rd, rs, rt', 'rd = 1 if rs <s rt else 0', R3, 'Signed comparison.', `Writes rd with 0 or 1. ${NO_FLAGS}`, 'slt $t0, $t1, $t2', page('SLT Set on Less Than'), { regs: { $t1: -1, $t2: 5 } }),
  real('sltu', 'Set on less than (unsigned)', 'compare', 'R', 'sltu rd, rs, rt', 'rd = 1 if rs <u rt else 0', R3,
    'Unsigned comparison. sltu rd, $zero, rt sets rd when rt is nonzero.', `Writes rd with 0 or 1. ${NO_FLAGS}`, 'sltu $t0, $t1, $t2', page('SLTU Set on Less Than Unsigned'), { regs: { $t1: -1, $t2: 5 } }),
  real('slti', 'Set on less than immediate (signed)', 'compare', 'I', 'slti rt, rs, imm', 'rt = 1 if rs <s sext(imm) else 0', I16, 'Signed comparison.', `Writes rt with 0 or 1. ${NO_FLAGS}`, 'slti $t0, $t1, 20', page('SLTI Set on Less Than Immediate'), regDemo),
  real('sltiu', 'Set on less than immediate (unsigned)', 'compare', 'I', 'sltiu rt, rs, imm', 'rt = 1 if rs <u sext(imm) else 0', I16,
    'The immediate is sign-extended first and then compared as unsigned, so the representable constants are 0 to 32767 and 4294934528 to 4294967295. sltiu rt, rs, 1 sets rt when rs is zero.',
    `Writes rt with 0 or 1. ${NO_FLAGS}`, 'sltiu $t0, $t1, 1', page('SLTIU Set on Less Than Immediate Unsigned'), regDemo),
  real('lw', 'Load word', 'memory', 'I', 'lw rt, offset(base)', 'rt = mem32[base + sext(offset)]', MEMOP,
    'The address must be a multiple of 4; otherwise the Address Error exception occurs and this simulator stops with a fault.', `Reads four bytes, least significant first in this little-endian profile. Writes rt. ${NO_FLAGS}`, 'lw $t0, 8($t1)', page('LW Load Word'), memDemo),
  real('lh', 'Load halfword (signed)', 'memory', 'I', 'lh rt, offset(base)', 'rt = sext(mem16[base + sext(offset)])', MEMOP,
    'The address must be even; otherwise the Address Error exception occurs.', `Reads two bytes and sign-extends. Writes rt. ${NO_FLAGS}`, 'lh $t0, 8($t1)', page('LH Load Halfword'), memDemo),
  real('lhu', 'Load halfword (unsigned)', 'memory', 'I', 'lhu rt, offset(base)', 'rt = zext(mem16[base + sext(offset)])', MEMOP,
    'The address must be even; otherwise the Address Error exception occurs.', `Reads two bytes and zero-extends. Writes rt. ${NO_FLAGS}`, 'lhu $t0, 8($t1)', page('LHU Load Halfword Unsigned'), memDemo),
  real('lb', 'Load byte (signed)', 'memory', 'I', 'lb rt, offset(base)', 'rt = sext(mem8[base + sext(offset)])', MEMOP, 'None.', `Reads one byte and sign-extends. Writes rt. ${NO_FLAGS}`, 'lb $t0, 11($t1)', page('LB Load Byte'), memDemo),
  real('lbu', 'Load byte (unsigned)', 'memory', 'I', 'lbu rt, offset(base)', 'rt = zext(mem8[base + sext(offset)])', MEMOP, 'None.', `Reads one byte and zero-extends. Writes rt. ${NO_FLAGS}`, 'lbu $t0, 11($t1)', page('LBU Load Byte Unsigned'), memDemo),
  real('sw', 'Store word', 'memory', 'I', 'sw rt, offset(base)', 'mem32[base + sext(offset)] = rt', MEMOP,
    'The address must be a multiple of 4; otherwise the Address Error exception occurs. The code region of this environment is read-only.', `Writes four bytes, least significant first. No register changes. ${NO_FLAGS}`, 'sw $t0, 8($t1)', page('SW Store Word'), memDemo),
  real('sh', 'Store halfword', 'memory', 'I', 'sh rt, offset(base)', 'mem16[base + sext(offset)] = rt[15:0]', MEMOP,
    'The address must be even; otherwise the Address Error exception occurs.', `Writes two bytes. No register changes. ${NO_FLAGS}`, 'sh $t0, 8($t1)', page('SH Store Halfword'), memDemo),
  real('sb', 'Store byte', 'memory', 'I', 'sb rt, offset(base)', 'mem8[base + sext(offset)] = rt[7:0]', MEMOP, 'None.', `Writes one byte. No register changes. ${NO_FLAGS}`, 'sb $t0, 8($t1)', page('SB Store Byte'), memDemo),
  real('beq', 'Branch on equal', 'control', 'I', 'beq rs, rt, target', 'if rs == rt then, after the delay slot, pc = target', `rs, rt: any register; ${BR}`,
    `The 16-bit offset counts instructions from the delay slot, not from the branch. ${DELAY_COND}`, `No register changes. ${NO_FLAGS}`, 'beq $t0, $t1, 0x00400010', page('BEQ Branch on Equal'), brDemo),
  real('bne', 'Branch on not equal', 'control', 'I', 'bne rs, rt, target', 'if rs != rt then, after the delay slot, pc = target', `rs, rt: any register; ${BR}`,
    DELAY_COND, `No register changes. ${NO_FLAGS}`, 'bne $t0, $t1, 0x00400010', page('BNE Branch on Not Equal'), brDemo),
  real('bltz', 'Branch on less than zero', 'control', 'I (REGIMM)', 'bltz rs, target', 'if rs <s 0 then, after the delay slot, pc = target', `rs: any register; ${BR}`,
    `There is no instruction that branches on rs < rt; slt followed by bne is used. ${DELAY_COND}`, `No register changes. ${NO_FLAGS}`, 'bltz $t0, 0x00400010', page('BLTZ Branch on Less Than Zero'), brDemo),
  real('bgez', 'Branch on greater than or equal to zero', 'control', 'I (REGIMM)', 'bgez rs, target', 'if rs >=s 0 then, after the delay slot, pc = target', `rs: any register; ${BR}`,
    DELAY_COND, `No register changes. ${NO_FLAGS}`, 'bgez $t0, 0x00400010', page('BGEZ Branch on Greater Than or Equal to Zero'), brDemo),
  real('blez', 'Branch on less than or equal to zero', 'control', 'I', 'blez rs, target', 'if rs <=s 0 then, after the delay slot, pc = target', `rs: any register; ${BR}`,
    `The rt field of the encoding must be zero in Release 2. ${DELAY_COND}`, `No register changes. ${NO_FLAGS}`, 'blez $t0, 0x00400010', page('BLEZ Branch on Less Than or Equal to Zero'), brDemo),
  real('bgtz', 'Branch on greater than zero', 'control', 'I', 'bgtz rs, target', 'if rs >s 0 then, after the delay slot, pc = target', `rs: any register; ${BR}`,
    `The rt field of the encoding must be zero in Release 2. ${DELAY_COND}`, `No register changes. ${NO_FLAGS}`, 'bgtz $t0, 0x00400010', page('BGTZ Branch on Greater Than Zero'), brDemo),
  real('j', 'Jump', 'control', 'J', 'j target', 'after the delay slot, pc = target', 'target: a multiple of 4 in the 256 MB region that contains the delay slot',
    `The 26-bit field times 4 replaces the low 28 bits of the address of the delay slot, so the jump is not relative. ${DELAY}`, `No register changes. ${NO_FLAGS}`, 'j 0x00400010', page('J Jump')),
  real('jal', 'Jump and link', 'control', 'J', 'jal target', '$ra = pc + 8; after the delay slot, pc = target', 'target: a multiple of 4 in the 256 MB region that contains the delay slot',
    `The return address is the address after the delay slot. ${DELAY}`, `Writes $ra. ${NO_FLAGS}`, 'jal 0x00400010', page('JAL Jump and Link')),
  real('jr', 'Jump register', 'control', 'R', 'jr rs', 'after the delay slot, pc = rs', 'rs: any register',
    `jr $ra returns from a call. If the address is not a multiple of 4, the Address Error exception occurs when the target is fetched. The hint field of the encoding must be zero in this profile. ${DELAY}`,
    `No register changes. ${NO_FLAGS}`, 'jr $ra', page('JR Jump Register'), jumpDemo),
  real('jalr', 'Jump and link register', 'control', 'R', 'jalr rd, rs (or jalr rs, which uses $ra)', 'rd = pc + 8; after the delay slot, pc = rs (the value before rd is written)', 'rd, rs: any register, rd different from rs',
    `With rd equal to rs the result is UNPREDICTABLE in the architecture; this simulator stops with a fault. The hint field of the encoding must be zero in this profile. ${DELAY}`,
    `Writes rd with the address after the delay slot. ${NO_FLAGS}`, 'jalr $ra, $t9', page('JALR Jump and Link Register'), jumpDemo),
  real('syscall', 'System call', 'system', 'R', 'syscall (or syscall code)', 'request a service from the execution environment', 'optional code: 0 to 1048575, stored in bits 25 to 6 and ignored by this environment',
    'In the architecture, syscall raises the System Call exception. In this environment $v0 selects the service (1 print, 2 exit, 3 runtime error) and $a0 carries its argument. These are not Linux or SPIM system calls.',
    'No register changes.', 'syscall', page('SYSCALL System Call'), { regs: { $v0: 1, $a0: 42 } }),

  pseudo('nop', 'No operation', 'move', 'nop', 'sll $zero, $zero, 0', `${NOT_MACHINE} The expansion is the all-zero word. The compiler places nop in every delay slot.`, 'nop'),
  pseudo('li', 'Load immediate', 'move', 'li rt, imm',
    'addiu rt, $zero, imm when imm is in -32768 to 32767, and addiu rt, $zero, imm - 4294967296 when imm is in 4294934528 to 4294967295; ori rt, $zero, imm when imm is in 32768 to 65535; otherwise lui rt, upper half, followed by ori rt, rt, lower half when the lower half is nonzero',
    `${NOT_MACHINE} imm: -2147483648 to 4294967295.`, 'li $t0, 100000'),
  pseudo('move', 'Copy register', 'move', 'move rd, rs', 'or rd, rs, $zero',
    `${NOT_MACHINE} Clang's assembler expands move to or; older assemblers and many textbooks use addu rd, rs, $zero, which has the same effect.`, 'move $t0, $t1', regDemo),
  pseudo('negu', 'Negate without overflow exception', 'arithmetic', 'negu rd, rs', 'subu rd, $zero, rs', NOT_MACHINE, 'negu $t0, $t1', regDemo),
  pseudo('not', 'Bitwise complement', 'logic', 'not rd, rs', 'nor rd, rs, $zero', NOT_MACHINE, 'not $t0, $t1', regDemo),
  pseudo('b', 'Unconditional branch', 'control', 'b target', 'beq $zero, $zero, target', `${NOT_MACHINE} The branch is relative to the delay slot and has a delay slot like every branch.`, 'b 0x00400010'),
  pseudo('beqz', 'Branch on zero', 'control', 'beqz rs, target', 'beq rs, $zero, target', `${NOT_MACHINE} The branch has a delay slot.`, 'beqz $t0, 0x00400010', brDemo),
  pseudo('bnez', 'Branch on not zero', 'control', 'bnez rs, target', 'bne rs, $zero, target', `${NOT_MACHINE} The branch has a delay slot.`, 'bnez $t0, 0x00400010', brDemo),
];

/** Equivalent sequences for the operations compared across targets. */
export const OPERATIONS: OperationExample[] = [
  { key: 'add-registers', assembly: ['addu $t0, $t1, $t2'], notes: 'Three-operand form. addu wraps on overflow; add would raise the Integer Overflow exception, so the compiler never uses it.' },
  { key: 'add-constant', assembly: ['addiu $t0, $t1, 100'], notes: 'The constant is a 16-bit signed field of the instruction.' },
  { key: 'load-constant-32', assembly: ['lui $t0, 0x1234', 'ori $t0, $t0, 0x5678'], notes: 'A 32-bit constant needs two instructions: the upper 16 bits, then the lower 16. ori zero-extends its immediate, so the upper half needs no correction.' },
  { key: 'subtract-registers', assembly: ['subu $t0, $t1, $t2'], notes: 'There is no subtract-immediate; addiu with a negative constant is used instead.' },
  { key: 'multiply', assembly: ['mul $t0, $t1, $t2'], notes: 'mul writes the low 32 bits of the product to a general register. It is a MIPS32 instruction of the SPECIAL2 group and was removed in Release 6.' },
  { key: 'shift-left-constant', assembly: ['sll $t0, $t1, 3'], notes: 'The shift amount is a 5-bit field.' },
  { key: 'shift-right-arithmetic', assembly: ['srav $t0, $t1, $t2'], notes: 'The value is the second operand and the count the third. Only the low five bits of the count register are used.' },
  { key: 'bitwise-and-constant', assembly: ['andi $t0, $t1, 0xff'], notes: 'The immediate is zero-extended from 16 bits, so masks up to 0xffff fit directly.' },
  { key: 'compare-set', assembly: ['slt $t0, $t1, $t2'], notes: 'A comparison result is produced directly in a register as 0 or 1.' },
  { key: 'branch-less-than', assembly: ['slt $t8, $t1, $t2', 'bne $t8, $zero, target', 'nop'], notes: 'Only equality and comparisons with zero have branch instructions. Other comparisons set a register with slt and branch on it. The nop fills the delay slot.' },
  { key: 'branch-equal-zero', assembly: ['beq $t0, $zero, target', 'nop'], notes: 'Comparison with zero uses the hard-wired zero register. The instruction after the branch executes before the branch takes effect.' },
  { key: 'load-array-element', assembly: ['sll $t8, $t1, 2', 'addu $t8, $t8, $gp', 'lw $t0, 0($t8)'], notes: 'The address is computed explicitly: index times four plus the base. A load accepts only base plus constant offset.' },
  { key: 'store-array-element', assembly: ['sll $t8, $t1, 2', 'addu $t8, $t8, $gp', 'sw $t0, 0($t8)'], notes: 'As for the load, with sw.' },
  { key: 'call-return', assembly: ['jal target', 'nop', 'jr $ra', 'nop'], notes: 'The return address, the address after the delay slot, goes to the link register $ra; memory is not touched. The callee returns with jr through $ra. Each jump has a delay slot.' },
  { key: 'service-call', assembly: ['addiu $v0, $zero, 1', 'syscall'], notes: 'The service number is passed in $v0 and the argument in $a0.' },
];
