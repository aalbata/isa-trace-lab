/**
 * Instruction catalog of the x86-64 profile: one entry per implemented
 * instruction and per accepted alternative spelling, with syntax, semantics,
 * operand forms, flag effects, and a worked example. The explanations are
 * written for this project; the cited entries of the Intel manual are the
 * normative source.
 */
import type { InsnGroup, InsnSpec, OperationExample } from '../types.ts';
import { CC_MEANING, CC_NAMES } from './isa.ts';

const VOL2A = 'Intel SDM Volume 2A, Chapter 3, Instructions (A-L), entry';
const VOL2B = 'Intel SDM Volume 2B, Chapter 4, Instructions (M-U), entry';
const VOL2 = 'Intel SDM Volume 2 (combined volumes 2A to 2D), Instruction Set Reference, entry';

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

const alias = (mnemonic: string, title: string, group: InsnGroup, syntax: string, expansion: string, example: string, reference: string): InsnSpec => ({
  mnemonic, title, group, format: 'alias', syntax, semantics: `Alternative spelling of: ${expansion}`,
  operands: 'as for the instruction it stands for', restrictions: 'not a separate machine instruction; the assembler emits the encoding of the instruction it stands for, and the disassembler prints that instruction',
  effects: 'as for the instruction it stands for', example, reference,
  encode: true, decode: false, simulate: true, pseudo: true, expansion,
});

const RM = 'r/m: a 32-bit or 64-bit register, or a memory operand (dword ptr or qword ptr) with base, index*scale, and displacement';
const TWO_OP = `Forms: r/m, r; r, r/m; r/m, imm. ${RM}. The immediate is 8 bits sign-extended or 32 bits (sign-extended to 64 bits for a 64-bit operand).`;
const NO_TWO_MEM = 'At most one operand is a memory operand. 8-bit and 16-bit operands are outside the subset.';
const ARITH_FLAGS = 'Writes the destination. Sets CF (unsigned carry or borrow), OF (signed overflow), SF, ZF, AF, and PF from the result.';
const LOGIC_FLAGS = 'Clears CF and OF; sets SF, ZF, and PF from the result. AF is undefined; this model clears it.';
const ZX = 'A 32-bit destination register is zero-extended to 64 bits.';
const NO_FLAGS = 'Flags are not changed.';
const ENCODING_2OP = 'opcode, ModR/M (op r/m, r and op r, r/m); 83 /n ib or 81 /n id for an immediate; a one-byte shorter form for eax or rax with a 32-bit immediate';

const regDemo = { regs: { eax: 12, ebx: 5 } };
const memDemo = { regs: { eax: 0x11223344, rbx: 0x10000000, rcx: 2 }, mem: [{ address: 0x10000008, value: 0x80c0ffee | 0 }] };
const flagDemo = { regs: { eax: 3, ebx: 7 } };

const ALIASES: Record<string, string[]> = {
  b: ['c', 'nae'], ae: ['nc', 'nb'], e: ['z'], ne: ['nz'], be: ['na'], a: ['nbe'], p: ['pe'], np: ['po'], l: ['nge'], ge: ['nl'], le: ['ng'], g: ['nle'],
};

const CC_TITLE: Record<string, string> = {
  o: 'overflow', no: 'no overflow', b: 'below (unsigned less than)', ae: 'above or equal (unsigned)', e: 'equal', ne: 'not equal',
  be: 'below or equal (unsigned)', a: 'above (unsigned greater than)', s: 'sign (negative)', ns: 'no sign (not negative)', p: 'parity even', np: 'parity odd',
  l: 'less than (signed)', ge: 'greater or equal (signed)', le: 'less or equal (signed)', g: 'greater than (signed)',
};

