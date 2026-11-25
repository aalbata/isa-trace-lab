/**
 * Export the inputs of the independent validation harness.
 *
 *   node scripts/export-validation.ts [--target <id>|all] [--out validation/work] [--per-family N]
 *
 * For each target the script writes four JSON files that hold this tool's own
 * results; `validation/run_validation.py` recomputes them with the reference
 * assembler and linker, the reference disassembler, and the reference emulator,
 * and compares:
 *   encoding.json   programs as reference assembly text with the bytes produced here;
 *   decoding.json   byte sequences with the decoding produced here, and the
 *                   encodings of every sweep instruction produced by the encoder;
 *   execution.json  single instructions with initial and final machine state,
 *                   including every byte of the data and stack regions that changed;
 *   programs.json   compiled programs, run with every argument tuple of the
 *                   corpus, with the observed execution results.
 * A fifth file, common/semantics.json, holds the source programs and the
 * outcomes of the reference evaluator and the IR interpreter.
 *
 * Every file records the combined hash of the source tree, computed when the
 * script starts (scripts/source-manifest.mjs); a stage of the harness runs
 * only on inputs exported from the tree it runs in.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileBackEnd, compileFrontEnd } from '../src/core/compile.ts';
import { interpretIR } from '../src/core/ir/interp.ts';
import { evaluateReference } from '../src/core/lang/reference.ts';
import { assembleText } from '../src/core/target/assemble.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import { Machine, loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { LAYOUT } from '../src/core/target/memory.ts';
import type { AssembledProgram, Backend, Insn } from '../src/core/target/types.ts';
import { bytesToHex } from '../src/core/util/int32.ts';
import { Prng } from '../src/core/util/prng.ts';
import { VERSION } from '../src/core/version.ts';
import { CORPUS_SETTINGS, loadCorpus, repoRoot } from './lib/corpus.ts';
import { sourceManifest } from './lib/source-tree.ts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const targetArg = opt('target', 'all');
const outDir = join(repoRoot(), opt('out', 'validation/work'));
const perFamily = Number(opt('per-family', String(CORPUS_SETTINGS.programsPerFamily)));
const backends = targetArg === 'all' ? availableBackends() : [getBackend(targetArg)];
const sourceTree = sourceManifest().sha256;
const corpus = loadCorpus({ perFamily });

const hexAddr = (a: number): string => (a >>> 0).toString(16).padStart(8, '0');
const hx = (b: ArrayLike<number>): string => bytesToHex(b, '');

/**
 * One byte per address of a region: (a + 37 * (a >> 8) + 101 * (a >> 16)) mod 256
 * for the address a, so the byte depends on every bit of the address that
 * varies within a region. Within the data region and within the stack region,
 * two addresses whose distance is a power of two hold different bytes, so a
 * load whose address is wrong by a power of two reads a different first byte.
 * Other pairs of addresses can hold the same byte, since each block of 256
 * addresses holds every byte value once. `validation/run_validation.py`
 * computes the same bytes, and `validation/harness_controls.py` checks the
 * property for every pair of addresses at such a distance.
 */
function addressBytes(base: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const a = base + i;
    out[i] = (a + 37 * (a >>> 8) + 101 * (a >>> 16)) % 256;
  }
  return out;
}

interface PatternedRegion {
  base: number;
  size: number;
  bytes: Uint8Array;
}

/** The writable regions, which both sides fill before an instruction-level case. */
const DATA_REGION: PatternedRegion = { base: LAYOUT.dataBase, size: LAYOUT.dataSize, bytes: addressBytes(LAYOUT.dataBase, LAYOUT.dataSize) };
const STACK_REGION: PatternedRegion = {
  base: LAYOUT.stackTop - LAYOUT.stackSize, size: LAYOUT.stackSize, bytes: addressBytes(LAYOUT.stackTop - LAYOUT.stackSize, LAYOUT.stackSize),
};

/**
 * Initial contents of a region for an instruction-level case: the address bytes XOR the low byte of the salt. The
 * salt changes every byte in the same way, so two addresses hold different bytes in every case or in none.
 */
export function regionPattern(region: PatternedRegion, salt: number): Uint8Array {
  const out = new Uint8Array(region.size);
  const words = new Uint32Array(out.buffer);
  const source = new Uint32Array(region.bytes.buffer, region.bytes.byteOffset, region.size >>> 2);
  const mask = (salt & 0xff) * 0x01010101;
  for (let i = 0; i < words.length; i++) words[i] = source[i]! ^ mask;
  return out;
}

