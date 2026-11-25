"""Reference-tool configuration for the x86-64 backend (target id `x86`)."""
import re

import capstone as cs
import unicorn as uc
from unicorn import x86_const as x86

_NAMES64 = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]
_NAMES32 = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi", "r8d", "r9d", "r10d", "r11d", "r12d", "r13d", "r14d", "r15d"]


def _registers():
    """The sixteen 64-bit registers first, then their 32-bit names, which the program stage uses for
    argument registers, the service registers, and variable homes."""
    out = {name: getattr(x86, "UC_X86_REG_" + name.upper()) for name in _NAMES64}
    out.update({name: getattr(x86, "UC_X86_REG_" + name.upper()) for name in _NAMES32})
    return out


def _normalize_capstone(text):
    """Capstone writes the no-index case of a SIB byte (index field 100 without REX.X) as a pseudo-register
    riz with a scale factor. The Intel manual defines this case as having no index register, so the scale has
    no effect (SDM Vol. 2, Table 2-3). The term is removed before two texts are compared."""
    text = re.sub(r"\s*\+\s*riz(\*\d+)?\b", "", text)
    text = re.sub(r"\[riz(\*\d+)?\s*\+\s*", "[", text)
    text = re.sub(r"\[riz(\*\d+)?\s*-\s*", "[-", text)
    return text


TARGET = {
    "triple": "x86_64-freestanding",
    "cpu": "x86_64",
    "reference": "Clang integrated assembler, x86-64 in 64-bit mode (-mcpu=x86_64), Intel syntax selected by .intel_syntax noprefix",
    "cc_flags": [],
    "capstone": (cs.CS_ARCH_X86, cs.CS_MODE_64),
    "unicorn": (uc.UC_ARCH_X86, uc.UC_MODE_64),
    "registers": _registers(),
    "pc": x86.UC_X86_REG_RIP,
    "register_bits": 64,
    # Status flags and their bit positions in EFLAGS.
    "flags": {"register": x86.UC_X86_REG_EFLAGS, "bits": {"CF": 0, "PF": 2, "AF": 4, "ZF": 6, "SF": 7, "OF": 11}},
    # Capstone prints the same condition spellings as this tool; the other spellings are listed in case a
    # later Capstone release changes its choice.
    "synonyms": {"jz": "je", "jnz": "jne", "jc": "jb", "jnae": "jb", "jnc": "jae", "jnb": "jae", "jna": "jbe", "jnbe": "ja",
                 "jpe": "jp", "jpo": "jnp", "jnge": "jl", "jnl": "jge", "jng": "jle", "jnle": "jg",
                 "setz": "sete", "setnz": "setne", "setc": "setb", "setnae": "setb", "setnc": "setae", "setnb": "setae",
                 "setna": "setbe", "setnbe": "seta", "setpe": "setp", "setpo": "setnp", "setnge": "setl", "setnl": "setge",
                 "setng": "setle", "setnle": "setg", "sal": "shl"},
    # The service instruction is SYSCALL. Unicorn calls the instruction hook in place of the instruction and
    # then continues at the next instruction.
    "service": {"kind": "insn", "insn": x86.UC_X86_INS_SYSCALL},
    "delay_slots": False,
    "normalize_capstone": _normalize_capstone,
    "exclude_execution": None,
}
