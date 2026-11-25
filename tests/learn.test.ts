/**
 * Worked state changes and exercises of the instruction-set explorer: the
 * MIPS delay slot in a worked example and in the branch explanation, and the
 * accepted answers of the field exercise.
 */
import { describe, expect, it } from 'vitest';
import { makeExercise, normalizeAnswer, runDemo } from '../src/core/learn.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import { hex } from '../src/core/util/int32.ts';

/** Initialization value of the n-th question of a kind, as the Exercises page computes it. */
const question = (n: number, kind: string): number => n * 7919 + kind.length;

describe('worked state change', () => {
  const mips = getBackend('mips');

  it('runs the delay slot of a MIPS branch or jump whether or not control moves', () => {
    const cases: [string, Record<string, number>][] = [
      ['beq $t0, $t1, 0x00400010\naddiu $t2, $t2, 1', { $t0: 7, $t1: 7 }],
      ['beq $t0, $t1, 0x00400010\naddiu $t2, $t2, 1', { $t0: 7, $t1: 8 }],
      ['bne $t0, $t1, 0x00400010\naddiu $t2, $t2, 1', { $t0: 7, $t1: 8 }],
      ['j 0x00400010\naddiu $t2, $t2, 1', {}],
      ['jal 0x00400010\naddiu $t2, $t2, 1', {}],
    ];
    for (const [text, registers] of cases) {
      const d = runDemo(mips, text, { registers });
      expect(d.fault, text).toBeNull();
      expect(d.events.map((e) => e.delaySlot === true), text).toEqual([false, true]);
      expect(d.after.registers['$t2'], text).toBe(1n);
    }
    expect(runDemo(mips, 'jal 0x00400010\naddiu $t2, $t2, 1').after.registers['$ra']).toBe(0x00400008n);
  });

  it('stops a taken MIPS branch after its delay slot and reports a branch placed there', () => {
    const taken = runDemo(mips, 'beq $t0, $t1, 0x00400010\naddiu $t2, $t2, 1\naddiu $t3, $t3, 1', { registers: { $t0: 7, $t1: 7 } });
    expect(taken.events).toHaveLength(2);
    expect(taken.events[1]!.nextPc).toBe(0x00400010);
    expect(taken.after.registers['$t3']).toBe(0n);
    expect(taken.fault).toBeNull();
    // A target inside the example does not run either: the demonstration ends once control has moved.
    const inside = runDemo(mips, 'beq $t0, $t1, 0x0040000c\naddiu $t2, $t2, 1\naddiu $t3, $t3, 1\naddiu $t4, $t4, 1', { registers: { $t0: 7, $t1: 7 } });
    expect(inside.events.map((e) => e.delaySlot === true)).toEqual([false, true]);
    expect([inside.after.registers['$t2'], inside.after.registers['$t3'], inside.after.registers['$t4']]).toEqual([1n, 0n, 0n]);
    expect(inside.fault).toBeNull();
    const nested = runDemo(mips, 'beq $t0, $t1, 0x00400010\nj 0x00400020', { registers: { $t0: 7, $t1: 7 } });
    expect(nested.fault).toMatch(/delay slot/);
  });

  it('records the fault or service that ends the demonstration in the event of its instruction', () => {
    const loads: [string, string][] = [
      ['riscv', 'lw a0, 0(zero)\naddi a1, a1, 1'],
      ['mips', 'lw $t0, 0($zero)\nnop'],
      ['aarch64', 'ldr x0, [x1]\nnop'],
      ['x86', 'mov eax, [0]\nnop'],
    ];
    for (const [target, text] of loads) {
      const d = runDemo(availableBackends().find((b) => b.profile.id === target)!, text);
      expect(d.fault, target).toBe('load from unmapped address 0x00000000');
      expect(d.events, target).toHaveLength(1);
      expect(d.events[0]!.stop, target).toEqual({ kind: 'fault', message: d.fault });
    }
    // The fault of a branch in a MIPS delay slot belongs to that branch, not to the one before it.
    const nested = runDemo(mips, 'beq $t0, $t1, 0x00400010\nj 0x00400020', { registers: { $t0: 7, $t1: 7 } });
    expect(nested.events.map((e) => e.stop)).toEqual([undefined, { kind: 'fault', message: nested.fault }]);
    const service = runDemo(mips, 'syscall\nnop');
    expect(service.fault).toBeNull();
    expect(service.events.map((e) => e.stop)).toEqual([{ kind: 'service' }]);
    // An instruction that completes carries no stop.
    expect(runDemo(mips, 'addiu $t2, $t2, 1\nnop').events.map((e) => e.stop)).toEqual([undefined, undefined]);
  });

  it('stops at a taken branch on a target without delay slots', () => {
    const riscv = getBackend('riscv');
    const away = runDemo(riscv, 'beq a0, a1, 0x00400010\naddi a2, a2, 1', { registers: { a0: 7, a1: 7 } });
    expect(away.events).toHaveLength(1);
    expect(away.after.registers['a2']).toBe(0n);
    expect(away.fault).toBeNull();
    const inside = runDemo(riscv, 'beq a0, a1, 0x00400008\naddi a2, a2, 1\naddi a3, a3, 1', { registers: { a0: 7, a1: 7 } });
    expect(inside.events).toHaveLength(1);
    expect([inside.after.registers['a2'], inside.after.registers['a3']]).toEqual([0n, 0n]);
    expect(inside.fault).toBeNull();
  });

  it('stops at an AArch64 register branch to a 64-bit address whose low half is the following instruction', () => {
    for (const branch of ['br x9', 'blr x9', 'ret x9']) {
      const d = runDemo(getBackend('aarch64'), `movz x9, #1, lsl #32\nmovk x9, #0x40, lsl #16\nmovk x9, #0x10\n${branch}\nnop`);
      expect(d.after.registers['x9'], branch).toBe(0x0000000100400010n);
      expect(d.events, branch).toHaveLength(4);
      expect(d.fault, branch).toBeNull();
    }
  });
});

