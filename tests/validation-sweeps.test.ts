/**
 * The registers that the instruction sweeps use. docs/validation.md, section 3,
 * states them in the paragraph "Registers in the sweeps". The statements of
 * that paragraph are the titles of the tests below: each test computes the
 * registers of every operand from the sweeps, assembled as
 * scripts/export-validation.ts assembles them for the reference tools, and
 * asserts its statement, and one test requires the paragraph to consist of
 * exactly these statements. One further test asserts the statement of
 * section 4 on the RISC-V sweep lines whose offset the comparison with the
 * reference emulator cannot execute.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../scripts/lib/corpus.ts';
import { assembleText } from '../src/core/target/assemble.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import type { Backend, Insn } from '../src/core/target/types.ts';
import { CC_NAMES, REG32, REG64, REG8, REG8_HIGH, SHIFT_EXT } from '../src/core/target/x86/isa.ts';

/** The sentences that open the paragraph: what the test does, and which programs the statements concern. */
const INTRODUCTION =
  '`tests/validation-sweeps.test.ts` computes the registers of every operand from the sweeps and asserts each statement of this paragraph. ' +
  'The statements concern the sweeps of the instructions themselves, not the programs of pseudoinstructions and aliases, whose operands are chosen line by line.';

/** The statements of the paragraph, in its order. */
const STATEMENTS = {
  riscvMips:
    'On RISC-V and MIPS, every one of the 32 registers appears in every register operand of every instruction, the base register of a memory operand included.',
  aarch64:
    'On AArch64, every register number from 0 to 31 appears in every register operand of every instruction at each operand width, ' +
    'the base register of a load or store included; number 31 is the zero register or the stack pointer as the instruction defines.',
  aarch64Index:
    'The one exception is the index register of the register-offset loads and stores, which takes 16 of the register numbers as a W register ' +
    '(extended with uxtw or sxtw) and the other 16 as an X register (with lsl or sxtx), so every register number appears in it at one of the two widths.',
  x86Registers:
    'On x86-64, every register appears in every register operand of every instruction at each operand width, the 20 byte registers of `movzx` included, ' +
    'with two exceptions: the count register of a shift is always cl, and each SETcc condition is used with 7 of the byte registers, ' +
    'the 16 conditions together with all 20.',
  x86Memory:
    'Every register appears as the base, and every register except rsp, which cannot be an index, as the index, of the memory operand of every memory form ' +
    'that has neither a 64-bit memory operand nor an immediate and is neither a shift nor SETcc.',
  x86MemoryForms:
    'These forms are `lea` at both destination widths, `movzx`, `movsxd`, and the forms with a 32-bit memory operand of `mov`, ' +
    'the arithmetic and logic instructions, `test`, two-operand `imul`, `neg`, `not`, `inc`, and `dec`.',
  x86OtherForms:
    'Every other memory form, the three-operand `imul` among them, takes its memory operand from a sample of the same address expressions ' +
    'and uses fewer base registers, fewer index registers, or both.',
};

/** The instructions of the sweeps of a back end, without the programs of pseudoinstructions and aliases. */
function sweepInstructions(backend: Backend): Insn[] {
  const out: Insn[] = [];
  for (const sweep of backend.validation.sweeps()) {
    if (sweep.passthrough) continue;
    const r = assembleText(backend, sweep.text);
    if (!r.ok) throw new Error(`${backend.profile.id} sweep ${sweep.name} does not assemble`);
    for (const i of r.program.insns) if (i.insn !== null) out.push(i.insn);
  }
  return out;
}

/**
 * The names seen in each register position of each form. `form` names the form of an instruction; a position is
 * the index of a register operand, or `base` or `index` for the registers of a memory operand.
 */
function registersByForm(insns: Insn[], form: (insn: Insn) => string): Map<string, Map<string, Set<string>>> {
  const forms = new Map<string, Map<string, Set<string>>>();
  for (const insn of insns) {
    const key = form(insn);
    const positions = forms.get(key) ?? new Map<string, Set<string>>();
    forms.set(key, positions);
    const add = (position: string, name: string): void => {
      if (!positions.has(position)) positions.set(position, new Set());
      positions.get(position)!.add(name);
    };
    insn.operands.forEach((o, k) => {
      if (o.t === 'reg') add(String(k), o.name);
      if (o.t === 'mem' && o.base) add('base', o.base);
      if (o.t === 'mem' && o.index) add('index', o.index);
    });
  }
  return forms;
}

