/**
 * Interactive debugger: a machine with stepping by instruction and by
 * source statement, breakpoints, controlled edits, and exact reverse stepping.
 *
 * Reverse stepping restores state by replaying: the machine is reset and run
 * forward to the requested instruction count, re-applying the recorded edits
 * (byte, register, and flag changes) at the steps where they were made.
 * Execution is deterministic, so the replayed state is the earlier state.
 */
import type { CompiledProgram } from './compile.ts';
import { trapMessage } from './exec.ts';
import type { RunLimits } from './exec.ts';
import { Machine, newStepEvent } from './target/machine.ts';
import { LAYOUT } from './target/memory.ts';
import type { AssembledProgram, Backend, StepEvent } from './target/types.ts';
import type { Metrics } from './trace/documents.ts';
import { metricsOf } from './trace/documents.ts';
import { hex64, hexAddress } from './util/int32.ts';

export interface ListingEntry {
  address: number;
  bytes: number[];
  text: string;
  pseudo?: string;
  labels: string[];
  region: string;
  lines: number[];
  ir: number[];
  note?: string;
  asmLine?: number;
}

export interface DebuggerView {
  target: string;
  status: 'running' | 'exited' | 'trap' | 'limit' | 'fault';
  statusText: string;
  /**
   * Address of the next instruction. A negative number is an address below zero
   * of the 64-bit x86-64 address space (2^64 plus the value).
   */
  pc: number;
  /**
   * Full program counter, present only when it lies above the 32-bit address
   * space and the processor model keeps it in two halves (AArch64 after a
   * branch to such a register value); `pc` then holds the low 32 bits, and no
   * instruction is offered as the next one.
   */
  pc64?: bigint;
  executed: number;
  boundaryCount: number;
  regionCounts: Record<string, number>;
  registers: { name: string; value: bigint; written: boolean }[];
  flags: Record<string, number>;
  output: number[];
  outputLength: number;
  lastEvent: StepEvent | null;
  /** The most recent instructions, oldest first; `pc` and `pc64` give the address of each as the fields of the view do. */
  recent: { index: number; pc: number; pc64?: bigint; text: string; note: string }[];
  next: { address: number; text: string; lines: number[]; ir: number[]; region: string } | null;
  nextStale: boolean;
  nextBoundaries: { statement: number; line: number }[];
  variables: { name: string; type: string; home: string; value: number | null }[];
  /** `defined` is false until the defining statement of the array has executed; `values` is then empty. */
  arrays: { name: string; address: number; defined: boolean; values: number[]; truncated: boolean }[];
  memory: { address: number; bytes: number[] | null }[];
  codeEdited: boolean;
  staleAddresses: number[];
  loads: number;
  stores: number;
  metrics: Metrics | null;
  stopReason: string;
}

type Edit =
  | { step: number; kind: 'poke'; address: number; bytes: number[] }
  | { step: number; kind: 'register'; name: string; value: bigint }
  | { step: number; kind: 'flag'; name: string; value: number };

const RECENT = 256;
const MAX_OUTPUT_SHOWN = 2000;
const MAX_ARRAY_SHOWN = 256;
/** Reverse stepping replays from the start, so it is offered only for runs up to this length. */
export const MAX_REPLAY_STEPS = 20_000_000;

/** Listing lines of an assembled program, with source lines when it was compiled from source. */
export function listingOf(program: AssembledProgram, compiled?: CompiledProgram): ListingEntry[] {
  return program.insns.map((i) => {
    const line: ListingEntry = {
      address: i.address,
      bytes: Array.from(program.bytes.subarray(i.address - program.base, i.address - program.base + i.length)),
      text: i.text,
      labels: i.labels.slice(),
      region: i.meta.region,
      lines: compiled ? [...new Set(i.meta.irOps.map((op) => compiled.opSpans[op]!.start.line))].sort((a, b) => a - b) : [],
      ir: i.meta.irOps.slice(),
    };
    if (i.meta.pseudo) line.pseudo = i.meta.pseudo.text;
    if (i.meta.note) line.note = i.meta.note;
    if (i.meta.line !== undefined) line.asmLine = i.meta.line;
    return line;
  });
}

export class Debugger {
  readonly backend: Backend;
  readonly machine: Machine;
  readonly compiled: CompiledProgram | undefined;
  readonly program: AssembledProgram | undefined;
  lastEvent: StepEvent | null = null;
  stopReason = '';
  private breakAddresses = new Set<number>();
  private breakLines = new Set<number>();
  private edits: Edit[] = [];
  /** Addresses of the recent instructions; a negative address is below zero of the 64-bit x86-64 address space. */
  private recentPc = new Float64Array(RECENT);
  private recentIndex = new Float64Array(RECENT);
  private recentCount = 0;
  /**
   * Full program counter of a recent instruction whose fetch faulted above the
   * 32-bit address space, by instruction index; `recentPc` holds its low 32 bits.
   */
  private recentPc64 = new Map<number, bigint>();

