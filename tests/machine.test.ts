/**
 * The simulated machine: the values its state reader reports for source
 * variables kept in registers and in stack slots and for arrays, the record
 * of written memory bytes, the arguments of main, the loading of program
 * images, instruction fetch faults, the labels and branch relaxation of the
 * assembler driver, and the interfaces that the backends implement.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ArgumentCountError, compareTargets, compileProgram, encodeAssembly, evaluateReference, FAMILIES, generateProgram, machineFromBytes, simulate, traceProgram,
} from '../src/core/api.ts';
import type { CompiledProgram } from '../src/core/compile.ts';
import { compileBackEnd, compileFrontEnd } from '../src/core/compile.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import { Machine, loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { LAYOUT, Memory } from '../src/core/target/memory.ts';
import type { Backend, RegisterInfo, ValidationSpec } from '../src/core/target/types.ts';

const backends = availableBackends();

/** Seven variables: x86-64 has six registers for variables, so g is kept in a stack slot there and in a register elsewhere. */
const SEVEN = 'def main():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    g = 7\n    return a + b + c + d + e + f + g\n';

const FOURTEEN = 'def main():\n' + 'abcdefghijklmn'.split('').map((v, i) => `    ${v} = ${i + 1}\n`).join('') + '    return a + n\n';

function compiled(source: string, target: string): CompiledProgram {
  const r = compileProgram(source, target);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('\n'));
  return r.compiled;
}

function slotVariables(c: CompiledProgram): string[] {
  return c.variables.filter((v) => !v.hidden && v.home.kind === 'slot').map((v) => v.name);
}

/** Assigned source variables reported by the reference evaluator at every boundary and after the run. */
function referenceStates(source: string, args: readonly number[]) {
  const front = compileFrontEnd(source);
  if (!front.ok) throw new Error('the program has errors');
  const boundaries: Record<string, number>[] = [];
  const outcome = evaluateReference(front.checked, args, {
    onBoundary: (_stmt, state) => {
      const values: Record<string, number> = {};
      for (const v of front.checked.vars) {
        const value = state.variable(v.name);
        if (value !== undefined) values[v.name] = value;
      }
      boundaries.push(values);
    },
  });
  return { front, boundaries, outcome };
}

/** Source variables reported by a simulator at every boundary and after the run. */
function machineStates(source: string, backend: Backend, args: readonly number[]) {
  const front = compileFrontEnd(source);
  const c = compileBackEnd(source, front.ir!, backend);
  const visible = c.variables.filter((v) => !v.hidden);
  const m = loadCompiled(backend, c, { args });
  const read = (): Record<string, number> => {
    const values: Record<string, number> = {};
    for (const v of visible) {
      const value = m.reader.variable(v.name);
      if (value !== undefined) values[v.name] = value;
    }
    return values;
  };
  const boundaries: Record<string, number>[] = [];
  m.onBoundary = () => boundaries.push(read());
  const outcome = m.run();
  return { compiled: c, boundaries, outcome, final: read() };
}

