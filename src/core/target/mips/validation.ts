/**
 * Validation inputs for MIPS32 Release 2: instruction sweeps with boundary
 * operands for comparison against the reference assembler, disassembler, and
 * emulator. Every branch and jump of a sweep is followed by a delay-slot
 * instruction that is not a control transfer, so that the two-step execution
 * of a branch (the branch, then its delay slot) is defined on both sides.
 */
import { LAYOUT } from '../memory.ts';
import type { ValidationSpec } from '../types.ts';
import { ENCODINGS, REG_NAMES } from './isa.ts';

const hex = (v: number): string => '0x' + (v >>> 0).toString(16).padStart(8, '0');

/** Delay-slot instruction of the sweeps: it changes a register, which shows that the slot executes. */
const SLOT = 'addiu $v1, $v1, 1';

function sweeps(): { name: string; text: string; passthrough?: boolean }[] {
  const out: { name: string; text: string; passthrough?: boolean }[] = [];
  const reg = (i: number): string => REG_NAMES[((i % 32) + 32) % 32]!;
  const signed16 = [-32768, -32767, -1, 0, 1, 2, 21845, -21846, 32766, 32767];
  const unsigned16 = [0, 1, 2, 255, 0x5555, 0xaaaa, 0x7fff, 0x8000, 0xfffe, 0xffff];
  // Offsets 1, 2, 3, and 32767 give misaligned word and halfword addresses, which must fault on both sides.
  const disp = [-32768, -4, 0, 4, 8, 32764, 1, 2, 3, 32767];

  for (const enc of ENCODINGS) {
    const lines: string[] = [];
    const m = enc.mnemonic;
    let words = 0;
    const emit = (line: string): void => {
      lines.push(line);
      words++;
    };
    const pad = (n: number): void => {
      lines.push(`.word ${Array.from({ length: n }, () => '0').join(', ')}`);
      words += n;
    };
    // The address of each instruction is known because every instruction is four bytes.
    const here = (): number => LAYOUT.codeBase + 4 * words;
    switch (enc.format) {
      case 'R3':
      case 'SHV':
        for (let i = 0; i < 32; i++) emit(`${m} ${reg(i)}, ${reg(i * 7 + 3)}, ${reg(i * 11 + 5)}`);
        emit(`${m} $a0, $a0, $a0`);
        emit(`${m} $zero, $ra, $ra`);
        emit(`${m} $t0, $t1, $zero`);
        emit(`${m} $t0, $zero, $t1`);
        break;
      case 'SHI':
        for (let s = 0; s < 32; s++) emit(`${m} ${reg(s + 1)}, ${reg(s + 9)}, ${s}`);
        emit(`${m} $zero, $zero, 0`);
        emit(`${m} $ra, $ra, 31`);
        break;
      case 'JR':
        // The stack pointer of every case is a mapped, aligned address; the other registers hold arbitrary values.
        for (let i = 0; i < 32; i++) {
          emit(`${m} ${reg(i)}`);
          emit(i % 2 === 0 ? SLOT : 'nop');
        }
        for (let i = 0; i < 8; i++) {
          emit(`${m} $sp`);
          emit(SLOT);
        }
        break;
      case 'JALR':
        // The destination differs from the target register in every line; equal registers are UNPREDICTABLE.
        for (let i = 0; i < 32; i++) {
          emit(`${m} ${reg(i)}, ${reg(i + 7)}`);
          emit(i % 2 === 0 ? SLOT : 'nop');
        }
        for (let i = 0; i < 32; i++) {
          if (reg(i) === '$sp') continue;
          emit(`${m} ${reg(i)}, $sp`);
          emit(SLOT);
        }
        emit(`${m} $t9`);
        emit('nop');
        break;
      case 'SYS':
        emit(m);
        emit(`${m} 1`);
        emit(`${m} 1048575`);
        break;
      case 'I':
        signed16.forEach((v, i) => emit(`${m} ${reg(i + 5)}, ${reg(i * 3 + 9)}, ${v}`));
        for (let i = 0; i < 32; i++) emit(`${m} ${reg(i)}, ${reg(31 - i)}, ${((i * 2731) % 65536) - 32768}`);
        emit(`${m} $t0, $t0, -1`);
        break;
      case 'IU':
        unsigned16.forEach((v, i) => emit(`${m} ${reg(i + 5)}, ${reg(i * 3 + 9)}, ${v}`));
        for (let i = 0; i < 32; i++) emit(`${m} ${reg(i)}, ${reg(31 - i)}, ${(i * 2731) % 65536}`);
        emit(`${m} $t0, $t0, 65535`);
        break;
      case 'LUI':
        unsigned16.forEach((v, i) => emit(`${m} ${reg(i + 10)}, ${v}`));
        for (let i = 0; i < 32; i++) emit(`${m} ${reg(i)}, ${(i * 0x8421) & 0xffff}`);
        break;
      case 'M':
        disp.forEach((d, i) => emit(`${m} ${reg(i + 10)}, ${d}(${reg(i + 5)})`));
        for (let i = 0; i < 32; i++) emit(`${m} ${reg(i)}, ${(i * 8) % 64}(${reg(i + 1)})`);
        for (let i = 0; i < 8; i++) emit(`${m} ${reg(i + 8)}, ${i - 4}(${reg(i + 16)})`);
        break;
      case 'B1':
      case 'B2': {
        // Targets inside the program are 4096 bytes back and 4096 bytes ahead of the block of branches,
        // and instructions of the block itself. The extreme offsets of the 18-bit field lie outside the
        // 65536-byte code region and are given as absolute addresses. Across the 32 branches of the block,
        // every register appears as rs and, for beq and bne, every register appears as rt.
        const base = LAYOUT.codeBase;
        const operands = (i: number): string => (enc.format === 'B2' ? `${reg(i)}, ${reg(i * 5 + 3)}` : reg(i));
        const branch = (ops: string, target: number): void => {
          emit(`${m} ${ops}, ${hex(target)}`);
          emit(SLOT);
        };
        pad(1024);
        const block = here();
        const count = 32;
        const blockBytes = 8 * (count + 6);
        branch(operands(4), base);
        branch(operands(5), block + blockBytes + 4096);
        branch(operands(6), here() + 4 - 131072);
        branch(operands(7), here() + 4 + 131068);
        for (let i = 0; i < count; i++) branch(operands(i), block + 8 * ((i * 5 + 3) % count));
        if (enc.format === 'B2') {
          branch('$t0, $t0', block);
          branch('$zero, $zero', block + 8);
        } else {
          branch('$zero', block);
          branch('$sp', block + 8);
        }
        pad(1024);
        emit('nop');
        break;
      }
      case 'J': {
        // The target field is absolute within the 256 MB region; the first and last words of the region,
        // the neighbours of the program, and instructions of the program are used.
        const targets = [0x00000000, 0x0ffffffc, LAYOUT.codeBase - 4, LAYOUT.codeBase + LAYOUT.codeSize, 0x08000000, 0x07fffffc, 0x05555554, 0x0aaaaaa8];
        for (const t of targets) {
          emit(`${m} ${hex(t)}`);
          emit(SLOT);
        }
        const block = here();
        for (let i = 0; i < 8; i++) {
          emit(`${m} ${hex(block + 8 * ((i * 3 + 1) % 8))}`);
          emit(i % 2 === 0 ? SLOT : 'nop');
        }
        break;
      }
    }
    out.push({ name: m, text: lines.join('\n') + '\n' });
  }

  // Pseudoinstruction expansions, compared with the expansions of the reference assembler. The program is
  // straight-line code, so that expansions that differ can be compared by executing both. The branch
  // pseudoinstructions b, beqz, and bnez are therefore absent here. The compiled programs use them, and the
  // code generator takes their expansions from the assembler (expandB and expandBranchZero in text.ts).
  const li = [
    0, 1, -1, 32767, -32768, 32768, -32769, 65535, 65536, 65537, 100000, 0x12345678, 0x7fffffff, -2147483648, -2147483647,
    0x7fff8000, 0x7fff7fff, -65536, -65535, 0x8000, 0x80000000, 0xffffffff, 0xffff8000, 0xffff7fff, 305419896, 4294901760,
  ];
  const pseudo: string[] = li.map((v, i) => `li ${reg(i + 2)}, ${v}`);
  pseudo.push('nop', 'move $a0, $a1', 'move $s7, $t9', 'move $t0, $zero', 'negu $a2, $a3', 'negu $t0, $t0', 'not $a0, $a1', 'not $s0, $ra');
  out.push({ name: 'pseudo', text: pseudo.join('\n') + '\n', passthrough: true });
  return out;
}

export const VALIDATION: ValidationSpec = {
  // noreorder keeps every instruction where it is written, so delay slots are explicit; noat forbids
  // expansions that would use $at. `_start` is the code base address.
  preamble: ['.set noreorder', '.set noat', '.text', '.globl _start', '_start:'],
  sweeps,
};
