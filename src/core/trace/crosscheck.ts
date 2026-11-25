/**
 * Cross-check of one program on every engine: the reference evaluator, the IR
 * interpreter, and the machine-code simulator of each target. The engines must
 * agree on the outcome and, at every boundary, on the statement reached, the
 * value of every source variable or that it is not yet assigned, the contents
 * of every array or that it is not yet defined, and the amount of output
 * produced.
 *
 * The reference run records, for every boundary, the statement and a 64-bit
 * digest of that state, so memory grows by a few words per boundary. The other
 * engines compute the same digest at each of their boundaries. At the first
 * difference the reference evaluator is run again up to that boundary to name
 * the variable, array element, or output count that differs.
 *
 * Every engine has a step limit in its own unit, so the work of a cross-check
 * is bounded whatever the program does: `limits.maxSteps` statements for the
 * reference evaluator, and ten times that number of IR steps for the IR
 * interpreter and of instructions for each simulator. A run that stops at its
 * own step limit is listed in `limitReached` and compared on the boundaries it
 * reached. The stop is neither a disagreement nor an agreement: the verdict of
 * such a cross-check is `incomplete` unless an engine disagrees elsewhere.
 *
 * An engine disagrees with the reference evaluator when the statement or the
 * state differs at a boundary that both reached, when both ended on their own
 * with different outcomes or after different numbers of boundaries, when the
 * engine passes a boundary after the last one of a reference evaluator that
 * ended on its own, and when the engine ended on its own before the boundary
 * at which the reference evaluator stopped at its step limit.
 */
import type { CompiledProgram, FrontEnd } from '../compile.ts';
import { compileBackEnds, compileFrontEnd, parameterNames } from '../compile.ts';
import type { Outcome, RunLimits, StateReader } from '../exec.ts';
import { DEFAULT_LIMITS, checkArguments, firstOutputDifference, observable, stoppedAtStepLimit } from '../exec.ts';
import { interpretIR } from '../ir/interp.ts';
import type { ReferenceOutcome } from '../lang/reference.ts';
import { evaluateReference } from '../lang/reference.ts';
import { loadCompiled } from '../target/machine.ts';
import type { Backend, CodeRegion, TargetId } from '../target/types.ts';
import type { ComparisonVerdict } from './compare.ts';

/** IR steps of the IR interpreter, and instructions of each simulator, allowed per statement of the reference evaluator's step limit. */
const ENGINE_STEPS_PER_STATEMENT = 10;

export interface EngineReport {
  engine: string;
  outcome: Outcome;
  /** Boundaries observed. */
  boundaries: number;
  /** Boundaries at which the engine was compared with the reference evaluator and agreed. */
  compared: number;
  /** First disagreement with the reference evaluator, or null. */
  mismatch: string | null;
  /**
   * True when the run stopped at its own step limit. It is compared on the
   * boundaries it reached, and its outcome is not compared.
   */
  limitReached: boolean;
}

export interface MachineReport extends EngineReport {
  target: TargetId;
  executed: number;
  regionCounts: Record<CodeRegion | 'unknown', number>;
  loads: number;
  stores: number;
  codeBytes: number;
  staticInstructions: number;
}

export interface CrossCheck {
  /** True when no engine disagrees with the reference evaluator. */
  ok: boolean;
  /** Front-end result; not ok also when the code of a target does not fit its memory layout (diagnostic code `assembler`). */
  front: FrontEnd;
  reference?: ReferenceOutcome;
  ir?: EngineReport;
  machines: MachineReport[];
  compiled: Partial<Record<TargetId, CompiledProgram>>;
  /** Engines that disagree with the reference evaluator. */
  failures: string[];
  /**
   * Runs that stopped at their own step limit: `reference`, `ir`, or the
   * identifier of a target. Such a run is compared on the boundaries it
   * reached; the stop is not a disagreement.
   */
  limitReached: string[];
  /**
   * Step limit of each kind of engine in its own unit: statements of the
   * reference evaluator, IR steps of the IR interpreter, and instructions of
   * each simulator. Present when the program compiled.
   */
  stepLimits?: { statements: number; irSteps: number; instructions: number };
}