describe('source variables kept in stack slots', () => {
  it('reads a variable kept in a stack slot as unassigned until the program stores it', () => {
    const homes = Object.fromEntries(backends.map((b) => [b.profile.id, compiled(SEVEN, b.profile.id).variables.find((v) => v.name === 'g')!.home.kind]));
    expect(homes).toEqual({ riscv: 'reg', mips: 'reg', aarch64: 'reg', x86: 'slot' });
    const cmp = compareTargets(SEVEN, [], backends);
    expect(cmp.outcomesAgree).toBe(true);
    expect(cmp.boundaries.filter((row) => !row.agree).map((row) => row.ordinal)).toEqual([]);
    expect(cmp.boundariesAgree).toBe(true);
    expect(cmp.boundaries[0]!.variables.x86).toEqual({});
    expect(cmp.boundaries[6]!.variables.x86).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expect(cmp.boundaries[7]!.variables.x86).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 });
    const trace = traceProgram(compiled(SEVEN, 'x86'), 'x86');
    expect(trace.boundaries[0]!.variables).toEqual({});
    expect(trace.boundaries[7]!.variables['g']).toBe(7);
  });

  it('agrees across targets at every boundary when x86-64 keeps the seventh variable of main(n) in a stack slot', () => {
    const source = 'def main(n):\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    return a + b + c + d + e + f + n\n';
    expect(slotVariables(compiled(source, 'x86'))).toEqual(['f']);
    const cmp = compareTargets(source, [0], backends);
    expect(cmp.outcomesAgree).toBe(true);
    expect(cmp.boundariesAgree).toBe(true);
    expect(cmp.boundaries).toHaveLength(7);
    for (const row of cmp.boundaries.slice(0, 6)) for (const b of backends) expect(row.variables[b.profile.id]!['f'], `boundary ${row.ordinal}`).toBeUndefined();
    for (const b of backends) expect(cmp.boundaries[6]!.variables[b.profile.id]!['f']).toBe(6);
  });

  it('reports the final values of variables kept in stack slots after main returns', () => {
    const { outcome } = referenceStates(FOURTEEN, []);
    expect(Object.keys(outcome.finalVars)).toHaveLength(14);
    for (const b of backends) {
      const c = compiled(FOURTEEN, b.profile.id);
      expect(slotVariables(c).length, b.profile.id).toBeGreaterThan(0);
      const run = simulate(c, b.profile.id);
      expect(run.outcome.returnValue).toBe(15);
      expect(run.variables, b.profile.id).toEqual(outcome.finalVars);
    }
  });

  it('forgets the stores of an earlier run when the machine is reset', () => {
    const m = loadCompiled(getBackend('x86'), compiled(SEVEN, 'x86'));
    const seen: (number | undefined)[] = [];
    m.onBoundary = () => seen.push(m.reader.variable('g'));
    const first = m.run();
    const expected = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, 7];
    expect(seen).toEqual(expected);
    expect(m.reader.variable('g')).toBe(7);
    seen.length = 0;
    m.reset();
    expect(m.reader.variable('g')).toBeUndefined();
    expect(m.run()).toEqual(first);
    expect(seen).toEqual(expected);
  });

  it('does not report a variable kept in a stack slot that a runtime error left unassigned', () => {
    const source = 'def main(n):\n    x = [1, 2, 3]\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    t = x[n]\n    g = 7\n    return a + b + c + d + e + t + g\n';
    expect(slotVariables(compiled(source, 'x86'))).toEqual(['t', 'g']);
    const { outcome } = referenceStates(source, [5]);
    expect(outcome.status).toBe('trap');
    expect(outcome.finalVars).toEqual({ n: 5, a: 1, b: 2, c: 3, d: 4, e: 5 });
    for (const b of backends) {
      const run = simulate(compiled(source, b.profile.id), b.profile.id, { args: [5] });
      expect(run.outcome.status).toBe('trap');
      expect(run.variables, b.profile.id).toEqual(outcome.finalVars);
    }
  });

  it('matches the reference evaluator in both directions at every boundary and after the run on generated programs', () => {
    let runs = 0;
    let slotRuns = 0;
    for (const family of FAMILIES) {
      for (let init = 1; init <= 20; init++) {
        const p = generateProgram(init, family);
        const args = p.args[0]!;
        const ref = referenceStates(p.source, args);
        for (const b of backends) {
          const got = machineStates(p.source, b, args);
          const where = `${family} ${init} ${b.profile.id}`;
          if (slotVariables(got.compiled).length > 0) slotRuns++;
          expect(got.boundaries, where).toEqual(ref.boundaries);
          if (got.outcome.status !== 'limit') expect(got.final, where).toEqual(ref.outcome.finalVars);
          runs++;
        }
      }
    }
    expect(runs).toBe(FAMILIES.length * 20 * backends.length);
    expect(slotRuns).toBeGreaterThan(20);
  });

  it('matches the reference evaluator at every boundary when the frame of main lies in the data region', () => {
    let slotRuns = 0;
    for (const family of FAMILIES) {
      for (let init = 1; init <= 12; init++) {
        const p = generateProgram(init, family);
        const args = p.args[0]!;
        const ref = referenceStates(p.source, args);
        for (const b of backends) {
          const c = compileBackEnd(p.source, ref.front.ir!, b);
          const slots = slotVariables(c);
          if (slots.length === 0) continue;
          // An unused part of the data region above the arrays, which a program loads from and stores to like the stack.
          const arraysEnd = c.arrays.reduce<number>((end, a) => Math.max(end, a.address + 4 * a.length), LAYOUT.dataBase);
          const frame = (arraysEnd + 64 + 15) & ~15;
          expect(frame + c.frame.size).toBeLessThan(LAYOUT.dataBase + LAYOUT.dataSize);
          slotRuns++;
          const m = loadCompiled(b, c, { args });
          const where = `${family} ${init} ${b.profile.id}`;
          let k = 0;
          m.onBoundary = () => {
            // The stack pointer moves at the first boundary, before the program has stored a slot, so the
            // program computes the same values with its frame in the data region.
            if (k === 0) m.cpu.writeReg(b.profile.conventions.stackPointer, BigInt(frame));
            const want = ref.boundaries[k] ?? {};
            for (const name of slots) expect(m.reader.variable(name), `${where} boundary ${k} ${name}`).toBe(want[name]);
            k++;
          };
          m.run();
          expect(k, where).toBe(ref.boundaries.length);
        }
      }
    }
    expect(slotRuns).toBeGreaterThan(20);
  });
});

