# Architecture

## Overview

```
                     Path A (inspection)
source text ──► CPython compile() in Pyodide ──► dis ──► bytecode listing

                     Path B (native compilation)
source text ──► lexer ──► parser ──► checker ──► IR builder ──► IR verifier
                                        │                          │
                                        ▼                          ▼
                              reference evaluator           IR interpreter
                                                                   │
                     ┌─────────────── lowering driver ◄───────────┘
                     ▼
        target instruction selection (RISC-V, MIPS, AArch64, x86-64)
                     │
                     ▼
        assembler driver (labels, relaxation) ──► target encoder ──► bytes + listing
                                                                       │
                                                                       ▼
                    machine: memory ◄── fetch ── processor model ── decoder
                             │                        │
                             ▼                        ▼
                     services (print, exit, error)   step events ──► views, traces
```

Everything in `src/core/` is plain TypeScript with no dependency on React, the
DOM, or Node.js. The browser application, the command-line tool, the tests, and
the validation exporter all use the same core.

## Front end

- `lang/lexer.ts` follows Python's lexical rules for logical lines, indentation,
  implicit and explicit line joining, comments, integer literals in four bases,
  and the operator set. Strings, floats, and imaginary literals are recognized
  so they can be reported as unsupported rather than as malformed.
- `lang/parser.ts` is a recursive-descent parser with Python's precedence. It
  builds nodes named like CPython's `ast` classes, with the same source ranges;
  the test `tests/syntax-cpython.test.ts` compares the two trees for every
  corpus program. Text that it reports with category `syntax` is rejected by
  CPython 3.14, so valid Python is never reported as a syntax error, and every
  program of the language is accepted. Category `unsupported` means that the
  parser recognized a construct outside the language. The remainder of that
  construct is not checked, so text reported as unsupported can also contain
  errors that CPython would report; [language.md](language.md) lists the
  constructs that are parsed completely before they are reported. Checks that
  CPython applies only when it compiles an expression are not applied inside
  the annotation of a local variable, which CPython does not compile.
- `lang/check.ts` enforces the language rules of [language.md](language.md):
  one entry function, static types, conservative definite assignment, array
  rules, and compile-time range checks.
- `lang/reference.ts` evaluates the checked tree with exact integers and
  explicit 32-bit wraparound. It defines the expected behaviour of every
  program.

## Intermediate representation

`ir/ir.ts` defines a function of basic blocks. Operations are `copy`, `un`,
`bin`, `cmp`, `load`, `store`, `print`, and the boundary marker `mark`;
terminators are `jump`, `br`, `ret`, and `trap`. Variables are mutable;
temporaries are defined once. Array range checks and shift-count checks are
explicit branches to trap blocks, so every back end implements the same checks.
Every operation records the syntax-tree node, the source range, and the
statement it belongs to. `ir/verify.ts` checks the structural invariants
(types, single definition and dominance of temporaries, reachability, block
references); `ir/interp.ts` executes the IR.

No optimization is applied. The only clean-up removes unreachable blocks and
redirects jumps through empty blocks.

## Back ends

Each instruction set has a back end in `src/core/target/<id>/` implementing the
interfaces of `target/types.ts`: a profile, an instruction catalog, an encoder,
a decoder, assembly text formatting and parsing, a processor model, and
instruction selection. The shared drivers are:

- `target/alloc.ts`: variables get one home each (register, then stack slot);
  temporaries get registers by linear scan over layout order.
- `target/lower.ts`: walks the IR, resolves operands, and calls the selection
  hooks; it records for every emitted instruction the IR operations it
  implements and the part of the image it belongs to (startup, main, error
  stub, helper).
- `target/assemble.ts`: resolves labels, relaxes branches that cannot reach
  their target, encodes, and builds the listing and the boundary table.
- `target/machine.ts`: loads code and data into a bounded memory, runs the
  processor model, performs the three services, fires statement boundaries,
  counts instructions per part of the image, and invalidates the provenance of
  instructions whose bytes are edited.

The processor models fetch instruction bytes from simulated memory and decode
them on every step; the listing is never consulted for execution. How to add a
back end is described in [backend-guide.md](backend-guide.md).

## Execution environment

The memory map is the same on every target: code at 0x00400000 (64 KiB,
read-only to programs), data at 0x10000000 (64 KiB), and stack below
0x7FFFF000 (64 KiB). Programs request three services with the target's trap
instruction: print a signed 32-bit value, exit with the return value of
`main`, and end with a runtime error code. These service numbers belong to this
environment and are not operating-system calls.

## Traces and comparison

`Machine.step` can fill a `StepEvent` with the fetched bytes, the decoded text,
register reads and writes, memory reads and writes with old and new values,
flags before and after, the arithmetic operands, the branch decision, and the
service request. These events drive the interface views and the trace export
(`trace/documents.ts`).

A boundary is the point just before a source statement executes. Every engine
(reference evaluator, IR interpreter, four simulators) produces the same
sequence of boundaries for a run. `trace/crosscheck.ts` compares the state at
every boundary across engines; `trace/compare.ts` aligns the four targets by
position in the boundary sequence, not by instruction count, and reports the
defined metrics.

Every engine has a step limit in its own unit, so the work of a comparison is
bounded whatever the program does: statements for the reference evaluator, IR
steps for the IR interpreter, and instructions for a simulator.
`compareTargets` applies `limits.maxSteps` (5,000,000 by default) to the
instructions of each target, exactly as a single run does. `crossCheck`
applies it to the statements of the reference evaluator and gives the IR
interpreter and each simulator ten times that value in their own unit. A run
that stops at its own step limit is neither a disagreement nor a full
agreement: it is listed in `limitReached` and compared on the boundaries it
reached.

`comparisonVerdict` (`trace/compare.ts`) and `crossCheckVerdict`
(`trace/crosscheck.ts`) reduce a result to one of three verdicts: `agree`
(no disagreement, and no run stopped at its step limit), `disagree`, and
`incomplete` (no disagreement found, and at least one run stopped at its step
limit). The command-line tool, its `batch` command, the comparison page of
the application, and the corpus script (`scripts/crosscheck-corpus.ts`) all
take the verdict from these two functions. The command-line tool exits with
status 0 for `agree`, 1 for `disagree` or a program with errors, 2 for a
usage or configuration error, and 3 for `incomplete`; the corpus script
counts a run as passed only when the verdict is `agree`. The limits and the
rules of the comparisons are given in full in [api.md](api.md).

## Browser application

`src/app/` uses React with CodeMirror for editing. All compilation and
simulation runs in a Web Worker (`app/engine/engine.worker.ts`); requests carry
identifiers, and results of superseded requests are discarded. Long runs
execute in slices of 200,000 instructions so that a pause request is handled
between slices; if a run does not stop within 1.5 s, or a comparison is
cancelled, the worker is terminated and recreated. Path A runs in its own worker
(`app/engine/pyodide.worker.ts`), which loads the Pyodide files only when the
bytecode view is opened.

Reverse stepping restores an earlier state by replaying the run from the start,
re-applying recorded edits at the instruction counts where they were made. It
is offered for runs of up to 20 million instructions.