/** Boundaries per block of the boundary log. */
const BLOCK = 8192;

/**
 * Statement and state digest of each boundary of the reference run, three
 * 32-bit words per boundary, kept in fixed-size blocks so that the log never
 * copies itself as it grows.
 */
class BoundaryLog {
  private blocks: Int32Array[] = [];
  length = 0;

  push(stmt: number, a: number, b: number): void {
    const slot = this.length % BLOCK;
    if (slot === 0) this.blocks.push(new Int32Array(3 * BLOCK));
    const block = this.blocks[this.blocks.length - 1]!;
    block[3 * slot] = stmt;
    block[3 * slot + 1] = a;
    block[3 * slot + 2] = b;
    this.length++;
  }

  statement(index: number): number {
    return this.blocks[Math.floor(index / BLOCK)]![3 * (index % BLOCK)]!;
  }

  matches(index: number, a: number, b: number): boolean {
    const block = this.blocks[Math.floor(index / BLOCK)]!;
    const k = 3 * (index % BLOCK);
    return block[k + 1] === a && block[k + 2] === b;
  }
}

/** True when a value is a signed 32-bit integer, the only kind of value the reference evaluator produces. */
const isInt32 = (v: number): boolean => v === (v | 0);

/** Two independent 32-bit hashes of a sequence of 32-bit words. */
class Digest {
  a = 0;
  b = 0;
  private readonly float = new Float64Array(1);
  private readonly halves = new Int32Array(this.float.buffer);

  reset(): void {
    this.a = 0x2545f491;
    this.b = 0x0b5d7a1d;
  }