describe('record of written memory', () => {
  const stackBase = LAYOUT.stackTop - LAYOUT.stackSize;

  it('marks the bytes that a store or an edit writes in the data and stack regions', () => {
    const mem = new Memory();
    for (const base of [LAYOUT.dataBase, stackBase]) {
      expect(mem.wasWritten(base + 8, 4)).toBe(false);
      mem.write(base + 8, 4, 0x11223344);
      expect(mem.wasWritten(base + 8, 4)).toBe(true);
      // A range has been written only when every byte of it has.
      expect(mem.wasWritten(base + 6, 4)).toBe(false);
      expect(mem.wasWritten(base + 10, 4)).toBe(false);
      mem.write(base + 12, 1, 0x55);
      mem.write(base + 13, 2, 0x6677);
      expect(mem.wasWritten(base + 8, 7)).toBe(true);
      expect(mem.wasWritten(base + 12, 4)).toBe(false);
      mem.write64(base + 32, 0x0102030405060708n);
      expect(mem.wasWritten(base + 32, 8)).toBe(true);
      expect(mem.wasWritten(base + 28, 8)).toBe(false);
      expect(mem.poke(base + 64, [1, 2, 3])).toBe(true);
      expect(mem.wasWritten(base + 64, 3)).toBe(true);
      expect(mem.wasWritten(base + 64, 4)).toBe(false);
    }
    // A store that faults writes nothing.
    expect(() => mem.write(LAYOUT.dataBase + LAYOUT.dataSize - 2, 4, 1)).toThrow('store to unmapped address');
    expect(mem.wasWritten(LAYOUT.dataBase + LAYOUT.dataSize - 2, 2)).toBe(false);
    mem.write(LAYOUT.dataBase + LAYOUT.dataSize - 4, 4, 1);
    expect(mem.wasWritten(LAYOUT.dataBase + LAYOUT.dataSize - 4, 4)).toBe(true);
    // A range across the end of a region, outside the regions, or at no whole address has not been written.
    expect(mem.wasWritten(LAYOUT.dataBase + LAYOUT.dataSize - 2, 4)).toBe(false);
    expect(mem.wasWritten(LAYOUT.dataBase - 2, 4)).toBe(false);
    expect(mem.wasWritten(0, 4)).toBe(false);
    expect(mem.wasWritten(2 ** 32 + LAYOUT.dataBase + 8, 4)).toBe(false);
    expect(mem.wasWritten(Number.NaN, 4)).toBe(false);
    expect(mem.wasWritten(LAYOUT.dataBase + 8.5, 2)).toBe(false);
    // The code region keeps no record: a program cannot store to it.
    expect(mem.poke(LAYOUT.codeBase, [1, 2, 3, 4])).toBe(true);
    expect(mem.wasWritten(LAYOUT.codeBase, 4)).toBe(false);
    expect(() => mem.write(LAYOUT.codeBase, 4, 1)).toThrow('store to the read-only code region');
    // The bytes of a program image that the loader places are not written bytes.
    expect(mem.loadImage(LAYOUT.dataBase + 128, [9, 9, 9, 9])).toBe(true);
    expect(mem.peek32(LAYOUT.dataBase + 128)).toBe(0x09090909);
    expect(mem.wasWritten(LAYOUT.dataBase + 128, 4)).toBe(false);
    expect(mem.loadImage(LAYOUT.dataBase + LAYOUT.dataSize - 2, [9, 9, 9, 9])).toBe(false);
    mem.clearWritten();
    for (const base of [LAYOUT.dataBase, stackBase]) {
      expect(mem.wasWritten(base + 8, 4)).toBe(false);
      expect(mem.wasWritten(base + 32, 8)).toBe(false);
      expect(mem.peek32(base + 8)).toBe(0x11223344);
    }
  });

  it('does not count the data image as written and forgets the stores of a run on reset', () => {
    const source = 'def main():\n    x = [1, 2, 3, 4]\n    x[2] = 9\n    return x[2]\n';
    for (const b of backends) {
      const c = compiled(source, b.profile.id);
      const m = loadCompiled(b, c);
      const at = c.arrays[0]!.address;
      const written = (): boolean[] => [0, 1, 2, 3].map((k) => m.mem.wasWritten(at + 4 * k, 4));
      expect([0, 1, 2, 3].map((k) => m.mem.peek32(at + 4 * k)), b.profile.id).toEqual([1, 2, 3, 4]);
      expect(written(), b.profile.id).toEqual([false, false, false, false]);
      expect(m.run().returnValue, b.profile.id).toBe(9);
      expect(written(), b.profile.id).toEqual([false, false, true, false]);
      m.reset();
      expect(written(), b.profile.id).toEqual([false, false, false, false]);
      expect(m.mem.peek32(at + 8), b.profile.id).toBe(3);
    }
  });
});