describe('exercises', () => {
  it('explains a MIPS branch by its delay slot and the address where execution continues', () => {
    const mips = getBackend('mips');
    let taken = 0;
    for (let n = 1; n <= 60; n++) {
      const ex = makeExercise(mips, 'branch', question(n, 'branch'))!;
      // Every MIPS branch example sits at the code base and names its target as its last operand.
      const target = Number(/0x[0-9a-f]+$/i.exec(ex.material[0]!)![0]);
      const isTaken = ex.answers[0] === 'taken';
      if (isTaken) taken++;
      const after = isTaken ? target : 0x00400008;
      expect(ex.explanation, ex.material[0]).toContain(`so the delay-slot instruction at ${hex(0x00400004)} executes next, and execution then continues at ${hex(after)}.`);
    }
    expect(taken).toBeGreaterThan(10);
  });

  it('keeps the branch explanation of the targets without delay slots', () => {
    for (const id of ['riscv', 'aarch64', 'x86']) {
      for (let n = 1; n <= 30; n++) {
        const ex = makeExercise(getBackend(id), 'branch', question(n, 'branch'))!;
        expect(ex.explanation, `${id} ${ex.material[0]}`).toMatch(/so the next instruction is fetched from 0x[0-9a-f]{8}\.$/);
        if (ex.answers[0] === 'taken') expect(ex.explanation).toContain(`fetched from ${hex(Number(/0x[0-9a-f]+$/i.exec(ex.material[0]!)![0]))}.`);
      }
    }
  });

  it('reads a field answer without a prefix as decimal only', () => {
    const first = makeExercise(getBackend('x86'), 'field', question(1, 'field'))!;
    expect(first.prompt).toContain('Answer in decimal, or in binary with the prefix 0b.');
    expect(first.answers).not.toContain(normalizeAnswer('11'));
    for (const a of ['3', '0b11', '0b011', '0x3', '0B011']) expect(first.answers).toContain(normalizeAnswer(a));
    for (const b of availableBackends()) {
      for (let n = 1; n <= 300; n++) {
        const ex = makeExercise(b, 'field', question(n, 'field'));
        if (!ex) continue;
        const value = Number(ex.answers[0]);
        for (const a of ex.answers) {
          // Each accepted answer has a single reading, and that reading is the value of the field.
          const read = a.startsWith('0b') ? parseInt(a.slice(2), 2) : a.startsWith('0x') ? parseInt(a.slice(2), 16) : Number(a);
          expect(read, `${b.profile.id} ${ex.prompt} accepts ${a}`).toBe(value);
        }
      }
    }
  });
});
