/**
 * A simulated machine: memory, a processor model, and the execution
 * environment (program loading, the three services, boundaries, limits).
 * The machine executes only what the processor model fetches and decodes from
 * the code bytes in memory; the compiled listing is used for provenance,
 * region accounting, boundary addresses, and following main's frame for the
 * stack-slot homes of variables, never for execution.
 */
import type { CompiledProgram } from '../compile.ts';
import type { BoundaryObserver, Outcome, RunLimits, RunStatus, StateReader } from '../exec.ts';
import { DEFAULT_LIMITS, checkArguments, trapMessage } from '../exec.ts';
import { LAYOUT, Memory, SERVICE, serviceName } from './memory.ts';
import type { AssembledInsn, AssembledProgram, Backend, CodeRegion, Cpu, StepEvent } from './types.ts';

export type MachineStatus = 'running' | RunStatus;

export interface MachineImage {
  /** Code bytes loaded at the code base address. */
  code: Uint8Array;
  /** Initial data-region contents. */
  data?: Uint8Array;
  entry: number;
  /** Listing that describes the code bytes, when one exists. */
  listing?: AssembledProgram;
  /** Compiled program, which adds variable homes and source provenance. */
  compiled?: CompiledProgram;
}

export function newStepEvent(index: number): StepEvent {
  return { index, pc: 0, length: 0, bytes: [], text: '', klass: 'other', regReads: [], regWrites: [], memReads: [], memWrites: [], nextPc: 0 };
}

export class Machine {
  readonly backend: Backend;
  readonly mem: Memory;
  readonly cpu: Cpu;
  readonly image: MachineImage;
  status: MachineStatus = 'running';
  output: number[] = [];
  returnValue: number | undefined;
  trap: { code: number; message: string; line: number | null } | undefined;
  fault: string | undefined;
  limit: 'steps' | 'output' | undefined;
  /** Number of instructions executed. */
  executed = 0;
  /** Executed instructions per part of the image; `unknown` counts addresses with no listing entry. */
  regionCounts: Record<CodeRegion | 'unknown', number> = { startup: 0, main: 0, helper: 0, trap: 0, unknown: 0 };
  limits: RunLimits;
  onBoundary: BoundaryObserver | undefined;
  /** Boundaries fired so far. */
  boundaryCount = 0;

  private insnAt = new Map<number, AssembledInsn>();
  private boundaryAt = new Map<number, number[]>();
  private edited = new Set<number>();
  private lastBody: AssembledInsn | null = null;
  private args: number[];
  /** Address of the first instruction of main, for a compiled program. */
  private readonly mainAddress: number | undefined;
  private readonly spName: string;
  /** True when the registers hold 64 bits, so that the stack pointer and the program counter can lie above the 32-bit address space. */
  private readonly wide: boolean;
  /**
   * True when a variable is kept in a stack slot. Only then is main's frame
   * followed, because the offsets of stack-slot homes are measured from main's
   * stack pointer.
   */
  private readonly slotHomes: boolean;
  /**
   * Addresses of the instructions of main's body outside the epilogue of a
   * return. The generated code does not change the stack pointer there, so
   * these instructions are not checked for a change unless their bytes were
   * edited.
   */
  private readonly steady = new Set<number>();
  /**
   * True while the stack pointer is main's: from the arrival at a statement
   * boundary, which lies in the body of main, until an instruction changes the
   * stack pointer, as the epilogue does when it releases the frame.
   */
  private inFrame = false;
  /**
   * Main's stack pointer while the stack pointer is not main's: before the
   * first boundary, the stack pointer at the first instruction of main less the
   * frame size that the prologue subtracts; after an instruction has changed
   * the stack pointer, the value it had before. Undefined until execution
   * reaches main.
   */
  private frameBase: number | undefined;
  /** Names of the arrays that each defining statement defines. */
  private readonly arrayDefinedBy = new Map<number, string[]>();
  /** Arrays whose defining statement has executed since reset. */
  private readonly arrayDefined = new Set<string>();
  /**
   * Arrays whose defining statement is executing: its boundary has been
   * reported, and execution has reached neither the next statement boundary
   * nor the exit of the program.
   */
  private defining: string[] | undefined;
  /**
   * Source-level state of a compiled program.
   *
   * A variable kept in a register reads as undefined until the register has
   * been written since reset. A variable kept in a stack slot is read at its
   * offset from main's stack pointer, in whichever region holds the slot
   * there, and reads as undefined until every byte of the slot has been written
   * since reset, by a store of an executed instruction or by a debugger edit of
   * memory. The program image that the loader places is not such a write. In a
   * run without debugger edits the first write of a slot is the assignment of
   * its variable. After an edit of the code or of the stack pointer that places
   * main's frame on memory written for another purpose, such as the return
   * address that an x86-64 call pushes or an element of an array, the reading
   * is the content of that memory.
   *
   * An array reads as undefined until its defining statement has executed
   * since reset, and as its current contents afterwards. The statement has
   * executed when, after its boundary, execution reaches the next statement
   * boundary or the program exits; a definition that a runtime error or a
   * limit interrupts has not executed.
   */
  readonly reader: StateReader;

