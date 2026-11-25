/**
 * Cross-engine comparisons and the command-line tool: the state compared
 * exactly at every boundary, the step limit of each engine in its own unit,
 * the three verdicts of a comparison, runs that stop at their step limit, runs
 * that end too early or too late, the number of arguments of main, code that
 * does not fit a target, and the exit status and option checks of the
 * commands.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../scripts/lib/corpus.ts';
import {
  ArgumentCountError, compareTargets, comparisonVerdict, compileProgram, crossCheck, crossCheckVerdict, encodeAssembly, machineFromBytes, simulate,
  stoppedAtStepLimit, traceProgram,
} from '../src/core/api.ts';
import type { Comparison, CrossCheck } from '../src/core/api.ts';
import type { StateReader } from '../src/core/exec.ts';
import type { IRProgram } from '../src/core/ir/ir.ts';
import { availableBackends, getBackend } from '../src/core/target/index.ts';
import { Machine } from '../src/core/target/machine.ts';
import type { Backend, StepEvent } from '../src/core/target/types.ts';

/** While `active` is set, the IR interpreter runs a copy of the IR whose array fill loops never advance their index. */
const irDefect = vi.hoisted(() => ({ active: false }));
vi.mock('../src/core/ir/interp.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/ir/interp.ts')>();
  const stuck = (ir: IRProgram): IRProgram => ({
    ...ir,
    blocks: ir.blocks.map((b) => (b.term.op === 'br' && (b.term.then === b.id || b.term.else === b.id) ? { ...b, ops: b.ops.filter((op) => op.op !== 'bin') } : b)),
  });
  return {
    ...original,
    interpretIR: (ir: IRProgram, args?: readonly number[], options?: Parameters<typeof original.interpretIR>[2]) =>
      original.interpretIR(irDefect.active ? stuck(ir) : ir, args, options),
  };
});

const root = repoRoot();
const backends = availableBackends();
const ids = backends.map((b) => b.profile.id);
const example = (name: string): string => readFileSync(join(root, 'examples', name), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'isa-trace-lab-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const file = (name: string, text: string | Uint8Array): string => {
  const path = join(work, name);
  writeFileSync(path, text);
  return path;
};
/** Run the command-line tool, after the modules given as Node options such as `--import`. */
const cliWith = (options: readonly string[], ...args: string[]) =>
  spawnSync(process.execPath, [...options, join(root, 'src', 'cli', 'main.ts'), ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 });
const cli = (...args: string[]) => cliWith([], ...args);
/**
 * Evaluate `body`, the source text of a function of the API module, in a
 * separate Node.js process and return its result, which must be JSON. A run of
 * tens of millions of steps takes less time there than under the test runner.
 */
