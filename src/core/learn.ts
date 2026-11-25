/**
 * Worked examples and self-checking exercises for the instruction-set
 * explorer. Every value shown or expected is produced by the real assembler,
 * decoder, and processor model of the selected target.
 */
import { assembleText } from './target/assemble.ts';
import { Machine, newStepEvent } from './target/machine.ts';
import { LAYOUT } from './target/memory.ts';
import type { Backend, BitField, DecodeResult, InsnSpec, StepEvent } from './target/types.ts';
import type { ListingEntry } from './debugger.ts';
import { listingOf } from './debugger.ts';
import { hex } from './util/int32.ts';
import { Prng } from './util/prng.ts';

export interface DemoState {
  registers: Record<string, bigint>;
  flags: Record<string, number>;
}

export interface DemoResult {
  ok: boolean;
  message: string;
  listing: ListingEntry[];
  decoded: { address: number; bytes: number[]; result: DecodeResult }[];
  before: DemoState;
  after: DemoState;
  events: StepEvent[];
  fault: string | null;
}

export interface DemoSetup {
  registers?: Record<string, number>;
  memory?: { address: number; value: number }[];
  flags?: Record<string, number>;
}

function snapshot(backend: Backend, m: Machine): DemoState {
  const registers: Record<string, bigint> = {};
  for (const r of backend.profile.registers) registers[r.name] = m.cpu.readReg(r.name);
  return { registers, flags: { ...m.cpu.readFlags() } };
}

/**
 * Assemble a short piece of assembly text and execute it from a given state.
 * Used for the worked state change of an instruction: the instructions run
 * in order, at most one step per instruction, and stop at a fault or service,
 * or once a transfer of control has taken effect. On MIPS that is after the
 * delay-slot instruction, which executes whether or not the branch is taken.
 */
export function runDemo(backend: Backend, text: string, setup: DemoSetup = {}): DemoResult {
  const empty: DemoState = { registers: {}, flags: {} };
  const assembled = assembleText(backend, text);
  if (!assembled.ok) {
    return { ok: false, message: assembled.errors.map((e) => e.message).join('; '), listing: [], decoded: [], before: empty, after: empty, events: [], fault: null };
  }
  const program = assembled.program;
  const m = new Machine(backend, { code: program.bytes, entry: program.base, listing: program });
  for (const [name, value] of Object.entries(setup.registers ?? {})) m.cpu.writeReg(name, BigInt(value >>> 0));
  for (const w of setup.memory ?? []) {
    m.mem.poke(w.address, [w.value & 0xff, (w.value >>> 8) & 0xff, (w.value >>> 16) & 0xff, (w.value >>> 24) & 0xff]);
  }
  for (const [name, value] of Object.entries(setup.flags ?? {})) m.cpu.writeFlag(name, value);
  const before = snapshot(backend, m);
  const events: StepEvent[] = [];
  const count = program.insns.filter((i) => i.insn !== null).length;
  for (let k = 0; k < count && m.status === 'running'; k++) {
    const ev = newStepEvent(k);
    const more = m.cpu.pc >= program.base && m.cpu.pc < program.base + program.bytes.length ? m.cpu.step(ev) : { kind: 'fault' as const, message: 'left the example' };
    if (ev.length > 0) events.push(ev);
    if (more !== null) {
      ev.stop = more;
      if (more.kind === 'fault') {
        return { ok: true, message: '', listing: listingOf(program), decoded: decodeAll(backend, program.bytes), before, after: snapshot(backend, m), events, fault: more.message };
      }
      break;
    }
    // A branch or jump ends the demonstration once control moves anywhere other than the
    // following instruction. A delayed branch moves it only after its delay slot. The full
    // program counter is compared, because on AArch64 it can exceed 32 bits.
    if (m.cpu.readReg(backend.profile.pcName) !== BigInt((ev.pc + ev.length) >>> 0)) break;
  }
  return { ok: true, message: '', listing: listingOf(program), decoded: decodeAll(backend, program.bytes), before, after: snapshot(backend, m), events, fault: null };
}