describe('arrays', () => {
  type Arrays = Record<string, number[]>;

  /** The arrays that a state reader reports; an array that reads as undefined is left out. */
  function reported(names: readonly string[], read: (name: string) => readonly number[] | undefined): Arrays {
    const out: Arrays = {};
    for (const name of names) {
      const values = read(name);
      if (values !== undefined) out[name] = values.slice();
    }
    return out;
  }

  /** Arrays that the reference evaluator reports at every boundary and holds after the run. */
  function referenceArrays(source: string, args: readonly number[]) {
    const front = compileFrontEnd(source);
    if (!front.ok) throw new Error('the program has errors');
    const names = front.checked.arrays.map((a) => a.name);
    const boundaries: Arrays[] = [];
    const outcome = evaluateReference(front.checked, args, { onBoundary: (_stmt, state) => boundaries.push(reported(names, (n) => state.array(n))) });
    return { front, names, boundaries, outcome };
  }

  const CASES: { label: string; source: string; args: number[]; status: string; boundaries: Arrays[]; final: Arrays }[] = [
    {
      label: 'a definition after another statement',
      source: 'def main(n):\n    print(n)\n    a = [7, 8, 9]\n    a[1] = n\n    return a[1]\n',
      args: [5], status: 'exited',
      boundaries: [{}, {}, { a: [7, 8, 9] }, { a: [7, 5, 9] }],
      final: { a: [7, 5, 9] },
    },
    {
      label: 'elements that generated code stores',
      source: 'def main(n):\n    x = n + 1\n    a = [x] * 3\n    b = [x, 8, 9]\n    a[0] = 4\n    return a[0] + b[0]\n',
      args: [5], status: 'exited',
      boundaries: [{}, {}, { a: [6, 6, 6] }, { a: [6, 6, 6], b: [6, 8, 9] }, { a: [4, 6, 6], b: [6, 8, 9] }],
      final: { a: [4, 6, 6], b: [6, 8, 9] },
    },
    {
      label: 'two definitions without instructions, whose boundaries share an address',
      source: 'def main():\n    a = [1, 2]\n    b = [3, 4]\n    return a[0] + b[1]\n',
      args: [], status: 'exited',
      boundaries: [{}, { a: [1, 2] }, { a: [1, 2], b: [3, 4] }],
      final: { a: [1, 2], b: [3, 4] },
    },
    {
      label: 'a return before the definition',
      source: 'def main(n):\n    t = n\n    while t > 0:\n        return 3\n    a = [5, 6]\n    return a[0]\n',
      args: [1], status: 'exited',
      boundaries: [{}, {}, {}],
      final: {},
    },
    {
      label: 'the same program when the definition is reached',
      source: 'def main(n):\n    t = n\n    while t > 0:\n        return 3\n    a = [5, 6]\n    return a[0]\n',
      args: [0], status: 'exited',
      boundaries: [{}, {}, {}, { a: [5, 6] }],
      final: { a: [5, 6] },
    },
    {
      label: 'a definition that a runtime error interrupts',
      source: 'def main(n):\n    a = [1, 2]\n    b = [a[n]] * 2\n    return b[0]\n',
      args: [7], status: 'trap',
      boundaries: [{}, { a: [1, 2] }],
      final: { a: [1, 2] },
    },
    {
      label: 'a definition as the last statement of main',
      source: 'def main(n):\n    a = [n] * 2\n',
      args: [4], status: 'exited',
      boundaries: [{}],
      final: { a: [4, 4] },
    },
  ];

  it('reads an array as undefined until its defining statement has executed and as its contents afterwards', () => {
    for (const c of CASES) {
      const ref = referenceArrays(c.source, c.args);
      expect(ref.outcome.status, c.label).toBe(c.status);
      expect(ref.boundaries, c.label).toEqual(c.boundaries);
      expect(ref.outcome.finalArrays, c.label).toEqual(c.final);
      for (const b of backends) {
        const where = `${c.label}, ${b.profile.id}`;
        const m = loadCompiled(b, compileBackEnd(c.source, ref.front.ir!, b), { args: c.args });
        const read = (): Arrays => reported(ref.names, (n) => m.reader.array(n));
        const boundaries: Arrays[] = [];
        m.onBoundary = (_stmt, state) => boundaries.push(reported(ref.names, (n) => state.array(n)));
        expect(read(), where).toEqual({});
        const first = m.run();
        expect(first.status, where).toBe(c.status);
        expect(boundaries, where).toEqual(c.boundaries);
        expect(read(), where).toEqual(c.final);
        // A reset forgets which definitions have executed.
        boundaries.length = 0;
        m.reset();
        expect(read(), where).toEqual({});
        expect(m.run(), where).toEqual(first);
        expect(boundaries, where).toEqual(c.boundaries);
      }
    }
  });

  it('counts a definition as executed when execution reaches the next boundary, not while its instructions run', () => {
    const { source, args } = CASES[1]!;
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(source, id);
      const full = loadCompiled(b, c, { args });
      // Instructions executed before each boundary: of x, of the definition of a, of the definition of b, and so on.
      const before: number[] = [];
      full.onBoundary = () => before.push(full.executed);
      full.run();
      expect(before, id).toHaveLength(5);
      const stoppedAfter = (maxSteps: number): Arrays => {
        const m = loadCompiled(b, c, { args, limits: { maxSteps } });
        expect(m.run().status, `${id} ${maxSteps}`).toBe('limit');
        return reported(['a', 'b'], (n) => m.reader.array(n));
      };
      // The definition of a stores three elements, so it takes more than one instruction.
      expect(before[2]! - before[1]!, id).toBeGreaterThan(1);
      expect(stoppedAfter(before[1]!), id).toEqual({});
      expect(stoppedAfter(before[1]! + 1), id).toEqual({});
      expect(stoppedAfter(before[2]! - 1), id).toEqual({});
      expect(stoppedAfter(before[2]!), id).toEqual({ a: [6, 6, 6] });
      expect(stoppedAfter(before[3]!), id).toEqual({ a: [6, 6, 6], b: [6, 8, 9] });
    }
  });
});

