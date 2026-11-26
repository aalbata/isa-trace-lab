# Validation methods

This document describes how the software is checked. The numbers of the last
full run are generated into [validation-results.md](validation-results.md) from
the JSON files in `validation/results/`.

## 1. What is checked and against what

| Layer | Question | Independent reference |
| --- | --- | --- |
| Parser | Does the front end build the same syntax tree as CPython, including the source range of every node? | CPython 3.14 `ast` in Pyodide (`tests/syntax-cpython.test.ts`) |
| Language semantics | Does the TypeScript reference evaluator implement the specification? | A separate Python evaluator written from the specification (`validation/reference_eval.py`); CPython itself for runs whose values stay in the 32-bit range |
| IR and back ends | Do the IR interpreter and the four simulators, executing the encoded bytes, agree with the reference evaluator at every statement boundary? | The reference evaluator (internal agreement across independently structured engines) |
| Encoding | Are the bytes the ones a production assembler produces? | Clang 20 integrated assembler and LLD (`ziglang` 0.15.2) |
| Decoding | Does the decoder accept valid encodings, reject the others, and name instructions correctly? | Clang (reassembly) and Capstone 5.0.9 |
| Instruction semantics | Does each implemented instruction change registers, flags, memory, and the program counter as the architecture defines? | Unicorn 2.1.4 |
| Program execution | Do compiled programs behave identically in an independent emulator? | Unicorn 2.1.4 |
| Interface | Do the pages work on the production build served from a repository path? | Playwright 1.65.1 with Google Chrome 158; axe-core 4.14.1 rules tagged WCAG 2.1 A and AA |

No reference is the implementation under test. The reference evaluator and the
IR interpreter are both part of this project, so their agreement is reported as
internal agreement; the independent references are CPython, the Python
evaluator, Clang, Capstone, and Unicorn.

## 2. Corpus

`scripts/lib/corpus.ts` builds the corpus from three groups:

- the 14 runnable example programs of `examples/` with the argument tuples of
  `examples/index.json`;
- 17 hand-designed edge cases in `validation/corpus/edge/` (register pressure,
  deep expressions, large arrays, every shift count, `range` at the 32-bit
  limits, short-circuit evaluation, evaluation order, wide constants,
  multiplication at the limits, Boolean values, nested loops, element updates,
  implicit return, every comparison operator, four parameters, constant
  conditions);
- generated programs from `src/core/gen/programs.ts` in five families
  (expressions, branches, loops, arrays, mixed), 200 per family in the full run.
  A generated program with parameters has three argument tuples drawn from
  boundary and random values; a program without parameters has one, empty,
  tuple, since every run of it would be the same.

A run is one program with one of its argument tuples. Every stage that runs
programs runs every argument tuple of every program.

The cross-engine agreement (`scripts/crosscheck-corpus.ts`) counts a run as
passed only when no engine disagrees and no engine stops at its step limit. A
run without a disagreement in which an engine stopped at its step limit is
incomplete: it was compared only on the boundaries reached, so it is counted on
its own, never as passed, and the script fails when there is one, as it does
for a disagreement. The boundaries reported as compared are those at which an
engine was compared with the reference evaluator.

The generator is deterministic: program k of a family uses the initialization
value 1000 + k of a recorded pseudo-random generator (xoshiro128**), so the
corpus is reproduced exactly from the generator version and the settings in
`CORPUS_SETTINGS`. Generated programs always pass the semantic checker and
terminate; some reach a runtime error on purpose through an unchecked array
index or shift count.

## 3. Stages of the reference-tool comparison

`node scripts/export-validation.ts` writes, for each target, the inputs of the
harness together with this tool's own results; `validation/run_validation.py`
recomputes them with the reference tools and compares.