  /**
   * Throws ArgumentCountError when `source` is a compiled program and `args`
   * does not supply one value per parameter of main, and a RangeError when the
   * code or data does not fit its region.
   */
  constructor(
    backend: Backend,
    source: { compiled: CompiledProgram } | { program: AssembledProgram } | { code: Uint8Array },
    options: { args?: readonly number[]; limits?: Partial<RunLimits> } = {},
  ) {
    this.backend = backend;
    if ('compiled' in source) {
      this.compiled = source.compiled;
      this.program = source.compiled.program;
      this.machine = new Machine(backend, { code: this.program.bytes, data: source.compiled.dataImage, entry: source.compiled.entry, compiled: source.compiled }, options);
    } else if ('program' in source) {
      this.program = source.program;
      this.machine = new Machine(backend, { code: source.program.bytes, entry: source.program.symbols['_start'] ?? source.program.base, listing: source.program }, options);
    } else {
      this.machine = new Machine(backend, { code: source.code, entry: LAYOUT.codeBase }, options);
    }
  }

  // ---- execution -------------------------------------------------------------

  private remember(pc: number, index: number): void {
    const slot = this.recentCount % RECENT;
    this.recentPc[slot] = pc;
    this.recentIndex[slot] = index;
    this.recentCount++;
  }

  private stepOnce(record: boolean): boolean {
    const m = this.machine;
    const pc = m.cpu.pc;
    const index = m.executed;
    let more: boolean;
    if (record) {
      const ev = newStepEvent(index);
      more = m.step(ev);
      if (m.executed > index) this.lastEvent = ev;
    } else more = m.step();
    if (m.executed > index) {
      this.remember(pc, index);
      // A fetch above the 32-bit address space faults and leaves the program counter where it was.
      if (m.status === 'fault') {
        const pc64 = m.pc64;
        if (pc64 !== undefined) this.recentPc64.set(index, pc64);
      }
    }
    return more;
  }

  private atBreakpoint(): string | null {
    const m = this.machine;
    const pc = m.cpu.pc;
    // The low half of a program counter above the 32-bit address space is not the address of a breakpoint.
    if (this.breakAddresses.has(pc) && m.pc64 === undefined) return `breakpoint at ${hexAddress(pc)}`;
    if (this.breakLines.size > 0 && this.compiled) {
      for (const stmt of m.boundariesAtPc() ?? []) {
        const line = this.compiled.ir.stmts[stmt]?.span.start.line;
        if (line !== undefined && this.breakLines.has(line)) return `breakpoint at source line ${line}`;
      }
    }
    return null;
  }

  /**
   * Execute up to `count` instructions, recording the details of the last one.
   * Every instruction is recorded, because a breakpoint or the end of the run
   * can make any of them the last one.
   */
  step(count = 1): void {
    this.stopReason = '';
    for (let i = 0; i < count; i++) {
      if (!this.stepOnce(true)) break;
      if (i < count - 1) {
        const hit = this.atBreakpoint();
        if (hit) {
          this.stopReason = hit;
          break;
        }
      }
    }
  }

  /** Execute until the next statement boundary is about to fire, or the machine stops. */
  stepSource(maxSteps = 5_000_000): void {
    this.stopReason = '';
    const m = this.machine;
    for (let i = 0; i < maxSteps; i++) {
      if (!this.stepOnce(true)) return;
      if (m.boundariesAtPc()) return;
      const hit = this.atBreakpoint();
      if (hit) {
        this.stopReason = hit;
        return;
      }
    }
    this.stopReason = `no statement boundary within ${maxSteps} instructions`;
  }

  /**
   * Execute up to `budget` instructions without recording details.
   * Returns true when the run should continue with another slice.
   */
  runSlice(budget: number): boolean {
    this.stopReason = '';
    this.lastEvent = null;
    for (let i = 0; i < budget; i++) {
      if (!this.stepOnce(false)) return false;
      const hit = this.breakAddresses.size > 0 || this.breakLines.size > 0 ? this.atBreakpoint() : null;
      if (hit) {
        this.stopReason = hit;
        return false;
      }
    }
    return this.machine.status === 'running';
  }

  reset(): void {
    this.machine.reset();
    this.edits = [];
    this.lastEvent = null;
    this.recentCount = 0;
    this.recentPc64.clear();
    this.stopReason = '';
  }