const sorted = (names: Iterable<string>): string[] => [...names].sort();

describe('docs/validation.md, section 3', () => {
  it('states in the paragraph on the registers in the sweeps exactly the statements that the tests below assert', () => {
    const text = readFileSync(join(repoRoot(), 'docs', 'validation.md'), 'utf8').replace(/\r\n/g, '\n');
    const paragraph = text.split('\n\n').find((p) => p.startsWith('Registers in the sweeps.')) ?? '';
    expect(paragraph.replace(/\s+/g, ' ').trim()).toBe(['Registers in the sweeps.', INTRODUCTION, ...Object.values(STATEMENTS)].join(' '));
  });

  it.each(availableBackends().map((b) => [b.profile.id, b] as const))('every implemented instruction is used by the sweeps of %s', (_id, backend) => {
    // The A64 catalog has one entry, b.cond, for the conditional branch of every condition.
    const swept = new Set(sweepInstructions(backend).map((i) => (backend.profile.id === 'aarch64' && /^b\.\w+$/.test(i.mnemonic) ? 'b.cond' : i.mnemonic)));
    expect(sorted(swept)).toEqual(sorted(backend.instructions.filter((s) => !s.pseudo).map((s) => s.mnemonic)));
  });
});

describe(STATEMENTS.riscvMips, () => {
  it.each(['riscv', 'mips'])('%s', (id) => {
    const backend = getBackend(id);
    const all = sorted(backend.profile.registers.map((r) => r.name));
    expect(all.length).toBe(32);
    const forms = registersByForm(sweepInstructions(backend), (insn) => insn.mnemonic);
    let positions = 0;
    for (const [mnemonic, byPosition] of forms) {
      for (const [position, names] of byPosition) {
        positions++;
        expect(sorted(names), `${mnemonic}, operand ${position}`).toEqual(all);
      }
    }
    // Every instruction with a register operand contributes; only the service instruction and the MIPS jumps j and jal have none.
    const without = [...forms].filter(([, byPosition]) => byPosition.size === 0).map(([mnemonic]) => mnemonic);
    expect(sorted(without)).toEqual(id === 'riscv' ? ['ecall'] : ['j', 'jal', 'syscall']);
    expect(positions).toBeGreaterThan(80);
  });
});

describe('docs/validation.md, section 4, RISC-V', () => {
  it('the sweep lines of loads, stores, and jalr whose offset would make the access misaligned or the target 2 modulo 4 use the base register zero', () => {
    // The exporter points the base register of a memory operand at a multiple of 4, so the offset decides the alignment.
    const accessSize: Record<string, number> = { lh: 2, lhu: 2, sh: 2, lw: 4, sw: 4 };
    const unaligned = (insn: Insn, disp: number): boolean => (insn.mnemonic === 'jalr' ? (disp & 2) !== 0 : (disp & (accessSize[insn.mnemonic]! - 1)) !== 0);
    const lines = new Map<string, { unaligned: number; alignedWithBase: number }>();
    for (const insn of sweepInstructions(getBackend('riscv'))) {
      if (insn.mnemonic !== 'jalr' && !(insn.mnemonic in accessSize)) continue;
      const counts = lines.get(insn.mnemonic) ?? { unaligned: 0, alignedWithBase: 0 };
      lines.set(insn.mnemonic, counts);
      for (const o of insn.operands) {
        if (o.t !== 'mem') continue;
        if (unaligned(insn, o.disp)) {
          counts.unaligned++;
          expect(o.base, `${insn.mnemonic} with offset ${o.disp}`).toBe('zero');
        } else if (o.base !== 'zero') counts.alignedWithBase++;
      }
    }
    expect(sorted(lines.keys())).toEqual(['jalr', 'lh', 'lhu', 'lw', 'sh', 'sw']);
    for (const [mnemonic, counts] of lines) {
      expect(counts.unaligned, mnemonic).toBeGreaterThan(0);
      expect(counts.alignedWithBase, mnemonic).toBeGreaterThan(30);
    }
  });
});