const inNode = <T>(body: string): T => {
  const api = pathToFileURL(join(root, 'src', 'core', 'api.ts')).href;
  const script = `import * as api from ${JSON.stringify(api)};\nconsole.log(JSON.stringify((${body})(api)));\n`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 170_000 });
  if (r.status !== 0) throw new Error(`the script ended with status ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as T;
};
/**
 * A module, given to the command-line tool with `--import`, that replaces the
 * step function of every riscv processor: `body` runs with `cpu` and its
 * original `step` in scope and assigns `cpu.step`.
 */
const riscvPreload = (name: string, body: string): string[] => {
  const targets = pathToFileURL(join(root, 'src', 'core', 'target', 'index.ts')).href;
  const text = [
    `const { getBackend } = await import(${JSON.stringify(targets)});`,
    `const riscv = getBackend('riscv');`,
    `const create = riscv.createCpu.bind(riscv);`,
    `riscv.createCpu = (mem) => {`,
    `  const cpu = create(mem);`,
    `  const step = cpu.step.bind(cpu);`,
    `  ${body}`,
    `  return cpu;`,
    `};`,
  ].join('\n');
  return ['--import', pathToFileURL(file(name, text + '\n')).href];
};
/** The riscv processor ends main with a return value one too large. */
const offByOne = (): string[] => riscvPreload('off-by-one.mjs', [
  'cpu.step = (ev) => {',
  '    const stop = step(ev);',
  "    if (stop?.kind === 'service' && cpu.reg32('a7') === 2) cpu.writeReg('a0', cpu.readReg('a0') + 1n);",
  '    return stop;',
  '  };',
].join('\n'));

const THREE = 'def main(a, b, c):\n    print(c)\n    return a + b\n';
const TWO = 'def main(a, b):\n    return a - b\n';
const FOREVER = 'def main():\n    n = 0\n    while True:\n        n += 1\n';
const FOREVER_MUL = 'def main():\n    x = 1\n    while True:\n        x = x * 1103515245 + 12345\n';
const FILL = 'def main(n):\n    a = [n + 1] * 6\n    return a[5]\n';
const FILL_LARGE = 'def main(n):\n    a = [n + 1] * 4096\n    return a[5]\n';
const LONG_LOOP = 'def main(n):\n    t = 0\n    i = 0\n    while i < n:\n        t += i\n        i += 1\n    return t\n';
const MUL_LOOP = 'def main(n):\n    x = 1\n    for i in range(n):\n        x = x * 1103515245 + 12345\n    return x\n';
const SEVEN = 'def main():\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    e = 5\n    f = 6\n    g = 7\n    return a + b + c + d + e + f + g\n';
const ARRAY_LOOP = 'def main(n):\n    a = [3, 1, 4, 1, 5]\n    total = 0\n    for i in range(n):\n        total += a[1]\n    return total\n';
/** `early` and the loop variable are assigned only when n is positive; `a` and `late` only when the loop does not return. */
const LATE = 'def main(n):\n    if n > 0:\n        early = 1\n    t = 0\n    for i in range(n):\n        t += i\n        if t > 2:\n            return t\n    a = [n + 1] * 3\n    late = a[0]\n    return t + late\n';

/** A program of 37,007 characters whose code fits RISC-V, MIPS, and AArch64 but needs more than 64 KiB on x86-64. */
function oversized(): string {
  let e = '(a-c)';
  for (let d = 0; d < 8; d++) e = `(${e}|${e})`;
  return `def main(a, b, c, d):\n${`    x = ${e}\n`.repeat(18)}    return x\n`;
}

type Cpu = ReturnType<Backend['createCpu']>;
type Mem = Parameters<Backend['createCpu']>[0];

/**
 * Wrap a back end's processor so that the state is wrong at exactly one
 * boundary: `spoil` runs once after the instruction at which boundary `at - 1`
 * (zero-based) fired, so boundary `at` observes the wrong state, and `repair`
 * runs once after the instruction of boundary `at`.
 */
function faulty(base: Backend, source: string, at: number, spoil: (cpu: Cpu, mem: Mem) => void, repair: (cpu: Cpu, mem: Mem) => void): Backend {
  const compiled = compileProgram(source, base.profile.id);
  if (!compiled.ok) throw new Error('compile');
  const marks = new Map(compiled.compiled.program.boundaries.map((b) => [b.address, b.stmts.length]));
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      let fired = 0;
      let phase = 0;
      cpu.step = (ev) => {
        fired += marks.get(cpu.pc) ?? 0;
        const stop = step(ev);
        if (phase === 0 && fired === at) {
          spoil(cpu, mem);
          phase = 1;
        } else if (phase === 1 && fired === at + 1) {
          repair(cpu, mem);
          phase = 2;
        }
        return stop;
      };
      return cpu;
    },
  };
}

/** The register of `variable` is one too large at boundary `at` only. */
function registerFault(base: Backend, source: string, variable: string, at: number): Backend {
  const c = compileProgram(source, base.profile.id);
  if (!c.ok) throw new Error('compile');
  const home = c.compiled.variables.find((v) => v.name === variable)!.home;
  if (home.kind !== 'reg') throw new Error('expected a register home');
  return faulty(base, source, at, (cpu) => cpu.writeReg(home.reg, cpu.readReg(home.reg) + 1n), (cpu) => cpu.writeReg(home.reg, cpu.readReg(home.reg) - 1n));
}

/** One element of an array that the program never writes is one too large at boundary `at` only. */
function memoryFault(base: Backend, source: string, array: string, element: number, at: number): Backend {
  const c = compileProgram(source, base.profile.id);
  if (!c.ok) throw new Error('compile');
  const address = c.compiled.arrays.find((a) => a.name === array)!.address + 4 * element;
  const word = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  return faulty(base, source, at, (_cpu, mem) => mem.poke(address, word(mem.peek32(address)! + 1)), (_cpu, mem) => mem.poke(address, word(mem.peek32(address)! - 1)));
}

/** After `at` boundaries the processor stops advancing: the same instruction repeats without another boundary. */
function stuckAfter(base: Backend, source: string, at: number): Backend {
  const c = compileProgram(source, base.profile.id);
  if (!c.ok) throw new Error('compile');
  const marks = new Map(c.compiled.program.boundaries.map((b) => [b.address, b.stmts.length]));
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      let fired = 0;
      let frozen = false;
      cpu.step = (ev) => {
        if (marks.has(cpu.pc)) fired += marks.get(cpu.pc)!;
        else if (fired >= at) frozen = true;
        return frozen ? null : step(ev);
      };
      return cpu;
    },
  };
}

/** The instruction at which boundary `at` (zero-based) fires stops the processor with a fault. */
function faultAfter(base: Backend, source: string, at: number): Backend {
  const c = compileProgram(source, base.profile.id);
  if (!c.ok) throw new Error('compile');
  const marks = new Map(c.compiled.program.boundaries.map((b) => [b.address, b.stmts.length]));
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      let fired = 0;
      cpu.step = (ev) => {
        fired += marks.get(cpu.pc) ?? 0;
        return fired > at ? { kind: 'fault', message: 'injected fault' } : step(ev);
      };
      return cpu;
    },
  };
}

/** After `after` boundaries, `variable` is set back to `low` whenever it reaches `high`, so the loop never ends. */
function livelock(base: Backend, source: string, variable: string, after: number, high: number, low: number): Backend {
  const c = compileProgram(source, base.profile.id);
  if (!c.ok) throw new Error('compile');
  const marks = new Map(c.compiled.program.boundaries.map((b) => [b.address, b.stmts.length]));
  const home = c.compiled.variables.find((v) => v.name === variable)!.home;
  if (home.kind !== 'reg') throw new Error('expected a register home');
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      let fired = 0;
      cpu.step = (ev) => {
        fired += marks.get(cpu.pc) ?? 0;
        const stop = step(ev);
        if (fired >= after && cpu.reg32(home.reg) >= high) cpu.writeReg(home.reg, BigInt(low));
        return stop;
      };
      return cpu;
    },
  };
}

/** The processor performs the exit service as a jump to `address` the first `times` times, and only then ends the run. */
function jumpAfterExit(base: Backend, address: number, times = 1): Backend {
  const conv = base.profile.conventions;
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      let jumps = 0;
      cpu.step = (ev) => {
        const stop = step(ev);
        if (jumps < times && stop?.kind === 'service' && cpu.reg32(conv.serviceNumber) === 2) {
          jumps++;
          cpu.pc = address;
          return null;
        }
        return stop;
      };
      return cpu;
    },
  };
}

/** The processor never performs the exit service: the instruction that requests it repeats. */
function noExit(base: Backend): Backend {
  const conv = base.profile.conventions;
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      cpu.step = (ev) => {
        const pc = cpu.pc;
        const stop = step(ev);
        if (stop?.kind === 'service' && cpu.reg32(conv.serviceNumber) === 2) {
          cpu.pc = pc;
          return null;
        }
        return stop;
      };
      return cpu;
    },
  };
}

/** The processor ends main with a return value one too large. */
function returnsOneMore(base: Backend): Backend {
  const conv = base.profile.conventions;
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      cpu.step = (ev) => {
        const stop = step(ev);
        if (stop?.kind === 'service' && cpu.reg32(conv.serviceNumber) === 2) cpu.writeReg(conv.serviceArg, cpu.readReg(conv.serviceArg) + 1n);
        return stop;
      };
      return cpu;
    },
  };
}

/** The processor passes every value to the print service one too large. */
function printsOneMore(base: Backend): Backend {
  const conv = base.profile.conventions;
  return {
    ...base,
    createCpu(mem) {
      const cpu = base.createCpu(mem);
      const step = cpu.step.bind(cpu);
      cpu.step = (ev) => {
        const stop = step(ev);
        if (stop?.kind === 'service' && cpu.reg32(conv.serviceNumber) === 1) cpu.writeReg(conv.serviceArg, cpu.readReg(conv.serviceArg) + 1n);
        return stop;
      };
      return cpu;
    },
  };
}

/**
 * Run `body` while the boundary observer of every `target` simulator sees the
 * state through `view` from boundary `from` (zero-based) on. Execution itself
 * is unchanged.
 */
function withReadout<T>(target: string, from: number, view: (state: StateReader) => StateReader, body: () => T): T {
  const step = Machine.prototype.step;
  const seen = new WeakMap<Machine, number>();
  Machine.prototype.step = function (this: Machine, ev?: StepEvent): boolean {
    const observer = this.onBoundary;
    if (this.backend.profile.id !== target || observer === undefined) return step.call(this, ev);
    this.onBoundary = (stmt, state) => {
      const index = seen.get(this) ?? 0;
      seen.set(this, index + 1);
      observer(stmt, index >= from ? view(state) : state);
    };
    try {
      return step.call(this, ev);
    } finally {
      this.onBoundary = observer;
    }
  };
  try {
    return body();
  } finally {
    Machine.prototype.step = step;
  }
}

/** The observer sees `variable` one too large. */
const oneMore = (variable: string) => (s: StateReader): StateReader => ({ ...s, variable: (n) => (n === variable ? s.variable(n)! + 1 : s.variable(n)) });

describe('cross-check of the state at every boundary', () => {
  const summation = example('summation.py');

  it('finds a wrong variable at any boundary of a long run, not only the first 20,000', () => {
    for (const at of [1000, 30000, 131000]) {
      const cc = crossCheck(summation, [65535], [registerFault(getBackend('riscv'), summation, 'total', at)]);
      expect(cc.ok, `fault at boundary ${at}`).toBe(false);
      expect(crossCheckVerdict(cc), `fault at boundary ${at}`).toBe('disagree');
      expect(cc.failures[0]).toMatch(new RegExp(`^riscv: boundary ${at} \\(statement \\d+\\): variable total is (-?\\d+), expected (-?\\d+)$`));
      const [, got, want] = /is (-?\d+), expected (-?\d+)$/.exec(cc.failures[0]!)!;
      expect(Number(got) - Number(want)).toBe(1);
    }
    const clean = crossCheck(summation, [65535], backends);
    expect(clean.failures).toEqual([]);
    expect(crossCheckVerdict(clean)).toBe('agree');
    expect(clean.machines.every((m) => m.compared === 131074)).toBe(true);
  });

  it('names the array element that differs', () => {
    const cc = crossCheck(ARRAY_LOOP, [20000], [memoryFault(getBackend('mips'), ARRAY_LOOP, 'a', 4, 30001)]);
    expect(cc.ok).toBe(false);
    expect(cc.failures).toHaveLength(1);
    expect(cc.failures[0]).toMatch(/^mips: boundary 30001 \(statement \d+\): array a element 4 is 6, expected 5$/);
  });

  it('compares every value exactly, not only its low 32 bits', () => {
    const source = 'def main(n):\n    t = 0\n    a = [0] * 4\n    i = 0\n    while i < n:\n        t -= 3\n        a[1] = t\n        i += 1\n    return t\n';
    const views: [string, (s: StateReader) => StateReader, RegExp][] = [
      ['unsigned variable', (s) => ({ ...s, variable: (n) => (n === 't' ? s.variable(n)! >>> 0 : s.variable(n)) }), /variable t is (\d+), expected (-\d+)$/],
      ['unsigned array element', (s) => ({ ...s, array: (n) => s.array(n)?.map((x) => x >>> 0) }), /array a element 1 is (\d+), expected (-\d+)$/],
      ['output length plus 2^32', (s) => ({ ...s, outputLength: () => s.outputLength() + 2 ** 32 }), /(\d+) values printed, expected (\d+)$/],
    ];
    for (const target of ['riscv', 'x86']) {
      for (const [what, view, message] of views) {
        const cc = withReadout(target, 30000, view, () => crossCheck(source, [20000], [getBackend(target)]));
        expect(cc.failures, `${target} ${what}`).toHaveLength(1);
        expect(cc.failures[0], `${target} ${what}`).toMatch(new RegExp(`^${target}: boundary 30000 \\(statement \\d+\\): `));
        const [, got, want] = message.exec(cc.failures[0]!)!;
        expect(Number(got) - Number(want), `${target} ${what}`).toBe(2 ** 32);
      }
    }
    const clean = withReadout('riscv', 30000, (s) => s, () => crossCheck(source, [20000], [getBackend('riscv')]));
    expect(clean.failures).toEqual([]);
  });

  it('reports a variable that an engine holds before the reference evaluator has assigned it', () => {
    // With n = 0 neither `early` nor the loop variable is ever assigned, and `late` only by the last statement but one.
    for (const [variable, boundary] of [['late', 0], ['early', 2], ['i', 4]] as const) {
      const view = (s: StateReader): StateReader => ({ ...s, variable: (n) => (n === variable ? 7 : s.variable(n)) });
      for (const target of ['riscv', 'x86']) {
        const cc = withReadout(target, boundary, view, () => crossCheck(LATE, [0], [getBackend(target)]));
        expect(cc.failures, `${target} ${variable}`).toEqual([expect.stringMatching(new RegExp(`^${target}: boundary ${boundary} \\(statement \\d+\\): variable ${variable} is 7, expected unassigned$`))]);
        expect(crossCheckVerdict(cc), `${target} ${variable}`).toBe('disagree');
      }
    }
    // An engine that does not hold a variable that the reference evaluator has assigned.
    const missing = withReadout('mips', 3, (s) => ({ ...s, variable: (n) => (n === 't' ? undefined : s.variable(n)) }), () => crossCheck(LATE, [0], [getBackend('mips')]));
    expect(missing.failures).toEqual([expect.stringMatching(/^mips: boundary 3 \(statement \d+\): variable t is unassigned, expected 0$/)]);
  });

  it('reports an array that an engine holds before its definition has executed', () => {
    // The boundary of the defining statement fires before the statement executes, so the array exists from the next boundary on.
    const defining = crossCheck(LATE, [0], []).reference!.steps - 3;
    for (const boundary of [0, defining]) {
      for (const target of ['riscv', 'x86']) {
        const cc = withReadout(target, boundary, (s) => ({ ...s, array: () => [1, 1, 1] }), () => crossCheck(LATE, [0], [getBackend(target)]));
        expect(cc.failures, `${target} ${boundary}`).toEqual([expect.stringMatching(new RegExp(`^${target}: boundary ${boundary} \\(statement \\d+\\): array a is defined with 3 elements, expected not defined$`))]);
        expect(crossCheckVerdict(cc), `${target} ${boundary}`).toBe('disagree');
      }
    }
    // An engine that does not hold an array that the reference evaluator has defined.
    const missing = withReadout('mips', defining + 1, (s) => ({ ...s, array: () => undefined }), () => crossCheck(LATE, [0], [getBackend('mips')]));
    expect(missing.failures).toEqual([expect.stringMatching(new RegExp(`^mips: boundary ${defining + 1} \\(statement \\d+\\): array a is not defined, expected 3 elements$`))]);
  });

  it('agrees on variables and arrays that are assigned late or never', () => {
    // n = 0 skips the conditional assignment and the loop; n = 5 returns from the loop before the array is defined.
    for (const n of [0, 1, 5]) {
      const cc = crossCheck(LATE, [n], backends);
      expect(cc.failures, `n = ${n}`).toEqual([]);
      expect(crossCheckVerdict(cc), `n = ${n}`).toBe('agree');
    }
  });

  it('reports a boundary after the last one of the reference evaluator, also at an address shared by two statements', () => {
    const source = example('linear_search.py');
    for (const target of ['riscv', 'x86']) {
      const c = compileProgram(source, target);
      if (!c.ok) throw new Error('compile');
      const shared = c.compiled.program.boundaries.find((b) => b.stmts.length === 2)!;
      const single = c.compiled.program.boundaries.find((b) => b.stmts.length === 1)!;
      for (const b of [shared, single]) {
        const cc = crossCheck(source, [15], [jumpAfterExit(getBackend(target), b.address)]);
        expect(cc.failures, `${target} ${b.stmts.length}`).toEqual([`${target}: boundary 12: the reference evaluator has no such boundary`]);
        expect(crossCheckVerdict(cc), `${target} ${b.stmts.length}`).toBe('disagree');
      }
    }
  });
});

describe('verdict of a comparison', () => {
  it('is disagree for any disagreement, incomplete when only a step limit was reached, and agree otherwise', () => {
    const compared = (outcomesAgree: boolean, boundariesAgree: boolean, limitReached: string[]) =>
      comparisonVerdict({ outcomesAgree, boundariesAgree, limitReached } as unknown as Comparison);
    expect(compared(true, true, [])).toBe('agree');
    expect(compared(true, true, ['riscv'])).toBe('incomplete');
    expect(compared(false, true, [])).toBe('disagree');
    expect(compared(true, false, [])).toBe('disagree');
    expect(compared(false, true, ['riscv'])).toBe('disagree');
    expect(compared(true, false, ['riscv', 'mips'])).toBe('disagree');
    const checked = (ok: boolean, limitReached: string[]) => crossCheckVerdict({ ok, limitReached } as unknown as CrossCheck);
    expect(checked(true, [])).toBe('agree');
    expect(checked(true, ['reference'])).toBe('incomplete');
    expect(checked(true, ['ir'])).toBe('incomplete');
    expect(checked(false, [])).toBe('disagree');
    expect(checked(false, ['reference', 'riscv'])).toBe('disagree');
  });
});

describe('step limit of a comparison across targets', () => {
  it('gives every target the instruction limit of a single run', () => {
    const source = example('summation.py');
    const limits = { maxSteps: 1000 };
    const cmp = compareTargets(source, [65535], backends, { limits });
    for (const run of cmp.runs) {
      const single = simulate(run.compiled, run.target, { args: [65535], limits });
      expect(run.outcome, run.target).toEqual(single.outcome);
      expect(run.metrics, run.target).toEqual(single.metrics);
      expect(run.outcome, run.target).toMatchObject({ status: 'limit', limit: 'steps', steps: 1000 });
      expect(run.metrics.executedInstructions, run.target).toBe(1000);
    }
    // The targets reach different numbers of boundaries within the limit, and each is compared on those it reached.
    const reached = new Map(cmp.runs.map((r) => [r.target, r.metrics.boundaries]));
    expect(new Set(reached.values()).size).toBeGreaterThan(1);
    expect(cmp.boundaries).toHaveLength(Math.max(...reached.values()));
    for (const row of cmp.boundaries) {
      expect(Object.keys(row.variables).sort(), `boundary ${row.ordinal}`).toEqual(ids.filter((id) => reached.get(id)! > row.ordinal).sort());
      expect(row.agree, `boundary ${row.ordinal}`).toBe(true);
    }
    expect(cmp.limitReached).toEqual(ids);
    expect(cmp.outcomesAgree).toBe(true);
    expect(cmp.boundariesAgree).toBe(true);
    expect(comparisonVerdict(cmp)).toBe('incomplete');
  });

  it('executes no more than the default instruction limit on a program that never ends', () => {
    // RV32I has no multiply instruction; one pass of this loop takes about 180 instructions there.
    const cmp = compareTargets(FOREVER_MUL, [], backends);
    expect(cmp.runs.map((r) => r.metrics.executedInstructions)).toEqual(backends.map(() => 5_000_000));
    expect(cmp.runs.every((r) => stoppedAtStepLimit(r.outcome))).toBe(true);
    expect(cmp.limitReached).toEqual(ids);
    expect(comparisonVerdict(cmp)).toBe('incomplete');
  });

  it('reports a multiplication loop that only RV32I cannot finish within the limit as incomplete, not as a disagreement', () => {
    // RV32I multiplies in a helper and needs about 22 million instructions; the other targets need fewer than 1.6 million.
    const cmp = compareTargets(MUL_LOOP, [120000], backends);
    const run = (id: string) => cmp.runs.find((r) => r.target === id)!;
    expect(run('riscv').outcome).toMatchObject({ status: 'limit', limit: 'steps', steps: 5_000_000 });
    for (const id of ids.filter((x) => x !== 'riscv')) {
      expect(run(id).outcome, id).toMatchObject({ status: 'exited', returnValue: 978488641 });
      expect(run(id).metrics.boundaries, id).toBe(240003);
      expect(run(id).metrics.boundaries, id).toBeGreaterThan(run('riscv').metrics.boundaries);
    }
    expect(cmp.limitReached).toEqual(['riscv']);
    expect(cmp.outcomesAgree).toBe(true);
    expect(cmp.boundariesAgree).toBe(true);
    expect(comparisonVerdict(cmp)).toBe('incomplete');

    // A shorter loop of the same kind: 20,000 instructions are too few for RV32I, and 200,000 are enough for every target.
    const short = compareTargets(MUL_LOOP, [1000], backends, { limits: { maxSteps: 20000 } });
    expect(short.limitReached).toEqual(['riscv']);
    expect(comparisonVerdict(short)).toBe('incomplete');
    const full = compareTargets(MUL_LOOP, [1000], backends, { limits: { maxSteps: 200000 } });
    expect(full.runs.map((r) => r.outcome.returnValue)).toEqual(backends.map(() => -928224423));
    expect(full.runs[0]!.metrics.executedInstructions).toBeGreaterThan(20000);
    expect(full.limitReached).toEqual([]);
    expect(full.outcomesAgree).toBe(true);
    expect(full.boundariesAgree).toBe(true);
    expect(comparisonVerdict(full)).toBe('agree');
  });

  it('keeps a real disagreement when another run stopped at the limit', () => {
    // RV32I stops at the limit after more than 200 boundaries; the other targets complete.
    const limits = { maxSteps: 20000 };
    const clean = compareTargets(MUL_LOOP, [1000], backends, { limits });
    expect(clean.limitReached).toEqual(['riscv']);
    expect(comparisonVerdict(clean)).toBe('incomplete');

    // A wrong value at a boundary that several runs reached, seen on the run that stopped or on one that completed.
    for (const target of ['riscv', 'mips']) {
      const cmp = withReadout(target, 100, oneMore('x'), () => compareTargets(MUL_LOOP, [1000], backends, { limits }));
      expect(cmp.limitReached, target).toEqual(['riscv']);
      expect(cmp.boundaries[99]!.agree, target).toBe(true);
      expect(cmp.boundaries[100]!.agree, target).toBe(false);
      expect(cmp.boundariesAgree, target).toBe(false);
      expect(comparisonVerdict(cmp), target).toBe('disagree');
    }

    // Different outcomes of two runs that both ended on their own.
    const outcome = compareTargets(MUL_LOOP, [1000], [getBackend('riscv'), returnsOneMore(getBackend('mips')), getBackend('x86')], { limits });
    expect(outcome.limitReached).toEqual(['riscv']);
    expect(outcome.runs.map((r) => r.outcome.returnValue)).toEqual([undefined, -928224422, -928224423]);
    expect(outcome.outcomesAgree).toBe(false);
    expect(outcome.boundariesAgree).toBe(true);
    expect(comparisonVerdict(outcome)).toBe('disagree');
  });

  it('reports a run that ended on its own after fewer boundaries than another run passed', () => {
    // riscv sets its loop counter back after boundary 1000 and runs to the instruction limit; mips completes after 1,504 boundaries.
    const looping = livelock(getBackend('riscv'), LONG_LOOP, 'i', 1000, 400, 300);
    // riscv stops with a fault after boundary 499 of a program that never ends; mips runs to the instruction limit.
    const faulting = faultAfter(getBackend('riscv'), FOREVER, 499);
    // Also when the kept boundaries end before the runs part.
    for (const maxBoundaries of [5000, 100]) {
      const cmp = compareTargets(LONG_LOOP, [500], [looping, getBackend('mips')], { limits: { maxSteps: 20000 }, maxBoundaries });
      expect(cmp.runs.map((r) => r.outcome.status)).toEqual(['limit', 'exited']);
      expect(cmp.limitReached).toEqual(['riscv']);
      expect(cmp.runs[1]!.metrics.boundaries).toBe(1504);
      expect(cmp.runs[0]!.metrics.boundaries).toBeGreaterThan(1504);
      expect(cmp.boundaries.slice(0, 100).every((row) => row.agree)).toBe(true);
      expect(cmp.boundariesAgree, `${maxBoundaries} kept`).toBe(false);
      expect(comparisonVerdict(cmp), `${maxBoundaries} kept`).toBe('disagree');

      const mixed = compareTargets(FOREVER, [], [faulting, getBackend('mips')], { limits: { maxSteps: 10000 }, maxBoundaries });
      expect(mixed.runs.map((r) => r.outcome.status)).toEqual(['fault', 'limit']);
      expect(mixed.limitReached).toEqual(['mips']);
      expect(mixed.runs[0]!.metrics.boundaries).toBe(500);
      expect(mixed.runs[1]!.metrics.boundaries).toBeGreaterThan(500);
      // The first boundary that the run with the fault did not reach is marked when it is kept.
      expect(mixed.boundaries.findIndex((row) => !row.agree), `${maxBoundaries} kept`).toBe(maxBoundaries > 500 ? 500 : -1);
      expect(mixed.boundariesAgree, `${maxBoundaries} kept`).toBe(false);
      expect(comparisonVerdict(mixed), `${maxBoundaries} kept`).toBe('disagree');
    }

    // The fault lies beyond the boundaries that either run reaches within the limit, so nothing disagrees.
    const unseen = compareTargets(FOREVER, [], [faultAfter(getBackend('riscv'), FOREVER, 3000), getBackend('mips')], { limits: { maxSteps: 1000 } });
    expect(unseen.limitReached).toEqual(['riscv', 'mips']);
    expect(comparisonVerdict(unseen)).toBe('incomplete');

    // Two runs that both end on their own, one of them after boundaries that the other does not have.
    const source = example('linear_search.py');
    const c = compileProgram(source, 'riscv');
    if (!c.ok) throw new Error('compile');
    const again = jumpAfterExit(getBackend('riscv'), c.compiled.program.boundaries.find((b) => b.stmts.length === 2)!.address);
    const extra = compareTargets(source, [15], [again, getBackend('mips')], { maxBoundaries: 5 });
    expect(extra.limitReached).toEqual([]);
    expect(extra.boundaries.every((row) => row.agree)).toBe(true);
    expect(extra.runs[0]!.metrics.boundaries).toBeGreaterThan(extra.runs[1]!.metrics.boundaries);
    expect(extra.boundariesAgree).toBe(false);
    expect(comparisonVerdict(extra)).toBe('disagree');
  });

  it('reports a simulator that runs to the instruction limit without reaching a boundary as incomplete', () => {
    const summation = example('summation.py');
    const cmp = compareTargets(summation, [100], [stuckAfter(getBackend('riscv'), summation, 50), getBackend('mips')]);
    expect(cmp.runs[0]!.outcome).toMatchObject({ status: 'limit', limit: 'steps', steps: 5_000_000 });
    expect(cmp.runs[0]!.metrics.boundaries).toBe(50);
    expect(cmp.runs[1]!.outcome).toMatchObject({ status: 'exited', returnValue: 5050 });
    expect(cmp.limitReached).toEqual(['riscv']);
    expect(cmp.outcomesAgree).toBe(true);
    expect(cmp.boundariesAgree).toBe(true);
    expect(comparisonVerdict(cmp)).toBe('incomplete');

    // A simulator that never performs the exit service after the last boundary.
    const never = compareTargets(summation, [10], [noExit(getBackend('x86')), getBackend('mips')], { limits: { maxSteps: 10000 } });
    expect(never.runs.map((r) => r.outcome.status)).toEqual(['limit', 'exited']);
    expect(never.runs[0]!.metrics.boundaries).toBe(never.runs[1]!.metrics.boundaries);
    expect(never.limitReached).toEqual(['x86']);
    expect(comparisonVerdict(never)).toBe('incomplete');
  });
});

describe('step limits of a cross-check', () => {
  it('lets every engine finish a program that the reference evaluator finishes within its limit', () => {
    // The reference evaluator needs 45 statements, the IR interpreter 140 steps, the simulators 103 to 137 instructions.
    const cc = crossCheck(example('fibonacci.py'), [10], backends, { maxSteps: 100 });
    expect(cc.failures).toEqual([]);
    expect(cc.limitReached).toEqual([]);
    expect(crossCheckVerdict(cc)).toBe('agree');
    expect(cc.reference!.steps).toBe(45);
    expect(cc.ir!.outcome.steps).toBeGreaterThan(100);
    expect(Math.max(...cc.machines.map((m) => m.executed))).toBeGreaterThan(100);
    for (const r of [cc.ir!, ...cc.machines]) {
      expect(r.outcome.status, r.engine).toBe('exited');
      expect(r.compared, r.engine).toBe(45);
    }
    // 304 statements, 709 IR steps, 410 to 715 instructions.
    const loop = crossCheck(LONG_LOOP, [100], backends, { maxSteps: 400 });
    expect(loop.reference).toMatchObject({ status: 'exited', returnValue: 4950, steps: 304 });
    expect(loop.ir!.outcome.steps).toBeGreaterThan(400);
    expect(Math.max(...loop.machines.map((m) => m.executed))).toBeGreaterThan(400);
    expect(loop.failures).toEqual([]);
    expect(loop.limitReached).toEqual([]);
    expect(crossCheckVerdict(loop)).toBe('agree');
  });

  it('does not stop an engine at the default limits when the reference evaluator completes', () => {
    // 3,000,004 statements, within the default limit of 5,000,000; 7,000,009 IR steps and 4,000,010 to 7,000,015 instructions.
    const run = inNode<{
      reference: object; engines: { engine: string; status: string; steps: number; compared: number }[]; failures: string[]; limitReached: string[]; verdict: string;
    }>(`(api) => {
      const cc = api.crossCheck(${JSON.stringify(LONG_LOOP)}, [1000000], api.availableBackends());
      return {
        reference: { status: cc.reference.status, returnValue: cc.reference.returnValue, steps: cc.reference.steps },
        engines: [cc.ir, ...cc.machines].map((r) => ({ engine: r.engine, status: r.outcome.status, steps: r.outcome.steps, compared: r.compared })),
        failures: cc.failures, limitReached: cc.limitReached, verdict: api.crossCheckVerdict(cc),
      };
    }`);
    expect(run.reference).toEqual({ status: 'exited', returnValue: 1783293664, steps: 3000004 });
    expect(run.engines.map((e) => e.engine)).toEqual(['ir', ...ids]);
    for (const e of run.engines) {
      expect(e.status, e.engine).toBe('exited');
      expect(e.compared, e.engine).toBe(3000004);
    }
    // The IR interpreter and MIPS need more steps of their own than the limit of the reference evaluator.
    for (const engine of ['ir', 'mips']) expect(run.engines.find((e) => e.engine === engine)!.steps, engine).toBeGreaterThan(5_000_000);
    expect(run.failures).toEqual([]);
    expect(run.limitReached).toEqual([]);
    expect(run.verdict).toBe('agree');
  });

  it('gives the IR interpreter and each simulator ten times the statement limit in their own unit', () => {
    const cc = crossCheck(FOREVER, [], backends, { maxSteps: 1000 });
    expect(cc.stepLimits).toEqual({ statements: 1000, irSteps: 10000, instructions: 10000 });
    expect(cc.reference).toMatchObject({ status: 'limit', limit: 'steps' });
    // The IR interpreter counts the step that exceeded its limit.
    expect(cc.ir!.outcome).toMatchObject({ status: 'limit', limit: 'steps' });
    expect(cc.ir!.outcome.steps).toBeGreaterThanOrEqual(10000);
    expect(cc.ir!.outcome.steps).toBeLessThanOrEqual(10001);
    for (const m of cc.machines) {
      expect(m.outcome, m.target).toMatchObject({ status: 'limit', limit: 'steps' });
      expect(m.executed, m.target).toBe(10000);
    }
    // Every engine passed the 1,000 boundaries of the reference evaluator and went on within its own limit.
    for (const r of [cc.ir!, ...cc.machines]) {
      expect(r.limitReached, r.engine).toBe(true);
      expect(r.compared, r.engine).toBe(1000);
      expect(r.boundaries, r.engine).toBeGreaterThan(1000);
    }
    expect(cc.failures).toEqual([]);
    expect(cc.limitReached).toEqual(['reference', 'ir', ...ids]);
    expect(crossCheckVerdict(cc)).toBe('incomplete');
  });

  it('executes no more than the default limits on a program that never ends', () => {
    // On RV32I, where one pass of this loop takes about 180 instructions.
    const run = inNode<{
      stepLimits: object; irCompared: number; irSteps: number; executed: number; failures: string[]; limitReached: string[]; verdict: string;
    }>(`(api) => {
      const cc = api.crossCheck(${JSON.stringify(FOREVER_MUL)}, [], [api.getBackend('riscv')]);
      return {
        stepLimits: cc.stepLimits, irCompared: cc.ir.compared, irSteps: cc.ir.outcome.steps, executed: cc.machines[0].executed,
        failures: cc.failures, limitReached: cc.limitReached, verdict: api.crossCheckVerdict(cc),
      };
    }`);
    expect(run.stepLimits).toEqual({ statements: 5_000_000, irSteps: 50_000_000, instructions: 50_000_000 });
    // The IR interpreter passed the 5,000,000 boundaries of the reference evaluator and counts the step that exceeded its limit.
    expect(run.irCompared).toBe(5_000_000);
    expect(run.irSteps).toBeGreaterThanOrEqual(50_000_000);
    expect(run.irSteps).toBeLessThanOrEqual(50_000_001);
    expect(run.executed).toBe(50_000_000);
    expect(run.failures).toEqual([]);
    expect(run.limitReached).toEqual(['reference', 'ir', 'riscv']);
    expect(run.verdict).toBe('incomplete');
  });

  it('does not derive a step limit from the number of boundaries', () => {
    // Two statements, of which the array fill takes several IR steps and instructions for each of 4,096 elements.
    const cc = crossCheck(FILL_LARGE, [7], backends);
    expect(cc.reference).toMatchObject({ status: 'exited', returnValue: 8, steps: 2 });
    expect(cc.ir!.outcome.steps).toBeGreaterThan(4096);
    for (const m of cc.machines) expect(m.executed, m.target).toBeGreaterThan(4096);
    expect(cc.failures).toEqual([]);
    expect(cc.limitReached).toEqual([]);
    expect(crossCheckVerdict(cc)).toBe('agree');

    // With a limit of 10 statements, which the reference evaluator meets, every other engine stops after 100 steps of its own.
    const limited = crossCheck(FILL_LARGE, [7], backends, { maxSteps: 10 });
    expect(limited.reference!.status).toBe('exited');
    for (const m of limited.machines) expect(m.executed, m.target).toBe(100);
    expect(limited.failures).toEqual([]);
    expect(limited.limitReached).toEqual(['ir', ...ids]);
    expect(crossCheckVerdict(limited)).toBe('incomplete');
  });

  it('reports a multiplication loop that only RV32I cannot finish within its limit as incomplete, not as a disagreement', () => {
    // 2,003 statements; RV32I needs about 187,000 instructions, the other targets fewer than 14,000.
    const cc = crossCheck(MUL_LOOP, [1000], backends, { maxSteps: 2100 });
    expect(cc.reference).toMatchObject({ status: 'exited', returnValue: -928224423 });
    expect(cc.ok).toBe(true);
    expect(cc.failures).toEqual([]);
    expect(cc.limitReached).toEqual(['riscv']);
    expect(crossCheckVerdict(cc)).toBe('incomplete');
    for (const r of [cc.ir!, ...cc.machines]) {
      expect(r.mismatch, r.engine).toBeNull();
      expect(r.compared, r.engine).toBe(r.boundaries);
      if (r.engine === 'riscv') {
        expect(r.outcome, r.engine).toMatchObject({ status: 'limit', limit: 'steps', steps: 21000 });
        expect(r.limitReached, r.engine).toBe(true);
        expect(r.compared, r.engine).toBeGreaterThan(100);
        expect(r.compared, r.engine).toBeLessThan(2003);
      } else {
        expect(r.outcome, r.engine).toMatchObject({ status: 'exited', returnValue: -928224423 });
        expect(r.limitReached, r.engine).toBe(false);
        expect(r.compared, r.engine).toBe(2003);
      }
    }

    // With ten times 20,000 instructions RV32I completes as well.
    const full = crossCheck(MUL_LOOP, [1000], backends, { maxSteps: 20000 });
    expect(full.machines.find((m) => m.target === 'riscv')!.executed).toBeGreaterThan(21000);
    expect(full.failures).toEqual([]);
    expect(full.limitReached).toEqual([]);
    expect(crossCheckVerdict(full)).toBe('agree');
  });

  it('reports an engine that runs to its own step limit without reaching a boundary as incomplete', () => {
    const summation = example('summation.py');
    const stuck = stuckAfter(getBackend('riscv'), summation, 50);
    // Whether the reference evaluator completes or stops at its limit after the boundary of the stall.
    for (const maxSteps of [1000, 100]) {
      const cc = crossCheck(summation, [100], [stuck], { maxSteps });
      expect(cc.machines[0]).toMatchObject({ limitReached: true, mismatch: null, boundaries: 50, compared: 50, executed: 10 * maxSteps });
      expect(cc.ok).toBe(true);
      expect(cc.failures).toEqual([]);
      expect(cc.limitReached).toEqual(maxSteps === 100 ? ['reference', 'riscv'] : ['riscv']);
      expect(crossCheckVerdict(cc)).toBe('incomplete');
    }

    // A simulator that never performs the exit service after the last boundary.
    const never = crossCheck(summation, [10], [noExit(getBackend('x86'))], { maxSteps: 1000 });
    expect(never.machines[0]).toMatchObject({ limitReached: true, mismatch: null, boundaries: 24, compared: 24, executed: 10000 });
    expect(never.failures).toEqual([]);
    expect(never.limitReached).toEqual(['x86']);
    expect(crossCheckVerdict(never)).toBe('incomplete');

    // An IR interpreter whose array fill loop never ends.
    irDefect.active = true;
    try {
      const cc = crossCheck(FILL, [9], backends, { maxSteps: 50 });
      expect(cc.reference!.status).toBe('exited');
      expect(cc.ir).toMatchObject({ limitReached: true, mismatch: null, boundaries: 1, compared: 1 });
      expect(cc.ir!.outcome).toMatchObject({ status: 'limit', limit: 'steps' });
      expect(cc.failures).toEqual([]);
      expect(cc.limitReached).toEqual(['ir']);
      expect(crossCheckVerdict(cc)).toBe('incomplete');
    } finally {
      irDefect.active = false;
    }
    expect(crossCheckVerdict(crossCheck(FILL, [9], backends, { maxSteps: 50 }))).toBe('agree');
  });

  it('reports a wrong state at a boundary that a run reached before it stopped at its limit', () => {
    // RV32I stops at its instruction limit after more than 200 boundaries; the other engines complete.
    for (const target of ['riscv', 'mips']) {
      const cc = withReadout(target, 100, oneMore('x'), () => crossCheck(MUL_LOOP, [1000], backends, { maxSteps: 2100 }));
      expect(cc.limitReached, target).toEqual(['riscv']);
      expect(cc.failures, target).toEqual([expect.stringMatching(new RegExp(`^${target}: boundary 100 \\(statement \\d+\\): variable x is -?\\d+, expected -?\\d+$`))]);
      expect(cc.ok, target).toBe(false);
      expect(crossCheckVerdict(cc), target).toBe('disagree');
    }
  });

  it('reports an engine that ended on its own before the boundary at which the reference evaluator stopped', () => {
    // The reference evaluator passes 1,000 boundaries and stops at the next one, boundary 1000 counted from zero.
    for (const [last, verdict] of [[499, 'disagree'], [999, 'disagree'], [1000, 'incomplete']] as const) {
      const cc = crossCheck(FOREVER, [], [faultAfter(getBackend('riscv'), FOREVER, last)], { maxSteps: 1000 });
      expect(cc.machines[0]!.outcome.status, `fault after boundary ${last}`).toBe('fault');
      expect(cc.machines[0]!.boundaries, `fault after boundary ${last}`).toBe(last + 1);
      expect(cc.failures, `fault after boundary ${last}`).toEqual(
        verdict === 'disagree' ? [`riscv: outcome "fault out=[]" after boundary ${last}, where the reference evaluator went on to boundary 1000`] : [],
      );
      expect(cc.limitReached, `fault after boundary ${last}`).toEqual(['reference', 'ir']);
      expect(crossCheckVerdict(cc), `fault after boundary ${last}`).toBe(verdict);
    }
  });

  it('accepts an engine that ends on its own after every boundary of a reference evaluator that stopped', () => {
    // The reference evaluator stops at its last statement; the other engines run to the end within their own limits.
    const cc = crossCheck(example('fibonacci.py'), [10], backends, { maxSteps: 44 });
    expect(cc.reference).toMatchObject({ status: 'limit', limit: 'steps' });
    for (const r of [cc.ir!, ...cc.machines]) {
      expect(r.outcome, r.engine).toMatchObject({ status: 'exited', returnValue: 55 });
      expect(r.boundaries, r.engine).toBe(45);
      expect(r.compared, r.engine).toBe(44);
      expect(r.limitReached, r.engine).toBe(false);
    }
    expect(cc.failures).toEqual([]);
    expect(cc.limitReached).toEqual(['reference']);
    expect(crossCheckVerdict(cc)).toBe('incomplete');
  });

  it('reports a boundary after the end of the reference evaluator on a run that then stops at its own limit', () => {
    const source = example('linear_search.py');
    const c = compileProgram(source, 'riscv');
    if (!c.ok) throw new Error('compile');
    // The exit service always jumps back into main, so the run never ends.
    const restarting = jumpAfterExit(getBackend('riscv'), c.compiled.program.boundaries.find((b) => b.stmts.length === 1)!.address, Infinity);
    const cc = crossCheck(source, [15], [restarting], { maxSteps: 1000 });
    expect(cc.reference!.status).toBe('exited');
    expect(cc.machines[0]!.outcome).toMatchObject({ status: 'limit', limit: 'steps', steps: 10000 });
    expect(cc.failures).toEqual(['riscv: boundary 12: the reference evaluator has no such boundary']);
    expect(cc.limitReached).toEqual(['riscv']);
    expect(crossCheckVerdict(cc)).toBe('disagree');
  });

  it('compares the outcome of a run that stops at the output limit', () => {
    const source = 'def main():\n    i = 0\n    while True:\n        print(i)\n        i += 1\n';
    const cc = crossCheck(source, [], backends, { maxOutput: 5 });
    expect(cc.failures).toEqual([]);
    expect(cc.limitReached).toEqual([]);
    expect(crossCheckVerdict(cc)).toBe('agree');
    for (const r of [cc.ir!, ...cc.machines]) expect(r.outcome, r.engine).toMatchObject({ status: 'limit', limit: 'output', output: [0, 1, 2, 3, 4] });
    const cmp = compareTargets(source, [], backends, { limits: { maxOutput: 5 } });
    expect(cmp.limitReached).toEqual([]);
    expect(comparisonVerdict(cmp)).toBe('agree');

    // Such a run has ended on its own, so a printed value that differs is a different outcome.
    const wrong = crossCheck(source, [], [printsOneMore(getBackend('riscv')), getBackend('mips')], { maxOutput: 5 });
    expect(wrong.machines.map((m) => m.outcome)).toMatchObject([
      { status: 'limit', limit: 'output', output: [1, 2, 3, 4, 5] }, { status: 'limit', limit: 'output', output: [0, 1, 2, 3, 4] },
    ]);
    expect(wrong.failures).toEqual(['riscv: printed value 0 is 1, expected 0']);
    expect(wrong.limitReached).toEqual([]);
    expect(crossCheckVerdict(wrong)).toBe('disagree');
    const differing = compareTargets(source, [], [getBackend('mips'), printsOneMore(getBackend('riscv')), getBackend('x86')], { limits: { maxOutput: 5 } });
    expect(differing.limitReached).toEqual([]);
    expect(differing.boundariesAgree).toBe(true);
    expect(differing.outcomesAgree).toBe(false);
    expect(comparisonVerdict(differing)).toBe('disagree');
  });
});

describe('arguments of main', () => {
  it('rejects a number of arguments that differs from the parameters', () => {
    expect(() => crossCheck(THREE, [5], backends)).toThrow(ArgumentCountError);
    expect(() => crossCheck(THREE, [5], backends)).toThrow('main takes 3 parameters (a, b, c), but 1 argument was given');
    expect(() => compareTargets(THREE, [5, 6, 7, 8, 9], backends)).toThrow('main takes 3 parameters (a, b, c), but 5 arguments were given');
    const c = compileProgram(THREE, 'riscv');
    if (!c.ok) throw new Error('compile');
    expect(() => simulate(c.compiled, 'riscv', { args: [5] })).toThrow(ArgumentCountError);
    expect(() => simulate(c.compiled, 'riscv')).toThrow('but 0 arguments were given');
    expect(() => traceProgram(c.compiled, 'riscv', { args: [5, 6] })).toThrow(ArgumentCountError);
    expect(() => compareTargets('def main():\n    return 1\n', [1], backends)).toThrow('main takes no parameters, but 1 argument was given');
    const run = simulate(c.compiled, 'riscv', { args: [5, 6, 7] });
    expect(run.outcome).toMatchObject({ status: 'exited', returnValue: 11, output: [7] });
    expect(crossCheck(THREE, [5, 6, 7], backends).ok).toBe(true);
  });

  it('reports the diagnostics of a program with errors whatever the number of arguments', () => {
    const source = 'def main(a):\n    return b\n';
    for (const result of [compareTargets(source, [], backends), crossCheck(source, [1, 2], backends)]) {
      expect(result.front.ok).toBe(false);
      expect(result.front.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('only sets the argument registers of a machine that is loaded from raw code', () => {
    const riscv = getBackend('riscv');
    const registers = riscv.profile.conventions.args;
    const assembled = encodeAssembly('riscv', 'addi a0, a0, 1\n');
    if (!assembled.ok) throw new Error('assemble');
    // Raw code has no parameter list, so any number of arguments is accepted and those without a register are not used.
    for (const args of [[], [41], [41, 7, 8, 9, 10, 11]]) {
      const m = machineFromBytes('riscv', assembled.program.bytes, { args });
      expect(registers.map((r) => m.cpu.reg32(r)), `${args.length} arguments`).toEqual(registers.map((_, k) => args[k] ?? 0));
      m.step();
      expect(m.cpu.reg32(registers[0]!), `${args.length} arguments`).toBe((args[0] ?? 0) + 1);
    }
  });
});

describe('code that does not fit a target', () => {
  it('is reported as an assembler diagnostic by compare and cross-check', () => {
    const source = oversized();
    for (const result of [compareTargets(source, [1, 2, 3, 4], backends), crossCheck(source, [1, 2, 3, 4], backends)]) {
      expect(result.front.ok).toBe(false);
      const d = result.front.diagnostics.find((x) => x.code === 'assembler');
      expect(d?.message).toMatch(/^x86: the program needs \d+ bytes of code; the code region holds 65536$/);
    }
  });
});

describe('command-line tool', () => {
  it('reads a source file that starts with a UTF-8 byte-order mark', () => {
    const bom = file('bom.py', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('def main():\n    print(7)\n    return 0\n')]));
    const check = cli('check', bom);
    expect(check.stdout).toBe('no errors\n');
    expect(check.status).toBe(0);
    const run = cli('run', bom, '-t', 'riscv');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).outcome).toMatchObject({ status: 'exited', returnValue: 0, output: [7] });
  });

  it('rejects step and trace limits that are not whole numbers in range', () => {
    const forever = file('forever.py', 'def main():\n    n = 0\n    while True:\n        n += 1\n');
    const fib = join(root, 'examples', 'fibonacci.py');
    for (const args of [['run', forever, '-t', 'riscv', '--max-steps', 'abc'], ['run', fib, '-t', 'riscv', '-a', '10', '--max-steps', '0'],
      ['trace', fib, '-t', 'riscv', '-a', '10', '--max-steps', '2.5'], ['trace', fib, '-t', 'riscv', '-a', '10', '--max-trace', 'abc'],
      ['trace', fib, '-t', 'riscv', '-a', '10', '--max-boundaries', '-5'], ['compare', fib, '-a', '10', '--max-steps', '']]) {
      const r = cli(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^error: option --max-\w+ needs a whole number of at least [01], not '/);
    }
  });

  it('keeps the boundary records asked for and marks the trace as truncated', () => {
    const out = join(work, 'trace.json');
    const r = cli('trace', join(root, 'examples', 'summation.py'), '-t', 'aarch64', '-a', '10', '--max-boundaries', '5', '-o', out);
    expect(r.status).toBe(0);
    const trace = JSON.parse(readFileSync(out, 'utf8'));
    expect(trace.boundaries).toHaveLength(5);
    expect(trace.metrics.boundaries).toBe(24);
    expect(trace.truncated).toBe(true);
  });

  it('gives compare the exit status of its verdict in table, JSON, and file form', () => {
    const fib = join(root, 'examples', 'fibonacci.py');
    const mul = file('mul.py', MUL_LOOP);
    const cases: [string[], string[], number, string][] = [
      [[], [fib, '-a', '10'], 0, 'agree'],
      // The riscv processor ends main with a return value one too large, so the targets disagree.
      [offByOne(), [fib, '-a', '10'], 1, 'disagree'],
      // RV32I cannot finish 100 multiplications within 2,000 instructions; the other targets can.
      [[], [mul, '-a', '100', '--max-steps', '2000'], 3, 'incomplete'],
    ];
    for (const [options, args, status, verdict] of cases) {
      const out = join(work, `compare-${verdict}.json`);
      const table = cliWith(options, 'compare', ...args);
      const json = cliWith(options, 'compare', ...args, '--json');
      const written = cliWith(options, 'compare', ...args, '-o', out);
      const doc = JSON.parse(json.stdout);
      expect(doc.verdict).toBe(verdict);
      expect(doc.outcomesAgree).toBe(verdict !== 'disagree');
      expect(doc.boundariesAgree).toBe(true);
      expect(doc.limitReached).toEqual(verdict === 'incomplete' ? ['riscv'] : []);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(doc);
      expect([table.status, json.status, written.status], verdict).toEqual([status, status, status]);
      expect(table.stdout.endsWith(`\nverdict: ${verdict}\n`), verdict).toBe(true);
    }
  });

  it('reports a multiplication loop that stops at the default instruction limit on RV32I only as incomplete', () => {
    const r = cli('compare', file('mul.py', MUL_LOOP), '-a', '120000');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/^riscv +limit limit=steps$/m);
    for (const id of ['mips', 'aarch64', 'x86']) expect(r.stdout).toMatch(new RegExp(`^${id} +exited ret=978488641 out=\\[\\]$`, 'm'));
    expect(r.stdout).toMatch(/^outcomes agree: true; 5000 boundaries compared, agree: true$/m);
    expect(r.stdout).toMatch(/^riscv stopped at the limit of 5000000 instructions after \d+ boundaries; it is compared on the boundaries it reached$/m);
    expect(r.stdout.endsWith('\nverdict: incomplete\n')).toBe(true);
  });

  it('counts as compared the boundaries that at least two targets reached', () => {
    const forever = file('forever.py', FOREVER);
    // Within 1,000 instructions the two targets reach different numbers of boundaries of a program that never ends.
    const cmp = compareTargets(FOREVER, [], [getBackend('riscv'), getBackend('mips')], { limits: { maxSteps: 1000 } });
    const [riscv, mips] = cmp.runs.map((r) => r.metrics.boundaries) as [number, number];
    expect(riscv).toBeGreaterThan(mips);
    expect(cmp.boundaries).toHaveLength(riscv);
    const r = cli('compare', forever, '--targets', 'riscv,mips', '--max-steps', '1000');
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(`\noutcomes not compared; ${mips} boundaries compared, agree: true\n`);
    expect(r.stdout).toContain(`\nriscv stopped at the limit of 1000 instructions after ${riscv} boundaries; it is compared on the boundaries it reached\n`);
    expect(r.stdout).toContain(`\nmips stopped at the limit of 1000 instructions after ${mips} boundaries; it is compared on the boundaries it reached\n`);
    const out = join(work, 'forever-batch.json');
    const manifest = file('forever-batch.manifest.json', JSON.stringify({ targets: ['riscv', 'mips'], programs: [{ file: 'forever.py' }] }));
    expect(cli('batch', manifest, '-o', out, '--max-steps', '1000').status).toBe(3);
    expect(JSON.parse(readFileSync(out, 'utf8')).results[0]).toMatchObject({ verdict: 'incomplete', boundaries: mips, limitReached: ['riscv', 'mips'] });
    // A single run has no other run to be compared with.
    const single = cli('compare', forever, '--targets', 'riscv', '--max-steps', '1000');
    expect(single.status).toBe(3);
    expect(single.stdout).toContain('\noutcomes not compared; 0 boundaries compared, agree: true\n');
  });

  it('reports the verdict of a cross-check and gives it as the exit status', () => {
    const fib = join(root, 'examples', 'fibonacci.py');
    const summation = join(root, 'examples', 'summation.py');
    // Statement limits that the reference evaluator meets; every other engine has ten times as many steps of its own.
    for (const args of [[fib, '-a', '10', '--max-steps', '100'], [file('long_loop.py', LONG_LOOP), '-a', '100', '--max-steps', '400'], [fib, '-a', '10']]) {
      const r = cli('crosscheck', ...args);
      expect(r.status, args.join(' ')).toBe(0);
      const lines = r.stdout.trimEnd().split('\n');
      expect(lines.map((line) => line.split(' ')[0]), args.join(' ')).toEqual(['reference', 'ir', ...ids, 'verdict:']);
      expect(lines.slice(1, -1).every((line) => line.endsWith('  agrees')), args.join(' ')).toBe(true);
      expect(lines.at(-1)).toBe('verdict: agree');
    }

    // The reference evaluator stops at its limit; the other engines agree on the boundaries it passed.
    const limited = cli('crosscheck', summation, '-a', '100', '--max-steps', '50');
    expect(limited.status).toBe(3);
    expect(limited.stdout).toContain('reference  limit limit=steps  stopped at its limit of 50 statements\n');
    expect(limited.stdout.match(/ {2}agrees on the 50 boundaries compared/g)).toHaveLength(1 + ids.length);
    expect(limited.stdout.endsWith('\nverdict: incomplete\n')).toBe(true);
    const one = cli('crosscheck', summation, '-a', '100', '--max-steps', '1');
    expect(one.status).toBe(3);
    expect(one.stdout).toContain('reference  limit limit=steps  stopped at its limit of 1 statement\n');
    expect(one.stdout.match(/ {2}agrees on the 1 boundary compared/g)).toHaveLength(1 + ids.length);
    expect(one.stdout).not.toContain('1 boundaries');

    // RV32I stops at its own limit of ten times 2,100 instructions; the reference evaluator and the other engines complete.
    const mul = cli('crosscheck', file('mul.py', MUL_LOOP), '-a', '1000', '--max-steps', '2100');
    expect(mul.status).toBe(3);
    expect(mul.stdout).toContain('reference  exited ret=-928224423 out=[]\n');
    expect(mul.stdout).toMatch(/^riscv +limit limit=steps {2}agrees on the \d+ boundaries compared; stopped at its limit of 21000 instructions$/m);
    for (const id of ['ir', 'mips', 'aarch64', 'x86']) expect(mul.stdout).toMatch(new RegExp(`^${id} +exited ret=-928224423 out=\\[\\] {2}agrees$`, 'm'));
    expect(mul.stdout.endsWith('\nverdict: incomplete\n')).toBe(true);

    // The riscv processor ends main with a return value one too large.
    const wrong = cliWith(offByOne(), 'crosscheck', fib, '-a', '10');
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toMatch(/^riscv +exited ret=56 out=\[55\] {2}outcome "exited ret=56 out=\[55\]" differs from the reference "exited ret=55 out=\[55\]"$/m);
    expect(wrong.stdout.endsWith('\nverdict: disagree\n')).toBe(true);
  });

  it('cross-checks a condition of 4,000 terms', () => {
    // Every term of the chain adds a block without a boundary marker to the IR.
    const chain = file('chain.py', `def main(n):\n    t = 0\n    if ${Array.from({ length: 4000 }, () => 'n>0').join(' and ')}:\n        t = 1\n    return t\n`);
    for (const [n, value] of [[5, 1], [0, 0]] as const) {
      const r = cli('crosscheck', chain, '-a', String(n));
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const lines = r.stdout.trimEnd().split('\n');
      expect(lines[0]).toBe(`reference  exited ret=${value} out=[]`);
      expect(lines.slice(1, -1).map((line) => line.replace(/^\w+ +/, ''))).toEqual(['ir', ...ids].map(() => `exited ret=${value} out=[]  agrees`));
      expect(lines.at(-1)).toBe('verdict: agree');
    }
  });

  it('reports a simulator that runs to its step limit without reaching a boundary as incomplete', () => {
    // After 40 instructions the riscv processor no longer advances.
    const frozen = riscvPreload('frozen.mjs', 'let n = 0;\n  cpu.step = (ev) => (n++ < 40 ? step(ev) : null);');
    const summation = join(root, 'examples', 'summation.py');
    const cc = cliWith(frozen, 'crosscheck', summation, '-a', '100', '--max-steps', '1000');
    expect(cc.status).toBe(3);
    expect(cc.stdout).toMatch(/^riscv +limit limit=steps {2}agrees on the \d+ boundaries compared; stopped at its limit of 10000 instructions$/m);
    expect(cc.stdout.endsWith('\nverdict: incomplete\n')).toBe(true);
    const cmp = cliWith(frozen, 'compare', summation, '-a', '100', '--max-steps', '10000');
    expect(cmp.status).toBe(3);
    expect(cmp.stdout).toMatch(/^riscv stopped at the limit of 10000 instructions after \d+ boundaries; it is compared on the boundaries it reached$/m);
    expect(cmp.stdout.endsWith('\nverdict: incomplete\n')).toBe(true);
  });

  it('rejects arguments that do not match the parameters of main', () => {
    const three = file('three.py', THREE);
    for (const args of [['run', three, '-t', 'riscv', '-a', '5'], ['trace', three, '-t', 'x86'], ['compare', three, '-a', '5,6,7,8'], ['crosscheck', three, '-a', '5']]) {
      const r = cli(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^error: main takes 3 parameters \(a, b, c\), but \d arguments? (was|were) given; give one value per parameter with -a\n$/);
    }
    expect(cli('crosscheck', three, '-a', '1,2,3').status).toBe(0);
    // An empty item is not taken for a missing value; empty text gives no arguments.
    const two = file('two.py', TWO);
    for (const list of ['5,,6', '5,6,', ',5,6']) {
      const r = cli('run', two, '-t', 'riscv', '-a', list);
      expect(r.status, list).toBe(2);
      expect(r.stderr, list).toBe("error: argument '' is not a 32-bit integer\n");
    }
    expect(JSON.parse(cli('run', two, '-t', 'riscv', '-a', '5,6').stdout).outcome.returnValue).toBe(-1);
    expect(cli('run', file('seven.py', SEVEN), '-t', 'riscv', '-a', '').status).toBe(0);
  });

  it('checks a batch manifest before running it', () => {
    file('three.py', THREE);
    const cases: [string, object, RegExp][] = [
      ['unknown-target.json', { targets: ['riscv', 'arm'], programs: [{ file: 'three.py', args: [[1, 2, 3]] }] }, /^error: unknown target 'arm'/],
      ['missing-args.json', { programs: [{ file: 'three.py' }] }, /program 1 \(three\.py\), arguments \[\]: main takes 3 parameters \(a, b, c\), but 0 arguments were given/],
      ['empty-args.json', { programs: [{ file: 'three.py', args: [] }] }, /program 1: 'args' must hold at least one argument list/],
      ['short-tuple.json', { programs: [{ name: 'three', file: 'three.py', args: [[1, 2, 3], [5]] }] }, /program 1 \(three\), arguments \[5\]: main takes 3 parameters/],
      ['bad-value.json', { programs: [{ file: 'three.py', args: [[1, 2, '3']] }] }, /argument "3" is not a 32-bit integer/],
      ['missing-file.json', { programs: [{ file: 'absent.py' }] }, /^error: cannot read /],
    ];
    for (const [name, manifest, message] of cases) {
      const out = join(work, `${name}.out`);
      const r = cli('batch', file(name, JSON.stringify(manifest)), '-o', out);
      expect(r.status, name).toBe(2);
      expect(r.stderr, name).toMatch(message);
      expect(existsSync(out), name).toBe(false);
    }
  });

  it('counts the verdicts of a batch and sets the exit status from them', () => {
    file('mul.py', MUL_LOOP);
    const fib = join(root, 'examples', 'fibonacci.py');
    const batch = (options: readonly string[], name: string, programs: object[], ...extra: string[]) => {
      const out = join(work, `${name}.out`);
      const r = cliWith(options, 'batch', file(name, JSON.stringify({ programs })), '-o', out, ...extra);
      return { status: r.status, doc: JSON.parse(readFileSync(out, 'utf8')) };
    };
    const mixed = [{ file: fib, args: [[10]] }, { file: 'mul.py', args: [[1000], [10]] }];

    const agree = batch([], 'agree.json', [{ file: fib, args: [[10], [20]] }]);
    expect(agree.status).toBe(0);
    expect(agree.doc.counts).toEqual({ agree: 2, disagree: 0, incomplete: 0, error: 0 });

    // With 20,000 instructions for each target, RV32I cannot finish 1,000 multiplications; the other targets can.
    const incomplete = batch([], 'incomplete.json', mixed, '--max-steps', '20000');
    expect(incomplete.status).toBe(3);
    expect(incomplete.doc.limits).toEqual({ maxSteps: 20000, maxOutput: 10000 });
    expect(incomplete.doc.counts).toEqual({ agree: 2, disagree: 0, incomplete: 1, error: 0 });
    expect(incomplete.doc.results.map((r: { verdict: string }) => r.verdict)).toEqual(['agree', 'incomplete', 'agree']);
    expect(incomplete.doc.results[1]).toMatchObject({ outcomesAgree: true, boundariesAgree: true, limitReached: ['riscv'] });
    expect(incomplete.doc.results[1].runs[0].outcome).toMatchObject({ status: 'limit', limit: 'steps', steps: 20000 });

    // A disagreement decides the exit status: the riscv processor ends main with a return value one too large.
    const disagree = batch(offByOne(), 'disagree.json', mixed, '--max-steps', '20000');
    expect(disagree.status).toBe(1);
    expect(disagree.doc.counts).toEqual({ agree: 0, disagree: 2, incomplete: 1, error: 0 });
    expect(disagree.doc.results.map((r: { verdict: string }) => r.verdict)).toEqual(['disagree', 'incomplete', 'disagree']);

    // Under the default limit of 5,000,000 instructions for each target.
    const trigger = batch([], 'default-limit.json', [{ file: 'mul.py', args: [[120000]] }]);
    expect(trigger.status).toBe(3);
    expect(trigger.doc.counts).toEqual({ agree: 0, disagree: 0, incomplete: 1, error: 0 });
    expect(trigger.doc.results[0]).toMatchObject({ verdict: 'incomplete', outcomesAgree: true, boundariesAgree: true, limitReached: ['riscv'] });
    expect(trigger.doc.results[0].runs.map((r: { outcome: { steps: number } }) => r.outcome.steps)[0]).toBe(5_000_000);
  });

  it('records a program whose code does not fit a target and keeps the other results', () => {
    file('three.py', THREE);
    file('big.py', oversized());
    const out = join(work, 'big-batch.json');
    const r = cli('batch', file('big.json', JSON.stringify({ programs: [{ file: 'three.py', args: [[1, 2, 3]] }, { file: 'big.py', args: [[1, 2, 3, 4]] }] })), '-o', out);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`wrote ${out}\n`);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.counts).toEqual({ agree: 1, disagree: 0, incomplete: 0, error: 1 });
    expect(doc.results[0]).toMatchObject({ program: 'three.py', verdict: 'agree', outcomesAgree: true, boundariesAgree: true });
    expect(doc.results[1].program).toBe('big.py');
    expect(doc.results[1].error[0]).toMatch(/^error \[assembler\] x86: the program needs \d+ bytes of code/);
  });

  it('reports a program whose code does not fit a target as a diagnostic of the compare and crosscheck commands', () => {
    const big = file('big.py', oversized());
    for (const command of ['compare', 'crosscheck']) {
      const r = cli(command, big, '-a', '1,2,3,4');
      expect(r.status, command).toBe(1);
      expect(r.stdout, command).toBe('');
      expect(r.stderr, command).toMatch(/^error \[assembler\] x86: the program needs \d+ bytes of code; the code region holds 65536\n$/);
    }
  });
});
