/**
 * Interfaces that every target backend implements.
 *
 * A backend supplies a profile (registers, conventions, references), an
 * instruction catalog, an encoder and decoder, an assembly-text parser and
 * formatter, a processor model that executes instructions fetched from memory
 * bytes, and the instruction selection used by the compiler.
 */
import type { IRProgram, BinFn, Pred, UnFn } from '../ir/ir.ts';
import type { Memory } from './memory.ts';

export type TargetId = 'riscv' | 'mips' | 'aarch64' | 'x86';

// ---- instructions ------------------------------------------------------------

export type AsmOperand =
  | { t: 'reg'; name: string }
  | { t: 'imm'; value: number }
  /**
   * Memory operand. RISC-V and MIPS use base and disp. AArch64 adds an index
   * register with an extend or shift (`ext`, `shift`). x86-64 adds index,
   * scale, and the operand size in bits.
   */
  | { t: 'mem'; base: string | null; disp: number; index?: string; scale?: number; size?: number; ext?: string; shift?: number }
  /** Symbolic code address, replaced by an `addr` operand when labels are resolved. */
  | { t: 'label'; name: string }
  /** Absolute code address; `label` keeps the symbol it was resolved from. */
  | { t: 'addr'; value: number; label?: string }
  /** Condition code operand (AArch64 conditional select and set). */
  | { t: 'cond'; name: string }
  /** Shift modifier of an AArch64 operand, as in `lsl #16`. */
  | { t: 'shift'; kind: string; amount: number };

export interface Insn {
  mnemonic: string;
  operands: AsmOperand[];
}

/** Part of the program image an instruction belongs to. */
export type CodeRegion = 'startup' | 'main' | 'helper' | 'trap';

export interface InsnMeta {
  region: CodeRegion;
  /** IR operations that this instruction implements, in part or in whole. Empty for runtime support code. */
  irOps: number[];
  /** Short explanation shown beside the instruction. */
  note?: string;
  /** Assembler pseudoinstruction that this instruction is an expansion of. */
  pseudo?: { text: string; index: number; count: number };
  /** One-based line of the assembly text, for programs entered as assembly. */
  line?: number;
}

export type AsmItem =
  | { kind: 'label'; name: string }
  | { kind: 'insn'; insn: Insn; meta: InsnMeta }
  /** Raw bytes placed in the code stream by a data directive. */
  | { kind: 'data'; bytes: Uint8Array; meta: InsnMeta; text: string }
  /** Boundary for a source statement, attached to the address of the next instruction. */
  | { kind: 'mark'; stmt: number };

export interface AssembledInsn {
  address: number;
  length: number;
  /** Instruction with labels resolved to addresses; null for raw data. */
  insn: Insn | null;
  text: string;
  meta: InsnMeta;
  /** Labels defined at this address. */
  labels: string[];
}

export interface AssembledProgram {
  base: number;
  bytes: Uint8Array;
  insns: AssembledInsn[];
  symbols: Record<string, number>;
  /** Statements whose boundary fires when execution reaches the address, in firing order. */
  boundaries: { address: number; stmts: number[] }[];
}

export class AsmError extends Error {
  /** Index of the offending item or source line, when known. */
  index: number | undefined;
  constructor(message: string, index?: number) {
    super(message);
    this.index = index;
  }
}

/** Encoder interface used by the generic assembler driver. */
export interface TargetAsm {
  /** Encoded size in bytes. `long` selects the long form of a relaxable instruction. */
  size(insn: Insn, long: boolean): number;
  /** True when the instruction has a short form whose reach depends on the branch distance. */
  relaxable(insn: Insn): boolean;
  /** Whether the short form at address `pc` can reach `target`. */
  shortFits(insn: Insn, pc: number, target: number): boolean;
  /**
   * Replacement for a branch whose short form cannot reach its target, when the
   * long form is a sequence of instructions (RISC-V: inverted branch over a jump).
   * `skip` is a fresh label name the replacement may define. Return null when the
   * long form is a longer encoding of the same instruction (x86-64).
   */
  relaxLong(insn: Insn, skip: string): AsmItem[] | null;
  /** Encode an instruction whose label operands have been resolved to `addr` operands. */
  encode(insn: Insn, pc: number, long: boolean): Uint8Array;
}

// ---- decoding ------------------------------------------------------------------