describe('arguments of main', () => {
  const TWO = 'def main(a, b):\n    return a - b\n';

  it('requires one argument for each parameter of a compiled program', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(TWO, id);
      expect(loadCompiled(b, c, { args: [7, 2] }).run().returnValue, id).toBe(5);
      for (const args of [[], [7], [7, 2, 1]]) {
        const given = `${args.length} argument${args.length === 1 ? ' was' : 's were'} given`;
        expect(() => loadCompiled(b, c, { args }), `${id} ${given}`).toThrow(ArgumentCountError);
        expect(() => new Machine(b, { code: c.program.bytes, data: c.dataImage, entry: c.entry, compiled: c }, { args }), `${id} ${given}`).toThrow(
          `main takes 2 parameters (a, b), but ${given}`,
        );
      }
      expect(() => loadCompiled(b, c), id).toThrow('main takes 2 parameters (a, b), but 0 arguments were given');
      const none = compiled('def main():\n    return 3\n', id);
      expect(loadCompiled(b, none).run().returnValue, id).toBe(3);
      expect(() => loadCompiled(b, none, { args: [1] }), id).toThrow('main takes no parameters, but 1 argument was given');
    }
  });

  it('writes the arguments of code without a compiled program to the argument registers', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const registers = b.profile.conventions.args;
      expect(registers, id).toHaveLength(4);
      // The bytes of the compiled program, loaded as raw code: there is no parameter list to check against.
      const code = compiled(TWO, id).program.bytes;
      const one = new Machine(b, { code, entry: LAYOUT.codeBase }, { args: [7] });
      expect(one.cpu.reg32(registers[0]!), id).toBe(7);
      expect(registers.map((r) => one.cpu.wasWritten(r)), id).toEqual([true, false, false, false]);
      const six = machineFromBytes(id, code, { args: [1, 2, 3, 4, 5, 6] });
      expect(registers.map((r) => six.cpu.reg32(r)), id).toEqual([1, 2, 3, 4]);
      expect(machineFromBytes(id, code, { args: [7, 2] }).run().returnValue, id).toBe(5);
    }
  });
});