const conditional: InsnSpec[] = [];
CC_NAMES.forEach((cc, n) => {
  const other = ALIASES[cc] ?? [];
  const spell = other.length ? ` Also written ${other.map((a) => `j${a}`).join(' or ')}.` : '';
  conditional.push(real(`j${cc}`, `Jump if ${CC_TITLE[cc]}`, 'control', 'rel8 or rel32', `j${cc} target`,
    `if ${CC_MEANING[n]} then rip = target else rip = address of the next instruction`,
    'target: a label or an absolute address within -2^31 to 2^31 - 1 bytes of the next instruction',
    `The offset is relative to the end of the instruction. The assembler uses the two-byte form (7${n.toString(16).toUpperCase()} cb) when a label is within -128 to +127 bytes and the six-byte form (0F 8${n.toString(16).toUpperCase()} cd) otherwise; a numeric target always gets the six-byte form.${spell}`,
    `Reads the flags named in the condition. ${NO_FLAGS}`, `j${cc} 0x00400010`, `${VOL2A} Jcc`, { flags: { ZF: 1, CF: 0, SF: 0, OF: 0, PF: 1 } }));
});
CC_NAMES.forEach((cc, n) => {
  const other = ALIASES[cc] ?? [];
  const spell = other.length ? ` Also written ${other.map((a) => `set${a}`).join(' or ')}.` : '';
  conditional.push(real(`set${cc}`, `Set byte if ${CC_TITLE[cc]}`, 'compare', '0F 9x, ModR/M', `set${cc} r/m8`,
    `r/m8 = 1 if ${CC_MEANING[n]} else 0`,
    'r/m8: an 8-bit register (al to r15b; ah, ch, dh, bh when no REX prefix is needed) or a byte in memory',
    `Only one byte is written; the other bits of a register keep their values, so the compiler follows SETcc with MOVZX.${spell}`,
    `Reads the flags named in the condition. ${NO_FLAGS}`, `set${cc} al`, `${VOL2B} SETcc`, { regs: { eax: -1 }, flags: { ZF: 1, CF: 0, SF: 0, OF: 0, PF: 1 } }));
});
const aliases: InsnSpec[] = [];
for (const [cc, others] of Object.entries(ALIASES)) {
  for (const a of others) {
    aliases.push(alias(`j${a}`, `Jump if ${CC_TITLE[cc]} (alternative spelling)`, 'control', `j${a} target`, `j${cc} target`, `j${a} 0x00400010`, `${VOL2A} Jcc`));
    aliases.push(alias(`set${a}`, `Set byte if ${CC_TITLE[cc]} (alternative spelling)`, 'compare', `set${a} r/m8`, `set${cc} r/m8`, `set${a} al`, `${VOL2B} SETcc`));
  }
}
aliases.push(alias('sal', 'Shift arithmetic left (alternative spelling)', 'shift', 'sal r/m, count', 'shl r/m, count', 'sal eax, 2', `${VOL2B} SAL/SAR/SHL/SHR`));

const SHIFT_RULES = 'The count is an immediate (0 to 255) or the register cl; the processor uses its low 5 bits for a 32-bit operand and its low 6 bits for a 64-bit operand. A count of 1 has its own opcode (D1), which the assembler chooses.';
const SHIFT_FLAGS = 'With a masked count of 0 no flag changes. Otherwise CF is the last bit shifted out and SF, ZF, and PF follow the result; OF is defined only for a count of 1; AF is undefined. This model clears AF and, for larger counts, sets OF as the last one-bit step would.';

