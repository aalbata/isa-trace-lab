/**
 * Validation inputs for RV32I: instruction sweeps with boundary operands for
 * comparison against the reference assembler, disassembler, and emulator.
 */
import { LAYOUT } from '../memory.ts';
import type { ValidationSpec } from '../types.ts';
import { ENCODINGS, REG_NAMES } from './isa.ts';

const hex = (v: number): string => '0x' + (v >>> 0).toString(16).padStart(8, '0');

/** Bytes accessed by each load and store. */
const ACCESS_SIZE: Record<string, number> = { lb: 1, lbu: 1, sb: 1, lh: 2, lhu: 2, sh: 2, lw: 4, sw: 4 };

/**
 * True when the instruction-level comparison can execute `mnemonic` with offset `d`. The exporter points the base
 * register of a memory operand at a multiple of 4 in the data region (scripts/export-validation.ts). This profile
 * requires naturally aligned halfword and word accesses and jump targets that are multiples of 4, while the
 * reference emulator performs misaligned accesses and accepts targets that are 2 mod 4.
 */
function executableOffset(mnemonic: string, d: number): boolean {
  // jalr clears bit 0 of base + d, so the target is a multiple of 4 when bit 1 of d is 0.
  if (mnemonic === 'jalr') return (d & 2) === 0;
  return (d & (ACCESS_SIZE[mnemonic]! - 1)) === 0;
}

function sweeps(): { name: string; text: string; passthrough?: boolean }[] {
  const out: { name: string; text: string; passthrough?: boolean }[] = [];
  const reg = (i: number): string => REG_NAMES[((i % 32) + 32) % 32]!;
  const imm12 = [-2048, -2047, -1, 0, 1, 2, 1365, -1366, 2046, 2047];
  const disp = [-2048, -4, 0, 4, 8, 2044];
  // Offsets whose two low bits take every value, with both extremes and middle values of the 12-bit field.
  const lowBits = [-2047, -2046, -2045, -1368, -1366, -3, -2, -1, 1, 2, 3, 5, 6, 7, 1364, 1365, 2045, 2046, 2047];
  // An offset that the comparison cannot execute is given base x0: the address then lies outside every memory
  // region, so both sides fault and the line still checks the encoding of the offset.
  const lowBitLines = (m: string): string[] =>
    lowBits.map((d, i) => `${m} ${reg(i + 12)}, ${d}(${executableOffset(m, d) ? reg(1 + ((i * 7) % 31)) : 'zero'})`);
  const upper = [0, 1, 0x12345, 0x7ffff, 0x80000, 0xfffff];

  for (const enc of ENCODINGS) {
    const lines: string[] = [];
    const m = enc.mnemonic;
    // The address of each instruction is known because every instruction is four bytes.
    const here = (): number => LAYOUT.codeBase + 4 * lines.length;
    switch (enc.format) {
      case 'R':
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${reg(i * 7 + 3)}, ${reg(i * 11 + 5)}`);
        lines.push(`${m} a0, a0, a0`, `${m} zero, t6, t6`);
        break;
      case 'I':
        imm12.forEach((v, i) => lines.push(`${m} ${reg(i + 5)}, ${reg(i * 3 + 9)}, ${v}`));
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${reg(31 - i)}, ${(i * 37) % 2048 - 1024}`);
        break;
      case 'SH':
        for (let s = 0; s < 32; s++) lines.push(`${m} ${reg(s + 1)}, ${reg(s + 9)}, ${s}`);
        break;
      case 'L':
      case 'JR':
        disp.forEach((d, i) => lines.push(`${m} ${reg(i + 10)}, ${d}(${reg(i + 5)})`));
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${(i * 8) % 64}(${reg(i + 1)})`);
        lines.push(...lowBitLines(m));
        break;
      case 'S':
        disp.forEach((d, i) => lines.push(`${m} ${reg(i + 10)}, ${d}(${reg(i + 5)})`));
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${(i * 8) % 64}(${reg(i + 1)})`);
        lines.push(...lowBitLines(m));
        break;
      case 'B': {
        // Targets are addresses of instructions of the same program, so the reference assembler keeps the
        // short form. Padding places one target 4096 bytes back and one 4092 bytes ahead.
        const base = LAYOUT.codeBase;
        const zeros = (n: number): string => `.word ${Array.from({ length: n }, () => '0').join(', ')}`;
        lines.push(zeros(1024));
        const at = base + 4096;
        lines.push(`${m} a0, a1, ${hex(base)}`);
        lines.push(`${m} a2, a3, ${hex(base + 8192)}`);
        for (let i = 0; i < 16; i++) lines.push(`${m} ${reg(i * 2)}, ${reg(i * 2 + 1)}, ${hex(at + 8 + 4 * ((i * 5 + 3) % 16))}`);
        // Every register as rs1 and as rs2: i maps one-to-one to 7i + 3 modulo 32. Targets lie among the branches.
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${reg(i * 7 + 3)}, ${hex(at + 8 + 4 * ((i * 5 + 3) % 48))}`);
        lines.push(zeros((8192 - (4096 + 8 + 64 + 128)) / 4));
        lines.push('addi zero, zero, 0');
        break;
      }
      case 'U':
        upper.forEach((v, i) => lines.push(`${m} ${reg(i + 10)}, ${v}`));
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${(i * 0x8421) & 0xfffff}`);
        break;
      case 'J':
        for (const off of [-1048576, -65536, -4096, -4, 0, 4, 8, 4096, 65536, 1048572]) {
          lines.push(`${m} ${reg(lines.length + 1)}, ${hex(here() + off)}`);
        }
        // Every register as rd, jumping two instructions forward or back.
        for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i)}, ${hex(here() + (i % 2 === 0 ? 8 : -8))}`);
        break;
      case 'SYS':
        lines.push(m);
        break;
    }
    out.push({ name: m, text: lines.join('\n') + '\n' });
  }

  // Pseudoinstruction expansions, compared with the expansions of the reference assembler. The program is
  // straight-line code, so that expansions that differ can be compared by executing both. Each line writes a
  // register that no other line writes, so that the result of every line remains in the final registers.
  const li = [0, 1, -1, 2047, -2048, 2048, -2049, 4096, 4095, 65535, 65536, 100000, 0x12345678, 0x7fffffff, -2147483648, -2147483647, 0x7ffff800, 0x7ffff7ff, -4096, 0x800, -0x801, 305419896];
  const pseudo: string[] = li.map((v, i) => `li ${reg(i + 5)}, ${v}`);
  pseudo.push('nop', 'mv ra, a1', 'mv s11, t6', 'not sp, a1', 'neg gp, a3', 'seqz tp, a5', 'snez t3, a7', 'sltz t4, t1', 'sgtz t5, s0');
  out.push({ name: 'pseudo', text: pseudo.join('\n') + '\n', passthrough: true });
  return out;
}

export const VALIDATION: ValidationSpec = {
  preamble: ['.text', '.globl _start', '_start:'],
  sweeps,
};