describe('program images', () => {
  const exit5 = (): Uint8Array => {
    const r = encodeAssembly('riscv', 'addi a0, zero, 5\nli a7, 2\necall\n');
    if (!r.ok) throw new Error('assembly');
    return r.program.bytes;
  };

  it('loads a code image that fills the code region', () => {
    const code = new Uint8Array(LAYOUT.codeSize);
    code.set(exit5());
    const outcome = machineFromBytes('riscv', code).run();
    expect(outcome.status).toBe('exited');
    expect(outcome.returnValue).toBe(5);
  });

  it('rejects a code image larger than the code region', () => {
    const code = new Uint8Array(LAYOUT.codeSize + 4);
    code.set(exit5());
    expect(() => machineFromBytes('riscv', code)).toThrow(RangeError);
    expect(() => machineFromBytes('riscv', code)).toThrow('the program needs 65540 bytes of code; the code region holds 65536');
  });

  it('rejects a data image larger than the data region and loads one that fills it', () => {
    const r = encodeAssembly('riscv', 'lui t0, 0x10000\nlw a0, 0(t0)\nli a7, 2\necall\n');
    if (!r.ok) throw new Error('assembly');
    const full = new Uint8Array(LAYOUT.dataSize);
    full[0] = 42;
    const outcome = new Machine(getBackend('riscv'), { code: r.program.bytes, data: full, entry: LAYOUT.codeBase }).run();
    expect(outcome.returnValue).toBe(42);
    const over = new Uint8Array(LAYOUT.dataSize + 1);
    expect(() => new Machine(getBackend('riscv'), { code: r.program.bytes, data: over, entry: LAYOUT.codeBase })).toThrow(
      'the program needs 65537 bytes of data; the data region holds 65536',
    );
  });
});

describe('instruction fetch faults', () => {
  it('names the full address of a fetch outside the code region', () => {
    const mem = new Memory();
    expect(() => mem.fetch(LAYOUT.codeBase + LAYOUT.codeSize, 4)).toThrow('instruction fetch outside the code region at 0x00410000');
    // An address below zero of the 64-bit x86-64 address space is 2^64 plus the value.
    expect(() => mem.fetch(-0x100005, 4)).toThrow('instruction fetch outside the code region at 0xffffffffffeffffb');
    expect(() => mem.fetch(2 ** 32 + LAYOUT.codeBase, 4)).toThrow('instruction fetch outside the code region at 0x100400000');
  });
});