export const INSTRUCTIONS: InsnSpec[] = [
  real('mov', 'Move', 'move', '89 /r, 8B /r, B8+r id, C7 /0 id', 'mov dst, src', 'dst = src',
    `Forms: r/m, r; r, r/m; r32, imm32; r64, imm32 (sign-extended); r/m, imm32. ${RM}.`,
    `${NO_TWO_MEM} A 64-bit immediate (MOV r64, imm64) is outside the subset.`, `Writes the destination. ${ZX} ${NO_FLAGS}`, 'mov eax, ebx', `${VOL2B} MOV`, regDemo),
  real('movzx', 'Move with zero-extension', 'move', '0F B6 /r', 'movzx r32, r/m8', 'r32 = zero-extended r/m8',
    'r32: any 32-bit register; r/m8: an 8-bit register or a byte in memory (byte ptr)',
    'Only the byte-to-doubleword form is in the subset. spl, bpl, sil, and dil need a REX prefix; ah, ch, dh, and bh cannot be used together with one.',
    `Writes r32. ${ZX} ${NO_FLAGS}`, 'movzx eax, al', `${VOL2B} MOVZX`, { regs: { eax: 0x12345681 } }),
  real('movsxd', 'Move with sign-extension, doubleword to quadword', 'move', 'REX.W 63 /r', 'movsxd r64, r/m32', 'r64 = sign-extended r/m32',
    'r64: any 64-bit register; r/m32: a 32-bit register or a doubleword in memory', 'The form without REX.W is outside the subset.',
    `Writes r64. ${NO_FLAGS}`, 'movsxd rax, ebx', `${VOL2B} MOVSX/MOVSXD`, { regs: { ebx: -5 } }),
  real('lea', 'Load effective address', 'arithmetic', '8D /r', 'lea r, [base + index*scale + disp]', 'r = base + index * scale + disp; memory is not accessed',
    'r: a 32-bit or 64-bit register; the source is a memory operand, written without a size keyword',
    'A 32-bit destination receives the low 32 bits of the address. A register as the source is an undefined opcode.',
    `Writes r. ${ZX} ${NO_FLAGS}`, 'lea eax, [rbx + rcx*4 + 8]', `${VOL2A} LEA`, { regs: { rbx: 100, rcx: 3 } }),
  real('add', 'Add', 'arithmetic', ENCODING_2OP, 'add dst, src', 'dst = (dst + src) mod 2^size', TWO_OP, NO_TWO_MEM, `${ARITH_FLAGS} ${ZX}`, 'add eax, ebx', `${VOL2A} ADD`, regDemo),
  real('sub', 'Subtract', 'arithmetic', ENCODING_2OP, 'sub dst, src', 'dst = (dst - src) mod 2^size', TWO_OP, NO_TWO_MEM,
    `${ARITH_FLAGS} CF is set when dst is below src as unsigned values. ${ZX}`, 'sub eax, ebx', `${VOL2B} SUB`, regDemo),
  real('and', 'Bitwise AND', 'logic', ENCODING_2OP, 'and dst, src', 'dst = dst & src', TWO_OP, NO_TWO_MEM, `Writes the destination. ${LOGIC_FLAGS} ${ZX}`, 'and eax, ebx', `${VOL2A} AND`, regDemo),
  real('or', 'Bitwise OR', 'logic', ENCODING_2OP, 'or dst, src', 'dst = dst | src', TWO_OP, NO_TWO_MEM, `Writes the destination. ${LOGIC_FLAGS} ${ZX}`, 'or eax, ebx', `${VOL2B} OR`, regDemo),
  real('xor', 'Bitwise exclusive OR', 'logic', ENCODING_2OP, 'xor dst, src', 'dst = dst ^ src', TWO_OP, NO_TWO_MEM, `Writes the destination. ${LOGIC_FLAGS} ${ZX}`, 'xor eax, ebx', `${VOL2} XOR`, regDemo),
  real('cmp', 'Compare', 'compare', ENCODING_2OP, 'cmp a, b', 'flags of (a - b); the difference is discarded', TWO_OP, NO_TWO_MEM,
    'No operand is written. Sets CF, OF, SF, ZF, AF, and PF as SUB does. A following jcc or setcc reads them: l, le, g, ge for signed and b, be, a, ae for unsigned comparison.',
    'cmp eax, ebx', `${VOL2A} CMP`, flagDemo),
  real('test', 'Logical compare', 'compare', '85 /r', 'test r/m, r', 'flags of (r/m & r); the result is discarded', `Form: r/m, r. ${RM}.`,
    'TEST with an immediate is outside the subset. test r, mem is accepted as another spelling of test mem, r.',
    `No operand is written. ${LOGIC_FLAGS}`, 'test eax, eax', `${VOL2B} TEST`, flagDemo),
  real('imul', 'Signed multiply', 'arithmetic', '0F AF /r, 6B /r ib, 69 /r id', 'imul r, r/m  or  imul r, r/m, imm', 'r = low half of (r * r/m), or of (r/m * imm)',
    `r: a 32-bit or 64-bit register. ${RM}. imm: 8 bits sign-extended or 32 bits.`,
    'The one-operand form, which writes edx:eax, is outside the subset. imul r, imm is accepted as shorthand for imul r, r, imm.',
    `Writes r. ${ZX} CF and OF are set when the exact signed product does not fit in the operand size, else cleared. SF, ZF, AF, and PF are undefined; this model sets SF, ZF, and PF from the truncated product and clears AF.`,
    'imul eax, ebx, 10', `${VOL2A} IMUL`, regDemo),
  real('neg', 'Two\'s complement negation', 'arithmetic', 'F7 /3', 'neg r/m', 'r/m = (0 - r/m) mod 2^size', RM, 'A memory operand needs a size keyword.',
    `Writes the operand. CF is set unless the operand was 0; OF, SF, ZF, AF, and PF follow the result of 0 - operand. ${ZX}`, 'neg eax', `${VOL2B} NEG`, regDemo),
  real('not', 'One\'s complement negation', 'logic', 'F7 /2', 'not r/m', 'r/m = ~r/m', RM, 'A memory operand needs a size keyword.', `Writes the operand. ${ZX} ${NO_FLAGS}`, 'not eax', `${VOL2B} NOT`, regDemo),
  real('inc', 'Increment by 1', 'arithmetic', 'FF /0', 'inc r/m', 'r/m = (r/m + 1) mod 2^size', RM, 'A memory operand needs a size keyword.',
    `Writes the operand. CF is not changed; OF, SF, ZF, AF, and PF follow the result. ${ZX}`, 'inc eax', `${VOL2A} INC`, regDemo),
  real('dec', 'Decrement by 1', 'arithmetic', 'FF /1', 'dec r/m', 'r/m = (r/m - 1) mod 2^size', RM, 'A memory operand needs a size keyword.',
    `Writes the operand. CF is not changed; OF, SF, ZF, AF, and PF follow the result. ${ZX}`, 'dec eax', `${VOL2A} DEC`, regDemo),
  real('shl', 'Shift logical left', 'shift', 'D1 /4, C1 /4 ib, D3 /4', 'shl r/m, count', 'r/m = r/m << count, zeros shifted in', `${RM}. ${SHIFT_RULES}`,
    'The source language rejects counts outside 0 to 31 before the instruction runs.', `Writes the operand. ${ZX} ${SHIFT_FLAGS} For a count of 1, OF = most significant bit of the result XOR CF.`,
    'shl eax, 3', `${VOL2B} SAL/SAR/SHL/SHR`, regDemo),
  real('sar', 'Shift arithmetic right', 'shift', 'D1 /7, C1 /7 ib, D3 /7', 'sar r/m, count', 'r/m = r/m >>s count, copies of the sign bit shifted in', `${RM}. ${SHIFT_RULES}`,
    'The result is the floor of the signed value divided by 2^count.', `Writes the operand. ${ZX} ${SHIFT_FLAGS} For a count of 1, OF = 0.`,
    'sar eax, cl', `${VOL2B} SAL/SAR/SHL/SHR`, { regs: { eax: -64, ecx: 4 } }),
  real('shr', 'Shift logical right', 'shift', 'D1 /5, C1 /5 ib, D3 /5', 'shr r/m, count', 'r/m = r/m >>u count, zeros shifted in', `${RM}. ${SHIFT_RULES}`,
    'The compiler does not generate SHR, because the source language has only the arithmetic right shift.', `Writes the operand. ${ZX} ${SHIFT_FLAGS} For a count of 1, OF = most significant bit of the original operand.`,
    'shr eax, 4', `${VOL2B} SAL/SAR/SHL/SHR`, { regs: { eax: -64 } }),
  ...conditional.filter((c) => c.mnemonic.startsWith('set')),
  real('jmp', 'Jump', 'control', 'EB cb or E9 cd', 'jmp target', 'rip = target', 'target: a label or an absolute address within -2^31 to 2^31 - 1 bytes of the next instruction',
    'The offset is relative to the end of the instruction. The assembler uses the two-byte form when a label is within -128 to +127 bytes and the five-byte form otherwise; a numeric target always gets the five-byte form. Indirect jumps are outside the subset.',
    `No register changes. ${NO_FLAGS}`, 'jmp 0x00400010', `${VOL2A} JMP`),
  ...conditional.filter((c) => c.mnemonic.startsWith('j')),
  real('call', 'Call procedure', 'control', 'E8 cd', 'call target', 'rsp = rsp - 8; mem64[rsp] = address of the next instruction; rip = target',
    'target: a label or an absolute address within -2^31 to 2^31 - 1 bytes of the next instruction', 'Only the direct near call is in the subset.',
    `Writes rsp and eight bytes of the stack. ${NO_FLAGS}`, 'call 0x00400010', `${VOL2A} CALL`),
  real('ret', 'Return from procedure', 'control', 'C3', 'ret', 'rip = mem64[rsp]; rsp = rsp + 8', 'no operands',
    'The form with an immediate that releases stack arguments is outside the subset. In this environment a return address of 2^32 or more is a fault.',
    `Reads eight bytes of the stack and writes rsp. ${NO_FLAGS}`, 'ret', `${VOL2B} RET`, { regs: { rsp: 0x7fffeff8 }, mem: [{ address: 0x7fffeff8, value: 0x00400020 }] }),
  real('push', 'Push quadword onto the stack', 'memory', '50+r', 'push r64', 'rsp = rsp - 8; mem64[rsp] = r64', 'r64: any 64-bit register',
    'In 64-bit mode the operand is 64 bits. push rsp stores the value that rsp had before the instruction. Memory and immediate operands are outside the subset.',
    `Writes rsp and eight bytes of the stack. ${NO_FLAGS}`, 'push rbx', `${VOL2B} PUSH`, { regs: { rbx: 0x12345678, rsp: 0x7fffeff8 } }),
  real('pop', 'Pop quadword from the stack', 'memory', '58+r', 'pop r64', 'r64 = mem64[rsp]; rsp = rsp + 8', 'r64: any 64-bit register',
    'pop rsp leaves the popped value in rsp. A memory operand is outside the subset.',
    `Reads eight bytes of the stack; writes r64 and rsp. ${NO_FLAGS}`, 'pop rbx', `${VOL2B} POP`, { regs: { rsp: 0x7fffeff8 }, mem: [{ address: 0x7fffeff8, value: 0x12345678 }] }),
  real('syscall', 'Fast system call', 'system', '0F 05', 'syscall', 'rcx = address of the next instruction; r11 = flags; request a service from the execution environment', 'no operands',
    'In this environment eax selects the service (1 print, 2 exit, 3 runtime error) and edi carries its argument. These are not Linux system calls. Execution resumes at the next instruction with the flags unchanged. r11 receives the modeled part of RFLAGS: bit 1 set and the six status flags.',
    `Writes rcx and r11. ${NO_FLAGS}`, 'syscall', `${VOL2B} SYSCALL`, { regs: { eax: 1, edi: 42 } }),
  real('nop', 'No operation', 'move', '90', 'nop', 'no effect other than advancing rip', 'no operands', 'Only the one-byte form is in the subset.', `No register changes. ${NO_FLAGS}`, 'nop', `${VOL2B} NOP`),
  ...aliases,
];

