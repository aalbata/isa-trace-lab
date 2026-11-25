/**
 * Validation inputs for x86-64: instruction sweeps with boundary operands for
 * comparison against the reference assembler, disassembler, and emulator,
 * valid encodings that the encoder does not choose, and the flags that each
 * instruction leaves undefined.
 */
import type { Insn, ValidationSpec } from '../types.ts';
import { ALU_EXT, CC_NAMES, REG32, REG64, REG8, REG8_HIGH, SHIFT_EXT } from './isa.ts';

const DATA = 0x10000000;
const hex = (v: number): string => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const r32 = (i: number): string => REG32[((i % 16) + 16) % 16]!;
const r64 = (i: number): string => REG64[((i % 16) + 16) % 16]!;

/**
 * Address expressions that cover every ModR/M and SIB case: each register as
 * base and as index, rsp and r12 as base (SIB required), rbp and r13 as base
 * (displacement required), every scale, 8-bit and 32-bit displacements at
 * their boundaries, an index without a base, and absolute addresses. The
 * validation harness points base registers into the data region and gives
 * index registers small values, so the displacements stay small.
 */
function addresses(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 16; i++) out.push(`[${r64(i)}]`);
  for (let i = 0; i < 16; i++) out.push(`[${r64(i)} + ${4 * i + 4}]`);
  out.push('[rcx + 127]', '[rdx - 128]', '[rbx + 128]', '[rsi - 129]', '[rsp + 127]', '[rsp + 128]', '[rbp - 128]', '[rbp - 129]',
    '[r12 + 1024]', '[r13 - 2048]', '[r8 + 4096]', '[rdi + 32768]');
  for (let i = 0; i < 16; i++) if (i !== 4) out.push(`[${r64(i + 5)} + ${r64(i)}*${1 << (i % 4)}]`);
  for (let i = 0; i < 16; i++) if (i !== 4) out.push(`[${r64(i + 9)} + ${r64(i)}*${1 << ((i + 2) % 4)} ${['+ 8', '- 8', '+ 127', '- 128', '+ 128', '- 129', '+ 2048', '+ 16'][i % 8]}]`);
  out.push('[rsp + rbp*4]', '[rbp + rax*8]', '[r12 + r13*4]', '[r13 + r12*2]', '[rsp + r12*1 + 64]', '[rbp + rbp*1]');
  for (let i = 0; i < 16; i++) if (i !== 4) out.push(`[${r64(i)}*${1 << (i % 4)} + ${hex(DATA + 0x100 * i)}]`);
  out.push(`[${hex(DATA)}]`, `[${hex(DATA + 0x804)}]`, `[${hex(DATA + 0xfffc)}]`, `[rcx*4 + ${hex(DATA + 0xffc)}]`);
  return out;
}

const IMM8_EDGE = [0, 1, -1, 2, 127, -128];
const IMM32_EDGE = [128, -129, 255, 256, 1000, 65535, 0x12345678, 0x7fffffff, -0x80000000, -0x7fffffff];

/** Padding bytes (one-byte NOPs) placed as data, so that they are not executed as test cases. */
function pad(n: number): string[] {
  const out: string[] = [];
  for (let left = n; left > 0; left -= 64) out.push(`.byte ${Array.from({ length: Math.min(64, left) }, () => '0x90').join(', ')}`);
  return out;
}