  /**
   * Throws ArgumentCountError when the image holds a compiled program and
   * `args` does not supply one value per parameter of main. Code without a
   * compiled program has no parameter list: its arguments are written to the
   * argument registers, as many as there are registers.
   */
  constructor(backend: Backend, image: MachineImage, options: { args?: readonly number[]; limits?: Partial<RunLimits> } = {}) {
    this.backend = backend;
    this.image = image;
    const compiled = image.compiled;
    this.args = (options.args ?? []).map((a) => a | 0);
    if (compiled) checkArguments(compiled.ir.params.map((id) => compiled.ir.vars[id]!.name), this.args);
    this.mem = new Memory();
    this.cpu = backend.createCpu(this.mem);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    const listing = compiled?.program ?? image.listing;
    if (listing) {
      for (const i of listing.insns) this.insnAt.set(i.address, i);
      for (const c of listing.boundaries) this.boundaryAt.set(c.address, c.stmts);
    }
    this.mainAddress = compiled?.program.symbols['main'];
    this.spName = backend.profile.conventions.stackPointer;
    this.wide = backend.profile.registerBits === 64;
    this.slotHomes = compiled?.variables.some((v) => v.home.kind === 'slot') ?? false;
    for (const a of compiled?.ir.arrays ?? []) {
      const names = this.arrayDefinedBy.get(a.defStmt);
      if (names) names.push(a.name);
      else this.arrayDefinedBy.set(a.defStmt, [a.name]);
    }
    if (compiled && this.slotHomes) {
      const returns = new Set<number>();
      for (const b of compiled.ir.blocks) if (b.term.op === 'ret') returns.add(b.term.id);
      // Startup, prologue, and helper instructions implement no IR operation.
      for (const i of compiled.program.insns) {
        if (i.meta.irOps.length > 0 && !i.meta.irOps.some((op) => returns.has(op))) this.steady.add(i.address);
      }
    }
    this.reader = {
      variable: (name) => {
        const v = compiled?.variables.find((x) => x.name === name);
        if (!v) return undefined;
        if (v.home.kind === 'reg') return this.cpu.wasWritten(v.home.reg) ? this.cpu.reg32(v.home.reg) : undefined;
        // A slot is read at its offset from main's stack pointer, in the region that holds it there, and only
        // once all four of its bytes have been written since reset.
        const address = (this.inFrame || this.frameBase === undefined ? this.stackPointer() : this.frameBase) + (v.slotOffset ?? 0);
        return this.mem.wasWritten(address, 4) ? this.mem.peek32(address)! | 0 : undefined;
      },
      array: (name) => {
        const a = compiled?.arrays.find((x) => x.name === name);
        // An array is read only once its defining statement has executed since reset.
        if (!a || !this.arrayDefined.has(name)) return undefined;
        const out: number[] = [];
        for (let i = 0; i < a.length; i++) out.push((this.mem.peek32(a.address + 4 * i) ?? 0) | 0);
        return out;
      },
      outputLength: () => this.output.length,
    };
    this.reset();
  }

  /**
   * Reload the image and return to the initial state. Byte edits made through `pokeCode` are discarded.
   * Throws a RangeError when the code or data image is larger than its region.
   */
  reset(): void {
    const { mem, image } = this;
    mem.code.bytes.fill(0);
    mem.data.bytes.fill(0);
    mem.stack.bytes.fill(0);
    mem.clearWritten();
    mem.loads = 0;
    mem.stores = 0;
    // The loader places the image without marking its bytes as written.
    if (!mem.loadImage(LAYOUT.codeBase, image.code)) {
      throw new RangeError(`the program needs ${image.code.length} bytes of code; the code region holds ${LAYOUT.codeSize}`);
    }
    if (image.data && !mem.loadImage(LAYOUT.dataBase, image.data)) {
      throw new RangeError(`the program needs ${image.data.length} bytes of data; the data region holds ${LAYOUT.dataSize}`);
    }
    this.inFrame = false;
    this.frameBase = undefined;
    this.arrayDefined.clear();
    this.defining = undefined;
    this.cpu.reset(image.entry, LAYOUT.stackTop);
    const argRegs = this.backend.profile.conventions.args;
    this.args.slice(0, argRegs.length).forEach((a, i) => this.cpu.writeReg(argRegs[i]!, BigInt(a >>> 0)));
    this.status = 'running';
    this.output = [];
    this.returnValue = undefined;
    this.trap = undefined;
    this.fault = undefined;
    this.limit = undefined;
    this.executed = 0;
    this.boundaryCount = 0;
    this.regionCounts = { startup: 0, main: 0, helper: 0, trap: 0, unknown: 0 };
    this.edited.clear();
    this.lastBody = null;
  }

