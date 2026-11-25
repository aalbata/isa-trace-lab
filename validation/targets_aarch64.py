"""Reference-tool configuration of the AArch64 (A64 integer subset) backend."""
import capstone as cs
import unicorn as uc
from unicorn import arm64_const as a64


def _registers():
    """X names are the profile registers; W names address the same Unicorn registers through their 32-bit views."""
    regs = {}
    for i in range(31):
        regs["x%d" % i] = getattr(a64, "UC_ARM64_REG_X%d" % i)
        regs["w%d" % i] = getattr(a64, "UC_ARM64_REG_W%d" % i)
    regs["sp"] = a64.UC_ARM64_REG_SP
    return regs


def _exclude_execution(case):
    """No instruction case is excluded: every instruction of the subset has defined results."""
    return None


TARGET = {
    "triple": "aarch64-freestanding",
    "cpu": "generic",
    "reference": "Clang integrated assembler, Armv8-A A64 (-target aarch64-freestanding -mcpu=generic), LLD",
    "cc_flags": [],
    "capstone": (cs.CS_ARCH_ARM64, cs.CS_MODE_ARM),
    "unicorn": (uc.UC_ARCH_ARM64, uc.UC_MODE_ARM),
    "registers": _registers(),
    "pc": a64.UC_ARM64_REG_PC,
    "register_bits": 64,
    # N, Z, C, V are bits 31 to 28 of the NZCV register.
    "flags": {"register": a64.UC_ARM64_REG_NZCV, "bits": {"N": 31, "Z": 30, "C": 29, "V": 28}},
    # Capstone prints the same condition spellings (b.hs, b.lo) and the preferred aliases that this tool reports,
    # with one difference: Capstone 5.0.9 prints mov for ORR (immediate) with Rn = ZR even when the immediate
    # can be built by MOVZ or MOVN. The Arm manual then prefers the orr spelling, because the immediate of the
    # mov alias (MOV, bitmask immediate) excludes the values that MOVZ or MOVN can load; this tool reports orr
    # for exactly those values.
    "synonyms": {"mov": "orr"},
    # Unicorn reports svc as interrupt 2 (supervisor call), with the program counter already past the instruction.
    "service": {"kind": "intr", "numbers": [2], "length": 4, "advance": False},
    "delay_slots": False,
    "fixed_length": 4,
    "exclude_execution": _exclude_execution,
}
