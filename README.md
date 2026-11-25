# ISA Trace Lab

ISA Trace Lab follows one program from source text to processor state. A small
program written with Python syntax and 32-bit integers is compiled through a
typed intermediate representation (IR) into real machine-code bytes for
documented subsets of four instruction sets, and the bytes are executed on
simulators that show registers, memory, output, and a datapath view. The same
program can be stepped on all four instruction sets side by side, aligned at
source statements. A separate view shows the genuine CPython bytecode of the
same text.

The software has two parts that share one implementation:

- a static web application (React, CodeMirror, Web Workers) that runs entirely
  in the browser and can be served from GitHub Pages; and
- a headless TypeScript core with a command-line tool, a documented API, and
  versioned JSON formats for programs, compiled code, and execution traces.

## What it covers

| Instruction set | Profile | Instructions | Instruction length |
| --- | --- | --- | --- |
| RISC-V | RV32I base integer instruction set except FENCE and EBREAK, without extensions | 38 instructions and 22 pseudoinstructions | 4 bytes |
| MIPS | MIPS32 Release 2 integer subset, little-endian, with architectural branch delay slots | 44 instructions and 8 pseudoinstructions | 4 bytes |
| Arm | AArch64 state, A64 integer subset | 38 instructions (32-bit and 64-bit forms) and 23 aliases | 4 bytes |
| x86 | x86-64 in 64-bit mode, general-purpose integer subset, Intel syntax | 58 instructions and 29 alternative spellings | 1 to 15 bytes |

Each profile is a subset of its architecture. The coverage tables in
[docs/coverage.md](docs/coverage.md) list every implemented instruction and how
it was checked; `node scripts/coverage-tables.ts` generates them from the
instruction catalogs and the results of the last validation run.

Two translation paths are kept separate:

- Path A, inspection: the source is compiled, not executed, by CPython 3.14 in
  the Pyodide runtime, and its bytecode is listed with the standard `dis` module.
- Path B, native compilation: the restricted source language
  ([docs/language.md](docs/language.md)) is compiled by this project's compiler
  to the IR and then to machine code. Path B does not use CPython bytecode, and
  the language is not Python: its integers wrap modulo 2^32 and arrays have a
  fixed length.

## Using the application

Build and serve it locally:

```
npm ci
npm run build
node scripts/serve.mjs --port 4173 --base /isa-trace-lab/
```

and open `http://localhost:4173/isa-trace-lab/`. For development with automatic
reloading, use `npm run dev`.

The application has these pages: an instruction-set explorer (architecture
overview, catalog with live encoding and a worked state change, the same
operation on each instruction set), the code workspace (source, bytecode, IR,
assembly and bytes, simulated machine), the cross-architecture comparison, an
assembler and decoder for hand-written assembly and raw bytes, and
self-checking exercises. Nothing is uploaded; see [docs/deployment.md](docs/deployment.md)
for network use and hosting.

## Using the core without the browser

Node.js 22.18 or later runs the TypeScript sources directly.

```
node src/cli/main.ts targets
node src/cli/main.ts compile examples/fibonacci.py -t riscv
node src/cli/main.ts run examples/fibonacci.py -t aarch64 -a 10
node src/cli/main.ts compare examples/array_traversal.py
node src/cli/main.ts trace examples/linear_search.py -t mips -a 23 -o trace.json
node src/cli/main.ts decode -t x86 "4f 69 84 f5 7f ff ff ff 78 56 34 12"
node src/cli/main.ts batch examples/batch/manifest.json -o results.json
```

`npm link` in the repository folder also installs the tool as the command
`isa-trace-lab` (for example `isa-trace-lab targets`). The command needs this
linked install; an install that copies the package into `node_modules` does
not run, because Node.js does not strip TypeScript types from files there.

`compare` runs a program on several targets and compares the runs at source
statements, `batch` does the same for a list of programs, and `crosscheck`
also compares the runs with the reference evaluator and the IR interpreter.
Every run has a step limit (`--max-steps`), so a comparison ends whatever the
program does, and it ends with one of three verdicts:

| Verdict | Meaning | Exit status |
| --- | --- | ---: |
| agree | No disagreement, and no run stopped at its step limit | 0 |
| disagree | The runs disagree | 1 |
| incomplete | No disagreement was found, and at least one run stopped at its step limit, so the rest of that run was not compared | 3 |

The exit status is also 1 when the program has errors and 2 for a usage or
configuration error. `batch` counts the disagreeing and the incomplete
comparisons separately in its result document; it exits with 1 when any
comparison disagrees, otherwise with 3 when any is incomplete, and otherwise
with 0.

The API and the JSON formats are described in [docs/api.md](docs/api.md); the
schemas are in [schemas/](schemas/).

## Testing and validation

```
npm run typecheck
npm test                  # unit and integration tests (Vitest)
npm run build
npm run test:browser      # browser tests on the production build (Playwright)
```

The browser tests run in the installed Google Chrome. Without Chrome, download
Playwright's own browser once with `npx playwright install chromium` and set the
environment variable `PW_CHANNEL` to `bundled`, as the continuous-integration
workflow does (`PW_CHANNEL=bundled npm run test:browser` in Bash,
`$env:PW_CHANNEL = 'bundled'; npm run test:browser` in PowerShell).

The independent validation compares encodings with the Clang integrated
assembler and LLD, decodings with Capstone, and execution with Unicorn, and
compares the reference evaluator, the IR interpreter, and the four simulators
on a corpus of example, edge-case, and generated programs. It needs Python 3.12
and the pinned packages of `validation/requirements.txt`:

```
python -m venv .venv
.venv/Scripts/python -m pip install -r validation/requirements.txt   # .venv/bin/python on Linux and macOS
node scripts/validate-all.mjs --per-family 200
```

Methods: [docs/validation.md](docs/validation.md). Results of the last full run,
generated from `validation/results/`: [docs/validation-results.md](docs/validation-results.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/core/` | Language front end, IR, back ends, assembler, simulators, traces, API |
| `src/core/target/<id>/` | One back end per instruction set; see [docs/backend-guide.md](docs/backend-guide.md) |
| `src/bytecode/` | Path A: CPython bytecode through Pyodide |
| `src/app/` | Browser application |
| `src/cli/` | Command-line tool |
| `examples/` | Example programs and the batch manifest |
| `schemas/` | JSON Schemas of the exported documents |
| `tests/` | Unit, integration, and browser tests |
| `validation/` | Independent validation harness, corpus of edge cases, results |
| `scripts/` | Build, validation, and reproduction scripts |
| `docs/` | Language specification and technical documentation |

## Scope and limitations

- The simulators are functional models of documented instruction subsets with
  an execution environment defined for this project (memory layout and three
  services). They are not models of any processor's timing or microarchitecture,
  and they do not run operating-system binaries.
- Instruction counts and code sizes describe this compiler's unoptimized output
  and say nothing about the speed of real processors.
- Validation results hold for the tested corpus and instruction sweeps; they are
  not a proof of correctness for all programs.
- Accessibility was checked with automated rules (axe-core, WCAG 2.1 A and AA)
  and keyboard tests; this is not a full accessibility audit.

## Licence and citation

MIT licence; see [LICENSE](LICENSE). The bundled Pyodide runtime and other
third-party components keep their own licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Citation metadata: [CITATION.cff](CITATION.cff).
