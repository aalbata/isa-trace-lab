# Headless API, command-line tool, and document formats

The core runs unchanged in Node.js, in browsers, and in Web Workers. In Node.js
22.18 or later the TypeScript sources run directly (type stripping), so a
script in a checkout of this repository can import the API by relative path.
Node.js does not strip types from files inside `node_modules`, so to use the
core as an installed dependency, compile or bundle it with a TypeScript-aware
tool.

## API

All functions are exported from `src/core/api.ts`.

| Function | Purpose |
| --- | --- |
| `compileProgram(source, target)` | Parse, check, build the IR, and compile for one target. Returns diagnostics, or the compiled program and its compiled-program document. |
| `simulate(compiled, target, { args, limits })` | Run a compiled program and return the outcome (status, output, return value or error), the metrics, and the final values of the source variables that were written and of the arrays whose definition has executed. `limits.maxSteps` counts executed instructions. |
| `traceProgram(compiled, target, { args, limits, maxTraceSteps, maxBoundaries })` | Run and record an execution-trace document. `limits.maxSteps` counts executed instructions. |
| `compareTargets(source, args, backends, { limits, maxBoundaries })` | Compile the same IR for several targets, run each, and align the runs at boundaries. `limits.maxSteps` counts the instructions that each target executes; see Step limits and verdicts. |
| `crossCheck(source, args, backends, limits)` | Compare the reference evaluator, the IR interpreter, and the simulators: the statement, every variable and array or that it is not yet assigned or defined, and the output length at every boundary, and the outcome. `limits.maxSteps` counts the statements that the reference evaluator executes; see Step limits and verdicts. |
| `comparisonVerdict(comparison)`, `crossCheckVerdict(result)` | Reduce the result of `compareTargets` or `crossCheck` to one verdict: `agree`, `disagree`, or `incomplete`. |
| `encodeAssembly(target, text)` | Assemble assembly text at the code base address. |
| `decodeBytes(target, bytes, address)` | Decode consecutive instructions, with bit or byte fields and the failure kind for undecodable bytes. |
| `machineFromBytes(target, code, { entry, args, limits })` | Load raw code bytes into a machine for step-by-step execution. |
| `availableBackends()`, `getBackend(id)` | The back ends; each exposes its profile, catalog, encoder, decoder, and processor model. |

Lower-level pieces (`check`, `parse`, `buildIR`, `verifyIR`, `interpretIR`,
`evaluateReference`, `Machine`, `assembleItems`, the document builders) are
exported as well.

The arguments of a run supply the parameters of `main`, one value per
parameter, as the language requires (section 1 of the language
specification). `simulate`, `traceProgram`, `recordTrace`, `compareTargets`,
`crossCheck`, `evaluateReference`, and `interpretIR` throw
`ArgumentCountError` when the number of arguments differs from the number of
parameters; no value is filled in or dropped. `loadCompiled`, a `Machine`
constructed with a compiled program, and a `Debugger` constructed with one
throw the same error.
`machineFromBytes` loads code without a source program, so its arguments only
set the argument registers.

`compareTargets` and `crossCheck` return a result whose `front.ok` is false,
with a diagnostic of code `assembler`, when the code of one of the targets does
not fit its memory layout.

### Step limits and verdicts

Every engine has a step limit in its own unit, so the work of a run or of a
comparison is bounded whatever the program does. The reference evaluator
counts executed statements, one at every statement boundary, the IR
interpreter counts IR operations and terminators, and a simulator counts
executed instructions.

- A single target run (`simulate`, `traceProgram`) and `compareTargets` apply
  `limits.maxSteps`, 5,000,000 by default, to the instructions that each
  target executes.
- `crossCheck` applies `limits.maxSteps`, 5,000,000 by default, to the
  statements that the reference evaluator executes. The IR interpreter and
  each simulator get ten times that value in IR steps and in instructions,
  50,000,000 by default. The result gives the three limits in `stepLimits`.

A program that never ends therefore costs at most these limits. With the
default values that is 5,000,000 instructions on each target in
`compareTargets`, and 5,000,000 statements, 50,000,000 IR steps, and
50,000,000 instructions on each target in `crossCheck`. A smaller `maxSteps`
shortens such runs.

