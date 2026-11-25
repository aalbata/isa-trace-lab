/**
 * Execution outcome and boundary types shared by the reference evaluator,
 * the IR interpreter, and the machine-code simulators.
 */

/** Runtime error codes passed to the error service by compiled programs. */
export const TRAP_INDEX = 1;
export const TRAP_SHIFT = 2;

export function trapMessage(code: number): string {
  switch (code) {
    case TRAP_INDEX:
      return 'array index out of range';
    case TRAP_SHIFT:
      return 'shift count outside 0 to 31';
    default:
      return `runtime error ${code}`;
  }
}

/**
 * How a run ended.
 *  - exited: the entry function returned and the exit service was called.
 *  - trap: a language-level runtime error (index or shift count out of range).
 *  - limit: a configured bound on steps or output was reached.
 *  - fault: the machine could not continue (illegal instruction, memory access
 *    outside the mapped regions, alignment, arithmetic overflow exception,
 *    unknown service). Faults do not occur for compiler-generated code.
 */
export type RunStatus = 'exited' | 'trap' | 'limit' | 'fault';

export interface Outcome {
  status: RunStatus;
  /** Signed 32-bit return value of the entry function when status is `exited`. */
  returnValue?: number;
  /** Signed 32-bit integers written by print, in order. */
  output: number[];
  trap?: { code: number; message: string; line: number | null };
  limit?: 'steps' | 'output';
  fault?: string;
  /** Engine-specific step count: statements, IR operations, or machine instructions. */
  steps: number;
}

export interface RunLimits {
  maxSteps: number;
  maxOutput: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxSteps: 5_000_000, maxOutput: 10_000 };

/**
 * Raised when the arguments of a run do not supply exactly one value per
 * parameter of main. The language requires the run configuration to supply
 * every parameter (docs/language.md, section 1); no value is filled in or
 * dropped.
 */
export class ArgumentCountError extends Error {
  /** Parameter names of main, in order. */
  readonly parameters: readonly string[];
  /** Number of arguments given. */
  readonly given: number;
  constructor(parameters: readonly string[], given: number) {
    const n = parameters.length;
    const takes = n === 0 ? 'takes no parameters' : `takes ${n} parameter${n === 1 ? '' : 's'} (${parameters.join(', ')})`;
    super(`main ${takes}, but ${given} argument${given === 1 ? ' was' : 's were'} given`);
    this.name = 'ArgumentCountError';
    this.parameters = parameters.slice();
    this.given = given;
  }
}

/** Throw ArgumentCountError unless `args` holds one value per parameter of main. */
export function checkArguments(parameters: readonly string[], args: readonly number[]): void {
  if (args.length !== parameters.length) throw new ArgumentCountError(parameters, args.length);
}

/** True when a run stopped at its step limit, as opposed to the output limit or its own end. */
export function stoppedAtStepLimit(o: Outcome): boolean {
  return o.status === 'limit' && o.limit === 'steps';
}

/** Read access to the source-level state of an engine at a boundary. */
export interface StateReader {
  /**
   * Signed value of a source variable, or undefined while it has not been assigned.
   * A simulator reads the home of the variable: a register home is assigned once
   * the register has been written since the machine was reset, and a stack-slot
   * home, at its offset from the stack pointer of main, once every byte of the
   * slot has been written since the reset by an executed store or a debugger edit.
   */
  variable(name: string): number | undefined;
  /** Current contents of an array, or undefined before its definition has executed. */
  array(name: string): readonly number[] | undefined;
  outputLength(): number;
}

/**
 * Called at each boundary with the identifier of the source statement about
 * to execute. A boundary occurs before a simple statement, before an `if`
 * condition, before each evaluation of a `while` condition, before the range
 * arguments of a `for` statement, and before each later advance of that loop.
 */
export type BoundaryObserver = (stmt: number, state: StateReader) => void;

/**
 * Outcome of a run as text: the status with the return value, the runtime
 * error, or the limit, and the printed values of a run that did not stop at a
 * limit. Two runs that ended on their own with different texts ended
 * differently.
 */
export function observable(o: Outcome): string {
  const parts: string[] = [o.status];
  if (o.status === 'exited') parts.push(`ret=${o.returnValue}`);
  if (o.status === 'trap') parts.push(`trap=${o.trap?.code}@${o.trap?.line ?? '?'}`);
  if (o.status === 'limit') parts.push(`limit=${o.limit}`);
  if (o.status !== 'limit') parts.push(`out=[${o.output.join(',')}]`);
  return parts.join(' ');
}

/** Position of the first printed value in which two outputs differ, where a missing value differs from any value; -1 when they are equal. */
export function firstOutputDifference(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return k;
  return -1;
}

/**
 * True when two runs that ended on their own, that is, not at their step
 * limit, ended the same way: the same status with the same return value,
 * runtime error, or limit, and the same printed values. The text of
 * `observable` leaves out the values printed before a stop at the output
 * limit, which are compared here.
 */
export function sameOutcome(a: Outcome, b: Outcome): boolean {
  return observable(a) === observable(b) && firstOutputDifference(a.output, b.output) < 0;
}