Encoding. Instruction sweeps (`src/core/target/<id>/validation.ts`) use every
implemented instruction with boundary operands: the extreme and middle values
of every immediate field, both directions and the extreme reach of branches,
and the registers stated in the next paragraph. Sweeps and every compiled
corpus program are printed as reference assembly text, assembled by Clang,
linked by LLD at the code base address, and the `.text` bytes must equal this
tool's bytes. In this text, an instruction that is the whole expansion of the
pseudoinstruction `b`, `beqz`, or `bnez` is printed as that pseudoinstruction
with a label as its target, so Clang chooses the expansion, and the bytes of a
compiled program agree only when this tool expands the pseudoinstruction as
Clang does. A pseudoinstruction sweep whose bytes differ is compared line by
line. Clang assembles each line of its text on its own, placed at the address
that the line has in this tool's program, so that an encoding that depends on
its address is the one for that address. Clang's bytes of the whole text must
be its bytes of these lines in source order, so a directive that changes how
Clang reads the lines after it is reported. An expansion that differs from
Clang's choice is accepted only when both straight-line sequences, run in
Unicorn at the address of the line, run to their end and leave every register,
every flag, and every byte of the data region, the stack region, and the code
region outside the two sequences equal from each of several initial states. In
these states the registers hold zero, one, all ones, or the most negative or
most positive value of their width or of 32 bits, either all the same value or
two different values chosen by the bits of each register's position in the
register list, so that in some state any two registers hold any two of these
values; in the remaining states they hold pseudo-random values. Before each run
the three regions hold the address-dependent bytes that the instruction-level
cases use, described below. The program's bytes must then equal Clang's bytes
of its lines in source order, with this tool's expansion in place of Clang's
for each accepted line, so a line that this tool drops, emits out of order, or
extends with other instructions is reported. Instruction counts, and the counts
for each mnemonic, leave out data directives, such as the padding that places
branch targets.

Registers in the sweeps. `tests/validation-sweeps.test.ts` computes the
registers of every operand from the sweeps and asserts each statement of this
paragraph. The statements concern the sweeps of the instructions themselves,
not the programs of pseudoinstructions and aliases, whose operands are chosen
line by line. On RISC-V and MIPS, every one of the 32 registers appears in
every register operand of every instruction, the base register of a memory
operand included. On AArch64, every register number from 0 to 31 appears in
every register operand of every instruction at each operand width, the base
register of a load or store included; number 31 is the zero register or the
stack pointer as the instruction defines. The one exception is the index
register of the register-offset loads and stores, which takes 16 of the
register numbers as a W register (extended with uxtw or sxtw) and the other 16
as an X register (with lsl or sxtx), so every register number appears in it at
one of the two widths. On x86-64, every register appears in every register
operand of every instruction at each operand width, the 20 byte registers of
`movzx` included, with two exceptions: the count register of a shift is always
cl, and each SETcc condition is used with 7 of the byte registers, the 16
conditions together with all 20. Every register appears as the base, and every
register except rsp, which cannot be an index, as the index, of the memory
operand of every memory form that has neither a 64-bit memory operand nor an
immediate and is neither a shift nor SETcc. These forms are `lea` at both
destination widths, `movzx`, `movsxd`, and the forms with a 32-bit memory
operand of `mov`, the arithmetic and logic instructions, `test`, two-operand
`imul`, `neg`, `not`, `inc`, and `dec`. Every other memory form, the
three-operand `imul` among them, takes its memory operand from a sample of the
same address expressions and uses fewer base registers, fewer index registers,
or both.