  /**
   * Update main's frame for execution that has reached `pc`. At the first
   * instruction of main the prologue has yet to allocate the frame; at a
   * statement boundary the stack pointer is main's.
   */
  private follow(pc: number): void {
    if (!this.slotHomes) return;
    if (pc === this.mainAddress && this.pc64 === undefined) {
      this.inFrame = false;
      this.frameBase = this.stackPointer() - (this.image.compiled?.frame.size ?? 0);
    }
    if (!this.inFrame && this.boundaryAt.has(pc) && this.pc64 === undefined) this.inFrame = true;
  }

  /** Count the arrays of the defining statement that was executing as defined: the statement has executed. */
  private completeDefinition(): void {
    if (!this.defining) return;
    for (const name of this.defining) this.arrayDefined.add(name);
    this.defining = undefined;
  }

  /**
   * The full program counter when `cpu.pc` holds only its low 32 bits, and
   * undefined when `cpu.pc` is the address of the next instruction. A processor
   * model with a 64-bit program counter keeps a program counter above the
   * 32-bit address space in two halves (AArch64 after a branch to such a
   * register value). Execution is then at no instruction, boundary, or
   * breakpoint address of the program, and the next fetch faults.
   */
  get pc64(): bigint | undefined {
    const pc = this.cpu.pc;
    if (!this.wide || !Number.isInteger(pc)) return undefined;
    const full = this.cpu.readReg(this.backend.profile.pcName);
    // A negative `cpu.pc` is an address below zero of the 64-bit address space (x86-64), held in full.
    return full === BigInt.asUintN(64, BigInt(pc)) ? undefined : full;
  }

  /**
   * The stack pointer as an address of the memory layout. A 64-bit stack
   * pointer above the 32-bit address space, where nothing is mapped, gives NaN,
   * so that no address computed from it lies in a region.
   */
  private stackPointer(): number {
    const low = this.cpu.reg32(this.spName) >>> 0;
    return this.wide && this.cpu.readReg(this.spName) !== BigInt(low) ? NaN : low;
  }

  /** Listing entry for the instruction at an address, or undefined when its bytes were edited or it has no entry. */
  insnInfo(address: number): AssembledInsn | undefined {
    if (this.mappingStale(address)) return undefined;
    return this.insnAt.get(address);
  }

  /** Statements whose boundary is attached to the address. */
  boundariesAtAddress(address: number): readonly number[] | undefined {
    return this.boundaryAt.get(address);
  }

  /** Statements whose boundary fires when the next instruction executes. */
  boundariesAtPc(): readonly number[] | undefined {
    const marks = this.boundaryAt.get(this.cpu.pc);
    return marks && this.pc64 === undefined ? marks : undefined;
  }

  /**
   * Overwrite code bytes, as a debugger would. Provenance of the affected
   * instructions is invalidated: for fixed-length targets the instructions
   * that contain the bytes, for variable-length targets the whole listing,
   * because instruction boundaries after the edit are no longer known.
   */
  pokeCode(address: number, bytes: ArrayLike<number>): boolean {
    if (!this.mem.poke(address, bytes)) return false;
    if (this.backend.profile.instructionLength.min !== this.backend.profile.instructionLength.max) {
      this.edited.add(-1);
      return true;
    }
    const width = this.backend.profile.instructionLength.min;
    for (let a = address - (address % width); a < address + bytes.length; a += width) this.edited.add(a);
    return true;
  }

  /** True when the listing no longer describes the bytes at the address. */
  mappingStale(address: number): boolean {
    return this.edited.has(-1) || this.edited.has(address);
  }

  get codeEdited(): boolean {
    return this.edited.size > 0;
  }