describe('AArch64', () => {
  const insns = sweepInstructions(getBackend('aarch64'));
  const width = (name: string): 'w' | 'x' => (name.startsWith('w') ? 'w' : 'x');
  /** Register number of a name; number 31 is the zero register or the stack pointer. */
  const number = (name: string): number => (/^[wx]\d+$/.test(name) ? Number(name.slice(1)) : 31);
  const numbers = (names: Iterable<string>): number[] => [...new Set([...names].map(number))].sort((a, b) => a - b);
  const every = Array.from({ length: 32 }, (_, n) => n);
  /**
   * A form is a mnemonic with the kinds of its operands and the width of each register operand. Shift and condition
   * operands are modifiers of a form, and the two halves of a 64-bit immediate count as one operand.
   */
  const form = (insn: Insn): string => {
    const operands = insn.operands.filter((o) => o.t !== 'shift' && o.t !== 'cond');
    const kinds = operands.map((o) => (o.t === 'reg' ? width(o.name) : o.t === 'mem' ? (o.index ? 'mem+index' : 'mem') : o.t));
    return `${insn.mnemonic} ${kinds.join(',').replace(/imm(,imm)+/, 'imm')}`;
  };
  const forms = registersByForm(insns, form);

  it(STATEMENTS.aarch64, () => {
    let positions = 0;
    for (const [key, byPosition] of forms) {
      for (const [position, names] of byPosition) {
        if (position === 'index') continue;
        positions++;
        // All names of one position have one width, since the form names the width.
        expect(new Set([...names].map(width)).size, `${key}, operand ${position}`).toBe(1);
        expect(numbers(names), `${key}, operand ${position}`).toEqual(every);
        // Number 31 has one meaning in a position: the zero register or the stack pointer of that width.
        const last = [...names].filter((n) => number(n) === 31);
        expect(last.length, `${key}, operand ${position}`).toBe(1);
        expect(['wzr', 'wsp', 'xzr', 'sp'], `${key}, operand ${position}`).toContain(last[0]);
      }
    }
    expect(positions).toBeGreaterThan(150);
    // Both widths of an instruction that has both are among the forms.
    for (const mnemonic of ['add', 'subs', 'and', 'orr', 'movz', 'lslv', 'madd', 'csel', 'ubfm', 'cbz', 'ldr', 'str']) {
      expect([...forms.keys()].filter((key) => key.startsWith(`${mnemonic} w`)).length, mnemonic).toBeGreaterThan(0);
      expect([...forms.keys()].filter((key) => key.startsWith(`${mnemonic} x`)).length, mnemonic).toBeGreaterThan(0);
    }
  });

  it(STATEMENTS.aarch64Index, () => {
    const indexed = [...forms].filter(([, byPosition]) => byPosition.has('index'));
    const loadsAndStores = ['ldr w', 'ldr x', 'str w', 'str x', 'ldrb w', 'strb w', 'ldrh w', 'strh w'].map((m) => `${m},mem+index`);
    expect(sorted(indexed.map(([key]) => key))).toEqual(sorted(loadsAndStores));
    for (const [key, byPosition] of indexed) {
      const names = [...byPosition.get('index')!];
      const w = numbers(names.filter((n) => width(n) === 'w'));
      const x = numbers(names.filter((n) => width(n) === 'x'));
      expect(w.length, key).toBe(16);
      expect(x.length, key).toBe(16);
      expect([...w, ...x].sort((a, b) => a - b), key).toEqual(every);
    }
    // A W index is extended with uxtw or sxtw, an X index with lsl or sxtx.
    const extensions = { w: new Set<string>(), x: new Set<string>() };
    for (const insn of insns) {
      for (const o of insn.operands) if (o.t === 'mem' && o.index) extensions[width(o.index)].add(o.ext ?? 'lsl');
    }
    expect(sorted(extensions.w)).toEqual(['sxtw', 'uxtw']);
    expect(sorted(extensions.x)).toEqual(['lsl', 'sxtx']);
  });
});

