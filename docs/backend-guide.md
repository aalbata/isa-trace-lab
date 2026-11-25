# Adding a target backend

A backend connects one instruction set to the shared compiler, assembler
driver, machine model, and validation harness. The RISC-V backend in
`src/core/target/riscv/` is the reference implementation; the MIPS, AArch64,
and x86-64 backends were added by following this guide.

## 1. Files

A backend lives in `src/core/target/<id>/` and exports one `Backend` object
(see `src/core/target/types.ts`) from `index.ts`.

| File | Contents |
| --- | --- |
| `isa.ts` | Register names, the encoding table, and the `TargetProfile` |
| `encode.ts` | Operand validation and encoding; the `TargetAsm` object |
| `decode.ts` | Bit-pattern recognition, the assembly-level `Insn`, the field breakdown |
| `text.ts` | `format`, `parseLine`, pseudoinstruction and alias handling |
| `cpu.ts` | Processor model implementing `Cpu` |
| `lower.ts` | Instruction selection implementing `TargetLowering` |
| `catalog.ts` | `InsnSpec` entries for the explorer and `OperationExample` sequences |
| `validation.ts` | Instruction sweeps and other inputs for the reference tools |
| `index.ts` | The `Backend` object |

Registering the backend takes these steps:

1. Add its id to the `TargetId` type in `src/core/target/types.ts`.
2. In `src/core/target/index.ts`, import the `Backend` object, add it to
   `BACKENDS`, and add its id to `TARGET_ORDER`, which sets the display order.
   `getBackend(id)` then finds it, and `availableBackends()` lists it for the
   tests, the cross-engine check, the export of the validation inputs, and
   the summary.
3. Add the id to the `target` enumeration of
   `schemas/target-configuration.schema.json`,
   `schemas/compiled-program.schema.json`, and
   `schemas/execution-trace.schema.json`.
4. Give the application an entry for the id in `ASM_EXAMPLES` and
   `BYTE_EXAMPLES` (`src/app/data/asmExamples.ts`) and in `TARGET_LABEL`
   (`src/app/components/format.ts`).
5. Create `validation/targets_<id>.py`, which defines `TARGET`, the
   reference-tool entry (section 8). `validation/targets.py` loads every
   `targets_<id>.py` module in that folder and registers its entry under
   `<id>`; no other file of the harness changes.

The core is plain TypeScript that Node.js runs directly. Use only erasable
syntax: no `enum`, no `namespace`, no constructor parameter properties, and do
not name a method `declare`. Relative imports carry the `.ts` extension. The
core must not import React, the DOM, or Node.js modules.

## 2. Execution environment (identical on every target)

Memory (`src/core/target/memory.ts`), all little-endian:

| Region | Range | Access |
| --- | --- | --- |
| code | `0x00400000` to `0x0040FFFF` | fetch and load; stores fault |
| data | `0x10000000` to `0x1000FFFF` | load and store |
| stack | `0x7FFEF000` to `0x7FFFEFFF` | load and store; the initial stack pointer is `0x7FFFF000` |

Any other access raises `MemoryFault`, which `Cpu.step` turns into a fault.
Arrays occupy the data region from its base, four bytes per element, in
declaration order (`Emitter.arrayAddress`, `Emitter.arrayOffset`).

Services are requested with the target's trap instruction. The service number
and its argument are passed in the registers named by
`profile.conventions.serviceNumber` and `serviceArg`:

| Number | Service | Argument |
| --- | --- | --- |
| 1 | print | signed 32-bit value appended to the output |
| 2 | exit | return value of `main` |
| 3 | runtime error | 1 index out of range, 2 shift count out of range |

`Cpu.step` executes the trap instruction (including every architectural side
effect it has on registers), advances the program counter, and returns
`{ kind: 'service' }`. The machine (`machine.ts`) then reads the two registers
and performs the service. These numbers belong to this environment and are not
operating-system call numbers; say so in the profile notes.

Program image, produced by the lowering driver (`lower.ts`):

1. `_start`: the hook `startup` sets up whatever the target needs, calls
   `main`, moves the result to the service argument register, and requests
   service 2.
2. `main`: `prologue` allocates the frame and moves the parameters (at most
   four, arriving in `conventions.args`) to their homes. The body follows.
   `ret` places the return value in `conventions.result`, releases the frame,
   and returns.
3. Trap stubs (`trap`): load the error code and request service 3.
4. `helpers`: runtime routines, if the target needs any.

The loader sets the stack pointer and the argument registers (32-bit values,
zero-extended in 64-bit registers) and nothing else.

## 3. Register roles

`profile.conventions` lists disjoint register sets:

- `varRegs`: homes of source variables, assigned in declaration order. A
  variable keeps its home for the whole function. Variables beyond the list
  live in stack slots.
- `tempRegs`: expression temporaries (at least four).
- `scratch`: exactly four registers reserved for the code generator. The
  driver places a spilled or constant operand `a` in `scratch[0]`, operand `b`
  or a stored value in `scratch[1]`, and computes results destined for a stack
  slot in `scratch[0]`. `scratch[2]` and `scratch[3]` belong to the hooks.
- The argument, result, service, stack-pointer, and link registers must not
  appear in `varRegs` or `tempRegs`, with one exception: a register may serve
  as an argument register and as a temporary, because the prologue moves the
  parameters to their homes first.

Homes are named with the 32-bit register names where the target has both
widths (`w19`, `ebx`). `Cpu.readReg`, `writeReg`, `reg32`, and `wasWritten`
must accept every name that appears in the profile and in formatted
instructions, of either width.

## 4. Lowering hooks

The driver resolves IR operands and calls the hooks of `TargetLowering`. It
guarantees:

- operand `a` of `bin`, `cmpSet`, and `branch` is a register; `b` is a
  register or a 32-bit signed immediate, and the hook must handle any
  immediate (materialize it in `scratch[2]` when it does not fit the encoding);
- a destination register may equal an operand register, so a hook that writes
  the destination before reading every operand must go through a scratch
  register;
- shift counts are in 0 to 31, and array indexes are in range (the driver has
  already emitted the range-check branches);
- all arithmetic is 32-bit and wraps; use non-trapping instructions.

Emit instructions with `e.insn(mnemonic, operands, note)`. Emit the expansion
of a pseudoinstruction or the canonical form of an alias with
`e.pseudo(text, expansion, note)`; the listing then shows the real
instructions and records the shorthand beside them. Notes are short phrases
for readers of the listing.

Branch targets are `{ t: 'label', name }` operands; the assembler driver
resolves them to `{ t: 'addr', value, label }` before encoding.

Boundaries need no target code. The driver emits a marker before the first
instruction of each statement and keeps an explicit jump at the end of a block
whose marker would otherwise have no instruction of its own.

## 5. Encoder and assembler driver

`TargetAsm.encode(insn, pc, long)` receives resolved operands and returns the
bytes, or throws an `Error` whose message names the operand and its legal
range. `size` must agree with `encode`.

Relaxation: an instruction is `relaxable` when it has a short form of limited
reach. The driver starts with every instruction short and grows the ones that
do not fit until nothing changes. `relaxLong` returns a replacement sequence
(RISC-V: inverted branch over a jump) or `null` when the long form is a longer
encoding of the same instruction, in which case `size` and `encode` are called
with `long = true`. Choose the same encodings as the reference assembler where
several are valid, and record deliberate differences in `validation.ts`.

In assembly text, a numeric branch or jump target is an absolute address, as
printed by `format` for an instruction without a label.

## 6. Decoder

`decode(bytes, offset, pc)` returns the instruction, its length, and its field
breakdown (`BitField` for fixed-width words, `ByteField` for variable-length
encodings), or a failure of one of three kinds:

- `truncated`: more bytes are needed;
- `unsupported`: an encoding in an instruction, an instruction class, or an
  extension outside the implemented subset (name the extension or instruction
  family in the message);
- `invalid`: not a valid encoding in the profile.

A decoder need not examine every word outside the subset. State in the header
of the decoder where it examines whether a word is an assigned encoding, and
report an unassigned word there as `invalid`; a group that the decoder
classifies as a whole is reported as `unsupported`, its reserved words
included. The A64 decoder classifies as a whole the SVE, SME, and scalar
floating-point and Advanced SIMD groups and the instruction classes without an
implemented instruction outside the branch, exception generation, and System
group; the RISC-V decoder the AMO, OP-32, OP-IMM-32, and floating-point
computational major opcodes and the SYSTEM encodings with funct3 000
(docs/validation.md, section 3).

Decoded branch targets are absolute `addr` operands. `format(decoded.insn)`
must parse back with `parseLine` and encode to the same bytes whenever the
encoding is the one the encoder chooses. Set `alias` to the conventional
shorthand when one exists.

## 7. Processor model

`Cpu.step` must fetch the instruction bytes from memory with `mem.fetch`,
decode them with the decoder's recognition function, and apply the semantics.
It must not consult the compiled listing. When a `StepEvent` is passed, fill
in the bytes, text, class, register reads and writes, memory accesses, flags
before and after, the arithmetic operands (`alu`), and the branch decision;
when none is passed, skip that work.