  /** Add a word; a number that is not a signed 32-bit integer is reduced to its low 32 bits. */
  add(word: number): void {
    let k = Math.imul(word, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    let a = this.a ^ Math.imul(k, 0x1b873593);
    a = (a << 13) | (a >>> 19);
    this.a = (Math.imul(a, 5) + 0xe6546b64) | 0;
    let b = (this.b + Math.imul(word, 0x85ebca77)) | 0;
    b = (b << 13) | (b >>> 19);
    this.b = Math.imul(b, 0x9e3779b1);
  }

  /** Add any value exactly, as the two halves of its 64-bit floating-point form. */
  addExact(value: number): void {
    this.float[0] = value;
    this.add(this.halves[0]!);
    this.add(this.halves[1]!);
  }
}

/** State of the variables and arrays at one boundary, for the detailed message. */
interface Captured {
  vars: (number | undefined)[];
  arrays: (readonly number[] | undefined)[];
  out: number;
}

/**
 * Run a program on the reference evaluator, the IR interpreter, and the
 * simulator of each target, and compare the engines with the reference
 * evaluator. `limits.maxSteps` is the limit on the statements that the
 * reference evaluator executes; the IR interpreter and each simulator get ten
 * times that value in IR steps and in instructions. Throws ArgumentCountError
 * unless `args` has one value per parameter of main.
 */
export function crossCheck(
  source: string,
  args: readonly number[],
  backends: readonly Backend[],
  limits?: Partial<RunLimits>,
): CrossCheck {
  const front = compileFrontEnd(source);
  const result: CrossCheck = { ok: false, front, machines: [], compiled: {}, failures: [], limitReached: [] };
  if (!front.ok || !front.ir) return result;
  const ir = front.ir;
  checkArguments(parameterNames(ir), args);
  const programs = compileBackEnds(source, ir, backends);
  if (!programs.ok) {
    result.front = { ...front, ok: false, diagnostics: [...front.diagnostics, programs.diagnostic] };
    return result;
  }
  const run = { ...DEFAULT_LIMITS, ...limits };
  const engineLimits: RunLimits = { maxSteps: ENGINE_STEPS_PER_STATEMENT * run.maxSteps, maxOutput: run.maxOutput };
  result.stepLimits = { statements: run.maxSteps, irSteps: engineLimits.maxSteps, instructions: engineLimits.maxSteps };

  // Every variable and array of the source program is compared at every boundary, including
  // those that the reference evaluator has not assigned or defined yet.
  const varNames = front.checked.vars.map((v) => v.name);
  const arrayNames = front.checked.arrays.map((a) => a.name);

  // Every field of the digest starts with a tag that says how many words follow, so that two
  // different states never give the same sequence of words. A value that is not a signed 32-bit
  // integer is added exactly after its own tag, so that it never matches a value of the reference
  // evaluator; an array that holds such a value adds the exact form of its elements after them.
  const d = new Digest();
  const digestOf = (state: StateReader): Digest => {
    d.reset();
    for (const name of varNames) {
      const v = state.variable(name);
      if (v === undefined) d.add(2);
      else if (isInt32(v)) {
        d.add(1);
        d.add(v);
      } else {
        d.add(5);
        d.addExact(v);
      }
    }
    for (const name of arrayNames) {
      const a = state.array(name);
      if (a === undefined) d.add(4);
      else {
        d.add(3);
        d.add(a.length);
        let int32 = true;
        for (let j = 0; j < a.length; j++) {
          const x = a[j]!;
          d.add(x);
          if ((x | 0) !== x) int32 = false;
        }
        if (!int32) {
          d.add(6);
          for (const x of a) d.addExact(x);
        }
      }
    }
    const out = state.outputLength();
    if (isInt32(out)) {
      d.add(0);
      d.add(out);
    } else {
      d.add(7);
      d.addExact(out);
    }
    return d;
  };
  const capture = (state: StateReader): Captured => ({
    vars: varNames.map((n) => state.variable(n)),
    arrays: arrayNames.map((n) => state.array(n)?.slice()),
    out: state.outputLength(),
  });

  const log = new BoundaryLog();
  const reference = evaluateReference(front.checked, args, {
    limits: run,
    onBoundary: (stmt, state) => {
      const h = digestOf(state);
      log.push(stmt, h.a, h.b);
    },
  });
  result.reference = reference;
  const expected = observable(reference);
  const count = log.length;
  const referenceComplete = !stoppedAtStepLimit(reference);
  if (!referenceComplete) result.limitReached.push('reference');

  // State of the reference evaluator at a boundary, recovered by running it again up to that boundary.
  const referenceAt = (index: number): Captured | undefined => {
    const found: Captured[] = [];
    let k = 0;
    evaluateReference(front.checked, args, {
      limits: { maxSteps: index + 1, maxOutput: run.maxOutput },
      onBoundary: (_stmt, state) => {
        if (k++ === index) found.push(capture(state));
      },
    });
    return found[0];
  };
  const valueText = (v: number | undefined): string => (v === undefined ? 'unassigned' : String(v));
  const describe = (index: number, stmt: number, got: Captured): string => {
    const where = `boundary ${index} (statement ${stmt})`;
    const want = referenceAt(index);
    if (want) {
      for (let i = 0; i < varNames.length; i++) {
        const g = got.vars[i];
        const w = want.vars[i];
        if (g === w) continue;
        return `${where}: variable ${varNames[i]} is ${valueText(g)}, expected ${valueText(w)}`;
      }
      for (let i = 0; i < arrayNames.length; i++) {
        const g = got.arrays[i];
        const w = want.arrays[i];
        if (g === undefined && w === undefined) continue;
        if (w === undefined) return `${where}: array ${arrayNames[i]} is defined with ${g!.length} elements, expected not defined`;
        if (g === undefined) return `${where}: array ${arrayNames[i]} is not defined, expected ${w.length} elements`;
        if (g.length !== w.length) return `${where}: array ${arrayNames[i]} has ${g.length} elements, expected ${w.length}`;
        const e = g.findIndex((x, j) => x !== w[j]);
        if (e >= 0) return `${where}: array ${arrayNames[i]} element ${e} is ${g[e]}, expected ${w[e]}`;
      }
      if (got.out !== want.out) return `${where}: ${got.out} values printed, expected ${want.out}`;
    }
    return `${where}: the state differs from the reference evaluator`;
  };

  const observer = () => {
    let seen = 0;
    let agreed = 0;
    let mismatch: string | null = null;
    let first: { index: number; stmt: number; got: Captured } | null = null;
    const fn = (stmt: number, state: StateReader): void => {
      const index = seen++;
      if (mismatch !== null || first !== null) return;
      if (index >= count) {
        // A reference evaluator that ended on its own has no further boundary; one that stopped at
        // its step limit has boundaries that it did not reach, which cannot be compared.
        if (referenceComplete) mismatch = `boundary ${index}: the reference evaluator has no such boundary`;
        return;
      }
      if (log.statement(index) !== stmt) {
        mismatch = `boundary ${index}: at statement ${stmt}, expected statement ${log.statement(index)}`;
        return;
      }
      const h = digestOf(state);
      if (!log.matches(index, h.a, h.b)) {
        first = { index, stmt, got: capture(state) };
        return;
      }
      agreed++;
    };
    const firstMismatch = (): string | null => {
      if (mismatch === null && first !== null) mismatch = describe(first.index, first.stmt, first.got);
      return mismatch;
    };
    return { fn, count: () => seen, agreed: () => agreed, mismatch: firstMismatch };
  };

  /** Verdict on one engine from its outcome and the boundaries that its observer saw. */
  const judge = (engine: string, outcome: Outcome, obs: ReturnType<typeof observer>): Omit<EngineReport, 'engine' | 'outcome'> => {
    const limitReached = stoppedAtStepLimit(outcome);
    let mismatch = obs.mismatch();
    // A run that stopped at its own step limit is compared on the boundaries it reached and no further.
    if (mismatch === null && !limitReached) {
      if (referenceComplete) {
        if (observable(outcome) !== expected) mismatch = `outcome "${observable(outcome)}" differs from the reference "${expected}"`;
        else if (obs.count() !== count) mismatch = `${obs.count()} boundaries, expected ${count}`;
        else {
          // The outcome text leaves out the values printed before a stop at the output limit.
          const k = firstOutputDifference(outcome.output, reference.output);
          if (k >= 0) mismatch = `printed value ${k} is ${outcome.output[k]}, expected ${reference.output[k]}`;
        }
      } else if (obs.count() <= count) {
        // The reference evaluator passed `count` boundaries and stopped at the next one, so a run
        // that ends on its own reaches that boundary first.
        const at = obs.count() > 0 ? `after boundary ${obs.count() - 1}` : 'before its first boundary';
        mismatch = `outcome "${observable(outcome)}" ${at}, where the reference evaluator went on to boundary ${count}`;
      }
    }
    if (mismatch !== null) result.failures.push(`${engine}: ${mismatch}`);
    if (limitReached) result.limitReached.push(engine);
    return { boundaries: obs.count(), compared: obs.agreed(), mismatch, limitReached };
  };

  {
    const obs = observer();
    const outcome = interpretIR(ir, args, { limits: engineLimits, onBoundary: obs.fn });
    result.ir = { engine: 'ir', outcome, ...judge('ir', outcome, obs) };
  }

  backends.forEach((backend, k) => {
    const id = backend.profile.id;
    const compiled = programs.compiled[k]!;
    result.compiled[id] = compiled;
    const machine = loadCompiled(backend, compiled, { args, limits: engineLimits });
    const obs = observer();
    machine.onBoundary = obs.fn;
    const outcome = machine.run();
    result.machines.push({
      engine: id,
      target: id,
      outcome,
      ...judge(id, outcome, obs),
      executed: machine.executed,
      regionCounts: { ...machine.regionCounts },
      loads: machine.mem.loads,
      stores: machine.mem.stores,
      codeBytes: compiled.program.bytes.length,
      staticInstructions: compiled.program.insns.filter((i) => i.insn !== null).length,
    });
  });
  result.ok = result.failures.length === 0;
  return result;
}

/** Verdict of a cross-check of a program that compiled. */
export function crossCheckVerdict(c: CrossCheck): ComparisonVerdict {
  if (!c.ok) return 'disagree';
  return c.limitReached.length > 0 ? 'incomplete' : 'agree';
}