describe('assembler driver', () => {
  /** B(i) jumps over 125 bytes and B(i+1), so B(i) needs its long form only after B(i+1) has grown. */
  function x86Chain(n: number): string {
    const lines = ['_start:'];
    for (let i = 1; i <= n; i++) {
      lines.push(`B${i}: jmp T${i}`);
      if (i > 1) lines.push(`T${i - 1}:`);
      lines.push(`    .byte ${new Array<string>(i === n ? 128 : 125).fill('0x90').join(', ')}`);
    }
    lines.push(`T${n}:`, '    nop');
    return lines.join('\n') + '\n';
  }

  /** n consecutive beq; each goes out of reach only after the branches after it have been replaced. */
  function rvStaircase(n: number): string {
    const words = (k: number): string[] => {
      const out: string[] = [];
      for (let left = k; left > 0; left -= 64) out.push(`    .word ${new Array<string>(Math.min(64, left)).fill('0x00000013').join(', ')}`);
      return out;
    };
    const lines = ['_start:'];
    for (let i = 1; i <= n; i++) lines.push(`br${i}: beq a0, a1, tgt${i}`);
    lines.push(...words((4100 - 8 * n) / 4));
    for (let i = 1; i <= n; i++) {
      lines.push(`tgt${i}:`);
      if (i < n) lines.push(...words(2));
    }
    lines.push('    ecall');
    return lines.join('\n') + '\n';
  }

  it('relaxes chains of more than 64 dependent branches', () => {
    // SHA-256 of the expected bytes, which are the bytes that Clang 20 produces for the same text.
    const cases = [
      { target: 'x86', text: x86Chain(65), size: 8454, long: 65, sha256: 'd860af8727e0f927dc6e78dab30634df19fdcf79f5debf8acc1eb16c8f0574f8' },
      { target: 'x86', text: x86Chain(70), size: 9104, long: 70, sha256: '591e330e87c47f35b6bd764c9f69346458b461f110bd00c3a2be9bed0689d475' },
      { target: 'riscv', text: rvStaircase(65), size: 4616, long: 65, sha256: '832e112ae26501f6fc1db97f05ba3c39898d5b2f88dca0e87eae58c7068b0443' },
    ];
    for (const c of cases) {
      const r = encodeAssembly(c.target, c.text);
      if (!r.ok) throw new Error(`${c.target}: ${JSON.stringify(r.errors)}`);
      expect(r.program.bytes.length).toBe(c.size);
      const longForms = r.program.insns.filter((i) => (c.target === 'x86' ? i.insn?.mnemonic === 'jmp' && i.length === 5 : i.insn?.mnemonic === 'jal'));
      expect(longForms).toHaveLength(c.long);
      expect(createHash('sha256').update(r.program.bytes).digest('hex')).toBe(c.sha256);
    }
  });

  it('accepts labels named like members of Object.prototype and reports them when undefined', () => {
    const jumps: Record<string, string> = { riscv: 'j', mips: 'j', aarch64: 'b', x86: 'jmp' };
    for (const b of backends) {
      const id = b.profile.id;
      const tail = id === 'mips' ? '  nop\n' : '';
      for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
        const defined = encodeAssembly(id, `${name}:\n  ${jumps[id]} ${name}\n${tail}`);
        if (!defined.ok) throw new Error(`${id} ${name}: ${JSON.stringify(defined.errors)}`);
        expect(defined.program.symbols[name]).toBe(LAYOUT.codeBase);
        expect(defined.program.insns[0]!.insn!.operands.find((o) => o.t === 'addr')).toEqual({ t: 'addr', value: LAYOUT.codeBase, label: name });
        const undefinedLabel = encodeAssembly(id, `start:\n  ${jumps[id]} ${name}\n${tail}`);
        expect(undefinedLabel, `${id} ${name}`).toEqual({ ok: false, errors: [{ line: 2, message: `label '${name}' is not defined` }] });
        // A reference before the definition, and a second definition.
        const forward = encodeAssembly(id, `  ${jumps[id]} ${name}\n${tail}${name}:\n  nop\n`);
        if (!forward.ok) throw new Error(`${id} ${name}: ${JSON.stringify(forward.errors)}`);
        const target = forward.program.insns.at(-1)!.address;
        expect(target, `${id} ${name}`).toBeGreaterThan(LAYOUT.codeBase);
        expect(forward.program.symbols[name], `${id} ${name}`).toBe(target);
        expect(forward.program.insns[0]!.insn!.operands.find((o) => o.t === 'addr'), `${id} ${name}`).toEqual({ t: 'addr', value: target, label: name });
        const twice = encodeAssembly(id, `${name}:\n  nop\n${name}:\n  nop\n`);
        expect(twice, `${id} ${name}`).toEqual({ ok: false, errors: [{ line: 3, message: `label '${name}' is defined more than once` }] });
      }
    }
    // RV32I texts in which such a name is defined alone, and referred to before its definition.
    for (const text of ['toString:\n ecall\n', 'j valueOf\nvalueOf:\n ecall\n', 'j __proto__\n__proto__:\n ecall\n']) {
      const r = encodeAssembly('riscv', text);
      expect(r.ok, JSON.stringify(text)).toBe(true);
    }
  });

  it('keeps the labels that relaxation adds apart from the labels of the program', () => {
    const far = '_start:\n  beq a0, a1, far\n' + '  nop\n'.repeat(1100) + 'far:\n  nop\n';
    const defined = encodeAssembly('riscv', far + '.Lrelax0:\n  nop\n');
    if (!defined.ok) throw new Error(JSON.stringify(defined.errors));
    expect(defined.program.insns.slice(0, 2).map((i) => i.text)).toEqual(['bne a0, a1, .Lrelax1', 'jal zero, far']);
    expect(defined.program.symbols['.Lrelax0']).toBe(defined.program.symbols['far']! + 4);
    const referenced = encodeAssembly('riscv', far + '  j .Lrelax0\n');
    expect(referenced).toEqual({ ok: false, errors: [{ line: 1105, message: "label '.Lrelax0' is not defined" }] });
  });
});