The engines need different numbers of steps for the same program. RV32I, for
example, has no multiply instruction and runs a helper routine for every
multiplication, so one run can stop at its step limit where another
completes. A run that stops at its own step limit is listed in `limitReached`
and compared on the boundaries it reached. The stop is not a disagreement,
and it is not an agreement either, because the rest of that run was not
compared. These are the disagreements:

- a different statement or state at a boundary that both runs reached;
- different outcomes of two runs that both ended on their own, that is, not
  at their step limit;
- a run that ended on its own after fewer boundaries than another run passed;
- in `crossCheck`, an engine that ended on its own before the boundary at
  which the reference evaluator stopped at its step limit.

`crossCheck` compares each engine with the reference evaluator, so what the
other engines do after the boundary at which the reference evaluator stopped
at its limit is not compared.

`comparisonVerdict` and `crossCheckVerdict` reduce a result to one of three
verdicts.

| Verdict | Meaning |
| --- | --- |
| `agree` | No disagreement, and no run stopped at its step limit. |
| `disagree` | At least one disagreement. |
| `incomplete` | No disagreement was found, and at least one run stopped at its step limit, so part of that run was not compared. A larger `maxSteps` can complete the comparison. |

In the result of `compareTargets`, `limitReached` lists the targets that
stopped at the instruction limit, `outcomesAgree` is false when two runs that
ended on their own ended differently, and `boundariesAgree` is false when a
kept boundary differs or when a run that ended on its own fired fewer
boundaries than another run. In the result of `crossCheck`, `limitReached`
lists `"reference"`, `"ir"`, or target identifiers, `ok` is false when an
engine disagrees with the reference evaluator, `failures` describes each
disagreement, and `compared` gives, for each engine, the number of boundaries
at which it was compared with the reference evaluator and agreed.

The output limit counts printed values on every engine, so a run that stops
there has ended on its own and is compared like any other, with the values it
printed.

Example, run from the repository root as `node example.ts`:

```ts
import { availableBackends, compareTargets, comparisonVerdict, compileProgram, simulate, traceProgram } from './src/core/api.ts';

const source = `def main(n):
    total = 0
    for i in range(1, n + 1):
        total += i
    return total
`;

const compiled = compileProgram(source, 'riscv');
if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join('\n'));

const run = simulate(compiled.compiled, 'riscv', { args: [10] });
console.log(run.outcome.returnValue, run.metrics.executedInstructions);

const trace = traceProgram(compiled.compiled, 'riscv', { args: [10] });
console.log(trace.steps.length, trace.boundaries.length);

const comparison = compareTargets(source, [10], availableBackends());
console.log(comparisonVerdict(comparison),
  comparison.runs.map((r) => `${r.target}: ${r.metrics.executedInstructions}`));
```

## Metrics

| Metric | Definition |
| --- | --- |
| `staticInstructions` | Instructions in the program image (startup stub, `main`, runtime error stubs, runtime helpers); also given per part. |
| `codeBytes` | Size of the encoded image in bytes; also per part. |
| `executedInstructions` | Instructions executed in the run, counted when fetched; also per part of the image. |
| `dataLoads`, `dataStores` | Executed loads and stores on the data and stack regions, including the stack accesses of calls and returns (for example the return address that x86-64 `call` pushes and `ret` pops, or a saved link register); instruction fetches are not counted. |
| `registersWritten` | Registers written at least once, by the loader's argument setup or by an executed instruction. |
| `boundaries` | Statement boundaries that fired. |

Runtime helpers, such as the shift-and-add multiplication routine of RV32I,
are counted in the totals and reported separately.

## Command-line tool

`node src/cli/main.ts <command>`; `node src/cli/main.ts help` lists the
commands: `targets`, `check`, `ir`, `compile`, `run`, `trace`, `compare`,
`crosscheck`, `encode`, `decode`, and `batch`.

- `-a` gives the arguments of `main` as comma-separated integers, one per
  parameter; empty text gives none. An empty item or a different number of
  arguments is a configuration error.
