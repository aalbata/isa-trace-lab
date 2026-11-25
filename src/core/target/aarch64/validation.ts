/**
 * Validation inputs for the A64 subset: instruction sweeps with boundary
 * operands for comparison against the reference assembler, disassembler, and
 * emulator. Every sweep line is one instruction, so the address of a line is
 * the code base plus four times its index.
 */
import { LAYOUT } from '../memory.ts';
import type { ValidationSpec } from '../types.ts';
import { COND_NAMES, decodeBitmask, regName } from './isa.ts';

type Sweep = { name: string; text: string; passthrough?: boolean };

const hex = (v: number): string => '0x' + v.toString(16);

/** Every distinct logical immediate of the given width, in increasing order. */
export function bitmaskImmediates(bits: 32 | 64): bigint[] {
  const seen = new Set<bigint>();
  for (let n = 0; n <= (bits === 64 ? 1 : 0); n++) {
    for (let imms = 0; imms < 64; imms++) {
      for (let immr = 0; immr < 64; immr++) {
        const v = decodeBitmask(n, immr, imms, bits);
        if (v !== null) seen.add(v);
      }
    }
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sweeps(): Sweep[] {
  const out: Sweep[] = [];
  const add = (name: string, lines: string[]): void => {
    out.push({ name, text: lines.join('\n') + '\n' });
  };
  const widths: (32 | 64)[] = [32, 64];
  const tag = (bits: number): string => (bits === 64 ? 'x' : 'w');
  /** Register i modulo 32 at the given width; number 31 is the zero register or the stack pointer. */
  const reg = (i: number, bits: 32 | 64, r31: 'sp' | 'zr' = 'zr'): string => regName(((i % 32) + 32) % 32, bits, r31);
  const at = (index: number): number => LAYOUT.codeBase + 4 * index;

  // Add and subtract: immediate and shifted-register forms, with and without flags.
  for (const m of ['add', 'adds', 'sub', 'subs']) {
    const flags = m.endsWith('s');
    for (const bits of widths) {
      const imms = [0, 1, 2, 4095, 2048, 1365, 7, 4094];
      const lines: string[] = [];
      for (let i = 0; i < 32; i++) {
        lines.push(`${m} ${reg(i, bits, flags ? 'zr' : 'sp')}, ${reg(i * 7 + 3, bits, 'sp')}, #${imms[i % imms.length]}${i % 3 === 1 ? ', lsl #12' : ''}`);
      }
      lines.push(`${m} ${reg(5, bits)}, ${reg(31, bits, 'sp')}, #4095, lsl #12`, `${m} ${reg(6, bits)}, ${reg(6, bits)}, #0, lsl #12`);
      add(`${m}-imm-${tag(bits)}`, lines);
      const top = bits - 1;
      const shifts = ['', ', lsl #1', `, lsr #${top}`, ', asr #5', `, lsl #${top}`, ', lsr #0', `, asr #${top}`, ', lsr #1'];
      const regLines: string[] = [];
      for (let i = 0; i < 32; i++) regLines.push(`${m} ${reg(i, bits)}, ${reg(i * 7 + 3, bits)}, ${reg(i * 11 + 5, bits)}${shifts[i % shifts.length]}`);
      regLines.push(`${m} ${reg(0, bits)}, ${reg(0, bits)}, ${reg(0, bits)}`, `${m} ${reg(31, bits)}, ${reg(31, bits)}, ${reg(31, bits)}, asr #3`);
      add(`${m}-reg-${tag(bits)}`, regLines);
    }
  }

  // Logical instructions: a spread of bitmask immediates, and shifted registers with all four shift types.
  for (const bits of widths) {
    const all = bitmaskImmediates(bits);
    const sample: bigint[] = [];
    for (let k = 0; k < 40; k++) sample.push(all[Math.floor((k * (all.length - 1)) / 39)]!);
    for (const m of ['and', 'orr', 'eor', 'ands']) {
      add(`${m}-imm-${tag(bits)}`, sample.map((v, i) => `${m} ${reg(i, bits, m === 'ands' ? 'zr' : 'sp')}, ${reg(i * 5 + 2, bits)}, #0x${v.toString(16)}`));
    }
    const top = bits - 1;
    const shifts = ['', ', lsl #4', `, lsr #${top}`, ', asr #9', `, ror #${top}`, ', ror #1', `, lsl #${top}`, ', asr #1'];
    for (const m of ['and', 'orr', 'eor', 'ands', 'orn', 'bic']) {
      const lines: string[] = [];
      for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i, bits)}, ${reg(i * 7 + 3, bits)}, ${reg(i * 11 + 5, bits)}${shifts[i % shifts.length]}`);
      lines.push(`${m} ${reg(1, bits)}, ${reg(31, bits)}, ${reg(2, bits)}`, `${m} ${reg(3, bits)}, ${reg(3, bits)}, ${reg(3, bits)}, ror #7`);
      add(`${m}-reg-${tag(bits)}`, lines);
    }
  }

  // Move wide: every shift position with boundary immediates.
  for (const m of ['movz', 'movn', 'movk']) {
    for (const bits of widths) {
      const imms = [0, 1, 0xffff, 0x8000, 0x1234, 0x00ff, 0xfffe, 0x7fff];
      const lines: string[] = [];
      for (let i = 0; i < 32; i++) {
        const shift = 16 * (i % (bits / 16));
        lines.push(`${m} ${reg(i, bits)}, #${hex(imms[(i * 3) % imms.length]!)}${shift ? `, lsl #${shift}` : ''}`);
      }
      add(`${m}-${tag(bits)}`, lines);
    }
  }

  // Shifts by a register, multiply-add, and conditional select.
  for (const bits of widths) {
    for (const m of ['lslv', 'lsrv', 'asrv']) {
      add(`${m}-${tag(bits)}`, Array.from({ length: 32 }, (_, i) => `${m} ${reg(i, bits)}, ${reg(i * 7 + 3, bits)}, ${reg(i * 11 + 5, bits)}`));
    }
    for (const m of ['madd', 'msub']) {
      add(`${m}-${tag(bits)}`, Array.from({ length: 32 }, (_, i) => `${m} ${reg(i, bits)}, ${reg(i * 7 + 3, bits)}, ${reg(i * 11 + 5, bits)}, ${reg(i * 13 + 31, bits)}`));
    }
    for (const m of ['csel', 'csinc']) {
      const lines: string[] = [];
      for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i, bits)}, ${reg(i * 7 + 3, bits)}, ${reg(i * 11 + 5, bits)}, ${COND_NAMES[i % 16]}`);
      lines.push(`${m} ${reg(4, bits)}, ${reg(31, bits)}, ${reg(31, bits)}, ne`, `${m} ${reg(4, bits)}, ${reg(7, bits)}, ${reg(7, bits)}, lt`);
      add(`${m}-${tag(bits)}`, lines);
    }
    for (const m of ['ubfm', 'sbfm']) {
      const top = bits - 1;
      const lines: string[] = [];
      for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i, bits)}, ${reg(i * 7 + 3, bits)}, #${(i * 5) % bits}, #${(i * 11 + 7) % bits}`);
      for (const [immr, imms] of [[0, top], [top, top], [0, 0], [1, 0], [top, 0], [0, 7], [0, 15], [0, 31 % bits], [top, top - 1], [bits / 2, bits / 2 - 1]]) {
        lines.push(`${m} ${reg(immr! + 1, bits)}, ${reg(imms! + 2, bits)}, #${immr}, #${imms}`);
      }
      add(`${m}-${tag(bits)}`, lines);
    }
  }

  // Branches. Targets are instructions of the same program or addresses outside it, at the extreme distances.
  for (const m of ['b', 'bl']) {
    const lines: string[] = [];
    for (const off of [-0x8000000, -0x400000, -0x10000, -4096, -4, 0, 4, 8, 4096, 0x10000, 0x7fffffc]) {
      const target = at(lines.length) + off;
      lines.push(`${m} ${target < 0 ? '0x' + ((1n << 64n) + BigInt(target)).toString(16) : hex(target)}`);
    }
    lines.push('nop', 'nop');
    add(m, lines);
  }
  {
    const lines: string[] = [];
    const total = 16 * 4 + 1;
    COND_NAMES.forEach((c, i) => {
      lines.push(`b.${c} ${hex(at(lines.length) - 0x100000)}`);
      lines.push(`b.${c} ${hex(at(lines.length) + 0xffffc)}`);
      lines.push(`b.${c} ${hex(at((i * 7 + 3) % total))}`);
      lines.push(`b.${c} ${hex(at(total - 1 - ((i * 5) % 9)))}`);
    });
    lines.push('nop');
    add('b.cond', lines);
  }
  for (const m of ['cbz', 'cbnz']) {
    for (const bits of widths) {
      const lines: string[] = [];
      const total = 34;
      for (let i = 0; i < 32; i++) {
        const target = i % 4 === 0 ? at(lines.length) - 0x100000 : i % 4 === 1 ? at(lines.length) + 0xffffc : at((i * 13 + 1) % total);
        lines.push(`${m} ${reg(i, bits)}, ${hex(target)}`);
      }
      lines.push('nop', 'nop');
      add(`${m}-${tag(bits)}`, lines);
    }
  }
  for (const m of ['br', 'blr', 'ret']) add(m, Array.from({ length: 32 }, (_, i) => `${m} ${reg(i, 64)}`));

  // Loads and stores: unsigned scaled offsets and register offsets with every extend.
  const memory = (m: string, bits: 32 | 64, size: number): void => {
    const max = 4095 * size;
    const offsets = [0, size, 2 * size, 8 * size, 255 * size, max - size, max, 1024 * size];
    const lines: string[] = [];
    for (let i = 0; i < 32; i++) lines.push(`${m} ${reg(i, bits)}, [${reg(i * 3 + 1, 64, 'sp')}, #${offsets[i % offsets.length]}]`);
    lines.push(`${m} ${reg(2, bits)}, [sp]`, `${m} ${reg(31, bits)}, [sp, #${max}]`);
    add(`${m}-offset-${tag(bits)}${size}`, lines);
    const amount = Math.log2(size);
    const forms: [string, 32 | 64][] = [['lsl', 64], ['uxtw', 32], ['sxtw', 32], ['sxtx', 64]];
    const indexed: string[] = [];
    for (let i = 0; i < 32; i++) {
      const [ext, indexBits] = forms[i % 4]!;
      const base = i * 3 + 1;
      // The index register differs from the base register, so that both can be given values inside the data region.
      const index = (i * 5 + 2) % 32 === base % 32 ? i * 5 + 3 : i * 5 + 2;
      const scaled = i % 8 < 4;
      const suffix = ext === 'lsl' && !scaled ? '' : `, ${ext}${scaled ? ` #${amount}` : ''}`;
      indexed.push(`${m} ${reg(i, bits)}, [${reg(base, 64, 'sp')}, ${reg(index, indexBits)}${suffix}]`);
    }
    add(`${m}-index-${tag(bits)}${size}`, indexed);
  };
  for (const m of ['ldr', 'str']) {
    memory(m, 32, 4);
    memory(m, 64, 8);
  }
  for (const m of ['ldrb', 'strb']) memory(m, 32, 1);
  for (const m of ['ldrh', 'strh']) memory(m, 32, 2);

  add('svc', ['svc #0', 'svc #1', 'svc #65535']);
  add('nop', ['nop']);

  // Aliases, given to the reference assembler as written. Its choice of canonical instruction must give the same bytes.
  const constants = [
    '0', '1', '-1', '0xffff', '0x10000', '0x12340000', '0xffff0000', '-2', '-65536', '0xfffeffff', '0x7fffffff', '0x80000000', '0x00ff00ff',
    '0x55555555', '0xaaaaaaaa', '0x0000ff00', '0xfffffffe', '0x3ffc', '0xf000000f', '0xffff', '-65537', '0x1fffe000',
  ];
  const aliases: string[] = constants.map((v, i) => `mov ${reg(i + 3, 32)}, #${v}`);
  for (const v of ['0', '-1', '0xffff', '0xffff0000', '0xffffffff', '0x1234000000000000', '-65536', '0xffffffff00000000', '0xffff0000ffff0000', '0x5555555555555555',
    '0xffffffffffff0000', '0x7fffffffffffffff', '0xffffffffffff', '0xfffffffffffe0000']) {
    aliases.push(`mov ${reg(aliases.length % 30, 64)}, #${v}`);
  }
  aliases.push(
    'mov w0, w1', 'mov x2, x3', 'mov w4, wzr', 'mov x5, sp', 'mov sp, x6', 'mov w7, wsp', 'mov wsp, w8',
    'mvn w0, w1', 'mvn x2, x3, lsl #7', 'neg w4, w5', 'neg x6, x7, asr #3', 'negs w8, w9', 'negs x10, x11, lsr #2',
    'cmp w0, w1', 'cmp x2, x3, lsl #4', 'cmp w4, #0', 'cmp w5, #4095', 'cmp w6, #4096', 'cmp x7, #16773120', 'cmp w8, #-1', 'cmp x9, #-4095', 'cmp wsp, #8',
    'cmn w0, w1', 'cmn x2, x3, asr #63', 'cmn w4, #5', 'cmn x5, #1, lsl #12', 'cmn w6, #-7',
    'tst w0, w1', 'tst x2, x3, ror #9', 'tst w4, #0xf', 'tst x5, #0xff00ff00ff00ff00',
    'mul w0, w1, w2', 'mul x3, x4, x5', 'mneg w6, w7, w8', 'mneg x9, x10, x11',
    'lsl w0, w1, #0', 'lsl w2, w3, #1', 'lsl w4, w5, #31', 'lsl x6, x7, #63', 'lsl x8, x9, #32', 'lsl w10, w11, w12', 'lsl x13, x14, x15',
    'lsr w0, w1, #0', 'lsr w2, w3, #31', 'lsr x4, x5, #63', 'lsr w6, w7, w8', 'lsr x9, x10, x11',
    'asr w0, w1, #0', 'asr w2, w3, #31', 'asr x4, x5, #63', 'asr w6, w7, w8', 'asr x9, x10, x11',
    ...COND_NAMES.slice(0, 14).flatMap((c, i) => [`cset ${reg(i, i % 2 ? 64 : 32)}, ${c}`, `cinc ${reg(i + 1, i % 2 ? 32 : 64)}, ${reg(i + 2, i % 2 ? 32 : 64)}, ${c}`]),
    'cset w0, cs', 'cset w0, cc',
    'ubfiz w0, w1, #3, #4', 'ubfiz x2, x3, #63, #1', 'ubfiz w4, w5, #0, #32', 'ubfx w6, w7, #3, #4', 'ubfx x8, x9, #0, #64', 'ubfx x10, x11, #62, #2',
    'sbfiz w0, w1, #3, #4', 'sbfiz x2, x3, #63, #1', 'sbfx w6, w7, #3, #4', 'sbfx x8, x9, #5, #59', 'sbfx w10, w11, #31, #1',
    'uxtb w0, w1', 'uxth w2, w3', 'sxtb w4, w5', 'sxtb x6, w7', 'sxth w8, w9', 'sxth x10, w11', 'sxtw x12, w13',
    'add w0, w1, #4096', 'add x2, x3, #-5', 'sub w4, w5, #-4095', 'adds x6, x7, #16773120', 'subs w8, w9, #-8192',
    'and w0, w1, #-16', 'orr x2, x3, #-2', 'eor w4, w5, #0x80000001',
    'ldr w0, [x1, x2, lsl #0]', 'ldr x3, [x4, w5, uxtw #0]', 'ldrb w6, [x7, x8, lsl #0]', 'strb w9, [x10, w11, sxtw #0]',
  );
  out.push({ name: 'aliases', text: aliases.join('\n') + '\n', passthrough: true });
  return out;
}

export const VALIDATION: ValidationSpec = {
  preamble: ['.text', '.globl _start', '_start:'],
  sweeps,
};