function decodeAll(backend: Backend, bytes: Uint8Array): DemoResult['decoded'] {
  const out: DemoResult['decoded'] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const result = backend.decode(bytes, offset, LAYOUT.codeBase + offset);
    const length = Math.max(1, Math.min(result.length, bytes.length - offset));
    out.push({ address: LAYOUT.codeBase + offset, bytes: Array.from(bytes.subarray(offset, offset + length)), result });
    if (!result.ok && result.kind === 'truncated') break;
    offset += length;
  }
  return out;
}

export type ExerciseKind = 'register' | 'field' | 'branch';

export interface Exercise {
  kind: ExerciseKind;
  target: string;
  prompt: string;
  material: string[];
  given: { name: string; value: string }[];
  /** Accepted answers in normalized form (lower case, no spaces or underscores). */
  answers: string[];
  explanation: string;
  choices?: string[];
}

export function normalizeAnswer(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_]/g, '');
}

function signed(value: bigint, bits: number): bigint {
  return BigInt.asIntN(bits, value);
}

function candidates(backend: Backend, test: (s: InsnSpec, demo: DemoResult) => boolean, values: (r: Prng) => number, r: Prng, tries = 80): { spec: InsnSpec; demo: DemoResult; setup: DemoSetup } | null {
  const specs = backend.instructions.filter((s) => !s.pseudo && s.simulate);
  for (let k = 0; k < tries; k++) {
    const spec = r.pick(specs);
    const setup: DemoSetup = { registers: {}, memory: spec.demo?.mem ?? [], flags: {} };
    for (const name of Object.keys(spec.demo?.regs ?? {})) setup.registers![name] = values(r);
    for (const f of backend.profile.flags) setup.flags![f.name] = r.below(2);
    // Registers that address memory in the example keep their documented values.
    if (spec.group === 'memory' || spec.group === 'control') Object.assign(setup.registers!, pickAddressRegisters(spec));
    const demo = runDemo(backend, spec.example, setup);
    if (demo.ok && demo.fault === null && demo.events.length > 0 && test(spec, demo)) return { spec, demo, setup };
  }
  return null;
}

function pickAddressRegisters(spec: InsnSpec): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(spec.demo?.regs ?? {})) {
    const u = value >>> 0;
    if (u >= LAYOUT.codeBase) out[name] = value;
  }
  return out;
}

/**
 * Build one exercise for a target from an initialization value. The same
 * value always gives the same exercise. Returns null when the target's
 * catalog has no instruction suitable for the kind.
 */