/** A bit field of a fixed-width instruction word. */
export interface BitField {
  name: string;
  /** Most and least significant bit positions, 31 down to 0. */
  hi: number;
  lo: number;
  value: number;
  /** Meaning of the value, such as a register name or a signed offset. */
  text: string;
}

/** A byte-level component of a variable-length instruction. */
export interface ByteField {
  name: string;
  offset: number;
  length: number;
  text: string;
  /** Bit fields inside a single-byte component such as ModR/M, SIB, or REX. */
  bits?: BitField[];
}

export type DecodeResult =
  | {
      ok: true;
      insn: Insn;
      length: number;
      /** Bit fields for fixed-width encodings. */
      fields: BitField[];
      /** Byte components for variable-length encodings. */
      byteFields?: ByteField[];
      /** Preferred alias or pseudoinstruction spelling of the instruction, when one exists. */
      alias?: string;
    }
  | {
      ok: false;
      /**
       * invalid: not a valid encoding in the profile.
       * unsupported: recognized as a defined instruction outside the implemented subset.
       * truncated: more bytes are needed.
       */
      kind: 'invalid' | 'unsupported' | 'truncated';
      message: string;
      length: number;
    };

// ---- execution -----------------------------------------------------------------

export type StepClass = 'alu' | 'load' | 'store' | 'branch' | 'jump' | 'service' | 'other';

/** Details of one executed instruction, recorded when tracing is requested. */
export interface StepEvent {
  /** Zero-based count of instructions executed before this one. */
  index: number;
  /** Address of the instruction; an x86-64 address below zero is a negative number, which stands for 2^64 plus the value. */
  pc: number;
  /**
   * Full address of the instruction, present only when its upper 32 bits are not zero; `pc` then
   * holds the low 32 bits. A fetch at such an address faults, so only the event of that fault has it.
   */
  pc64?: bigint;
  length: number;
  bytes: number[];
  text: string;
  klass: StepClass;
  regReads: { reg: string; value: bigint }[];
  regWrites: { reg: string; before: bigint; value: bigint }[];
  memReads: { address: number; size: number; value: bigint }[];
  memWrites: { address: number; size: number; before: bigint; value: bigint }[];
  /** Condition flags before and after, when the target has flags and the instruction changed them. */
  flags?: { before: Record<string, number>; after: Record<string, number> };
  /** Operands and result of the arithmetic or address computation, for the datapath view. */
  alu?: { op: string; a: bigint; b: bigint; result: bigint };
  /**
   * `target64` is the full target address, present only when its upper 32 bits are not zero
   * (an AArch64 br, blr, or ret to such a register value, or an AArch64 branch below address
   * zero); `target` then holds the low 32 bits. An x86-64 target below address zero is a
   * negative `target`, which stands for 2^64 plus the value, without `target64`.
   */
  branch?: { conditional: boolean; taken: boolean; target: number; target64?: bigint };
  /** Address of the next instruction; an x86-64 address below zero is a negative number, as for the target of a branch. */
  nextPc: number;
  /** Full address of the next instruction, present only when its upper 32 bits are not zero; `nextPc` then holds the low 32 bits. */
  nextPc64?: bigint;
  /** MIPS: the instruction executed in the delay slot of the preceding branch or jump. */
  delaySlot?: boolean;
  service?: { number: number; name: string; argument: number };
  /** Statement boundaries that fired when this instruction was fetched. */
  boundaries?: number[];
  stop?: Stop;
}

export type Stop =
  /** The service instruction executed; the machine performs the service. */
  | { kind: 'service' }
  | { kind: 'fault'; message: string };

export interface CpuSnapshot {
  pc: number;
  data: unknown;
}

export interface Cpu {
  /**
   * Address of the next instruction. A model with a 64-bit program counter
   * gives a negative number for an address below zero that it holds in full
   * (x86-64, 2^64 plus the value), or the low 32 bits of a program counter
   * above the 32-bit address space that it keeps in two halves (AArch64);
   * `readReg` of the program counter register gives the full value.
   */
  pc: number;
  /** Execute the instruction at `pc`. Records into `ev` when given. Returns null to continue. */
  step(ev?: StepEvent): Stop | null;
  /** Full register value. */
  readReg(name: string): bigint;
  writeReg(name: string, value: bigint): void;
  /** Low 32 bits of a register as a signed integer. */
  reg32(name: string): number;
  /** Current condition flags, empty for targets without flags. */
  readFlags(): Record<string, number>;
  writeFlag(name: string, value: number): void;
  /** True when the register has been written since reset. */
  wasWritten(name: string): boolean;
  reset(entry: number, stackPointer: number): void;
  snapshot(): CpuSnapshot;
  restore(s: CpuSnapshot): void;
}