describe('interfaces of the backends', () => {
  it('reports a program counter above the 32-bit address space in full beside its low 32 bits', () => {
    const r = encodeAssembly('aarch64', 'movz x1, #0x8\nmovk x1, #0x40, lsl #16\nmovk x1, #0x1, lsl #32\nbr x1\n');
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const m = new Machine(getBackend('aarch64'), { code: r.program.bytes, entry: r.program.base, listing: r.program });
    for (let k = 0; k < 3; k++) m.step();
    expect(m.pc64).toBeUndefined();
    const ev = newStepEvent(m.executed);
    expect(m.step(ev)).toBe(true);
    expect(m.cpu.readReg('pc')).toBe(0x100400008n);
    expect([m.cpu.pc, ev.nextPc, ev.branch?.target]).toEqual([0x00400008, 0x00400008, 0x00400008]);
    expect(m.pc64).toBe(0x100400008n);
    // The 64-bit fields of a step event are present only for such an address and then hold all of it.
    expect(ev.nextPc64).toBeOneOf([undefined, 0x100400008n]);
    expect(ev.branch?.target64).toBeOneOf([undefined, 0x100400008n]);
    // The low half is the address of an instruction of the listing, which the program counter is not at.
    expect(m.insnInfo(m.cpu.pc)?.text).toBe('movk x1, #0x1, lsl #32');
    const fetch = newStepEvent(m.executed);
    expect(m.step(fetch)).toBe(false);
    expect(m.fault).toBe('instruction fetch outside the code region at 0x0000000100400008');
    expect(fetch).toMatchObject({ index: 4, pc: 0x00400008, pc64: 0x100400008n, length: 0, text: '', stop: { kind: 'fault', message: m.fault } });
    expect(ev.pc64).toBeUndefined();
    expect(m.regionCounts).toEqual({ startup: 0, main: 4, helper: 0, trap: 0, unknown: 1 });
    // A program counter that `cpu.pc` holds in full, also below zero on x86-64, has no separate full value.
    for (const b of backends) expect(machineFromBytes(b.profile.id, new Uint8Array(8)).pc64, b.profile.id).toBeUndefined();
    const x = machineFromBytes('x86', new Uint8Array(8));
    x.cpu.pc = -16;
    expect(x.cpu.readReg('rip')).toBe(0xfffffffffffffff0n);
    expect(x.pc64).toBeUndefined();
  });

  it('marks a register outside the general-purpose register file with false and other registers not at all', () => {
    const sp: RegisterInfo = { name: 'sp', aliases: ['wsp'], bits: 64, role: 'stack pointer', generalPurpose: false };
    // @ts-expect-error A general-purpose register leaves the marker out; it has no other value.
    const x0: RegisterInfo = { name: 'x0', aliases: ['w0'], bits: 64, role: 'argument', generalPurpose: true };
    expect([sp.generalPurpose, x0.generalPurpose]).toEqual([false, true]);
    const unmarked = (id: string): number => getBackend(id).profile.registers.filter((r) => r.generalPurpose !== false).length;
    expect([unmarked('riscv'), unmarked('mips'), unmarked('x86')]).toEqual([32, 32, 16]);
    for (const b of backends) for (const r of b.profile.registers) expect(r.generalPurpose, `${b.profile.id} ${r.name}`).toBeOneOf([undefined, false]);
  });

  it('gives the flags that an instruction leaves undefined a reader of the registers before the instruction', () => {
    const spec: ValidationSpec = getBackend('x86').validation;
    const r = encodeAssembly('x86', 'shl eax, cl\n');
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const insn = r.program.insns[0]!.insn!;
    const names: string[] = [];
    const undefinedWith = (cl: bigint): string[] | undefined =>
      spec.undefinedFlags?.(insn, (name) => {
        names.push(name);
        return name === 'rcx' ? 0x7700n | cl : 0n;
      });
    // Intel SDM Vol. 2B, SAL/SAR/SHL/SHR: a masked count of 0 changes no flag, and OF is defined for a masked count of 1.
    expect(undefinedWith(0n)).toEqual([]);
    expect(undefinedWith(1n)).toEqual(['AF']);
    expect(undefinedWith(5n)).toEqual(['OF', 'AF']);
    expect(names).toEqual(['rcx', 'rcx', 'rcx']);
    // Without the reader the count is unknown.
    expect(spec.undefinedFlags?.(insn)).toEqual(['OF', 'AF']);
  });
});