function sweeps(): { name: string; text: string; passthrough?: boolean }[] {
  const out: { name: string; text: string; passthrough?: boolean }[] = [];
  const add = (name: string, lines: string[]): void => {
    out.push({ name, text: lines.join('\n') + '\n' });
  };
  const mem = addresses();
  const some = (step: number, offset = 0): string[] => mem.filter((_, i) => i % step === offset);

  // Two-operand arithmetic and logic.
  for (const m of [...Object.keys(ALU_EXT), 'mov']) {
    const rr: string[] = [];
    for (let i = 0; i < 16; i++) rr.push(`${m} ${r32(i)}, ${r32(i * 7 + 3)}`, `${m} ${r64(i)}, ${r64(i * 5 + 1)}`);
    rr.push(`${m} eax, eax`, `${m} r15d, r15d`, `${m} rsp, rsp`, `${m} r8, rax`, `${m} eax, r8d`, `${m} r9d, ecx`);
    add(`${m}-reg-reg`, rr);

    const ri: string[] = [];
    for (const v of [...IMM8_EDGE, ...IMM32_EDGE]) ri.push(`${m} eax, ${v}`, `${m} rax, ${v}`);
    [...IMM8_EDGE, ...IMM32_EDGE].forEach((v, i) => ri.push(`${m} ${r32(i + 1)}, ${v}`, `${m} ${r64(i + 2)}, ${v}`));
    for (let i = 0; i < 16; i++) ri.push(`${m} ${r32(i)}, ${i * 9 - 60}`, `${m} ${r64(i)}, ${(i * 0x01234567) | 0}`);
    add(`${m}-reg-imm`, ri);

    const rm: string[] = [];
    mem.forEach((a, i) => rm.push(`${m} ${r32(i * 3)}, dword ptr ${a}`));
    some(4).forEach((a, i) => rm.push(`${m} ${r64(i * 5 + 2)}, qword ptr ${a}`));
    add(`${m}-reg-mem`, rm);

    const mr: string[] = [];
    mem.forEach((a, i) => mr.push(`${m} dword ptr ${a}, ${r32(i * 5 + 1)}`));
    some(4, 1).forEach((a, i) => mr.push(`${m} qword ptr ${a}, ${r64(i * 3 + 7)}`));
    add(`${m}-mem-reg`, mr);

    const mi: string[] = [];
    some(3).forEach((a, i) => mi.push(`${m} dword ptr ${a}, ${[...IMM8_EDGE, ...IMM32_EDGE][i % 16]}`));
    some(5, 2).forEach((a, i) => mi.push(`${m} qword ptr ${a}, ${[...IMM32_EDGE, ...IMM8_EDGE][i % 16]}`));
    add(`${m}-mem-imm`, mi);
  }

  // test: r/m, r.
  {
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(`test ${r32(i)}, ${r32(i * 3 + 5)}`, `test ${r64(i)}, ${r64(i * 7 + 2)}`, `test ${r32(i)}, ${r32(i)}`);
    mem.forEach((a, i) => lines.push(`test dword ptr ${a}, ${r32(i * 7 + 2)}`));
    some(4, 2).forEach((a, i) => lines.push(`test qword ptr ${a}, ${r64(i * 3)}`));
    add('test', lines);
  }

  // movzx with every byte register, movsxd, and lea.
  {
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(`movzx ${r32(i * 3 + 1)}, ${REG8[i]}`, `movzx ${r32(i)}, ${REG8[i]}`);
    REG8_HIGH.forEach((h, i) => lines.push(`movzx ${r32(i)}, ${h}`, `movzx ${r32(7 - i)}, ${h}`));
    mem.forEach((a, i) => lines.push(`movzx ${r32(i * 5 + 3)}, byte ptr ${a}`));
    add('movzx', lines);
  }
  {
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(`movsxd ${r64(i)}, ${r32(i * 3 + 1)}`, `movsxd ${r64(i * 7 + 5)}, ${r32(i)}`);
    mem.forEach((a, i) => lines.push(`movsxd ${r64(i * 3 + 2)}, dword ptr ${a}`));
    add('movsxd', lines);
  }
  {
    const lines: string[] = [];
    mem.forEach((a, i) => lines.push(`lea ${r32(i * 3 + 1)}, ${a}`, `lea ${r64(i * 5 + 2)}, ${a}`));
    lines.push('lea rsp, [rsp + 8]', 'lea eax, [rax + rax*2]', 'lea rbp, [rbp + rbp*8 - 1]', 'lea r15, [r15 + r15*1]');
    add('lea', lines);
  }

  // imul: two-operand and three-operand forms.
  {
    const rr: string[] = [];
    for (let i = 0; i < 16; i++) rr.push(`imul ${r32(i)}, ${r32(i * 7 + 3)}`, `imul ${r64(i)}, ${r64(i * 5 + 1)}`, `imul ${r32(i)}, ${r32(i)}`);
    mem.forEach((a, i) => rr.push(`imul ${r32(i * 3)}, dword ptr ${a}`));
    some(4, 3).forEach((a, i) => rr.push(`imul ${r64(i * 5 + 2)}, qword ptr ${a}`));
    add('imul-two', rr);
    const ri: string[] = [];
    [...IMM8_EDGE, ...IMM32_EDGE].forEach((v, i) => ri.push(`imul ${r32(i)}, ${r32(i * 3 + 2)}, ${v}`, `imul ${r64(i + 4)}, ${r64(i * 7 + 1)}, ${v}`, `imul ${r32(i + 8)}, ${r32(i + 8)}, ${v}`));
    some(2).forEach((a, i) => ri.push(`imul ${r32(i * 5 + 1)}, dword ptr ${a}, ${[...IMM32_EDGE, ...IMM8_EDGE][i % 16]}`));
    some(6, 1).forEach((a, i) => ri.push(`imul ${r64(i * 3 + 4)}, qword ptr ${a}, ${[...IMM8_EDGE, ...IMM32_EDGE][i % 16]}`));
    add('imul-three', ri);
  }

  // One-operand instructions.
  for (const m of ['neg', 'not', 'inc', 'dec']) {
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(`${m} ${r32(i)}`, `${m} ${r64(i)}`);
    mem.forEach((a) => lines.push(`${m} dword ptr ${a}`));
    some(4).forEach((a) => lines.push(`${m} qword ptr ${a}`));
    add(m, lines);
  }

  // Shifts by 1, by an immediate, and by cl.
  for (const m of Object.keys(SHIFT_EXT)) {
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(`${m} ${r32(i)}, 1`, `${m} ${r64(i)}, 1`, `${m} ${r32(i)}, cl`, `${m} ${r64(i)}, cl`);
    [0, 2, 3, 5, 8, 16, 30, 31, 32, 33, 63, 64, 255].forEach((c, i) => lines.push(`${m} ${r32(i * 3)}, ${c}`, `${m} ${r64(i * 5 + 1)}, ${c}`));
    for (let c = 0; c < 32; c++) lines.push(`${m} ${r32(c + 3)}, ${c}`);
    some(4).forEach((a, i) => lines.push(`${m} dword ptr ${a}, 1`, `${m} dword ptr ${a}, ${(i * 5 + 2) % 32}`, `${m} dword ptr ${a}, cl`));
    some(8, 3).forEach((a, i) => lines.push(`${m} qword ptr ${a}, 1`, `${m} qword ptr ${a}, ${(i * 11 + 2) % 64}`, `${m} qword ptr ${a}, cl`));
    add(m, lines);
  }

  // setcc: every condition with every byte register and with memory.
  {
    const lines: string[] = [];
    CC_NAMES.forEach((cc, n) => {
      for (let i = 0; i < 16; i += 3) lines.push(`set${cc} ${REG8[(i + n) % 16]}`);
      lines.push(`set${cc} ${REG8_HIGH[n % 4]}`, `set${cc} byte ptr ${mem[(n * 7) % mem.length]}`, `set${cc} byte ptr ${mem[(n * 13 + 5) % mem.length]}`);
    });
    add('setcc', lines);
  }

  // Stack instructions.
  {
    const lines: string[] = [];
    for (let i = 0; i < 16; i++) lines.push(`push ${r64(i)}`, `pop ${r64(i)}`);
    lines.push('ret', 'nop', 'syscall');
    add('stack', lines);
  }

  // Jumps. Targets are labels of the same program, so that the assembler chooses between the 8-bit and
  // the 32-bit offset. The padding places a target at each limit of the 8-bit offset and one byte beyond.
  const jumpBlocks = (m: string, tag: string): string[] => {
    const lines: string[] = [];
    lines.push(`${tag}a:`, ...pad(126), `${m} ${tag}a`);
    lines.push(`${tag}b:`, ...pad(127), `${m} ${tag}b`);
    lines.push(`${m} ${tag}c`, ...pad(127), `${tag}c:`);
    lines.push(`${m} ${tag}d`, ...pad(128), `${tag}d:`);
    lines.push(`${m} ${tag}e`, `${tag}e:`, `${tag}f:`, `${m} ${tag}f`);
    return lines;
  };
  {
    const lines: string[] = ['top:', 'nop'];
    lines.push(...jumpBlocks('jmp', 'p'));
    lines.push('jmp far', 'jmp top', 'call far', 'call top', 'call near', 'near:', 'nop', `jmp ${hex(0x0040f000)}`, `call ${hex(0x00408000)}`, `jmp ${hex(0x0040fffb)}`);
    lines.push(...pad(0x3000), 'far:', 'jmp top', 'call top', 'jmp far', 'call far', 'nop');
    add('jmp-call', lines);
  }
  CC_NAMES.forEach((cc) => {
    const lines: string[] = ['top:', 'nop'];
    lines.push(...jumpBlocks(`j${cc}`, 'c'));
    lines.push(`j${cc} far`, `j${cc} top`, `j${cc} ${hex(0x0040c000)}`);
    lines.push(...pad(0x1000), 'far:', `j${cc} top`, `j${cc} far`, 'nop');
    add(`j${cc}`, lines);
  });
  return out;
}

