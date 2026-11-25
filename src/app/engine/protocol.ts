/**
 * Messages exchanged between the interface and the engine worker.
 * Every request carries an identifier that the response repeats, so the
 * interface can discard results that belong to superseded requests.
 */
import type { CompiledProgramDocument, DecodedInstruction, Diagnostic, Metrics, Outcome, StepEvent, TargetId } from '../../core/api.ts';
import type { ComparedBoundary } from '../../core/trace/compare.ts';

export interface MemoryWindow {
  address: number;
  length: number;
}

export interface ListingLine {
  address: number;
  bytes: number[];
  text: string;
  pseudo?: string;
  labels: string[];
  region: string;
  lines: number[];
  ir: number[];
  note?: string;
  /** One-based line of the assembly text, for programs entered as assembly. */
  asmLine?: number;
}

export interface MachineView {
  machine: string;
  target: TargetId;
  status: 'running' | 'exited' | 'trap' | 'limit' | 'fault';
  /** Sentence describing the status. */
  statusText: string;
  /** True while the worker is executing a run request for this machine. */
  busy: boolean;
  pc: number;
  /** Full program counter, present only when it lies above the 32-bit address space on AArch64; `pc` then holds the low 32 bits. */
  pc64?: bigint;
  executed: number;
  boundaryCount: number;
  regionCounts: Record<string, number>;
  registers: { name: string; value: bigint; written: boolean }[];
  flags: Record<string, number>;
  output: number[];
  outputLength: number;
  /** Details of the most recently executed instruction. */
  lastEvent: StepEvent | null;
  /** The most recent instructions, oldest first. */
  recent: { index: number; pc: number; pc64?: bigint; text: string; note: string }[];
  /** Listing entry of the next instruction to execute, when the listing still describes it. */
  next: { address: number; text: string; lines: number[]; ir: number[]; region: string } | null;
  /** True when the bytes at the program counter were edited and have no valid provenance. */
  nextStale: boolean;
  /** Statements whose boundary is attached to the next instruction. */
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
  /** Why the last run or step request stopped. */
  stopReason: string;
}

export interface CompileResponse {
  ok: boolean;
  diagnostics: Diagnostic[];
  document: CompiledProgramDocument | null;
  irText: string;
  target: TargetId;
  /** Parameter names of main, in order. */
  parameters: string[];
}

export interface AssembleResponse {
  ok: boolean;
  errors: { line: number; message: string }[];
  listing: ListingLine[];
  bytes: number[];
  base: number;
}

export interface DemoResponse {
  ok: boolean;
  message: string;
  listing: ListingLine[];
  decoded: DecodedInstruction[];
  before: { registers: Record<string, bigint>; flags: Record<string, number> };
  after: { registers: Record<string, bigint>; flags: Record<string, number> };
  events: StepEvent[];
  fault: string | null;
}

export interface CompareResponse {
  ok: boolean;
  diagnostics: Diagnostic[];
  runs: { target: TargetId; outcome: Outcome; metrics: Metrics; document: CompiledProgramDocument }[];
  boundaries: ComparedBoundary[];
  boundariesTruncated: boolean;
  outcomesAgree: boolean;
  boundariesAgree: boolean;
  /** Targets whose run stopped at its step limit; each is compared on the boundaries it reached. */
  limitReached: TargetId[];
  /**
   * `agree`, `disagree`, or `incomplete` (no disagreement found and at least one target in
   * `limitReached`). It describes the runs, so it has a meaning only when `ok` is true.
   */
  verdict: 'agree' | 'disagree' | 'incomplete';
}

export interface ExerciseResponse {
  kind: 'register' | 'field' | 'branch';
  target: TargetId;
  prompt: string;
  /** Assembly lines or other material shown with the prompt. */
  material: string[];
  /** Initial register values shown to the learner. */
  given: { name: string; value: string }[];
  /** Accepted answers, normalized (lower case, no spaces). */
  answers: string[];
  /** Explanation shown after an answer. */
  explanation: string;
  choices?: string[];
}

export type Request =
  | { op: 'compile'; source: string; target: TargetId }
  | { op: 'load'; machine: string; target: TargetId; source: string; args: number[]; memory?: MemoryWindow[] }
  | { op: 'loadAssembly'; machine: string; target: TargetId; text: string; memory?: MemoryWindow[] }
  | { op: 'step'; machine: string; count: number; memory?: MemoryWindow[] }
  | { op: 'stepSource'; machine: string; memory?: MemoryWindow[] }
  | { op: 'back'; machine: string; count: number; memory?: MemoryWindow[] }
  | { op: 'backSource'; machine: string; memory?: MemoryWindow[] }
  | { op: 'run'; machine: string; memory?: MemoryWindow[] }
  | { op: 'pause'; machine: string }
  | { op: 'reset'; machine: string; memory?: MemoryWindow[] }
  | { op: 'view'; machine: string; memory?: MemoryWindow[] }
  | { op: 'poke'; machine: string; address: number; bytes: number[]; memory?: MemoryWindow[] }
  | { op: 'setRegister'; machine: string; name: string; value: bigint; memory?: MemoryWindow[] }
  | { op: 'setFlag'; machine: string; name: string; value: number; memory?: MemoryWindow[] }
  | { op: 'setBreakpoints'; machine: string; addresses: number[]; lines: number[] }
  | { op: 'close'; machine: string }
  | { op: 'compare'; source: string; args: number[]; targets: TargetId[] }
  | { op: 'assemble'; target: TargetId; text: string }
  | { op: 'decode'; target: TargetId; bytes: number[]; address: number }
  | { op: 'demo'; target: TargetId; text: string; registers: Record<string, number>; memory: { address: number; value: number }[]; flags: Record<string, number> }
  | { op: 'exercise'; target: TargetId; kind: 'register' | 'field' | 'branch'; init: number }
  | { op: 'trace'; target: TargetId; source: string; args: number[]; maxTraceSteps: number };

export type RequestMessage = Request & { id: number };

export type ResponseMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  /** Progress of a run request; the final response follows. */
  | { id: number; progress: MachineView };