describe('x86-64', () => {
  const insns = sweepInstructions(getBackend('x86'));
  const r64: readonly string[] = REG64;
  const r32: readonly string[] = REG32;
  const bytes: readonly string[] = [...REG8, ...REG8_HIGH];
  const width = (name: string): string => (r64.includes(name) ? 'r64' : r32.includes(name) ? 'r32' : 'r8');
  const isShift = (mnemonic: string): boolean => mnemonic in SHIFT_EXT;
  const isSetcc = (mnemonic: string): boolean => CC_NAMES.some((cc) => mnemonic === `set${cc}`);
  /** A form is a mnemonic with the kinds of its operands, the width of each register operand, and the size of a memory operand. */
  const form = (insn: Insn): string => {
    const kinds = insn.operands.map((o) => (o.t === 'reg' ? width(o.name) : o.t === 'mem' ? `m${o.size ?? ''}` : o.t));
    return `${insn.mnemonic} ${kinds.join(',')}`;
  };
  const forms = registersByForm(insns, form);
  const mnemonicOf = (key: string): string => key.split(' ')[0]!;
  const kindsOf = (key: string): string[] => key.split(' ')[1]!.split(',');

  it(STATEMENTS.x86Registers, () => {
    let positions = 0;
    for (const [key, byPosition] of forms) {
      const mnemonic = mnemonicOf(key);
      for (const [position, names] of byPosition) {
        if (position === 'base' || position === 'index' || isSetcc(mnemonic)) continue;
        positions++;
        const kind = kindsOf(key)[Number(position)]!;
        if (isShift(mnemonic) && position === '1') expect(sorted(names), key).toEqual(['cl']);
        else if (kind === 'r8') expect(sorted(names), key).toEqual(sorted(bytes));
        else expect(sorted(names), `${key}, operand ${position}`).toEqual(sorted(kind === 'r64' ? r64 : r32));
      }
    }
    expect(positions).toBeGreaterThan(100);
    // The 20 byte registers are the second operand of movzx.
    expect(bytes.length).toBe(20);
    expect(sorted(forms.get('movzx r32,r8')!.get('1')!)).toEqual(sorted(bytes));
    // Every shift has forms with a count register.
    for (const mnemonic of Object.keys(SHIFT_EXT)) expect(forms.has(`${mnemonic} r32,r8`) && forms.has(`${mnemonic} m64,r8`), mnemonic).toBe(true);
    // SETcc: 7 byte registers for each of the 16 conditions, all 20 over the conditions.
    const used = new Set<string>();
    for (const cc of CC_NAMES) {
      const names = forms.get(`set${cc} r8`)!.get('0')!;
      expect(names.size, `set${cc}`).toBe(7);
      for (const n of names) used.add(n);
    }
    expect(CC_NAMES.length).toBe(16);
    expect(sorted(used)).toEqual(sorted(bytes));
  });

  /** The forms with a memory operand, with the base and index registers that the operand uses. */
  const memoryForms = [...forms].filter(([key]) => kindsOf(key).some((k) => k.startsWith('m'))).map(([key, byPosition]) => ({
    key, base: byPosition.get('base') ?? new Set<string>(), index: byPosition.get('index') ?? new Set<string>(),
  }));
  /** A memory form with a 64-bit memory operand or an immediate, or a shift or SETcc. */
  const sampled = (key: string): boolean => kindsOf(key).includes('m64') || kindsOf(key).includes('imm') || isShift(mnemonicOf(key)) || isSetcc(mnemonicOf(key));

  it(STATEMENTS.x86Memory, () => {
    const full = memoryForms.filter((f) => !sampled(f.key));
    expect(full.length).toBeGreaterThan(20);
    for (const f of full) {
      expect(sorted(f.base), f.key).toEqual(sorted(r64));
      expect(sorted(f.index), f.key).toEqual(sorted(r64.filter((r) => r !== 'rsp')));
    }
  });

  it(STATEMENTS.x86MemoryForms, () => {
    const twoOperand = ['mov', 'add', 'or', 'and', 'sub', 'xor', 'cmp'].flatMap((m) => [`${m} r32,m32`, `${m} m32,r32`]);
    const oneOperand = ['neg', 'not', 'inc', 'dec'].map((m) => `${m} m32`);
    const named = ['lea r32,m', 'lea r64,m', 'movzx r32,m8', 'movsxd r64,m32', ...twoOperand, 'test m32,r32', 'imul r32,m32', ...oneOperand];
    expect(sorted(memoryForms.filter((f) => !sampled(f.key)).map((f) => f.key))).toEqual(sorted(named));
  });

  it(STATEMENTS.x86OtherForms, () => {
    const others = memoryForms.filter((f) => sampled(f.key));
    expect(others.length).toBeGreaterThan(50);
    for (const f of others) {
      // Fewer than the 16 base registers, or fewer than the 15 index registers.
      expect(f.base.size < 16 || f.index.size < 15, f.key).toBe(true);
      for (const r of f.base) expect(r64, f.key).toContain(r);
      for (const r of f.index) expect(r64.filter((name) => name !== 'rsp'), f.key).toContain(r);
    }
    expect(others.map((f) => f.key)).toContain('imul r32,m32,imm');
    expect(others.map((f) => f.key)).toContain('imul r64,m64,imm');
  });
});