/**
 * Valid encodings that the encoder does not choose; the decoder accepts each of them.
 * Encodings with a SIB byte that names no index register where none is needed are also accepted
 * by the decoder but are not listed here: the reference disassembler prints them with a
 * placeholder index name, so its text cannot be compared with that of the chosen encoding.
 */
function alternateEncodings(): { bytes: string; note: string }[] {
  const out: { bytes: string; note: string }[] = [];
  const h = (...b: number[]): string => b.map((x) => (x & 0xff).toString(16).padStart(2, '0')).join('');
  const le = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [m, ext] of Object.entries(ALU_EXT)) {
    out.push({ bytes: h((ext << 3) | 3, 0xc3), note: `${m} eax, ebx with the register-from-r/m opcode (direction bit set)` });
    out.push({ bytes: h(0x4c, (ext << 3) | 3, 0xe1), note: `${m} r12, rcx with the register-from-r/m opcode` });
    out.push({ bytes: h(0x81, 0xc3 | (ext << 3), ...le(5)), note: `${m} ebx, 5 with a 32-bit immediate where 8 bits suffice` });
    out.push({ bytes: h(0x48, 0x81, 0xc0 | (ext << 3) | 6, ...le(-3)), note: `${m} rsi, -3 with a 32-bit immediate where 8 bits suffice` });
    out.push({ bytes: h((ext << 3) | 5, ...le(5)), note: `${m} eax, 5 in the accumulator form with a 32-bit immediate` });
    out.push({ bytes: h(0x81, 0xc0 | (ext << 3), ...le(1000)), note: `${m} eax, 1000 with ModR/M instead of the accumulator form` });
    out.push({ bytes: h(0x48, 0x81, 0xc0 | (ext << 3), ...le(100000)), note: `${m} rax, 100000 with ModR/M instead of the accumulator form` });
    out.push({ bytes: h(0x81, 0x03 | (ext << 3), ...le(9)), note: `${m} dword ptr [rbx], 9 with a 32-bit immediate where 8 bits suffice` });
    out.push({ bytes: h(0x40, (ext << 3) | 1, 0xd8), note: `${m} eax, ebx with a REX prefix that has no bit set` });
  }
  out.push(
    { bytes: h(0x8b, 0xc3), note: 'mov eax, ebx with opcode 8B (register from r/m)' },
    { bytes: h(0x49, 0x8b, 0xe4), note: 'mov rsp, r12 with opcode 8B' },
    { bytes: h(0xc7, 0xc0, ...le(5)), note: 'mov eax, 5 with C7 /0 instead of B8+r' },
    { bytes: h(0x41, 0xc7, 0xc1, ...le(-1)), note: 'mov r9d, -1 with C7 /0 instead of B8+r' },
    { bytes: h(0x40, 0x89, 0xd8), note: 'mov eax, ebx with a REX prefix that has no bit set' },
    { bytes: h(0x42, 0x89, 0xd8), note: 'mov eax, ebx with REX.X set although there is no SIB byte' },
    { bytes: h(0x40, 0xb8, ...le(7)), note: 'mov eax, 7 with a REX prefix that has no bit set' },
    { bytes: h(0x69, 0xc3, ...le(5)), note: 'imul eax, ebx, 5 with a 32-bit immediate where 8 bits suffice' },
    { bytes: h(0x48, 0x69, 0xc3, ...le(-128)), note: 'imul rax, rbx, -128 with a 32-bit immediate' },
    { bytes: h(0xc1, 0xe0, 1), note: 'shl eax, 1 with C1 /4 ib instead of D1 /4' },
    { bytes: h(0xc1, 0xf8, 1), note: 'sar eax, 1 with C1 /7 ib instead of D1 /7' },
    { bytes: h(0x48, 0xc1, 0xeb, 1), note: 'shr rbx, 1 with C1 /5 ib instead of D1 /5' },
    { bytes: h(0xc1, 0x23, 1), note: 'shl dword ptr [rbx], 1 with C1 /4 ib' },
    { bytes: h(0x8b, 0x43, 0x00), note: 'mov eax, dword ptr [rbx] with an 8-bit displacement of zero' },
    { bytes: h(0x8b, 0x83, ...le(8)), note: 'mov eax, dword ptr [rbx + 8] with a 32-bit displacement where 8 bits suffice' },
    { bytes: h(0x8b, 0x83, ...le(0)), note: 'mov eax, dword ptr [rbx] with a 32-bit displacement of zero' },
    { bytes: h(0x8b, 0x84, 0x24, ...le(8)), note: 'mov eax, dword ptr [rsp + 8] with a 32-bit displacement where 8 bits suffice' },
    { bytes: h(0x8b, 0x44, 0x8b, 0x00), note: 'mov eax, dword ptr [rbx + rcx*4] with an 8-bit displacement of zero' },
    { bytes: h(0x48, 0x8d, 0x43, 0x00), note: 'lea rax, [rbx] with an 8-bit displacement of zero' },
    { bytes: h(0x0f, 0x94, 0xc8), note: 'sete al with a nonzero reg field, which SETcc ignores' },
    { bytes: h(0x40, 0x0f, 0x9c, 0xc3), note: 'setl bl with a REX prefix that has no bit set' },
    { bytes: h(0x0f, 0x95, 0x7b, 0x04), note: 'setne byte ptr [rbx + 4] with a nonzero reg field' },
    { bytes: h(0x40, 0x0f, 0xb6, 0xc3), note: 'movzx eax, bl with a REX prefix that has no bit set' },
    { bytes: h(0xff, 0xf0), note: 'push rax with FF /6 instead of 50+r' },
    { bytes: h(0x41, 0xff, 0xf4), note: 'push r12 with FF /6' },
    { bytes: h(0x8f, 0xc0), note: 'pop rax with 8F /0 instead of 58+r' },
    { bytes: h(0x41, 0x8f, 0xc5), note: 'pop r13 with 8F /0' },
    { bytes: h(0x48, 0x50), note: 'push rax with REX.W, which does not change the 64-bit operand size' },
    { bytes: h(0x48, 0x5b), note: 'pop rbx with REX.W' },
    { bytes: h(0xe9, ...le(0x10)), note: 'jmp with a 32-bit offset where 8 bits suffice' },
    { bytes: h(0x0f, 0x84, ...le(0x10)), note: 'je with a 32-bit offset where 8 bits suffice' },
    { bytes: h(0x0f, 0x8c, ...le(-0x20)), note: 'jl with a 32-bit offset where 8 bits suffice' },
    { bytes: h(0x40, 0xf7, 0xd8), note: 'neg eax with a REX prefix that has no bit set' },
    { bytes: h(0x40, 0xff, 0xc0), note: 'inc eax with a REX prefix that has no bit set' },
    { bytes: h(0x40, 0x85, 0xd8), note: 'test eax, ebx with a REX prefix that has no bit set' },
    { bytes: h(0x40, 0x0f, 0xaf, 0xc3), note: 'imul eax, ebx with a REX prefix that has no bit set' },
  );
  return out;
}