  /** True when the earlier state can be restored by replay within the supported length. */
  get canStepBack(): boolean {
    return this.machine.executed > 0 && this.machine.executed <= MAX_REPLAY_STEPS;
  }

  private applyEdit(e: Edit): void {
    const m = this.machine;
    if (e.kind === 'poke') {
      const inCode = e.address >= LAYOUT.codeBase && e.address < LAYOUT.codeBase + LAYOUT.codeSize;
      if (inCode) m.pokeCode(e.address, e.bytes);
      else m.mem.poke(e.address, e.bytes);
    } else if (e.kind === 'register') m.cpu.writeReg(e.name, e.value);
    else m.cpu.writeFlag(e.name, e.value);
  }

  /**
   * Reset the machine and run it forward to `target` executed instructions,
   * applying each recorded edit at the instruction count where it was made.
   * `visit` is called after every replayed instruction, once the edits
   * recorded at the new instruction count have been applied.
   */
  private replay(target: number, edits: readonly Edit[], visit?: () => void): void {
    const m = this.machine;
    m.reset();
    this.lastEvent = null;
    this.recentCount = 0;
    this.recentPc64.clear();
    let next = 0;
    const apply = (): void => {
      while (next < edits.length && edits[next]!.step <= m.executed) {
        if (edits[next]!.step === m.executed) this.applyEdit(edits[next]!);
        next++;
      }
    };
    apply();
    while (m.executed < target && m.status === 'running') {
      this.stepOnce(m.executed === target - 1);
      apply();
      if (visit) visit();
    }
  }

  /**
   * Undo the last `count` instructions. `count` is a whole number of
   * instructions, at least 0; a count larger than the number executed returns
   * to the start. Throws a RangeError for a negative, fractional, or NaN count.
   */
  back(count = 1): void {
    if (!(count >= 0) || Math.floor(count) !== count) throw new RangeError(`the number of instructions to undo must be a whole number of at least 0, not ${count}`);
    if (!this.canStepBack) {
      this.stopReason = 'reverse stepping is not available for this run';
      return;
    }
    const target = Math.max(0, this.machine.executed - count);
    const edits = this.edits.filter((e) => e.step <= target);
    this.replay(target, edits);
    this.edits = edits;
    this.stopReason = '';
  }

  /** Return to the most recent statement boundary before the current instruction. */
  backSource(): void {
    if (!this.canStepBack) {
      this.stopReason = 'reverse stepping is not available for this run';
      return;
    }
    const m = this.machine;
    const here = m.executed;
    const all = this.edits.slice();
    // First pass: find the last instruction count below the current one at which a boundary address was reached.
    let boundary = 0;
    this.replay(here - 1, all, () => {
      if (m.boundariesAtPc()) boundary = m.executed;
    });
    const edits = all.filter((e) => e.step <= boundary);
    this.replay(boundary, edits);
    this.edits = edits;
    this.stopReason = '';
  }

  // ---- edits -----------------------------------------------------------------

  /** Overwrite memory bytes while paused. Code edits invalidate the provenance of the affected instructions. */
  poke(address: number, bytes: number[]): boolean {
    const m = this.machine;
    const inCode = address >= LAYOUT.codeBase && address < LAYOUT.codeBase + LAYOUT.codeSize;
    const ok = inCode ? m.pokeCode(address, bytes) : m.mem.poke(address, bytes);
    if (ok) this.edits.push({ step: m.executed, kind: 'poke', address, bytes: bytes.slice() });
    return ok;
  }

  setRegister(name: string, value: bigint): void {
    this.machine.cpu.writeReg(name, value);
    this.edits.push({ step: this.machine.executed, kind: 'register', name, value });
  }

  setFlag(name: string, value: number): void {
    this.machine.cpu.writeFlag(name, value);
    this.edits.push({ step: this.machine.executed, kind: 'flag', name, value });
  }

  setBreakpoints(addresses: readonly number[], lines: readonly number[]): void {
    this.breakAddresses = new Set(addresses);
    this.breakLines = new Set(lines);
  }

  // ---- views -----------------------------------------------------------------

  /** Text of the instruction at `pc`; `pc64` is given when `pc` is the low half of an address above the 32-bit address space. */
  private textAt(pc: number, pc64?: bigint): { text: string; note: string } {
    const m = this.machine;
    const info = pc64 === undefined ? m.insnInfo(pc) : undefined;
    if (info) return { text: info.text, note: info.meta.pseudo?.text ?? '' };
    if (pc64 !== undefined || pc < LAYOUT.codeBase || pc >= LAYOUT.codeBase + LAYOUT.codeSize) return { text: '(outside the code region)', note: '' };
    const bytes = m.mem.code.bytes.subarray(pc - LAYOUT.codeBase);
    const d = this.backend.decode(bytes.subarray(0, this.backend.profile.instructionLength.max), 0, pc);
    return d.ok ? { text: this.backend.format(d.insn), note: m.codeEdited ? 'decoded from current bytes' : '' } : { text: `(${d.kind})`, note: d.message };
  }