- `--max-steps` sets the step limit (see Step limits and verdicts): the
  instructions that each target executes for `run`, `trace`, `compare`, and
  `batch`; the statements that the reference evaluator executes for
  `crosscheck`, which gives the IR interpreter and each simulator ten times
  the value. `--max-trace` and `--max-boundaries` set the number of
  instruction records and of boundary records that a trace keeps. Each takes a
  whole number (at least 1 for `--max-steps`, at least 0 for the others).
- Source files are read as UTF-8; a byte-order mark at the start of a file is
  ignored, as CPython does.
- The exit status is 0 on success, 1 when the program has errors (including
  code that does not fit a target) or the runs disagree, 2 for a usage or
  configuration error, and 3 when a comparison (`compare`, `crosscheck`,
  `batch`) found no disagreement but is incomplete because a run stopped at
  its step limit. `compare` and `crosscheck` name each run that stopped at its
  limit and print the verdict as the last line. `compare` sets the same status
  with `--json` or `-o` as in table form, and its JSON output holds the
  verdict as `verdict`.

`batch` takes a manifest of programs, argument tuples, and targets and writes
one result document; see `examples/batch/manifest.json`. Each program entry has
a `file` (relative to the manifest), an optional `name`, and `args`, a list of
argument tuples; an entry without `args` stands for one run with no arguments,
for a `main` without parameters. The manifest is checked before any program
runs, and the command stops with status 2 at an unreadable file, an unknown
target, an empty `args` list, or an argument tuple that is not a list of 32-bit
integers with one value per parameter of `main`. A program with diagnostics, or whose code does
not fit a target, is recorded in the result document with its diagnostics.
The result document holds the verdict of each comparison and, in `counts`,
the numbers of comparisons that agree, disagree, and are incomplete and the
number of entries that could not be run. The exit status is 1 when a
comparison disagrees or an entry could not be run, otherwise 3 when a
comparison is incomplete, and otherwise 0.

## Documents

The documents below are JSON with a `schema` name and a `schemaVersion`; the
schemas are in `schemas/` (JSON Schema 2020-12). The other JSON output of the
command-line tool (`run`, `compare --json`, `encode -o`, `decode --json`) is
plain command output without a schema.

| Schema | Contents |
| --- | --- |
| `source-program` | Source text and the arguments of `main` |
| `target-configuration` | Target, ISA description, memory layout, optimization policy, run limits |
| `compiled-program` | Code and data bytes with SHA-256, entry point, symbols, listing with pseudoinstruction notes, IR operations with source ranges, statements, boundary addresses, variable homes, arrays |
| `execution-trace` | Software version, configuration, program hashes, arguments, outcome, metrics, one record per executed instruction (bytes, text, register and memory writes, flags, branch decision, service, boundaries, fault), the boundary sequence with variable values, final contents of the arrays whose definition has executed |
| `batch-result` | Software version (`tool`, `version`), targets, instruction and output limits, the numbers of comparisons with each verdict and of entries that could not be run, and for each program and argument tuple either the verdict, the agreement of outcomes and boundaries, the number of boundaries compared, the targets that stopped at the instruction limit, and the outcome and metrics of each target, or the diagnostics that prevented the run |

Register and memory values are hexadecimal strings (`0x...`), so 64-bit values
are exact. Code addresses are integers; a negative address denotes an address
below zero of the 64-bit x86-64 address space (2^64 plus the value), which only
edited or hand-written code can reach. An AArch64 branch record whose target
has nonzero upper 32 bits (a `br`, `blr`, or `ret` to such a register value, or
a branch below address zero) also carries `target64`, the full address as a
hexadecimal string of sixteen digits; `target` then holds its low 32 bits. An
instruction record has no field for the address of the next instruction: within
32 bits that address is the `pc` of the following record. After a taken branch
it is the target, except on MIPS, where the following record is the
delay-slot instruction at `pc` + 4 and the target is the `pc` of the record after
it. For an address above 32 bits the `pc` of the following record holds only
the low 32 bits, so `target64` is where such an address appears in full.

Traces keep at most a configurable number of instruction records and of
boundary records (100,000 of each by default) and set `truncated` when the run
produced more of either; the counts in `metrics` (`executedInstructions`,
`boundaries`) are always complete.

Relations between the levels are many-to-many and are stored explicitly: each
instruction lists the IR operations it implements, and each IR operation has
its source range and statement. Runtime support code has no IR operations and
no source line.
