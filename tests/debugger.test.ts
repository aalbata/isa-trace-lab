/**
 * The interactive debugger: stepping with breakpoints, reverse stepping with
 * recorded edits, the status text, the program counter of the view, and the
 * views of variables and arrays.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../scripts/lib/corpus.ts';
import { ArgumentCountError, compileProgram, encodeAssembly, evaluateReference } from '../src/core/api.ts';
import type { CompiledProgram } from '../src/core/compile.ts';
import { compileFrontEnd } from '../src/core/compile.ts';
import { Debugger } from '../src/core/debugger.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import { LAYOUT } from '../src/core/target/memory.ts';

const backends = availableBackends();
const example = (name: string): string => readFileSync(join(repoRoot(), 'examples', `${name}.py`), 'utf8');

function compiled(source: string, target: string): CompiledProgram {
  const r = compileProgram(source, target);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('\n'));
  return r.compiled;
}

describe('stepping', () => {
  it('records the last executed instruction when a step of more than 64 instructions stops early', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(example('fibonacci'), id);
      const ahead = new Debugger(b, { compiled: c }, { args: [3] });
      ahead.step(4);
      const d = new Debugger(b, { compiled: c }, { args: [3] });
      d.step(1);
      d.setBreakpoints([ahead.machine.cpu.pc], []);
      d.step(1000);
      expect(d.stopReason, id).toMatch(/^breakpoint at 0x/);
      expect(d.machine.executed, id).toBe(4);
      const last = d.view().recent.at(-1)!;
      expect(d.lastEvent?.index, id).toBe(3);
      expect(d.lastEvent?.pc, id).toBe(last.pc);
      d.setBreakpoints([], []);
      d.step(100_000);
      expect(d.machine.status, id).toBe('exited');
      expect(d.lastEvent?.index, id).toBe(d.machine.executed - 1);
      expect(d.lastEvent?.service?.name, id).toBe('exit');
    }
  });

  it('prints a program counter below zero as a 64-bit address', () => {
    const d = new Debugger(getBackend('x86'), { code: Uint8Array.of(0x90, 0x90) });
    d.machine.cpu.pc = -0x100005;
    expect(d.statusText()).toBe('ready at 0xffffffffffeffffb');
    d.machine.cpu.pc = LAYOUT.codeBase;
    d.step(1);
    d.machine.cpu.pc = -0x100005;
    expect(d.statusText()).toBe('paused at 0xffffffffffeffffb after 1 instructions');
    d.step(1);
    expect(d.view().statusText).toBe('fault: instruction fetch outside the code region at 0xffffffffffeffffb');
    expect(d.view().recent.map((r) => r.pc)).toEqual([LAYOUT.codeBase, -0x100005]);
  });

  it('names a breakpoint below address zero as a 64-bit address', () => {
    // jmp with a 32-bit offset from 0x00400000 to 0xffffffffffeffffb.
    const d = new Debugger(getBackend('x86'), { code: Uint8Array.of(0xe9, 0xf6, 0xff, 0xaf, 0xff) });
    d.setBreakpoints([-0x100005], []);
    d.step(2);
    expect(d.machine.executed).toBe(1);
    expect(d.stopReason).toBe('breakpoint at 0xffffffffffeffffb');
    const v = d.view();
    expect(v.statusText).toBe('paused at 0xffffffffffeffffb after 1 instructions');
    expect(v.pc).toBe(-0x100005);
    expect(v.pc64).toBeUndefined();
    expect(v.next).toBeNull();
  });

  it('rejects a code image larger than the code region', () => {
    expect(() => new Debugger(getBackend('riscv'), { code: new Uint8Array(LAYOUT.codeSize + 1) })).toThrow(
      'the program needs 65537 bytes of code; the code region holds 65536',
    );
  });

  it('requires one argument for each parameter of main when it loads a compiled program', () => {
    const riscv = getBackend('riscv');
    const c = compiled(example('fibonacci'), 'riscv');
    expect(() => new Debugger(riscv, { compiled: c })).toThrow(ArgumentCountError);
    expect(() => new Debugger(riscv, { compiled: c }, { args: [3, 4] })).toThrow('main takes 1 parameter (n), but 2 arguments were given');
    const d = new Debugger(riscv, { compiled: c }, { args: [3] });
    d.step(1000);
    expect(d.statusText()).toMatch(/^main returned 2 after \d+ instructions$/);
    // An assembled program and raw code have no parameter list.
    expect(new Debugger(riscv, { program: c.program }, { args: [3, 4] }).machine.cpu.reg32('a1')).toBe(4);
    expect(new Debugger(riscv, { code: c.program.bytes }).machine.cpu.wasWritten('a0')).toBe(false);
  });
});

describe('program counter above the 32-bit address space', () => {
  const aarch64 = getBackend('aarch64');
  const assemble = (text: string) => {
    const r = encodeAssembly('aarch64', text);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.program;
  };

  it('names the full program counter and offers no next instruction', () => {
    // br x1 with x1 = 0x100400014; the low half is the address of the second nop.
    const wide = assemble('movz x1, #0x14\nmovk x1, #0x40, lsl #16\nmovk x1, #0x1, lsl #32\nbr x1\nnop\nnop\n');
    const d = new Debugger(aarch64, { program: wide });
    d.step(4);
    const v = d.view();
    expect(v.status).toBe('running');
    expect(v.statusText).toBe('paused at 0x0000000100400014 after 4 instructions');
    expect([v.pc, v.pc64]).toEqual([0x00400014, 0x100400014n]);
    expect(v.next).toBeNull();
    expect(v.nextStale).toBe(false);
    expect(v.recent.at(-1)).toEqual({ index: 3, pc: 0x0040000c, text: 'br x1', note: '' });
    // The fetch at that address faults, and the recent list names the address, not the nop at its low half.
    d.step(1);
    const w = d.view();
    expect(w.statusText).toBe('fault: instruction fetch outside the code region at 0x0000000100400014');
    expect(w.recent.at(-1)).toEqual({ index: 4, pc: 0x00400014, pc64: 0x100400014n, text: '(outside the code region)', note: '' });
    expect(w.lastEvent).toMatchObject({ index: 4, pc: 0x00400014, pc64: 0x100400014n, length: 0 });
    expect(w.regionCounts).toEqual({ startup: 0, main: 4, helper: 0, trap: 0, unknown: 1 });
    d.back(1);
    expect(d.view().statusText).toBe('paused at 0x0000000100400014 after 4 instructions');
    expect(d.view().recent.at(-1)).toEqual({ index: 3, pc: 0x0040000c, text: 'br x1', note: '' });
    // An edit of the program counter gives the same view before any instruction has executed.
    const edited = new Debugger(aarch64, { program: wide });
    edited.setRegister('pc', 0xffffffff00400014n);
    expect(edited.view().statusText).toBe('ready at 0xffffffff00400014');
    expect(edited.view().next).toBeNull();
    // Control: the same low half with the upper half zero is the address of the nop.
    const low = new Debugger(aarch64, { program: assemble('movz x1, #0x14\nmovk x1, #0x40, lsl #16\nnop\nbr x1\nnop\nnop\n') });
    low.step(4);
    expect(low.view().statusText).toBe('paused at 0x00400014 after 4 instructions');
    expect(low.view().pc64).toBeUndefined();
    expect(low.view().next).toMatchObject({ address: 0x00400014, text: 'nop' });
  });

  it('does not stop at a breakpoint whose address is the low half of the program counter', () => {
    const wide = assemble('movz x1, #0x14\nmovk x1, #0x40, lsl #16\nmovk x1, #0x1, lsl #32\nbr x1\nnop\nnop\n');
    const d = new Debugger(aarch64, { program: wide });
    d.setBreakpoints([0x00400014], []);
    d.step(10);
    expect(d.stopReason).toBe('');
    expect(d.machine.executed).toBe(5);
    expect(d.machine.status).toBe('fault');
    const sliced = new Debugger(aarch64, { program: wide });
    sliced.setBreakpoints([0x00400014], []);
    expect(sliced.runSlice(10)).toBe(false);
    expect(sliced.stopReason).toBe('');
    expect(sliced.machine.status).toBe('fault');
    // Control: the breakpoint stops a run that reaches the address itself.
    const low = new Debugger(aarch64, { program: assemble('movz x1, #0x14\nmovk x1, #0x40, lsl #16\nnop\nbr x1\nnop\nnop\n') });
    low.setBreakpoints([0x00400014], []);
    low.step(10);
    expect(low.stopReason).toBe('breakpoint at 0x00400014');
    expect(low.machine.executed).toBe(4);
  });

  it('fires no boundary and keeps the variables of main when a return goes to the low half of a boundary address', () => {
    const source = 'def main():\n' + 'abcdefghijklmn'.split('').map((v, i) => `    ${v} = ${i + 1}\n`).join('') + '    print(n)\n    n = n + 10\n    print(n)\n    return a + n\n';
    const c = compiled(source, 'aarch64');
    expect(c.variables.find((v) => v.name === 'n')!.home.kind).toBe('slot');
    const d = new Debugger(aarch64, { compiled: c });
    const n = (): number | null => d.view().variables.find((v) => v.name === 'n')!.value;
    while (d.view().nextBoundaries[0]?.line !== 19) d.stepSource();
    expect(n()).toBe(24);
    // The return address becomes 2^32 plus the address of the boundary of `d = 4`.
    const boundary = c.program.boundaries[3]!;
    const line = c.ir.stmts[boundary.stmts[0]!]!.span.start.line;
    expect(line).toBe(5);
    d.setRegister('x30', (1n << 32n) | BigInt(boundary.address));
    d.setBreakpoints([], [line]);
    while (d.machine.status === 'running' && d.machine.pc64 === undefined) d.step(1);
    const v = d.view();
    expect(v.status).toBe('running');
    expect([v.pc, v.pc64]).toEqual([boundary.address, (1n << 32n) | BigInt(boundary.address)]);
    expect(v.statusText).toBe(`paused at 0x00000001${boundary.address.toString(16).padStart(8, '0')} after ${v.executed} instructions`);
    expect(v.next).toBeNull();
    expect(v.nextBoundaries).toEqual([]);
    expect(v.boundaryCount).toBe(18);
    // Main has returned, so its variables keep the values of its frame.
    expect(n()).toBe(24);
    d.stepSource();
    expect(d.stopReason).toBe('');
    expect(d.machine.status).toBe('fault');
    expect(d.view().boundaryCount).toBe(18);
    expect(n()).toBe(24);
    // Returning to the last statement boundary finds the boundary of the return, not the address after it.
    d.backSource();
    expect(d.view().nextBoundaries).toEqual([{ statement: expect.any(Number), line: 19 }]);
    // A statement step from there does not stop at the low half as at a statement boundary: it runs into the fault.
    d.setBreakpoints([], []);
    d.stepSource();
    expect(d.machine.status).toBe('fault');
    expect(d.machine.fault).toBe(`instruction fetch outside the code region at 0x00000001${boundary.address.toString(16).padStart(8, '0')}`);
    expect(d.view().boundaryCount).toBe(18);
  });
});

describe('reverse stepping', () => {
  it('returns to a statement boundary that an edit of the program counter reached', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(example('summation'), id);
      const fresh = (): Debugger => {
        const d = new Debugger(b, { compiled: c }, { args: [5] });
        d.stepSource();
        d.stepSource();
        d.stepSource();
        d.step(1);
        while (d.machine.boundariesAtAddress(d.machine.cpu.pc)) d.step(1);
        return d;
      };
      // A boundary address from which one instruction does not reach another boundary.
      const target = c.program.boundaries.map((x) => x.address).find((address) => {
        const d = fresh();
        d.setRegister(b.profile.pcName, BigInt(address));
        d.step(1);
        return d.machine.status === 'running' && !d.machine.boundariesAtAddress(d.machine.cpu.pc);
      });
      expect(target, id).toBeDefined();
      const d = fresh();
      const edited = d.machine.executed;
      expect(d.machine.boundariesAtAddress(d.machine.cpu.pc), id).toBeUndefined();
      d.setRegister(b.profile.pcName, BigInt(target!));
      d.step(1);
      const after = d.machine.cpu.pc;
      d.backSource();
      expect(d.machine.executed, id).toBe(edited);
      expect(d.machine.cpu.pc, id).toBe(target);
      d.step(1);
      expect(d.machine.cpu.pc, id).toBe(after);
    }
  });

  it('rejects a count for back that is not a whole number of at least 0', () => {
    const c = compiled(example('fibonacci'), 'riscv');
    const d = new Debugger(getBackend('riscv'), { compiled: c }, { args: [10] });
    d.setRegister('t6', 1234n);
    d.step(10);
    d.setRegister('s5', 77n);
    for (const count of [-5, -0.5, 2.5, Number.NaN, -Infinity]) {
      expect(() => d.back(count), String(count)).toThrow(RangeError);
      expect(d.machine.executed).toBe(10);
      expect(d.machine.cpu.readReg('s5')).toBe(77n);
    }
    d.back(0);
    expect(d.machine.executed).toBe(10);
    expect(d.machine.cpu.readReg('s5')).toBe(77n);
    d.back(2);
    expect(d.machine.executed).toBe(8);
    d.back(Infinity);
    expect(d.machine.executed).toBe(0);
    expect(d.machine.cpu.readReg('t6')).toBe(1234n);
  });
});

describe('variable view', () => {
  /** Seven variables: x86-64 keeps g in a stack slot, the other targets in a register. */
  const SEVEN = 'def main():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    g = 7\n    return a + b + c + d + e + f + g\n';

  it('shows a variable kept in a stack slot as unassigned until it is stored and keeps its value after main returns', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const d = new Debugger(b, { compiled: compiled(SEVEN, id) });
      const g = (): number | null => d.view().variables.find((v) => v.name === 'g')!.value;
      expect(d.view().variables.find((v) => v.name === 'g')!.home, id).toBe(id === 'x86' ? 'stack + 0' : { riscv: 's6', mips: '$s6', aarch64: 'w25' }[id]);
      // Instruction by instruction through the startup code and the prologue, up to the first boundary.
      while (d.view().nextBoundaries.length === 0) {
        expect(g(), `${id} after ${d.machine.executed} instructions`).toBeNull();
        d.step(1);
      }
      expect(g(), id).toBeNull();
      for (let k = 0; k < 7; k++) d.stepSource();
      expect(g(), id).toBe(7);
      d.step(1000);
      expect(d.machine.status, id).toBe('exited');
      expect(g(), id).toBe(7);
      d.back(1);
      expect(g(), id).toBe(7);
    }
  });

  it('shows a value written into a stack slot by an edit', () => {
    const d = new Debugger(getBackend('x86'), { compiled: compiled(SEVEN, 'x86') });
    d.stepSource();
    const g = (): number | null => d.view().variables.find((v) => v.name === 'g')!.value;
    expect(g()).toBeNull();
    expect(d.poke(d.machine.cpu.reg32('rsp') >>> 0, [42, 0, 0, 0])).toBe(true);
    expect(g()).toBe(42);
    d.stepSource();
    d.backSource();
    expect(g()).toBe(42);
  });

  /** Fourteen variables: every target keeps n in a stack slot, and print(n) shows the value that the program loads. */
  const FOURTEEN = 'def main():\n' + 'abcdefghijklmn'.split('').map((v, i) => `    ${v} = ${i + 1}\n`).join('') + '    print(n)\n    n = n + 10\n    print(n)\n    return a + n\n';
  const valueOf = (d: Debugger, name: string): number | null => d.view().variables.find((v) => v.name === name)!.value;

  it('follows an edit of the stack pointer inside main for a variable kept in a stack slot', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(FOURTEEN, id);
      expect(c.variables.find((v) => v.name === 'n')!.home.kind, id).toBe('slot');
      const sp = b.profile.conventions.stackPointer;
      const moveFrame = (d: Debugger): void => d.setRegister(sp, BigInt((d.machine.cpu.reg32(sp) >>> 0) - 64));
      // The frame moves before n = 14, so the program stores and loads n in the moved frame.
      const early = new Debugger(b, { compiled: c });
      for (let k = 0; k < 14; k++) early.stepSource();
      moveFrame(early);
      expect(valueOf(early, 'n'), id).toBeNull();
      early.stepSource();
      expect(valueOf(early, 'n'), id).toBe(14);
      early.stepSource();
      early.stepSource();
      expect(valueOf(early, 'n'), id).toBe(24);
      early.stepSource();
      expect(early.machine.output, id).toEqual([14, 24]);
      early.step(1000);
      // x86-64 returns through the stack, and the moved frame does not hold the return address.
      expect(early.machine.status, id).toBe(id === 'x86' ? 'fault' : 'exited');
      if (id !== 'x86') expect(early.machine.returnValue, id).toBe(25);
      expect(valueOf(early, 'n'), id).toBe(24);
      // The frame moves after n = 14, so the slot of n in the moved frame has not been written.
      const late = new Debugger(b, { compiled: c });
      for (let k = 0; k < 15; k++) late.stepSource();
      expect(valueOf(late, 'n'), id).toBe(14);
      moveFrame(late);
      expect(valueOf(late, 'n'), id).toBeNull();
      late.stepSource();
      late.stepSource();
      expect(valueOf(late, 'n'), id).toBe(10);
      late.stepSource();
      expect(late.machine.output, id).toEqual([0, 10]);
      late.backSource();
      expect(valueOf(late, 'n'), id).toBe(10);
    }
  });

  it('reads a variable kept in a stack slot when an edit of the stack pointer has moved the frame of main into the data region', () => {
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(FOURTEEN, id);
      const sp = b.profile.conventions.stackPointer;
      // The program has no arrays, so this part of the data region is unused. A program loads from the data
      // region and stores to it as it does with the stack.
      const frame = LAYOUT.dataBase + 0x8000;
      const slot = frame + c.variables.find((v) => v.name === 'n')!.slotOffset!;
      const d = new Debugger(b, { compiled: c });
      for (let k = 0; k < 14; k++) d.stepSource();
      d.setRegister(sp, BigInt(frame));
      expect(valueOf(d, 'n'), id).toBeNull();
      d.stepSource();
      expect(d.machine.mem.peek32(slot), id).toBe(14);
      expect(valueOf(d, 'n'), id).toBe(14);
      d.stepSource();
      expect(d.machine.output, id).toEqual([14]);
      d.stepSource();
      expect(valueOf(d, 'n'), id).toBe(24);
      d.stepSource();
      expect(d.machine.output, id).toEqual([14, 24]);
      d.step(1000);
      // x86-64 returns through the stack, and the moved frame does not hold the return address.
      expect(d.machine.status, id).toBe(id === 'x86' ? 'fault' : 'exited');
      if (id !== 'x86') expect(d.machine.returnValue, id).toBe(25);
      expect(valueOf(d, 'n'), id).toBe(24);
      d.backSource();
      expect(valueOf(d, 'n'), id).toBe(24);
      d.reset();
      expect(d.machine.mem.wasWritten(slot, 4), id).toBe(false);
    }
  });

  it('shows the content of a stack slot that an edit has placed on memory written for another purpose', () => {
    // The frame of main is placed on the array x, with the slot of n on the element x[p].
    const source = 'def main(p):\n    x = [7] * 32\n' + 'abcdefghijklm'.split('').map((v, i) => `    ${v} = ${i + 1}\n`).join('') + '    x[p] = 99\n    n = 14\n    print(x[p])\n    return a + n\n';
    const front = compileFrontEnd(source);
    if (!front.ok) throw new Error('the program has errors');
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(source, id);
      const n = c.variables.find((v) => v.name === 'n')!;
      expect(n.home.kind, id).toBe('slot');
      const x = c.arrays[0]!;
      const index = n.slotOffset! / 4;
      // In the program itself n is unassigned until `n = 14`, whatever x holds.
      const assigned: boolean[] = [];
      evaluateReference(front.checked, [index], { onBoundary: (_stmt, state) => assigned.push(state.variable('n') !== undefined) });
      expect(assigned.lastIndexOf(false), id).toBe(15);
      const d = new Debugger(b, { compiled: c }, { args: [index] });
      while (d.view().nextBoundaries[0]?.line !== 16) d.stepSource();
      expect(valueOf(d, 'n'), id).toBeNull();
      d.setRegister(b.profile.conventions.stackPointer, BigInt(x.address));
      // The slot holds the 7 of the data image, which the loader placed: no instruction has written it.
      expect(d.machine.mem.peek32(x.address + n.slotOffset!), id).toBe(7);
      expect(valueOf(d, 'n'), id).toBeNull();
      // `x[p] = 99` stores to the bytes of the slot, and the view shows what the machine holds there.
      d.stepSource();
      expect(d.view().nextBoundaries[0]?.line, id).toBe(17);
      expect(valueOf(d, 'n'), id).toBe(99);
      d.stepSource();
      expect(valueOf(d, 'n'), id).toBe(14);
      expect(d.view().arrays[0]!.values[index], id).toBe(14);
      d.stepSource();
      expect(d.machine.output, id).toEqual([14]);
    }
  });

  it('shows the return address that call pushed when a code edit places stack slots on it', () => {
    // x86-64: the prologue allocates 40 bytes, and the slots of m and n are the last 8 of them. With the frame
    // shortened to 24 bytes they are the 8 bytes above it, where the call of the startup code stored the return
    // address 0x0000000000400005 before main ran. An instruction has written these bytes, so the view shows
    // them, while in the program itself m and n are unassigned until their statements.
    const x86 = getBackend('x86');
    const c = compiled(FOURTEEN, 'x86');
    expect(c.frame.size).toBe(40);
    expect(['m', 'n'].map((name) => c.variables.find((v) => v.name === name)!.slotOffset)).toEqual([24, 28]);
    expect(c.program.insns[0]).toMatchObject({ address: LAYOUT.codeBase, text: 'call main', length: 5 });
    const d = new Debugger(x86, { compiled: c });
    const resize = c.program.insns.filter((i) => i.meta.note === 'allocate the stack frame' || i.meta.note === 'release the stack frame');
    expect(resize.map((i) => i.text)).toEqual(['sub rsp, 40', 'add rsp, 40']);
    for (const i of resize) {
      const r = encodeAssembly('x86', `${i.text.replace('40', '24')}\n`);
      if (!r.ok) throw new Error(JSON.stringify(r.errors));
      expect(r.program.bytes.length).toBe(i.length);
      expect(d.poke(i.address, Array.from(r.program.bytes))).toBe(true);
    }
    // Before the call no instruction has written the stack.
    expect([valueOf(d, 'm'), valueOf(d, 'n')]).toEqual([null, null]);
    for (let k = 0; k < 13; k++) {
      d.stepSource();
      expect([valueOf(d, 'l'), valueOf(d, 'm'), valueOf(d, 'n')], `boundary ${k}`).toEqual([k === 12 ? 12 : null, LAYOUT.codeBase + 5, 0]);
    }
    d.stepSource();
    expect([valueOf(d, 'm'), valueOf(d, 'n')]).toEqual([13, 0]);
    d.stepSource();
    expect([valueOf(d, 'm'), valueOf(d, 'n')]).toEqual([13, 14]);
    d.stepSource();
    expect(d.machine.output).toEqual([14]);
  });

  it('reads no stack slot while the stack pointer lies above the 32-bit address space', () => {
    for (const id of ['aarch64', 'x86']) {
      const b = getBackend(id);
      const sp = b.profile.conventions.stackPointer;
      const d = new Debugger(b, { compiled: compiled(FOURTEEN, id) });
      for (let k = 0; k < 15; k++) d.stepSource();
      expect([valueOf(d, 'a'), valueOf(d, 'm'), valueOf(d, 'n')], id).toEqual([1, 13, 14]);
      const main = d.machine.cpu.readReg(sp);
      // The low 32 bits of the stack pointer are those of main's frame, but no region holds a slot at this address.
      d.setRegister(sp, main + (1n << 32n));
      expect([valueOf(d, 'a'), valueOf(d, 'm'), valueOf(d, 'n')], id).toEqual([1, null, null]);
      // `print(n)` loads n from its slot.
      d.stepSource();
      expect(d.machine.fault, id).toMatch(/unmapped address 0x000000017fff/);
      expect(valueOf(d, 'n'), id).toBeNull();
      d.back(1);
      expect(d.machine.status, id).toBe('running');
      expect(valueOf(d, 'n'), id).toBeNull();
      d.setRegister(sp, main);
      expect([valueOf(d, 'm'), valueOf(d, 'n')], id).toEqual([13, 14]);
      // The same holds after main has released its frame with such a stack pointer. The return statement of
      // this program reads no slot, so AArch64 exits; x86-64 returns through the stack and faults.
      const e = new Debugger(b, { compiled: compiled(FOURTEEN.replace('return a + n', 'return a'), id) });
      while (e.view().nextBoundaries[0]?.line !== 19) e.stepSource();
      expect(valueOf(e, 'n'), id).toBe(24);
      e.setRegister(sp, e.machine.cpu.readReg(sp) + (1n << 32n));
      e.step(1000);
      expect(e.machine.status, id).toBe(id === 'x86' ? 'fault' : 'exited');
      expect([valueOf(e, 'a'), valueOf(e, 'm'), valueOf(e, 'n')], id).toEqual([1, null, null]);
    }
  });

  it('shows an array as not defined until its defining statement has executed', () => {
    const source = 'def main(n):\n    x = n + 1\n    a = [x] * 3\n    return a[0]\n';
    for (const b of backends) {
      const id = b.profile.id;
      const d = new Debugger(b, { compiled: compiled(source, id) }, { args: [5] });
      const a = () => d.view().arrays[0]!;
      const undefinedArray = { name: 'a', address: LAYOUT.dataBase, defined: false, values: [], truncated: false };
      const definedArray = { name: 'a', address: LAYOUT.dataBase, defined: true, values: [6, 6, 6], truncated: false };
      expect(a(), id).toEqual(undefinedArray);
      while (d.view().nextBoundaries[0]?.line !== 3) d.stepSource();
      expect(a(), id).toEqual(undefinedArray);
      // Instruction by instruction through the definition, which stores three elements, up to the next boundary.
      let inside = 0;
      for (d.step(1); d.view().nextBoundaries.length === 0; d.step(1)) {
        expect(a(), `${id} after ${d.machine.executed} instructions`).toEqual(undefinedArray);
        inside++;
      }
      expect(inside, id).toBeGreaterThan(0);
      expect(a(), id).toEqual(definedArray);
      d.back(1);
      expect(a(), id).toEqual(undefinedArray);
      d.step(1000);
      expect(d.machine.returnValue, id).toBe(6);
      expect(a(), id).toEqual(definedArray);
      d.reset();
      expect(a(), id).toEqual(undefinedArray);
    }
  });

  it('matches the reference evaluator after code edits that enlarge the frame of main', () => {
    const front = compileFrontEnd(FOURTEEN);
    if (!front.ok) throw new Error('the program has errors');
    const reference: Record<string, number>[] = [];
    const outcome = evaluateReference(front.checked, [], {
      onBoundary: (_stmt, state) => {
        const values: Record<string, number> = {};
        for (const v of front.checked.vars) {
          const value = state.variable(v.name);
          if (value !== undefined) values[v.name] = value;
        }
        reference.push(values);
      },
    });
    expect(outcome.returnValue).toBe(25);
    const shown = (d: Debugger): Record<string, number> => {
      const values: Record<string, number> = {};
      for (const v of d.view().variables) if (v.value !== null) values[v.name] = v.value;
      return values;
    };
    for (const b of backends) {
      const id = b.profile.id;
      const c = compiled(FOURTEEN, id);
      const d = new Debugger(b, { compiled: c });
      // The prologue allocates 32 bytes more and the epilogue releases 32 bytes more, so the program
      // computes the same values in a frame 32 bytes lower than the compiled one.
      const resize = c.program.insns.filter((i) => i.meta.note === 'allocate the stack frame' || i.meta.note === 'release the stack frame');
      expect(resize.map((i) => i.meta.note), id).toEqual(['allocate the stack frame', 'release the stack frame']);
      for (const i of resize) {
        const text = i.text.replace(/\d+$/, (n) => String(Number(n) + 32));
        const r = encodeAssembly(id, `${text}\n`);
        if (!r.ok) throw new Error(`${id}: ${text}: ${JSON.stringify(r.errors)}`);
        expect(r.program.bytes.length, text).toBe(i.length);
        expect(d.poke(i.address, Array.from(r.program.bytes)), text).toBe(true);
      }
      const views: Record<string, number>[] = [];
      while (d.machine.status === 'running') {
        const marks = d.machine.boundariesAtAddress(d.machine.cpu.pc)?.length ?? 0;
        for (let k = 0; k < marks; k++) views.push(shown(d));
        d.stepSource();
      }
      expect(views, id).toEqual(reference);
      expect(d.machine.status, id).toBe('exited');
      expect(d.machine.returnValue, id).toBe(25);
      expect(shown(d), id).toEqual(outcome.finalVars);
      d.backSource();
      expect(shown(d), id).toEqual(reference.at(-1));
    }
  });
});