export function makeExercise(backend: Backend, kind: ExerciseKind, init: number): Exercise | null {
  const r = new Prng(init ^ 0x5bd1e995);
  const id = backend.profile.id;
  const bits = backend.profile.registerBits;
  const small = (p: Prng): number => p.pick([p.range(-9, 20), p.range(0, 255), p.range(1, 31), -1, 4096, 0x7fffffff]);

  if (kind === 'register') {
    const found = candidates(
      backend,
      (s, d) => ['arithmetic', 'logic', 'shift', 'compare'].includes(s.group) && d.events.length === 1 && d.events[0]!.regWrites.length === 1 && d.events[0]!.regReads.length > 0,
      small, r,
    );
    if (!found) return null;
    const ev = found.demo.events[0]!;
    const w = ev.regWrites[0]!;
    const value = signed(w.value, 32);
    const full = BigInt.asUintN(bits, w.value);
    const given = ev.regReads.map((x) => ({ name: x.reg, value: `${signed(x.value, 32)} (${hex(Number(BigInt.asUintN(32, x.value)))})` }));
    for (const f of backend.profile.flags) given.push({ name: `flag ${f.name}`, value: String(found.demo.before.flags[f.name] ?? 0) });
    return {
      kind, target: id,
      prompt: `What value does ${w.reg} hold after this instruction? Give the low 32 bits as a signed decimal number or in hexadecimal.`,
      material: [found.spec.example],
      given,
      answers: [normalizeAnswer(String(value)), normalizeAnswer(hex(Number(BigInt.asUintN(32, w.value)))), normalizeAnswer('0x' + full.toString(16)), normalizeAnswer('0x' + BigInt.asUintN(32, w.value).toString(16))],
      explanation: `${found.spec.semantics}. The simulator computed ${w.reg} = ${value} (${hex(Number(BigInt.asUintN(32, w.value)))}).`,
    };
  }

  if (kind === 'field') {
    const specs = backend.instructions.filter((s) => !s.pseudo && s.decode);
    for (let k = 0; k < 60; k++) {
      const spec = r.pick(specs);
      const demo = runDemo(backend, spec.example, {});
      const first = demo.decoded[0];
      if (!demo.ok || !first || !first.result.ok) continue;
      const pool: { field: BitField; where: string }[] = [];
      for (const f of first.result.fields) pool.push({ field: f, where: `bits ${f.hi} to ${f.lo} of the instruction word` });
      for (const b of first.result.byteFields ?? []) {
        for (const f of b.bits ?? []) pool.push({ field: f, where: `bits ${f.hi} to ${f.lo} of the ${b.name} byte` });
      }
      const usable = pool.filter((x) => x.field.hi > x.field.lo && !/opcode/i.test(x.field.name));
      if (usable.length === 0) continue;
      const pick = r.pick(usable);
      const bytes = first.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const binary = pick.field.value.toString(2);
      const padded = binary.padStart(pick.field.hi - pick.field.lo + 1, '0');
      // Digits without a prefix are read as decimal only, so that a wrong decimal answer
      // spelled with 0 and 1 is never taken for the binary value.
      return {
        kind, target: id,
        prompt: `The instruction "${spec.example}" is stored as the bytes ${bytes} (in memory order). What is the value of the field ${pick.field.name}, ${pick.where}? Answer in decimal, or in binary with the prefix 0b.`,
        material: [spec.example],
        given: [],
        answers: [...new Set([normalizeAnswer(String(pick.field.value)), normalizeAnswer('0b' + binary), normalizeAnswer('0b' + padded), normalizeAnswer('0x' + pick.field.value.toString(16))])],
        explanation: `The field holds ${pick.field.value} (binary ${padded}): ${pick.field.text}.`,
      };
    }
    return null;
  }

  const found = candidates(backend, (_s, d) => d.events[0]!.branch?.conditional === true, (p) => p.pick([0, 1, -1, 3, 7, 7, 12]), r, 200);
  if (!found) return null;
  const ev = found.demo.events[0]!;
  const taken = ev.branch!.taken;
  const given = ev.regReads.map((x) => ({ name: x.reg, value: String(signed(x.value, 32)) }));
  for (const f of backend.profile.flags) given.push({ name: `flag ${f.name}`, value: String(found.demo.before.flags[f.name] ?? 0) });
  // The processor model shows where execution continues when the example runs again with an
  // instruction after it, which on a target with delay slots executes before control moves.
  const slot = runDemo(backend, `${found.spec.example}\nnop`, found.setup).events[1];
  const next = slot?.delaySlot
    ? `the delay-slot instruction at ${hex(slot.pc)} executes next, and execution then continues at ${hex(slot.nextPc)}`
    : `the next instruction is fetched from ${hex(ev.nextPc)}`;
  return {
    kind, target: id,
    prompt: `The instruction is at address ${hex(ev.pc)}. Is the branch taken?`,
    material: [found.spec.example],
    given,
    answers: [taken ? 'taken' : 'nottaken'],
    choices: ['taken', 'not taken'],
    explanation: `${found.spec.semantics}. With these values the branch is ${taken ? 'taken' : 'not taken'}, so ${next}.`,
  };
}