Faults are returned as `{ kind: 'fault', message }` and must be deterministic:
undecodable bytes, unmapped or forbidden memory access, misalignment where the
profile requires alignment, and any exception the instruction itself defines.
`wasWritten` reports whether a register has been written since reset; the
variable view uses it to show unassigned variables. A variable kept in a stack
slot is shown as unassigned until every byte of its slot has been written since
the reset, by a store of an executed instruction or by a debugger edit of
memory; `memory.ts` records the written bytes of the data and stack regions for
this, and the loader places the program image without marking it.

64-bit registers are exposed as `bigint`; `reg32` returns the low 32 bits as a
signed number. Internally, keep the 32-bit path free of BigInt arithmetic
where practical, since most generated instructions are 32-bit.

## 8. Validation inputs

`validation.ts` exports a `ValidationSpec`:

- `preamble`: lines that put the reference assembler in the right mode and
  define `_start`.
- `sweeps()`: assembly programs in this tool's syntax that use every
  implemented instruction with boundary operands (every register in every
  register operand that the encoding can name, the extreme and middle values
  of every immediate, both directions and the extreme distances of every
  branch; docs/validation.md, section 3, states the register coverage of the
  existing sweeps, and `tests/validation-sweeps.test.ts` asserts each of its
  statements). Data directives may place branch targets; they are not
  counted as instructions, and their bytes are not executed. The exporter
  assembles them here and prints the listing for the reference assembler with
  `format`, so the text that `format` produces must be accepted by Clang's
  integrated assembler. A branch target that is the address of an instruction
  of the same program becomes a label; any other target becomes a symbol
  defined relative to `_start`, so the preamble must end with the line
  `_start:`.
- `alternateEncodings`: valid byte sequences that the encoder does not choose.
- `undefinedFlags(insn, readReg)`: flags the architecture leaves undefined
  after the instruction. `readReg`, when given, reads a register of the state
  before the instruction, so the set can depend on a run-time count (x86-64
  shifts by cl). The exporter passes the registers that it recorded before the
  step, because the instruction may overwrite the register that holds the count.

`validation/targets_<id>.py` defines `TARGET` with the Clang triple and CPU,
extra flags, the Capstone and Unicorn modes, the register map, the flags
register and bit positions, the service hook, and `exclude_execution(case)`
for cases the emulator cannot model, each with a stated reason. Optional keys
(`synonyms`, `lenient_capstone`, `normalize_capstone`, `reencode_text`,
`capstone_alias_ids`) adapt the comparison to Capstone's spelling and syntax;
the existing entries show their use. Two further optional keys narrow what is
left unchecked. `partial_exclusions` maps a reason of `exclude_execution` to
the comparisons that it affects (`pc_mask`, the bits of the program counter
that are compared, and `unicorn_errors`, the Unicorn errors that stand for the
failed fetch of a jump target); a case with such a reason is run and compared
in every other respect instead of being left out, as the MIPS entry does for
`jr` and `jalr`. `defined_without_capstone(raw)` returns the reason why bytes
that Capstone does not decode are a defined encoding, or `None`; with it, a
rejection as unsupported that Capstone does not decode and that has no reason
fails the decoding stage. `validation/targets.py` registers the
module automatically. `run_validation.py --target all` stops with
an error when the work folder holds inputs of a target without an entry, and
the summary stops when a result file is missing, so a target cannot be left out
of the comparison unnoticed.

Run, from the repository root:

```
node scripts/export-validation.ts --target <id>
python validation/run_validation.py --target <id>
```

The export records the combined hash of the source tree in its files, and a
stage stops when its input was exported from another state of the tree, so
export again after a change to a file that the validation reads or executes
(docs/validation.md, section 5).

A backend is complete when every stage reports zero failures and every
exclusion has a documented reason: `encoding` (bytes equal the reference
assembler and linker output), `decoding` (decoded text reassembles to the same
bytes; Capstone names the same instruction), `execution` (single instructions
agree with Unicorn), and `programs` (compiled programs agree with Unicorn).
The cross-engine test (`npm test`) and the full pipeline
(`node scripts/validate-all.mjs`, docs/validation.md, section 5) must also
pass for the new target.

## 9. Catalog

Provide one `InsnSpec` per implemented instruction and per accepted
pseudoinstruction or alias, with syntax, register-transfer semantics, legal
operand ranges, restrictions, register and flag effects, an example that the
assembler accepts, and the section of the specification that defines it.
Write the explanations yourself and cite the manual; do not copy its text.
Provide an `OperationExample` for each operation key used by the RISC-V
backend so that the cross-target comparison has a complete row.