/** Runs of consecutive bytes whose value in `after` differs from `before`, with their addresses. */
function changedRuns(base: number, before: Uint8Array, after: Uint8Array): { address: number; bytes: string }[] {
  const out: { address: number; bytes: string }[] = [];
  const b32 = new Uint32Array(before.buffer, before.byteOffset, before.length >>> 2);
  const a32 = new Uint32Array(after.buffer, after.byteOffset, after.length >>> 2);
  let i = 0;
  while (i < after.length) {
    if ((i & 3) === 0 && i + 4 <= after.length && a32[i >>> 2] === b32[i >>> 2]) {
      i += 4;
      continue;
    }
    if (after[i] === before[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < after.length && after[i] !== before[i]) i++;
    out.push({ address: base + start, bytes: hx(after.subarray(start, i)) });
  }
  return out;
}

/** Little-endian bytes of an unsigned value. */
function littleEndian(value: bigint, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, k) => Number((value >> BigInt(8 * k)) & 0xffn));
}

/**
 * Definition of a symbol for a branch target that is not the address of an
 * instruction of the program. The symbol is defined relative to `_start`, the
 * first address of the program, so the reference assembler knows the distance
 * to it and chooses the same instruction form as for a label.
 */
function targetSymbol(name: string, address: number): string {
  const delta = address - LAYOUT.codeBase;
  return `.set ${name}, _start ${delta < 0 ? '-' : '+'} ${Math.abs(delta)}`;
}

/** Branch pseudoinstructions that `referenceText` prints as written in the source. */
const BRANCH_PSEUDO = /^(b|beqz|bnez)\s+(.*)$/;

/**
 * Text of an assembled program in the syntax of the reference assembler.
 * A branch target that is the address of an instruction of the program becomes
 * a label; any other target becomes a symbol defined relative to `_start`.
 *
 * An instruction that is the whole expansion of the pseudoinstruction b, beqz,
 * or bnez is printed as that pseudoinstruction, with its mnemonic and register
 * as written and the label or symbol of the resolved target as its last
 * operand. The reference assembler then chooses the expansion, so the bytes
 * of a compiled program agree only when this tool expands the
 * pseudoinstruction as the reference assembler does.
 */
function referenceText(backend: Backend, program: AssembledProgram): { asm: string } {
  const starts = new Set(program.insns.map((i) => i.address));
  const labels = new Map<number, string>();
  const absolutes = new Map<number, string>();
  for (const i of program.insns) {
    for (const o of i.insn?.operands ?? []) {
      if (o.t !== 'addr') continue;
      if (starts.has(o.value)) labels.set(o.value, `L_${hexAddr(o.value)}`);
      else absolutes.set(o.value, `T_${hexAddr(o.value)}`);
    }
  }
  const lines: string[] = [...backend.validation.preamble];
  for (const [value, name] of absolutes) lines.push(targetSymbol(name, value));
  for (const i of program.insns) {
    const label = labels.get(i.address);
    if (label) lines.push(`${label}:`);
    if (i.insn === null) {
      const bytes = program.bytes.subarray(i.address - program.base, i.address - program.base + i.length);
      lines.push(`.byte ${Array.from(bytes, (b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}`);
      continue;
    }
    const pseudo = i.meta.pseudo && i.meta.pseudo.count === 1 ? BRANCH_PSEUDO.exec(i.meta.pseudo.text) : null;
    const target = i.insn.operands.find((o) => o.t === 'addr');
    if (pseudo && target) {
      const operands = pseudo[2]!.split(',').map((s) => s.trim());
      operands[operands.length - 1] = (labels.get(target.value) ?? absolutes.get(target.value))!;
      lines.push(`    ${pseudo[1]} ${operands.join(', ')}`);
      continue;
    }
    const insn: Insn = {
      mnemonic: i.insn.mnemonic,
      operands: i.insn.operands.map((o) => (o.t === 'addr' ? { t: 'label', name: (labels.get(o.value) ?? absolutes.get(o.value))! } : o)),
    };
    lines.push(`    ${backend.format(insn)}`);
  }
  return { asm: lines.join('\n') + '\n' };
}

/**
 * Listing entries: address, length, and text of each item. `d` marks a data
 * directive (bytes placed as data, not an instruction); `p` gives the
 * pseudoinstruction or alias written in the source, on the first instruction of
 * its expansion; `n` gives the line of the assembly text the item comes from.
 */
function listing(program: AssembledProgram): { a: number; l: number; t: string; d?: 1; p?: string; n?: number }[] {
  return program.insns.map((i) => ({
    a: i.address, l: i.length, t: i.text,
    ...(i.insn === null ? { d: 1 as const } : {}),
    ...(i.meta.pseudo && i.meta.pseudo.index === 0 ? { p: i.meta.pseudo.text } : {}),
    ...(i.meta.line !== undefined ? { n: i.meta.line } : {}),
  }));
}