  statusText(): string {
    const m = this.machine;
    switch (m.status) {
      case 'running': {
        // The full program counter: 16 digits when it lies outside the 32-bit address space.
        const pc64 = m.pc64;
        const at = pc64 === undefined ? hexAddress(m.cpu.pc) : hex64(pc64);
        return m.executed === 0 ? `ready at ${at}` : `paused at ${at} after ${m.executed} instructions`;
      }
      case 'exited':
        return `main returned ${m.returnValue} after ${m.executed} instructions`;
      case 'trap':
        return `runtime error ${m.trap!.code}: ${trapMessage(m.trap!.code)}${m.trap!.line !== null ? ` (source line ${m.trap!.line})` : ''}`;
      case 'limit':
        return m.limit === 'output' ? `stopped: the output limit of ${m.limits.maxOutput} values was reached` : `stopped: the limit of ${m.limits.maxSteps} instructions was reached`;
      case 'fault':
        return `fault: ${m.fault}`;
    }
  }

  view(windows: readonly { address: number; length: number }[] = []): DebuggerView {
    const m = this.machine;
    const c = this.compiled;
    const pc = m.cpu.pc;
    const pc64 = m.pc64;
    const recent: DebuggerView['recent'] = [];
    const n = Math.min(this.recentCount, RECENT);
    for (let k = this.recentCount - n; k < this.recentCount; k++) {
      const slot = k % RECENT;
      const index = this.recentIndex[slot]!;
      const full = this.recentPc64.get(index);
      const at = this.textAt(this.recentPc[slot]!, full);
      recent.push({ index, pc: this.recentPc[slot]!, ...(full === undefined ? {} : { pc64: full }), text: at.text, note: at.note });
    }
    // The low half of a program counter above the 32-bit address space is the address of no instruction.
    const info = pc64 === undefined ? m.insnInfo(pc) : undefined;
    const stale: number[] = [];
    if (this.program && m.codeEdited) for (const i of this.program.insns) if (m.mappingStale(i.address)) stale.push(i.address);
    return {
      target: this.backend.profile.id,
      status: m.status,
      statusText: this.statusText(),
      pc,
      ...(pc64 === undefined ? {} : { pc64 }),
      executed: m.executed,
      boundaryCount: m.boundaryCount,
      regionCounts: { ...m.regionCounts },
      registers: this.backend.profile.registers.map((r) => ({ name: r.name, value: m.cpu.readReg(r.name), written: m.cpu.wasWritten(r.name) })),
      flags: { ...m.cpu.readFlags() },
      output: m.output.slice(-MAX_OUTPUT_SHOWN),
      outputLength: m.output.length,
      lastEvent: this.lastEvent,
      recent,
      next: info && m.status === 'running'
        ? {
            address: pc, text: info.text, region: info.meta.region, ir: info.meta.irOps.slice(),
            lines: c ? [...new Set(info.meta.irOps.map((op) => c.opSpans[op]!.start.line))] : [],
          }
        : null,
      nextStale: pc64 === undefined && m.mappingStale(pc),
      nextBoundaries: c && m.status === 'running'
        ? (m.boundariesAtPc() ?? []).map((s) => ({ statement: s, line: c.ir.stmts[s]?.span.start.line ?? 0 }))
        : [],
      variables: c
        ? c.variables.map((v) => ({
            name: v.name, type: v.hidden ? `${v.type} (compiler)` : v.type,
            home: v.home.kind === 'reg' ? v.home.reg : `stack + ${v.slotOffset}`,
            value: m.reader.variable(v.name) ?? null,
          }))
        : [],
      arrays: c
        ? c.arrays.map((a) => {
            const read = m.reader.array(a.name);
            const all = read ?? [];
            return { name: a.name, address: a.address, defined: read !== undefined, values: all.slice(0, MAX_ARRAY_SHOWN), truncated: all.length > MAX_ARRAY_SHOWN };
          })
        : [],
      memory: windows.map((w) => {
        const b = m.mem.peek(w.address, w.length);
        return { address: w.address, bytes: b ? Array.from(b) : null };
      }),
      codeEdited: m.codeEdited,
      staleAddresses: stale,
      loads: m.mem.loads,
      stores: m.mem.stores,
      metrics: c ? metricsOf(this.backend, c, m) : null,
      stopReason: this.stopReason,
    };
  }
}