// ---- profile -------------------------------------------------------------------

export interface RegisterInfo {
  /** Canonical name used in listings. */
  name: string;
  /** Other accepted spellings. */
  aliases: string[];
  bits: 32 | 64;
  /** Conventional role in this environment. */
  role: string;
  /** False for a register outside the general-purpose register file, such as the AArch64 stack pointer. */
  generalPurpose?: false;
}

export interface SpecReference {
  title: string;
  version: string;
  url: string;
  sections: string;
}

export interface TargetProfile {
  id: TargetId;
  /** Display name, such as "RISC-V RV32I". */
  name: string;
  /** Exact ISA revision and subset. */
  isa: string;
  registerBits: 32 | 64;
  /** Width of the integer operations generated for the source language. */
  operationBits: 32;
  endianness: 'little';
  instructionLength: { min: number; max: number; description: string };
  registers: RegisterInfo[];
  /** Names of condition flags, most significant first; empty when the target has none. */
  flags: { name: string; description: string }[];
  pcName: string;
  /** Extensions that the profile does not include and must not be assumed. */
  excluded: string[];
  references: SpecReference[];
  conventions: {
    /** Registers that carry the first four integer arguments of main. */
    args: string[];
    /** Register that carries the return value of main. */
    result: string;
    stackPointer: string;
    /** Register or mechanism holding the return address. */
    link: string;
    /** Registers assigned to source variables, in assignment order. */
    varRegs: string[];
    /** Registers assigned to expression temporaries. */
    tempRegs: string[];
    /** Registers reserved for the code generator: [operand a, operand b, internal, internal]. */
    scratch: [string, string, string, string];
    serviceInsn: string;
    serviceNumber: string;
    serviceArg: string;
    /** Registers that the service instruction itself overwrites. */
    serviceClobbers: string[];
    /** Differences from the platform ABI. */
    notes: string[];
  };
  /** Comment introducers accepted by the assembly parser. */
  commentChars: string[];
  /** Facts shown in the architecture overview. */
  overview: string[];
}

export type InsnGroup = 'arithmetic' | 'logic' | 'shift' | 'compare' | 'move' | 'memory' | 'control' | 'system';

/** Catalog entry for one instruction; also the source of the support matrix. */
export interface InsnSpec {
  mnemonic: string;
  title: string;
  group: InsnGroup;
  /** Encoding format name. */
  format: string;
  syntax: string;
  /** Precise effect in register-transfer notation. */
  semantics: string;
  /** Legal operands and their ranges. */
  operands: string;
  restrictions: string;
  /** Registers and flags read and written. */
  effects: string;
  /** Default text of the editable example. */
  example: string;
  /** Register and memory values for the worked example. */
  demo?: { regs?: Record<string, number>; mem?: { address: number; value: number }[]; flags?: Record<string, number> };
  /** Section of the reference document that defines the instruction. */
  reference: string;
  /** Stages implemented for the instruction. */
  encode: boolean;
  decode: boolean;
  simulate: boolean;
  /** True for assembler pseudoinstructions, which expand to real instructions. */
  pseudo?: boolean;
  /** Expansion rule of a pseudoinstruction. */
  expansion?: string;
}

/** Equivalent sequences for one abstract operation, used by the cross-target comparison. */
export interface OperationExample {
  /** Key shared by all targets, such as "add-registers". */
  key: string;
  assembly: string[];
  notes: string;
}

// ---- compiler lowering ---------------------------------------------------------

/** A register or an immediate. */
export type Src = { reg: string } | { imm: number };

export function isImm(s: Src): s is { imm: number } {
  return 'imm' in s;
}

export interface FrameInfo {
  /** Bytes subtracted from the stack pointer by the prologue. */
  size: number;
  /** Offset of each spill slot from the stack pointer after the prologue. */
  slotOffsets: number[];
  /** Offset at which the return address is saved, or null when it is not saved. */
  linkOffset: number | null;
}

/** Sink for generated instructions; the lowering driver sets the provenance. */
export interface Emitter {
  insn(mnemonic: string, operands: AsmOperand[], note?: string): void;
  /** Emit the expansion of a pseudoinstruction, recording the pseudo text on each real instruction. */
  pseudo(text: string, expansion: Insn[], note?: string): void;
  label(name: string): void;
  /** Address of an array's element 0. */
  arrayAddress(arrayId: number): number;
  /** Byte offset of an array's element 0 from the start of the data region. */
  arrayOffset(arrayId: number): number;
}