/** Equivalent sequences for the operations compared across targets. */
export const OPERATIONS: OperationExample[] = [
  { key: 'add-registers', assembly: ['mov eax, ebx', 'add eax, ecx'], notes: 'Two-operand form: the destination is also the first source, so a separate destination needs a move first. The addition writes all six status flags.' },
  { key: 'add-constant', assembly: ['mov eax, ebx', 'add eax, 100'], notes: 'A constant from -128 to 127 takes one byte in the instruction; any other 32-bit constant takes four.' },
  { key: 'load-constant-32', assembly: ['mov eax, 0x12345678'], notes: 'One five-byte instruction holds the whole 32-bit constant. Instructions have variable length, so no second instruction is needed.' },
  { key: 'subtract-registers', assembly: ['mov eax, ebx', 'sub eax, ecx'], notes: 'When the destination already holds the second operand, the compiler first copies that operand to a scratch register.' },
  { key: 'multiply', assembly: ['imul eax, ebx, 10', 'imul eax, ecx'], notes: 'IMUL keeps the low 32 bits of the product, which are the same for signed and unsigned operands. The three-operand form multiplies by a constant.' },
  { key: 'shift-left-constant', assembly: ['mov eax, ebx', 'shl eax, 3'], notes: 'The count is one immediate byte; the processor uses its low five bits for a 32-bit operand.' },
  { key: 'shift-right-arithmetic', assembly: ['mov ecx, edx', 'mov eax, ebx', 'sar eax, cl'], notes: 'A variable count must be in the register cl, so the count is moved to ecx first.' },
  { key: 'bitwise-and-constant', assembly: ['mov eax, ebx', 'and eax, 0xff'], notes: 'Any 32-bit mask can be an immediate. The instruction also clears CF and OF and sets SF, ZF, and PF.' },
  { key: 'compare-set', assembly: ['cmp ebx, ecx', 'setl al', 'movzx eax, al'], notes: 'The comparison sets flags, SETcc turns a condition into a byte, and MOVZX widens the byte to a 32-bit 0 or 1.' },
  { key: 'branch-less-than', assembly: ['cmp ebx, ecx', 'jl target'], notes: 'Compare and branch are two instructions that communicate through the flags: jl is taken when SF differs from OF.' },
  { key: 'branch-equal-zero', assembly: ['cmp eax, 0', 'je target'], notes: 'The compiler compares with the constant 0. Hand-written code often uses test eax, eax, which sets ZF the same way in fewer bytes.' },
  { key: 'load-array-element', assembly: ['mov eax, dword ptr [rcx*4 + 0x10000000]'], notes: 'One instruction: the address is index times four plus the address of the array, formed by the addressing mode. The index register is used with its 64-bit name; its upper half is zero after any 32-bit write.' },
  { key: 'store-array-element', assembly: ['mov dword ptr [rcx*4 + 0x10000000], eax'], notes: 'As for the load, with the memory operand as the destination. A constant can be stored directly with an immediate.' },
  { key: 'call-return', assembly: ['call target', 'ret'], notes: 'CALL pushes the return address on the stack and RET pops it, so every call and return accesses memory. There is no link register.' },
  { key: 'service-call', assembly: ['mov edi, eax', 'mov eax, 1', 'syscall'], notes: 'The service number is passed in eax and the argument in edi. SYSCALL itself overwrites rcx and r11.' },
];