interface SweepProgram {
  name: string;
  program: AssembledProgram;
}

function exportTarget(backend: Backend): void {
  const id = backend.profile.id;
  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  const header = { tool: 'isa-trace-lab', version: VERSION, source: sourceTree, target: id, base: LAYOUT.codeBase };

  // ---- encoding ---------------------------------------------------------------
  const encodingPrograms: unknown[] = [];
  const sweepPrograms: SweepProgram[] = [];
  // Encodings of every sweep instruction, produced by the encoder. The decoding stage names them with the reference
  // disassembler to learn which instructions are implemented, independently of the decoder under test.
  const implemented = new Set<string>();
  for (const sweep of backend.validation.sweeps()) {
    const res = assembleText(backend, sweep.text);
    if (!res.ok) throw new Error(`${id} sweep '${sweep.name}' does not assemble: ${res.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
    const ref = sweep.passthrough ? { asm: backend.validation.preamble.join('\n') + '\n' + sweep.text } : referenceText(backend, res.program);
    encodingPrograms.push({
      name: `sweep/${sweep.name}`, kind: sweep.passthrough ? 'pseudo' : 'sweep', ...ref, bytes: hx(res.program.bytes), insns: listing(res.program),
    });
    if (!sweep.passthrough) sweepPrograms.push({ name: sweep.name, program: res.program });
    for (const i of res.program.insns) {
      if (i.insn !== null) implemented.add(hx(res.program.bytes.subarray(i.address - res.program.base, i.address - res.program.base + i.length)));
    }
  }
  const compiledPrograms = corpus.map((p) => {
    const front = compileFrontEnd(p.source);
    if (!front.ok || !front.ir) throw new Error(`corpus program ${p.name} does not compile`);
    return { p, front, compiled: compileBackEnd(p.source, front.ir, backend) };
  });
  for (const { p, compiled } of compiledPrograms) {
    encodingPrograms.push({
      name: p.name, kind: 'compiled', ...referenceText(backend, compiled.program), bytes: hx(compiled.program.bytes), insns: listing(compiled.program),
    });
  }
  writeFileSync(join(dir, 'encoding.json'), JSON.stringify({
    ...header, preamble: backend.validation.preamble, registers: backend.profile.registers.map((r) => r.name), programs: encodingPrograms,
  }));

  // ---- decoding ---------------------------------------------------------------
  // Random words (fixed-length targets) and alternate encodings, decoded here. The harness
  // reassembles the decoded text with the reference assembler and compares the bytes.
  const decodeCases: unknown[] = [];
  const prng = new Prng(20261121);
  const fixed = backend.profile.instructionLength.min === backend.profile.instructionLength.max;
  const emitDecodeGroup = (name: string, chunks: Uint8Array[], exact: boolean): void => {
    let pc = LAYOUT.codeBase;
    const accepted: { pc: number; bytes: string; text: string; alias?: string }[] = [];
    const rejected: { bytes: string; kind: string }[] = [];
    const lines: string[] = [...backend.validation.preamble];
    const absolutes = new Map<number, string>();
    const body: string[] = [];
    for (const bytes of chunks) {
      const d = backend.decode(bytes, 0, pc);
      if (!d.ok) {
        rejected.push({ bytes: hx(bytes), kind: d.kind });
        continue;
      }
      const used = bytes.subarray(0, d.length);
      const insn: Insn = {
        mnemonic: d.insn.mnemonic,
        operands: d.insn.operands.map((o) => {
          if (o.t !== 'addr') return o;
          const sym = `T_${hexAddr(o.value)}`;
          absolutes.set(o.value, sym);
          return { t: 'label', name: sym };
        }),
      };
      const entry: { pc: number; bytes: string; text: string; alias?: string } = { pc, bytes: hx(used), text: backend.format(d.insn) };
      if (d.alias) entry.alias = d.alias;
      accepted.push(entry);
      body.push(`    ${backend.format(insn)}`);
      pc += d.length;
    }
    for (const [value, sym] of absolutes) lines.push(targetSymbol(sym, value));
    decodeCases.push({ name, exact, accepted, rejected, asm: lines.concat(body).join('\n') + '\n' });
  };
  if (fixed) {
    const width = backend.profile.instructionLength.min;
    for (let g = 0; g < 20; g++) {
      const chunks: Uint8Array[] = [];
      for (let k = 0; k < 5000; k++) chunks.push(Uint8Array.from({ length: width }, () => prng.below(256)));
      emitDecodeGroup(`random-words-${g}`, chunks, true);
    }
  } else {
    // Variable-length targets: random byte strings of the maximum instruction length. The first
    // instruction of each string is decoded; accepted ones keep only the bytes the instruction uses.
    const max = backend.profile.instructionLength.max;
    for (let g = 0; g < 20; g++) {
      const chunks: Uint8Array[] = [];
      for (let k = 0; k < 5000; k++) {
        const bytes = Uint8Array.from({ length: max }, () => prng.below(256));
        const d = backend.decode(bytes, 0, LAYOUT.codeBase);
        chunks.push(d.ok ? bytes.subarray(0, d.length) : bytes);
      }
      emitDecodeGroup(`random-bytes-${g}`, chunks, true);
    }
  }
  const alternates = backend.validation.alternateEncodings ?? [];
  if (alternates.length > 0) {
    emitDecodeGroup('alternate-encodings', alternates.map((a) => Uint8Array.from(a.bytes.match(/../g)!.map((h) => parseInt(h, 16)))), false);
  }
  writeFileSync(join(dir, 'decoding.json'), JSON.stringify({ ...header, groups: decodeCases, implemented: [...implemented] }));

  // ---- instruction-level execution ----------------------------------------------
  const execCases: unknown[] = [];
  const states = 4;
  const regNames = backend.profile.registers.map((r) => r.name);
  const flagNames = backend.profile.flags.map((f) => f.name);
  const boundary = [0, 1, -1, 2, 0x7fffffff, -0x80000000, 0x55555555, -0x55555556, 0xff, 0x100, 31, 32];
  const initialSp = LAYOUT.stackTop - 0x100;
  for (const sweep of sweepPrograms) {
    for (const ai of sweep.program.insns) {
      if (ai.insn === null) continue;
      for (let s = 0; s < states; s++) {
        const salt = execCases.length;
        const m = new Machine(backend, { code: sweep.program.bytes, entry: ai.address });
        // The whole data and stack regions are filled, so that every load reads bytes that depend on its address.
        // In half of the states the word at the initial stack pointer holds an address in the code region, so that
        // a return that pops it reaches mapped code; in the others it holds the bytes of the fill.
        const dataBefore = regionPattern(DATA_REGION, salt);
        const stackBefore = regionPattern(STACK_REGION, salt);
        const memoryInit: { address: number; bytes: string }[] = [];
        if (s % 2 === 0) {
          const slot = littleEndian(BigInt(LAYOUT.codeBase + LAYOUT.codeSize / 2 + 8 * (salt % 512)), backend.profile.registerBits / 8);
          stackBefore.set(slot, initialSp - STACK_REGION.base);
          memoryInit.push({ address: initialSp, bytes: hx(slot) });
        }
        m.mem.poke(DATA_REGION.base, dataBefore);
        m.mem.poke(STACK_REGION.base, stackBefore);
        for (const name of regNames) {
          const lo = prng.chance(0.5) ? prng.pick(boundary) : prng.s32();
          const hi = backend.profile.registerBits === 64 && prng.chance(0.5) ? prng.u32() : 0;
          m.cpu.writeReg(name, (BigInt(hi) << 32n) | BigInt(lo >>> 0));
        }
        m.cpu.writeReg(backend.profile.conventions.stackPointer, BigInt(initialSp));
        // Memory operands are steered into the data region.
        for (const o of ai.insn.operands) {
          if (o.t !== 'mem') continue;
          if (o.index) m.cpu.writeReg(o.index, BigInt(prng.below(8)));
          if (o.base) m.cpu.writeReg(o.base, BigInt(LAYOUT.dataBase + 0x800));
        }
        for (const f of flagNames) m.cpu.writeFlag(f, prng.below(2));
        m.cpu.pc = ai.address;
        const before: Record<string, string> = {};
        for (const name of regNames) before[name] = m.cpu.readReg(name).toString(16);
        const flagsBefore = { ...m.cpu.readFlags() };
        const ev = newStepEvent(0);
        m.step(ev);
        let steps = 1;
        // The service instruction: the processor has executed it, and the machine has then performed the requested
        // service, which stops the machine when the random service number is not one of the services provided. The
        // expectation is the processor's state after the instruction, which the reference emulator gives with its
        // service hook, installed for every case. `service` marks the cases that this tool executed as a service
        // request.
        const service = ev.klass === 'service' && ev.stop?.kind === 'service';
        // A MIPS branch or jump takes effect after the instruction in its delay slot.
        if (id === 'mips' && (ev.klass === 'branch' || ev.klass === 'jump') && m.status === 'running') {
          m.step();
          steps = 2;
        }
        const after: Record<string, string> = {};
        for (const name of regNames) after[name] = m.cpu.readReg(name).toString(16);
        execCases.push({
          sweep: sweep.name, text: ai.text, pc: ai.address, length: ai.length, salt, steps,
          ...(service ? { service: true } : {}),
          code: hx(sweep.program.bytes),
          regs: before, flags: flagsBefore, memoryInit,
          expect: {
            fault: !service && m.status === 'fault' ? m.fault : null,
            regs: after, flags: m.cpu.readFlags(),
            pc: BigInt.asUintN(backend.profile.registerBits, m.cpu.readReg(backend.profile.pcName)).toString(16),
            memory: [...changedRuns(DATA_REGION.base, dataBefore, m.mem.data.bytes), ...changedRuns(STACK_REGION.base, stackBefore, m.mem.stack.bytes)],
            memWrites: ev.memWrites.map((w) => ({ address: w.address, size: w.size, value: w.value.toString(16) })),
            // The registers are those of the state before the instruction, which may overwrite the register it reads.
            undefinedFlags: backend.validation.undefinedFlags?.(ai.insn, (name) => BigInt('0x' + before[name]!)) ?? [],
          },
        });
      }
    }
  }
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({
    ...header, registers: regNames, flags: flagNames, stackPointer: backend.profile.conventions.stackPointer,
    memoryRegions: [{ name: 'data', base: DATA_REGION.base, size: DATA_REGION.size }, { name: 'stack', base: STACK_REGION.base, size: STACK_REGION.size }],
    cases: execCases,
  }));

  // ---- program-level execution ----------------------------------------------------
  const programCases: unknown[] = [];
  for (const { p, compiled } of compiledPrograms) {
    for (const args of p.args) {
      const m = loadCompiled(backend, compiled, { args, limits: { maxSteps: 50_000_000 } });
      const o = m.run();
      const homes: Record<string, string> = {};
      for (const v of compiled.variables) if (v.home.kind === 'reg') homes[v.home.reg] = (m.cpu.reg32(v.home.reg) >>> 0).toString(16);
      programCases.push({
        name: p.name, args, code: hx(compiled.program.bytes), data: hx(compiled.dataImage), entry: compiled.entry,
        expect: {
          status: o.status, returnValue: o.returnValue ?? null, trapCode: o.trap?.code ?? null, output: o.output,
          executed: m.executed, dataAfter: hx(m.mem.peek(LAYOUT.dataBase, compiled.dataImage.length) ?? new Uint8Array()), homes,
        },
      });
    }
  }
  const conv = backend.profile.conventions;
  writeFileSync(join(dir, 'programs.json'), JSON.stringify({
    ...header, layout: LAYOUT, args: conv.args, serviceNumber: conv.serviceNumber, serviceArg: conv.serviceArg,
    stackPointer: conv.stackPointer, cases: programCases,
  }));
  console.log(`${id}: ${encodingPrograms.length} encoding programs, ${decodeCases.length} decoding groups, ${execCases.length} instruction cases, ${programCases.length} program runs`);
}

function exportSemantics(): void {
  const dir = join(outDir, 'common');
  mkdirSync(dir, { recursive: true });
  const cases: unknown[] = [];
  for (const p of corpus) {
    const front = compileFrontEnd(p.source);
    if (!front.ok || !front.ir) throw new Error(`corpus program ${p.name} does not compile`);
    for (const args of p.args) {
      const ref = evaluateReference(front.checked, args);
      const ir = interpretIR(front.ir, args);
      const pick = (o: typeof ref | typeof ir) => ({
        status: o.status, returnValue: o.returnValue ?? null, trapCode: o.trap?.code ?? null, trapLine: o.trap?.line ?? null, output: o.output,
      });
      cases.push({
        name: p.name, group: p.group, family: p.family, args, reference: pick(ref), ir: pick(ir),
        pythonCoincident: ref.pythonCoincident, implicitReturn: ref.implicitReturn, finalVars: ref.finalVars, finalArrays: ref.finalArrays,
      });
    }
  }
  const sources: Record<string, string> = {};
  for (const p of corpus) sources[p.name] = p.source;
  writeFileSync(join(dir, 'semantics.json'), JSON.stringify({
    tool: 'isa-trace-lab', version: VERSION, source: sourceTree, corpus: { ...CORPUS_SETTINGS, programsPerFamily: perFamily }, sources, cases,
  }));
  console.log(`common: ${corpus.length} programs, ${cases.length} runs`);
}

exportSemantics();
for (const b of backends) exportTarget(b);