export type Home = { kind: 'reg'; reg: string } | { kind: 'slot'; index: number };

/**
 * Instruction selection for one target. The driver in `lower.ts` resolves IR
 * operands to registers or immediates and calls these hooks. Guarantees made
 * by the driver:
 *  - operand `a` of bin, cmpSet, and branch is always a register;
 *  - destination registers are variable homes, temporaries, or scratch[0];
 *  - scratch[0] and scratch[1] may hold operands; scratch[2] and scratch[3]
 *    are free for the hook's internal use;
 *  - a destination may be the same register as an operand.
 */
export interface TargetLowering {
  /** True when main must save its return address (for example, it calls a runtime helper). */
  needsLinkSave(ir: IRProgram): boolean;
  frame(slotCount: number, saveLink: boolean): FrameInfo;
  /** Program entry stub: set up the environment, call main, call the exit service. */
  startup(e: Emitter): void;
  /** Allocate the frame, save the return address if needed, and move parameters to their homes. */
  prologue(e: Emitter, frame: FrameInfo, params: Home[]): void;
  /** Place the return value, release the frame, and return to the caller. */
  ret(e: Emitter, frame: FrameInfo, value: Src): void;
  loadSlot(e: Emitter, dst: string, offset: number): void;
  storeSlot(e: Emitter, src: string, offset: number): void;
  mov(e: Emitter, dst: string, src: Src): void;
  un(e: Emitter, fn: UnFn, dst: string, a: string): void;
  bin(e: Emitter, fn: BinFn, dst: string, a: string, b: Src): void;
  /** dst = 1 when (a pred b) holds, else 0. */
  cmpSet(e: Emitter, pred: Pred, dst: string, a: string, b: Src): void;
  /** Jump to the label when (a pred b) holds. */
  branch(e: Emitter, pred: Pred, a: string, b: Src, label: string): void;
  jump(e: Emitter, label: string): void;
  /** dst = element `index` of the array. */
  load(e: Emitter, dst: string, arrayId: number, index: Src): void;
  store(e: Emitter, value: Src, arrayId: number, index: Src): void;
  print(e: Emitter, a: Src): void;
  /** Call the error service with the given code; does not return. */
  trap(e: Emitter, code: number): void;
  /** Runtime helper routines required by the program, such as software multiplication. */
  helpers(e: Emitter, ir: IRProgram): void;
}

export type ParsedLine =
  | { ok: true; items: AsmItem[] }
  | { ok: false; message: string };

/** Inputs for the independent validation harness (reference assembler, disassembler, and emulator). */
export interface ValidationSpec {
  /** Lines placed before the program text given to the reference assembler. */
  preamble: string[];
  /**
   * Assembly programs, in this tool's syntax, that exercise every implemented
   * instruction with boundary operands. With `passthrough`, the text itself is
   * given to the reference assembler (used for pseudoinstruction expansions);
   * otherwise the expanded listing is.
   */
  sweeps(): { name: string; text: string; passthrough?: boolean }[];
  /** Byte sequences that are valid but are not the encoding the encoder chooses. */
  alternateEncodings?: { bytes: string; note: string }[];
  /**
   * Flags left undefined by the instruction, excluded from emulator comparisons. `readReg`, when
   * given, reads a register in the state before the instruction, for flags whose status depends
   * on a run-time value (an x86-64 shift by cl).
   */
  undefinedFlags?(insn: Insn, readReg?: (name: string) => bigint): string[];
}

export interface Backend {
  profile: TargetProfile;
  validation: ValidationSpec;
  instructions: InsnSpec[];
  operations: OperationExample[];
  lowering: TargetLowering;
  asm: TargetAsm;
  /** Decode the instruction that starts at `offset` in `bytes`, located at address `pc`. */
  decode(bytes: Uint8Array, offset: number, pc: number): DecodeResult;
  /** Assembly text of an instruction in the target's standard syntax. */
  format(insn: Insn): string;
  /**
   * Parse one line of assembly text (label, instruction, pseudoinstruction, or
   * data directive). Comments have been removed. Pseudoinstructions are returned
   * expanded, with `meta.pseudo` set.
   */
  parseLine(text: string): ParsedLine;
  createCpu(mem: Memory): Cpu;
}
