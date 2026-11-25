"""Per-target configuration of the reference tools.

Each entry names the reference assembler configuration (Clang's integrated
assembler and the LLD linker, both shipped in the pinned `ziglang` wheel), the
Capstone mode, and the Unicorn mode, and maps this tool's register names to
Unicorn register identifiers.

The RISC-V entry is defined here. The entry of every other target is the
`TARGET` dictionary of a module `validation/targets_<id>.py`; every such module
next to this file is loaded at import and registered under its `<id>`.
"""
import glob
import importlib.util
import os
import sys

import capstone as cs
import unicorn as uc
from unicorn import riscv_const as rv


def _riscv_registers():
    names = ["zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
             "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"]
    return {name: getattr(rv, "UC_RISCV_REG_X%d" % i) for i, name in enumerate(names)}


def _riscv_lenient(insn, raw):
    """Capstone 5.0.9 in RV32 mode decodes shift-immediate encodings whose shift amount has bit 5 set.
    The RV32I specification reserves these encodings; they are defined only in RV64I."""
    word = int.from_bytes(raw, "little")
    if insn.mnemonic in ("slli", "srli", "srai") and (word >> 25) & 1:
        return "shift-immediate encoding with shamt[5] = 1, reserved in RV32I and defined only in RV64I"
    return None


def _riscv_reencode_text(md, insn, text):
    """Capstone 5.0.9 prints the target of a RISC-V branch or jal, under every alias spelling, as an offset from the
    address of the instruction; this tool's assembly syntax takes the absolute address (docs/backend-guide.md,
    section 5). The offset is replaced by the address it designates."""
    if md.insn_name(insn.id) not in ("beq", "bne", "blt", "bge", "bltu", "bgeu", "jal"):
        return text
    head, _, offset = text.rpartition(" ")
    return "%s 0x%08x" % (head, (insn.address + int(offset, 0)) & 0xFFFFFFFF)


TARGETS = {
    "riscv": {
        "triple": "riscv32-freestanding",
        "cpu": "generic_rv32",
        "reference": "Clang integrated assembler, RV32I without extensions (-mcpu=generic_rv32), linker relaxation off",
        "cc_flags": ["-mno-relax"],
        "capstone": (cs.CS_ARCH_RISCV, cs.CS_MODE_RISCV32),
        "unicorn": (uc.UC_ARCH_RISCV, uc.UC_MODE_RISCV32),
        "registers": _riscv_registers(),
        "pc": rv.UC_RISCV_REG_PC,
        "register_bits": 32,
        "flags": None,
        # Mnemonics that Capstone prints differently from this tool for the same instruction.
        "synonyms": {},
        # Capstone 5.0.9 gives a RISC-V alias (j, beqz, mv, ret, ...) the identifier of the instruction it stands for.
        "capstone_alias_ids": True,
        "lenient_capstone": _riscv_lenient,
        "reencode_text": _riscv_reencode_text,
        # Unicorn reports the service instruction as interrupt 8 (environment call from user mode), with the
        # program counter already past the instruction, so the hook does not advance it.
        "service": {"kind": "intr", "numbers": [8], "length": 4, "advance": False},
        "delay_slots": False,
        "fixed_length": 4,
    },
}


def _load_target_modules():
    """Register the TARGET entry of every module validation/targets_<id>.py under <id>. The folder path is escaped, so
    a folder name with glob characters such as brackets is matched literally."""
    here = os.path.dirname(os.path.abspath(__file__))
    for path in sorted(glob.glob(os.path.join(glob.escape(here), "targets_*.py"))):
        name = os.path.splitext(os.path.basename(path))[0]
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        TARGETS[name[len("targets_"):]] = module.TARGET


_load_target_modules()