  /** Execute one instruction and perform a requested service. Returns false when the machine has stopped. */
  step(ev?: StepEvent): boolean {
    if (this.status !== 'running') return false;
    if (this.executed >= this.limits.maxSteps) {
      this.status = 'limit';
      this.limit = 'steps';
      return false;
    }
    const pc = this.cpu.pc;
    this.follow(pc);
    const marks = this.boundaryAt.get(pc);
    if (marks && this.pc64 === undefined) {
      this.boundaryCount += marks.length;
      if (ev) ev.boundaries = marks.slice();
      for (const s of marks) {
        // The boundary of a statement fires before the statement executes and after the statement before it
        // has executed, also when the two share an address because the earlier one has no instructions.
        this.completeDefinition();
        if (this.onBoundary) this.onBoundary(s, this.reader);
        this.defining = this.arrayDefinedBy.get(s);
      }
    }
    if (ev) {
      ev.index = this.executed;
      ev.pc = pc;
    }
    const watch = this.inFrame && (!this.steady.has(pc) || (this.codeEdited && this.mappingStale(pc)));
    const sp = watch ? this.stackPointer() : 0;
    const stop = this.cpu.step(ev);
    this.executed++;
    // An instruction that changes main's stack pointer ends the frame, which keeps the stack pointer it had.
    if (watch && !Object.is(this.stackPointer(), sp)) {
      this.inFrame = false;
      this.frameBase = sp;
    }
    // A service request is excluded, because after the exit service the program counter is the address after
    // the startup stub, which can be main.
    if (stop === null) this.follow(this.cpu.pc);
    if (this.defining && stop === null && this.boundariesAtPc()) this.completeDefinition();
    // A fetch above the 32-bit address space faults and leaves the program counter where it was. The event
    // names that address in full, and the listing has no entry for it.
    const outside = stop !== null && stop.kind === 'fault' ? this.pc64 : undefined;
    if (ev && outside !== undefined) ev.pc64 = outside;
    const info = outside !== undefined ? undefined : this.insnAt.get(pc);
    if (info) {
      this.regionCounts[info.meta.region]++;
      if (info.meta.region !== 'trap' && info.meta.irOps.length > 0) this.lastBody = info;
    } else this.regionCounts.unknown++;
    if (stop === null) return true;
    if (ev) ev.stop = stop;
    if (stop.kind === 'fault') {
      this.status = 'fault';
      this.fault = stop.message;
      return false;
    }
    const conv = this.backend.profile.conventions;
    const number = this.cpu.reg32(conv.serviceNumber);
    const argument = this.cpu.reg32(conv.serviceArg);
    if (ev) ev.service = { number, name: serviceName(number), argument };
    switch (number) {
      case SERVICE.print:
        if (this.output.length >= this.limits.maxOutput) {
          this.status = 'limit';
          this.limit = 'output';
          return false;
        }
        this.output.push(argument);
        return true;
      case SERVICE.exit:
        this.completeDefinition();
        this.status = 'exited';
        this.returnValue = argument;
        return false;
      case SERVICE.error:
        this.status = 'trap';
        this.trap = { code: argument, message: trapMessage(argument), line: this.trapLine() };
        return false;
      default:
        this.status = 'fault';
        this.fault = `service number ${number} is not provided by the execution environment`;
        return false;
    }
  }

  /** Source line of the range check that led to the error service, from the last executed instruction outside the trap stub. */
  private trapLine(): number | null {
    const compiled = this.image.compiled;
    const info = this.lastBody;
    if (!compiled || !info || this.mappingStale(info.address)) return null;
    const span = compiled.opSpans[info.meta.irOps[0]!];
    return span ? span.start.line : null;
  }

  /** Run until the program stops or a limit is reached. */
  run(): Outcome {
    while (this.step()) {
      // The loop body is the step.
    }
    return this.outcome();
  }

  outcome(): Outcome {
    const o: Outcome = { status: this.status === 'running' ? 'limit' : this.status, output: this.output.slice(), steps: this.executed };
    if (this.status === 'exited') o.returnValue = this.returnValue!;
    if (this.trap) o.trap = this.trap;
    if (this.fault) o.fault = this.fault;
    if (this.limit) o.limit = this.limit;
    return o;
  }
}

/** Load a compiled program into a new machine. Throws ArgumentCountError unless `args` has one value per parameter of main. */
export function loadCompiled(backend: Backend, compiled: CompiledProgram, options: { args?: readonly number[]; limits?: Partial<RunLimits> } = {}): Machine {
  return new Machine(backend, { code: compiled.program.bytes, data: compiled.dataImage, entry: compiled.entry, compiled }, options);
}