/**
 * Flags that the manual leaves undefined after the instruction. `readReg`, when given, reads a register in
 * the state before the instruction executes; a shift by cl then uses the masked count of that state, as a
 * shift by an immediate uses the masked immediate (SDM Vol. 2B, SAL/SAR/SHL/SHR: with a masked count of 0
 * no flag changes, and OF is defined for a masked count of 1).
 */
export function undefinedFlags(insn: Insn, readReg?: (name: string) => bigint): string[] {
  const m = insn.mnemonic;
  if (m === 'and' || m === 'or' || m === 'xor' || m === 'test') return ['AF'];
  if (m === 'imul') return ['SF', 'ZF', 'AF', 'PF'];
  if (m in SHIFT_EXT) {
    const count = insn.operands[1];
    let raw: number;
    if (count && count.t === 'imm') raw = count.value;
    else if (count && count.t === 'reg' && count.name === 'cl' && readReg) raw = Number(readReg('rcx') & 0xffn);
    // Without the state before the instruction the count in cl is unknown; OF is defined only when it is 1.
    else return ['OF', 'AF'];
    const first = insn.operands[0]!;
    const wide = first.t === 'reg' ? (REG64 as readonly string[]).includes(first.name) : first.t === 'mem' && first.size === 64;
    const masked = raw & (wide ? 63 : 31);
    return masked === 0 ? [] : masked === 1 ? ['AF'] : ['OF', 'AF'];
  }
  return [];
}

export const VALIDATION: ValidationSpec = {
  preamble: ['.intel_syntax noprefix', '.text', '.globl _start', '_start:'],
  sweeps,
  alternateEncodings: alternateEncodings(),
  undefinedFlags,
};