Decoding. For the fixed-length targets, 100,000 random 32-bit words are
decoded; for x86-64, 100,000 random 15-byte strings. Every accepted encoding is
reassembled by Clang from the decoded text and must give the same bytes, or
bytes that Capstone disassembles to the same instruction; Capstone must also
name the same instruction (preferred aliases and documented spelling
differences are mapped). On x86-64, Clang encodes a relative branch or call of
the reassembled text for the address it has there, which differs from the
original address when earlier instructions changed length; such a line is
assembled again at its original address and counts as identical when Clang
then gives the original bytes. Every rejection is classified as invalid,
unsupported (an encoding in an instruction, an instruction class, or an
extension outside the implemented subset), or truncated. Each decoder states in
its header where it examines whether a word outside the subset is an assigned
encoding; there it reports an unassigned word as invalid. Elsewhere it reports
every word of a group as unsupported, so a reserved word of such a group is
reported as unsupported too. On AArch64 these groups are SVE, SME, scalar
floating point and Advanced SIMD, and the instruction classes without an
implemented instruction outside the branch, exception generation, and System
group. On RISC-V they are the AMO, OP-32, OP-IMM-32, and floating-point
computational major opcodes and the SYSTEM encodings with funct3 000. A
rejection as invalid fails the check when Capstone decodes the bytes as an
implemented instruction, unless the target entry documents why the encoding is
reserved; the implemented instructions are the names Capstone gives to the
encodings that this tool's encoder produced for the sweeps, so they do not
depend on the decoder under test. For every rejected encoding that Capstone
decodes, this tool's own assembler is given Capstone's text (on RISC-V with the
branch offset replaced by the target address, since this tool's syntax takes
an absolute target), in the long form and, for a jump that has one, in the
short form that a label target would select; if it produces the same bytes,
the decoder rejected an encoding the encoder produces, which fails the check.
A rejection as unsupported that Capstone does not decode can be checked in
neither way. These rejections are counted, and the results give their number.
Capstone 5.0.9 lacks recent extensions, so such a rejection is not a failure in
itself. A target entry can state which of these encodings are defined, each
with its reason (`defined_without_capstone`); the rejections are then counted
for each reason, and one for which the entry gives no reason fails the check.
`validation/harness_controls.py` gives this check implemented instructions of
every target, branches and jumps included, which it must reproduce, and valid
branch encodings presented as rejections, which the decoding stage must report.

Instruction execution. Each sweep instruction, the service instruction
included, is executed from four random initial states (boundary and random
register values, memory operands steered into the data region, random flags)
in this tool and in Unicorn. Before the instruction, both sides fill the whole
64 KiB data region and the whole 64 KiB stack region: the byte at address a is
(a + 37 * (a >> 8) + 101 * (a >> 16)) mod 256, combined by exclusive or with
the low byte of the number of the case. The byte depends on every bit of the
address that varies within a region, and two addresses of a region whose
distance is a power of two hold different bytes in every case
(`validation/harness_controls.py` compares every such pair). A load whose
address is wrong by a power of two, as one wrong bit of an offset makes it,
therefore reads a different first byte and gives a different value. Addresses
at other distances can hold the same byte, since each block of 256 addresses
holds every byte value once. In two of the four states the word at the initial
stack pointer holds an address in the code region, so that a return reaches
mapped code. All registers, the flags that the architecture defines for the
instruction, the full-width program counter, and every byte of the data and
stack regions must match, which covers every byte that either side writes. The
address of a load into the zero register (`wzr` or `xzr` on AArch64, `zero` on
RISC-V, `$zero` on MIPS) is not observable in this stage, because the loaded
value is discarded; the operand fields of such an instruction are covered by
the encoding and decoding stages. The flags that x86-64 leaves undefined after
a shift by cl depend on the count, as after a shift by an immediate; the export
takes the count from cl as it is before the instruction, so the overflow flag
is compared after a shift by one and every flag after a shift by zero. When
both fault, the case passes. MIPS
branches and jumps are compared after their delay-slot instruction. A case that
the target entry excludes is left out of the comparison, unless the entry
states which comparisons the reason affects (`partial_exclusions`); such a case
is run, compared in every other respect, and counted among the compared cases
and, separately, as partially compared (section 4). Unicorn
reports the service instruction as an interrupt, or calls
an instruction hook in place of it (section 4). In every case a hook completes
the instruction and lets the emulation continue at the next instruction, so the
comparison covers the instruction's effect on the processor: this tool's
expectation is the processor state after the instruction, before the machine
performs the requested service, which stops the machine when the random service
number is not one of the three provided. A service instruction on which this
tool faults, or whose register effects it omits, therefore differs from the
reference.

