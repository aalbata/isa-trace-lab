"""Reference-tool configuration of the MIPS32 Release 2 backend (little-endian, with delay slots)."""
import capstone as cs
import unicorn as uc
from unicorn import mips_const as mc

_NAMES = ["$zero", "$at", "$v0", "$v1", "$a0", "$a1", "$a2", "$a3", "$t0", "$t1", "$t2", "$t3", "$t4", "$t5", "$t6", "$t7",
          "$s0", "$s1", "$s2", "$s3", "$s4", "$s5", "$s6", "$s7", "$t8", "$t9", "$k0", "$k1", "$gp", "$sp", "$fp", "$ra"]


def _lenient(insn, raw):
    """Reason for an encoding that Capstone decodes as an implemented instruction although MIPS32 Release 2
    reserves it. No such encoding has been observed for this target, so every case is reported."""
    return None


_BIT0 = ("jr or jalr to an address with bit 0 set: the profile has neither MIPS16e nor microMIPS, so the address is "
         "kept and the Address Error exception belongs to the fetch of the target; Unicorn 2.1.4 treats bit 0 as "
         "the instruction-set mode bit and clears it")
_KERNEL = ("jr or jalr to an address in 0xC0000000 to 0xFFFFFFFF: Unicorn 2.1.4 translates these kernel segments "
           "through its TLB model and reports the failed fetch of the target as UC_ERR_READ_UNMAPPED, which the "
           "harness cannot tell apart from a fault of the jump itself")
_BIT1 = ("jr or jalr to an address below 0xC0000000 with bit 1 set and bit 0 clear: the Address Error exception "
         "belongs to the fetch of the target; the Linux build of Unicorn 2.1.4 reports that fetch as "
         "UC_ERR_READ_UNALIGNED before the jump completes, while the Windows build completes the jump")


def _exclude_execution(case):
    """Reason for which comparisons of an instruction-level case with Unicorn are left out, or None. A target in the
    kernel segments is tested first, because Unicorn reports the fetch of such a target as UC_ERR_READ_UNMAPPED
    whether or not bit 0 or bit 1 is set; bit 0 is tested before bit 1. _PARTIAL gives the comparisons that each
    reason affects."""
    words = case["text"].replace(",", " ").split()
    if words[0] not in ("jr", "jalr"):
        return None
    target = int(case["regs"][words[-1]], 16)
    if target >= 0xC0000000:
        return _KERNEL
    if target & 1:
        return _BIT0
    if target & 2:
        return _BIT1
    return None


# The comparisons that each reason affects. Neither reason affects the other comparisons of the case: the
# registers, among them the link register of jalr and the register that the delay-slot instruction writes, and
# memory, which Unicorn computes as for any jump.
#   pc_mask             the bits of the program counter that can be compared; 0 leaves the program counter out;
#   unicorn_errors      Unicorn errors that, when this tool reports no fault, stand for the failed fetch of the jump
#                       target, as UC_ERR_FETCH_UNMAPPED does for every case;
#   unicorn_interrupts  interrupt numbers that Unicorn passes to the interrupt hook for that failed fetch before it
#                       reports the error. For a target in the kernel segments Unicorn 2.1.4 passes 26 and then
#                       reports UC_ERR_READ_UNMAPPED. Such an interrupt belongs to the fetch of the target and is
#                       not a fault of the jump or of its delay-slot instruction. For a target with bit 1 set the
#                       key is absent, so an interrupt that precedes one of the listed errors belongs to that error.
# For a target with bit 1 set the program counter is left out, as for the kernel segments, because the Linux build
# of Unicorn ends the step with an error; every other comparison is made as for any jump.
_PARTIAL = {
    _BIT0: {"pc_mask": 0xFFFFFFFE, "unicorn_errors": [], "unicorn_interrupts": []},
    _KERNEL: {"pc_mask": 0, "unicorn_errors": [uc.UC_ERR_READ_UNMAPPED], "unicorn_interrupts": [26]},
    _BIT1: {"pc_mask": 0, "unicorn_errors": [uc.UC_ERR_READ_UNALIGNED, uc.UC_ERR_FETCH_UNALIGNED]},
}


TARGET = {
    "triple": "mipsel-freestanding",
    "cpu": "mips32r2",
    "reference": "Clang integrated assembler, MIPS32 Release 2 little-endian (-target mipsel-freestanding -mcpu=mips32r2), "
                 "with .set noreorder and .set noat",
    "cc_flags": [],
    "capstone": (cs.CS_ARCH_MIPS, cs.CS_MODE_MIPS32 | cs.CS_MODE_LITTLE_ENDIAN),
    "unicorn": (uc.UC_ARCH_MIPS, uc.UC_MODE_MIPS32 | uc.UC_MODE_LITTLE_ENDIAN),
    "registers": {name: mc.UC_MIPS_REG_0 + i for i, name in enumerate(_NAMES)},
    "pc": mc.UC_MIPS_REG_PC,
    "register_bits": 32,
    "flags": None,
    # Mnemonics that Capstone prints differently from this tool for the same instruction.
    # ssnop, ehb, and pause are the names of sll $zero, $zero, 1, 3, and 5; neg is sub with $zero as the
    # first source; Capstone prints jalr with destination $zero as jr.
    "synonyms": {"ssnop": "sll", "ehb": "sll", "pause": "sll", "neg": "sub", "jr": "jalr"},
    "lenient_capstone": _lenient,
    # Unicorn reports syscall as interrupt 17 (system call exception) with the program counter already
    # past the instruction, so the hook does not advance it.
    "service": {"kind": "intr", "numbers": [17], "length": 4, "advance": False},
    "delay_slots": True,
    "fixed_length": 4,
    "exclude_execution": _exclude_execution,
    "partial_exclusions": _PARTIAL,
}
