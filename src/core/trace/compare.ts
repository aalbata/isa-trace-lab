/**
 * Cross-architecture comparison of one program.
 *
 * The same validated IR is lowered for each target under the same policy.
 * Each target runs independently; runs are aligned at statement boundaries by
 * their position in the boundary sequence, never by instruction index,
 * because targets execute different numbers of instructions per statement.
 * At each boundary the observable state is compared: the statement reached,
 * the values of the source variables, and the amount of output produced.
 * Physical registers, addresses, and program counters are not compared.
 *
 * Every target runs under the same limit on executed instructions, as a
 * single run does, so the work of a comparison is bounded whatever the program
 * does. The targets need different numbers of instructions for the same
 * program, so one of them can stop at the limit where another completes. A
 * run that stops at the limit is listed in `limitReached` and compared on the
 * boundaries it reached. The stop is neither a disagreement nor an agreement:
 * the verdict of such a comparison is `incomplete` unless the runs disagree
 * elsewhere.
 */
import type { CompiledProgram, FrontEnd } from '../compile.ts';
import { compileBackEnds, compileFrontEnd, parameterNames } from '../compile.ts';
import type { Outcome, RunLimits } from '../exec.ts';
import { checkArguments, sameOutcome, stoppedAtStepLimit } from '../exec.ts';
import { loadCompiled } from '../target/machine.ts';
import type { Backend, TargetId } from '../target/types.ts';
import type { Metrics } from './documents.ts';
import { metricsOf } from './documents.ts';

export interface ComparedBoundary {
  ordinal: number;
  statement: number;
  occurrence: number;
  line: number;
  /** Instructions executed before the boundary, per target that reached it. */
  steps: Partial<Record<TargetId, number>>;
  /** Variable values per target that reached the boundary; equal across those targets when `agree` is true. */
  variables: Partial<Record<TargetId, Record<string, number>>>;
  outputLength: Partial<Record<TargetId, number>>;
  /**
   * False when the targets that reached the boundary differ in the statement,
   * a variable, or the output length, or when a target that ended on its own
   * did not reach it.
   */
  agree: boolean;
}

export interface TargetRun {
  target: TargetId;
  outcome: Outcome;
  metrics: Metrics;
  compiled: CompiledProgram;
}

export interface Comparison {
  /** Front-end result; not ok also when the code of a target does not fit its memory layout (diagnostic code `assembler`). */
  front: FrontEnd;
  runs: TargetRun[];
  boundaries: ComparedBoundary[];
  /** True when more boundaries occurred than were kept. */
  boundariesTruncated: boolean;
  /**
   * Targets whose run stopped at the limit on executed instructions. Each is
   * compared on the boundaries it reached, and its outcome is not compared.
   */
  limitReached: TargetId[];
  /**
   * True when the runs that ended on their own all ended the same way with the
   * same output and return value. The runs listed in `limitReached` are left
   * out, so the value is also true when fewer than two runs ended on their own.
   */
  outcomesAgree: boolean;
  /**
   * True when every kept boundary agrees and no run that ended on its own
   * fired fewer boundaries than another run.
   */
  boundariesAgree: boolean;
}

/**
 * Compile one program for several targets, run it on each, and align the runs
 * at statement boundaries. `limits.maxSteps` is the limit on the instructions
 * that each target executes, as for a single run. Throws ArgumentCountError
 * unless `args` has one value per parameter of main.
 */
export function compareTargets(
  source: string,
  args: readonly number[],
  backends: readonly Backend[],
  options: { limits?: Partial<RunLimits>; maxBoundaries?: number } = {},
): Comparison {
  const front = compileFrontEnd(source);
  const out: Comparison = { front, runs: [], boundaries: [], boundariesTruncated: false, limitReached: [], outcomesAgree: false, boundariesAgree: false };
  if (!front.ok || !front.ir) return out;
  const maxBoundaries = options.maxBoundaries ?? 5000;
  const ir = front.ir;
  checkArguments(parameterNames(ir), args);
  const programs = compileBackEnds(source, ir, backends);
  if (!programs.ok) {
    out.front = { ...front, ok: false, diagnostics: [...front.diagnostics, programs.diagnostic] };
    return out;
  }

  backends.forEach((backend, k) => {
    const id = backend.profile.id;
    const compiled = programs.compiled[k]!;
    const m = loadCompiled(backend, compiled, { args, limits: options.limits });
    const visible = compiled.variables.filter((v) => !v.hidden);
    const occurrences = new Map<number, number>();
    let ordinal = 0;
    m.onBoundary = (stmt, state) => {
      const index = ordinal++;
      const occurrence = occurrences.get(stmt) ?? 0;
      occurrences.set(stmt, occurrence + 1);
      if (index >= maxBoundaries) {
        out.boundariesTruncated = true;
        return;
      }
      const variables: Record<string, number> = {};
      for (const v of visible) {
        const value = state.variable(v.name);
        if (value !== undefined) variables[v.name] = value;
      }
      let row = out.boundaries[index];
      if (!row) {
        row = { ordinal: index, statement: stmt, occurrence, line: ir.stmts[stmt]?.span.start.line ?? 0, steps: {}, variables: {}, outputLength: {}, agree: true };
        out.boundaries[index] = row;
      } else if (row.statement !== stmt) row.agree = false;
      row.steps[id] = m.executed;
      row.variables[id] = variables;
      row.outputLength[id] = state.outputLength();
    };
    const outcome = m.run();
    if (stoppedAtStepLimit(outcome)) out.limitReached.push(id);
    out.runs.push({ target: id, outcome, metrics: metricsOf(backend, compiled, m), compiled });
  });

  const ids = out.runs.map((r) => r.target);
  const stopped = new Set(out.limitReached);
  for (const row of out.boundaries) {
    const first = ids.find((id) => row.variables[id] !== undefined);
    for (const id of ids) {
      const vars = row.variables[id];
      if (vars === undefined || first === undefined) {
        // A run that stopped at the instruction limit is compared only on the boundaries it reached.
        if (!stopped.has(id)) row.agree = false;
        continue;
      }
      const base = row.variables[first]!;
      const names = new Set([...Object.keys(base), ...Object.keys(vars)]);
      for (const n of names) if (base[n] !== vars[n]) row.agree = false;
      if (row.outputLength[id] !== row.outputLength[first]) row.agree = false;
    }
  }
  const ended = out.runs.filter((r) => !stopped.has(r.target));
  out.outcomesAgree = out.runs.length > 0 && ended.every((r) => sameOutcome(r.outcome, ended[0]!.outcome));
  // A run that ended on its own fired every boundary of the program, so no other run fires more. The
  // counts cover the boundaries after the kept ones as well.
  const most = out.runs.reduce((n, r) => Math.max(n, r.metrics.boundaries), 0);
  out.boundariesAgree = out.boundaries.every((c) => c.agree) && ended.every((r) => r.metrics.boundaries === most);
  return out;
}

/**
 * Verdict of a comparison. `incomplete` means that no disagreement was found and at least one
 * run stopped at its step limit, so that the rest of that run was not compared.
 */
export type ComparisonVerdict = 'agree' | 'disagree' | 'incomplete';

/** Verdict of a cross-target comparison of a program that compiled. */
export function comparisonVerdict(c: Comparison): ComparisonVerdict {
  if (!c.outcomesAgree || !c.boundariesAgree) return 'disagree';
  return c.limitReached.length > 0 ? 'incomplete' : 'agree';
}