Program execution. Each compiled corpus program runs in Unicorn with every
argument tuple of the corpus, the same memory layout, and the same service
conventions (hooked through the emulator's interrupt or instruction hooks).
Output, return value or error code, the number of executed instructions, the
final data region, and the registers that hold source variables must match.

The controls in `validation/harness_controls.py` run before the comparison. Each
gives a stage an input with a known outcome: a case it must pass, or a
deliberately wrong expectation it must report, such as a wrong stack store, a
pop from the wrong address, a load within or beyond the first 4 KiB of the data
region that reads the bytes at each of 15 distances further on (the powers of
two from 1 byte to 16 KiB), a branch target with a wrong upper half, wrong
SYSCALL results, a service instruction on which this tool faults, a partially
compared MIPS jump whose link register holds the address of the delay slot,
whose delay-slot result is missing, or whose program counter is wrong in a
compared bit, a wrong overflow flag after an x86-64 shift by cl with a count of
one, a rejection as unsupported that Capstone does not decode and that the
target entry does not state to be defined, a
pseudoinstruction expansion that differs only for negative or zero inputs,
reads another register, also stores to memory, never reaches its end, or is
right only at another address than that of its line, a pseudoinstruction
program with a dropped,
moved, or added instruction or with a directive that changes how Clang reads
the lines after it, or a wrong expectation in every second run of each program
group and outcome, the runs that end with a runtime error included, which the
program stage must report run by run while it passes the others. Other
controls check the pipeline itself: the fill of the data and stack regions must
give different bytes to any two addresses a power of two apart; the export must
hold every hand-written argument tuple and, for every generated program, the
number of tuples that the exporter was asked for; the export must spell the
branch pseudoinstructions of the compiled MIPS programs as written and mark the
undefined flags of every x86-64 shift by cl by the count before the
instruction; the cross-engine script, given a statement limit that some runs
exceed, must count those runs as incomplete and fail; a new `targets_<id>.py` must
be registered; a target without a reference-tool entry or a missing work folder
must stop the comparison; and the source manifest, the stages, and the summary
must follow the rules of section 5.

## 4. Exclusions and documented differences

Every exclusion is reported in the results with its reason and the number of
cases excluded for that reason, and every reason for which cases are compared
only in part with the number of those cases. The current ones are:

- MIPS: no case is left out. `jr` and `jalr` to an address with bit 0 set are
  compared with Unicorn except for bit 0 of the program counter, which Unicorn
  2.1.4 clears as an instruction-set mode bit. `jr` and `jalr` to an address
  in the kernel segments 0xC0000000 to 0xFFFFFFFF are compared except for the
  program counter: Unicorn translates these addresses through its model of the
  memory-management unit: for such a target it raises interrupt 26 and then
  reports `UC_ERR_READ_UNMAPPED`, and the harness takes both as the failed fetch
  of the target when this tool reports no fault. `jr` and `jalr` to an address
  below 0xC0000000 with bit 1 set and bit 0 clear are compared except for the
  program counter: the Address Error exception belongs to the fetch of the
  target, and the Linux build of Unicorn 2.1.4 reports that fetch as
  `UC_ERR_READ_UNALIGNED` before the jump completes, which the harness takes as
  the failed fetch of the target when this tool reports no fault; the Windows
  build completes the jump. A target in the kernel segments counts under the
  second reason whether or not bit 0 or bit 1 is set, and a target with bit 0
  set counts under the first. In all three groups the registers, the link
  register and the result of the delay-slot instruction among them, and memory
  are compared. A word whose SPECIAL or SPECIAL2
  function code is marked as a MIPS64 code in Tables A.3 and A.5 of the MIPS32
  manual (MD00086) is rejected as unsupported by that code alone, like a word
  with a MIPS64 opcode; the manual gives no field layout for these
  instructions, so the other fields of the word are not examined.
- RISC-V: Capstone 5.0.9 decodes shift-immediate encodings with bit 25 set in
  RV32 mode; the RV32I specification reserves them, and this tool rejects them.
  Capstone prints the target of a branch or `jal` as an offset from the
  instruction; the re-encoding check replaces it by the target address.
  Unicorn 2.1.4 performs misaligned halfword and word accesses and accepts a
  `jalr` target that is 2 modulo 4, while this profile faults on both by its
  documented choice. The sweep lines of loads, stores, and `jalr` whose offset
  would make the access misaligned or the target 2 modulo 4 therefore use the
  base register `zero`: the address then lies outside every memory region, and
  both sides fault. The encoding stage compares these lines with Clang, and the
  lines with the other offsets are executed against Unicorn. Among the vector
  encodings, the decoder reports as invalid those that the manual reserves by
  their register numbers under every vtype setting (Sections 31.5.2 and 31.5.3
  and the sections on single instructions); a reservation that depends on the
  vtype setting cannot be decided from the word, and such words are reported
  as unsupported, as every vector instruction is.
- AArch64: logical-immediate encodings with `immr` bits above the element size
  are valid and decode to the same immediate; Clang re-encodes them canonically.
  Capstone prints `mov` for ORR (immediate) with the zero register even where
  the Arm manual's preferred disassembly is `orr`; the comparison maps the two.
- x86-64: Capstone writes the no-index case of a SIB byte as a pseudo-register
  `riz`; the term is removed before texts are compared. Jump targets below
  address zero are represented as negative numbers and printed as 64-bit
  addresses. Unicorn 2.1.4 calls the instruction hook in place of SYSCALL and
  does not perform its writes to RCX and R11; the hook, installed in every
  single-instruction case and every program run, performs them as the
  Intel SDM (Vol. 2B, SYSCALL) defines them, from Unicorn's own state: RCX
  receives the address of the next instruction (the hook's program counter plus
  the length Capstone decodes there) and R11 receives RFLAGS. The decoder
  treats the VEX map 7 encodings of RDMSR, URDMSR, UWRMSR, and WRMSRNS with a
  32-bit immediate as defined, as their instruction pages do (Intel SDM,
  Vol. 2B and 2D), although Vol. 2A, Table 2-10, lists the VEX opcode maps 4
  to 31 as reserved; Capstone 5.0.9 does not decode them. Capstone decodes
  some encodings that the opcode columns of the instruction pages exclude, and
  the decoder reports them as invalid: an SSE opcode with a 66, F2, or F3
  prefix that its page does not list (for example `f3 48 0f 28`, which
  Capstone prints as `movaps`); SHA, MOVDIRI, CLAC, STAC, PCONFIG, RDPKRU, and
  FXSAVE with a prefix that the NP marking of their pages excludes;
  and the AMD opcodes of SSE4a, SVM, `0F 0D /0`, and FEMMS. None of them is an
  implemented instruction, so the check of the rejections as invalid does not
  concern them. An instruction that would be longer than 15 bytes is reported
  as invalid, not as truncated, when 15 bytes are present.

## 5. Reproducing the results

```
node scripts/validate-all.mjs --per-family 200
```

runs, in order: the source manifest, the cross-engine agreement, the export,
the harness controls, the reference-tool comparison for all targets and stages,
the summary (`docs/validation-results.md` and the support matrix of the
application, `src/app/data/support-matrix.json`), the coverage tables
(`docs/coverage.md`, which `scripts/coverage-tables.ts` writes from the support
matrix and the instruction catalogs), and a check that the source tree still
matches the manifest. On the development machine (Windows 11, Intel Core Ultra
7 155U, Node.js 24.19, Python 3.12.10) the full run takes about half an hour;
most of the time is spent in Clang and LLD. Continuous integration runs the same
pipeline on a reduced corpus.

The source manifest. `node scripts/source-manifest.mjs` writes
`validation/results/source-manifest.json`: the SHA-256 of every file that the
validation reads or executes, and the combined hash of these files, which
identifies the evaluated software. The files are named by a list of patterns in
the script, derived from what the scripts of the pipeline import and read:

- `src/core/**`, the software under test, which the scripts import;
- the scripts that `validate-all.mjs` runs and the one that the harness runs:
  `scripts/validate-all.mjs`, `source-manifest.mjs`, `crosscheck-corpus.ts`,
  `export-validation.ts`, `reencode.ts`, `summarize-validation.ts`, and
  `coverage-tables.ts`, with the modules they share, `scripts/lib/**`;
- `validation/**`: the harness of the reference tools, the versions of the
  tools that it pins (`requirements.txt`), and the edge programs of the corpus
  with their argument tuples;
- `examples/index.json` and `examples/*.py`: the example programs of the corpus
  with their argument tuples;
- `package.json`, `package-lock.json`, and `tsconfig.json`.

Below these folders, the manifest leaves out what a run writes:
`validation/work/**`, `validation/results/**`, the bytecode that Python caches
(`**/__pycache__/**`), and logs (`**/*.log`). Nothing else decides what is
hashed, and `.gitignore` is not read. Because the patterns name whole folders,
they also cover the few files there that no script of the pipeline reads: some
modules of the core, and the example of unsupported syntax, which is not part
of the corpus. `package-lock.json`, `tsconfig.json`, and the pinned
requirements of the harness are hashed as the settings of a run. The
documentation, the browser
application (`src/app/**`), the command-line interface (`src/cli/**`), the JSON
schemas, the tests, the benchmark and build scripts, the public assets, the
licences, and the repository configuration are outside the manifest, so a
change to them does not invalidate recorded results. A control in
`validation/harness_controls.py` follows the imports of the scripts and fails
when a file that the validation reads or executes is not covered.

A file without a NUL byte is text and is hashed with its CRLF line endings
converted to LF, so a checkout that converts line endings, as Git does on
Windows with `core.autocrlf`, has the same manifest. The combined hash is the
SHA-256 of the lines `<path> NUL <file hash> LF`, sorted by the UTF-8 bytes of
the path. `node scripts/source-manifest.mjs --hash` prints it.

The link from results to sources. The export, the cross-engine agreement, and
every stage of `validation/run_validation.py` compute the combined hash from
the files when they start, not from the recorded manifest, and record it in
the file they write. A stage stops when its input was exported from a tree with
another hash. The summary recomputes the hash and writes nothing when a result
file records another hash or none, has another result format than the one the
summary reads, or is missing. The result files are the recorded manifest,
`crosscheck.json`, `semantics.json`, and the four stage results of each target.
With `--partial` the summary names the missing results in its text instead of
stopping; a result that records another hash stops it in every case. A summary
is therefore written only from results that all record the hash of the tree in
which the summary runs, and `docs/validation-results.md`, the support matrix,
and `docs/coverage.md` cite that hash.

These checks establish that the hashed files had the cited contents when the
export and each stage started and when the summary ran. They do not show that a
file stayed unchanged while a stage ran, and they do not protect a result file
against an edit by hand, since a result is tied to its tree by the hash that it
records and not by a signature. The versions of the reference tools that
actually ran are recorded in each result.

To check that a tree is the one that produced a set of results, run

```
node scripts/source-manifest.mjs --check [validation/results/source-manifest.json] [--root <tree>]
```

which recomputes the manifest of the tree (by default the one that contains the
script), compares it with the recorded one, lists every changed, added, and
removed file, and exits with status 1 when they differ. It also fails when the
recorded file count is not the number of recorded entries, and when the
recorded combined hash is not both the hash of the recorded entries and the
combined hash of the tree. The last step of `validate-all.mjs` runs this check,
so a run during which a hashed file changed fails.

`node scripts/summarize-validation.ts --check` and
`node scripts/coverage-tables.ts --check` write nothing: they generate the
summary, the support matrix, and the coverage tables in memory and exit with
status 1 when the files on disk differ from them (line endings and the date of
the support matrix aside), so a hand edit, or a document not regenerated after
the results changed, is detected. The summary check applies the rules of the
summary first, so it also fails when a result file is missing or records
another source tree. Continuous integration runs the manifest check and both
summary checks on the committed files, in a job separate from the pipeline run.
The job fails when a hashed file changed after the committed results were
produced, when a result file is missing, and when a committed document is not
the one generated from the committed results. A change to a hashed file
therefore needs a new run of `node scripts/validate-all.mjs --per-family 200`
and the commit of its results; a change to any other file does not.
