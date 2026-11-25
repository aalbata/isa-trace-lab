"""Controls of the validation harness. A check that can never fire would pass silently, so each control gives a
stage, or a script of the pipeline, an input whose outcome is known: a positive control must pass or be
reproduced, and a negative control (a deliberately wrong expectation) must be reported as a failure.

    python validation/harness_controls.py [--work validation/work]

Some controls start from the inputs that `node scripts/export-validation.ts` wrote into the work folder, so the
export runs first, as in `node scripts/validate-all.mjs`. The process exits with 1 when any control fails.
"""
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import capstone as cs  # noqa: E402

import run_validation as rv  # noqa: E402
from targets import TARGETS  # noqa: E402

BASE = 0x400000

# Encodings of implemented instructions, disassembled at BASE; this tool's assembler must reproduce each of them from
# Capstone's text. The first five of each target are ordinary instructions; the others are branches and jumps, whose
# targets Capstone prints relative to the instruction (RISC-V) or as absolute addresses, in short and long forms.
REENCODED = {
    "riscv": ["33055500", "13051000", "03a54100", "2324a100", "b7553412",
              "6300b580", "63e46200", "ef001000", "6f000080", "63180500"],
    "mips": ["21104300", "0500a424", "0800a4af", "02488870", "3412083c",
             "04008510", "fbff0015", "40001008", "0020100c", "07000106"],
    "aarch64": ["0200010b", "431c0012", "245963b8", "e40b00b9", "857c031b",
                "04000014", "00fcff97", "00020034", "01080054", "03feffb5"],
    "x86": ["01c8", "8b4c8b08", "0fafd8", "4489642408", "41d3f9",
            "7402", "ebfa", "7ff8", "0f8510000000", "e8fb0f0000"],
}

# Valid encodings of implemented branches and jumps, each given to the decoding stage as a rejection of the stated
# kind; the stage must report every one of them.
WRONGLY_REJECTED = {
    "riscv": [("ef001000", "invalid"), ("6f000080", "invalid"), ("6300b580", "unsupported"), ("63e46200", "unsupported")],
    "x86": [("7f00", "invalid"), ("7402", "unsupported"), ("ebfa", "unsupported"), ("0f8510000000", "unsupported")],
}


def disassembler(target):
    cfg = TARGETS[target]
    md = cs.Cs(*cfg["capstone"])
    if cfg["capstone"][0] == cs.CS_ARCH_X86:
        md.syntax = cs.CS_OPT_SYNTAX_INTEL
    return md


def load(work, target, stage):
    path = os.path.join(work, target, stage + ".json")
    if not os.path.exists(path):
        raise FileNotFoundError("%s is missing; run node scripts/export-validation.ts first" % path)
    return json.load(open(path))


def run_stage(stage, target, document, tmp):
    """Run one stage of run_validation.py on a single input document placed in a fresh work folder."""
    work = tempfile.mkdtemp(dir=tmp)
    os.makedirs(os.path.join(work, target))
    with open(os.path.join(work, target, stage + ".json"), "w", newline="\n") as f:
        json.dump(document, f)
    sub = tempfile.mkdtemp(dir=tmp)
    return rv.STAGES[stage](target, work, sub)


def with_cases(document, cases):
    out = dict(document)
    out["cases"] = cases
    return out


# ---- decoding -----------------------------------------------------------------------

def control_reencoding(work, tmp):
    """Capstone's text of implemented encodings, branches included, is reproduced by this tool's assembler."""
    results = []
    for target, words in REENCODED.items():
        md = disassembler(target)
        cases = [rv.reencode_case(TARGETS[target], md, next(md.disasm(bytes.fromhex(w), BASE, 1)), bytes.fromhex(w)) for w in words]
        for case, res in zip(cases, rv.reencode_with_this_tool(target, cases, tmp)):
            results.append(("re-encoding of %s '%s' (%s)" % (target, case["text"], case["bytes"]), res["reproduced"], res["error"]))
    return results


def control_wrong_rejections(work, tmp):
    """A decoder that rejects valid encodings of implemented branches, as invalid or as unsupported, is reported. A
    rejection as invalid is also reported by the check against the implemented instructions alone."""
    results = []
    for target, rejections in WRONGLY_REJECTED.items():
        implemented = load(work, target, "decoding")["implemented"]
        for word, kind in rejections:
            group = {"name": "control", "exact": True, "accepted": [], "rejected": [{"bytes": word, "kind": kind}], "asm": ""}
            document = {"target": target, "groups": [group], "implemented": implemented}
            res = run_stage("decoding", target, document, tmp)
            results.append(("decoding stage reports %s %s rejected as %s" % (target, word, kind), res["failure_count"] > 0,
                            "%d failure(s)" % res["failure_count"]))
            if kind != "invalid":
                continue
            # The same input with a re-encoding check that never reproduces the bytes.
            saved = rv.reencode_with_this_tool
            rv.reencode_with_this_tool = lambda target, cases, tmp: [{"reproduced": False, "error": ""} for _ in cases]
            try:
                res = run_stage("decoding", target, document, tmp)
            finally:
                rv.reencode_with_this_tool = saved
            results.append(("decoding stage reports %s %s rejected as invalid by the implemented instructions alone" % (target, word),
                            res["failure_count"] > 0, "%d failure(s)" % res["failure_count"]))
    return results


def control_relative_branch(work, tmp):
    """An x86-64 relative branch that the reassembled group moves, because Clang encodes the instruction before it
    shorter, is assembled again at its original address and counted as identical; the shorter instruction is a
    non-canonical form and stays equivalent."""
    header = load(work, "x86", "encoding")["preamble"] + [".set T_00400005, _start + 5"]
    group = {"name": "control", "exact": True, "rejected": [],
             "accepted": [{"pc": BASE, "bytes": "4001d8", "text": "add eax, ebx"}, {"pc": BASE + 3, "bytes": "7400", "text": "je 0x400005"}],
             "asm": "\n".join(header + ["    add eax, ebx", "    je T_00400005"]) + "\n"}
    res = run_stage("decoding", "x86", {"target": "x86", "groups": [group], "implemented": []}, tmp)
    t = res["totals"]
    counts = {k: t.get(k) for k in ("reassembled_equal", "reassembled_equal_at_original_address", "reassembled_equivalent")}
    ok = res["failure_count"] == 0 and counts == {"reassembled_equal": 1, "reassembled_equal_at_original_address": 1, "reassembled_equivalent": 1}
    return [("decoding stage counts an x86-64 jump moved by the reassembly as identical at its original address", ok,
             "%s, %d failure(s)" % (json.dumps(counts), res["failure_count"]))]


def control_unsupported_without_capstone(work, tmp):
    """A rejection as unsupported that Capstone does not decode is counted. When the target entry states which of
    these encodings are defined (`defined_without_capstone`), the count is split by the stated reasons and a rejection
    without a reason is reported; a rejection as invalid is not part of the count."""
    # D6 (UDB) and 0F 18 C0 (the hint and NOP space) are defined encodings that Capstone 5.0.9 does not decode.
    md = disassembler("x86")
    undecoded = all(next(md.disasm(bytes.fromhex(word), BASE, 1), None) is None for word in ("d6", "0f18c0"))
    group = {"name": "control", "exact": True, "accepted": [], "asm": "",
             "rejected": [{"bytes": "d6", "kind": "unsupported"}, {"bytes": "0f18c0", "kind": "unsupported"}, {"bytes": "d6", "kind": "invalid"}]}
    document = {"target": "x86", "groups": [group], "implemented": []}
    entry = TARGETS["x86"]
    absent = object()
    saved = entry.get("defined_without_capstone", absent)
    results = []
    try:
        entry.pop("defined_without_capstone", None)
        res = run_stage("decoding", "x86", document, tmp)
        count = res["totals"]["rejected_as_unsupported_not_decoded_by_capstone"]
        results.append(("decoding stage counts the rejections as unsupported that Capstone does not decode",
                        undecoded and count == 2 and res["failure_count"] == 0
                        and res["unsupported_not_decoded_by_capstone"] == {"checked_against_the_target_entry": False, "defined": {}},
                        "counted %d, %d failure(s), %s" % (count, res["failure_count"], json.dumps(res["unsupported_not_decoded_by_capstone"]))))
        entry["defined_without_capstone"] = lambda raw: "control reason" if raw[0] == 0xD6 else None
        res = run_stage("decoding", "x86", document, tmp)
        count = res["totals"]["rejected_as_unsupported_not_decoded_by_capstone"]
        reported = [f["bytes"] for f in res["failures"]]
        results.append(("decoding stage reports a rejection as unsupported that Capstone does not decode and that the target entry does not state to be defined",
                        count == 2 and reported == ["0f18c0"]
                        and res["unsupported_not_decoded_by_capstone"] == {"checked_against_the_target_entry": True, "defined": {"control reason": 1}},
                        "counted %d, reported %s, %s" % (count, json.dumps(reported), json.dumps(res["unsupported_not_decoded_by_capstone"]))))
    finally:
        if saved is absent:
            entry.pop("defined_without_capstone", None)
        else:
            entry["defined_without_capstone"] = saved
    return results


# ---- encoding -----------------------------------------------------------------------

BRANCH_PSEUDO = re.compile(r"^(b|beqz|bnez)\s")
BRANCH_LABEL = re.compile(r"[\s,][LT]_[0-9a-f]{8}$")


def control_branch_pseudoinstructions(work, tmp):
    """The text that the export gives Clang for a compiled MIPS program spells the pseudoinstructions b, beqz, and bnez
    as written, with a label or symbol as the target, so that Clang chooses their expansion. A branch of a corpus
    program reaches its target with one instruction, because the code region is smaller than the reach of a MIPS
    branch, so every such pseudoinstruction of the listing is one line of the text."""
    compiled = [p for p in load(work, "mips", "encoding")["programs"] if p["kind"] == "compiled"]
    listed, spelled, other = {}, {}, []
    for p in compiled:
        for ins in p["insns"]:
            match = BRANCH_PSEUDO.match(ins.get("p", ""))
            if match:
                listed[match.group(1)] = listed.get(match.group(1), 0) + 1
        for line in p["asm"].split("\n"):
            match = BRANCH_PSEUDO.match(line.strip())
            if match:
                spelled[match.group(1)] = spelled.get(match.group(1), 0) + 1
                if not BRANCH_LABEL.search(line.rstrip()):
                    other.append(line.strip())
    return [("the MIPS encoding export spells the pseudoinstructions b, beqz, and bnez of the compiled programs as written, with a label as the target",
             sorted(listed) == ["b", "beqz", "bnez"] and spelled == listed and not other,
             "in the listings %s, in the texts %s, without a label %s" % (json.dumps(listed, sort_keys=True), json.dumps(spelled, sort_keys=True), json.dumps(other[:2])))]


def control_encoding(work, tmp):
    """Data directives are not counted as instructions or as mnemonics, pseudoinstructions are counted by name, and a
    pseudoinstruction program whose bytes differ from Clang's is compared line by line: an expansion that differs from
    Clang's is accepted only when it runs to its end and has the same effect on the registers, the flags, and the
    mapped memory at the address of its line from every initial state; Clang assembles each line for that address;
    the program must give Clang's bytes of its other lines in source order; and Clang's bytes of the whole text must
    be its bytes of the lines."""
    # The preamble and the register list that the export gives the stage for each target.
    settings = {"riscv": {"preamble": [".text", ".globl _start", "_start:"], "registers": list(TARGETS["riscv"]["registers"])}}
    for target in ("mips", "aarch64"):
        exported = load(work, target, "encoding")
        settings[target] = {"preamble": exported["preamble"], "registers": exported["registers"]}

    def program(target, kind, lines, items):
        """A program whose text is `lines` and whose bytes and listing are `items`, in the order this tool emits them:
        (source line number or None, listing text, encoding, other listing fields)."""
        insns, address = [], BASE
        for n, t, word, extra in items:
            insns.append(dict({"a": address, "l": len(word) // 2, "t": t}, **({"n": n} if n else {}), **extra))
            address += len(word) // 2
        return {"name": "control", "kind": kind, "asm": "\n".join(settings[target]["preamble"] + lines) + "\n",
                "bytes": "".join(word for _, _, word, _ in items), "insns": insns}

    def run(kind, lines, items, target="riscv"):
        doc = dict(settings[target], target=target, programs=[program(target, kind, lines, items)])
        return run_stage("encoding", target, doc, tmp)

    results = []
    res = run("sweep", ["nop", ".word 0"], [(1, "addi zero, zero, 0", "13000000", {"p": "nop"}), (2, ".word 0", "00000000", {"d": 1})])
    s = res["summary"]["sweep"]
    results.append(("encoding stage counts one instruction in a program with one instruction and one data line",
                    s["instructions"] == 1 and ".word" not in res["by_mnemonic"] and res["failure_count"] == 0,
                    "instructions %d, mnemonics %s" % (s["instructions"], sorted(res["by_mnemonic"]))))
    results.append(("encoding stage counts the pseudoinstruction nop by name",
                    res.get("by_pseudo", {}).get("nop") == {"sweep": 1}, json.dumps(res.get("by_pseudo"))))
    # li a0, 2048: this tool emits lui + addi, Clang emits addi + slli; both load 2048. The programs of five lines below
    # begin with this line, so each is compared line by line with this expansion accepted as equivalent.
    li = [(1, "lui a0, 0x1", "37150000", {"p": "li a0, 2048"}), (1, "addi a0, a0, -2048", "13050580", {})]
    res = run("pseudo", ["li a0, 2048"], li)
    results.append(("encoding stage accepts an equivalent expansion of li a0, 2048", res["failure_count"] == 0
                    and res["summary"]["pseudo"]["expansions_equivalent"] == 1, json.dumps(res["summary"]["pseudo"])))
    lines = ["li a0, 2048", "mv a0, a1", "not a0, a1", "seqz a4, a5", "snez a6, a7"]
    mv = (2, "addi a0, a1, 0", "13850500", {"p": "mv a0, a1"})
    not_ = (3, "xori a0, a1, -1", "13c5f5ff", {"p": "not a0, a1"})
    seqz = (4, "sltiu a4, a5, 1", "13b71700", {"p": "seqz a4, a5"})
    snez = (5, "sltu a6, zero, a7", "33381001", {"p": "snez a6, a7"})
    res = run("pseudo", lines, li + [mv, not_, seqz, snez])
    results.append(("encoding stage passes a program with an equivalent expansion and four identical lines", res["failure_count"] == 0
                    and res["summary"]["pseudo"]["programs_passed"] == 1 and res["summary"]["pseudo"]["expansions_equivalent"] == 1,
                    "%s, failures %s" % (json.dumps(res["summary"]["pseudo"]), json.dumps(res["failures"])[:200])))
    wrong = {
        "li a0, 2048 expanded to load 2049": (["li a0, 2048"], [li[0], (1, "addi a0, a0, -2047", "13051580", {})]),
        "snez a6, a7 expanded as slt a6, zero, a7": (["snez a6, a7"], [(1, "slt a6, zero, a7", "33281001", {"p": "snez a6, a7"})]),
        "sltz t0, t1 expanded as sltu t0, t1, zero": (["sltz t0, t1"], [(1, "sltu t0, t1, zero", "b3320300", {"p": "sltz t0, t1"})]),
        # A zero test that reads its destination, or another register, instead of its source register.
        "seqz a4, a5 expanded as sltiu a4, a4, 1": (lines, li + [mv, not_, (4, "sltiu a4, a4, 1", "13371700", {"p": "seqz a4, a5"}), snez]),
        "snez a6, a7 expanded as sltu a6, zero, a5": (lines, li + [mv, not_, seqz, (5, "sltu a6, zero, a5", "3338f000", {"p": "snez a6, a7"})]),
        # Lines that this tool drops, emits out of source order, or follows with bytes that belong to no line.
        "a program whose line 'mv a0, a1' gives no bytes": (lines, li + [not_, seqz, snez]),
        "a program with the lines 'mv a0, a1' and 'not a0, a1' emitted in swapped order": (lines, li + [not_, mv, seqz, snez]),
        "a program with an instruction that belongs to no line": (lines, li + [mv, not_, seqz, snez, (None, "addi a0, a0, 1", "13051500", {})]),
    }
    for label, (text, items) in wrong.items():
        res = run("pseudo", text, items)
        results.append(("encoding stage rejects %s" % label, res["failure_count"] > 0 and res["summary"]["pseudo"]["programs_passed"] == 0,
                        "%d failure(s)" % res["failure_count"]))

    def passes(label, res, equivalent):
        s = res["summary"]["pseudo"]
        results.append((label, res["failure_count"] == 0 and s["programs_passed"] == 1 and s["expansions_equivalent"] == equivalent,
                        "%s, failures %s" % (json.dumps(s), json.dumps(res["failures"])[:300])))

    def rejects(label, res, error):
        ok = res["failure_count"] == 1 and res["summary"]["pseudo"]["programs_passed"] == 0 and error in res["failures"][0]["error"]
        results.append((label, ok, json.dumps(res["failures"])[:300]))

    # A data line of a program that is compared line by line is not counted as a mnemonic.
    nop = (2, "addi zero, zero, 0", "13000000", {"p": "nop"})
    res = run("pseudo", ["li a0, 2048", "nop", ".word 0"], li + [nop, (3, ".word 0", "00000000", {"d": 1})])
    results.append(("encoding stage leaves a data line out of the mnemonics of a program compared line by line",
                    res["failure_count"] == 0 and res["summary"]["pseudo"]["programs_passed"] == 1 and res["by_mnemonic"] == {"addi": {"pseudo": 1}},
                    "mnemonics %s, failures %d" % (json.dumps(res["by_mnemonic"]), res["failure_count"])))
    # An expansion that computes its value from the program counter. auipc s7, 0xffbff gives -4096 only at the code
    # base: it is accepted for a line there and rejected for the same line at 0x400008.
    auipc = "auipc s7, 0xffbff"
    passes("encoding stage accepts li s7, -4096 expanded as %s at the code base" % auipc,
           run("pseudo", ["li s7, -4096"], [(1, auipc, "97fbbfff", {"p": "li s7, -4096"})]), 1)
    rejects("encoding stage rejects li s7, -4096 expanded as %s at 0x400008, where it gives another value" % auipc,
            run("pseudo", ["li a0, 2048", "li s7, -4096"], li + [(2, auipc, "97fbbfff", {"p": "li s7, -4096"})]), "its effect at the address of the line differs")
    # auipc s8, 0xffc00 and addi s8, s8, 2040 give 2048 at 0x400008 and nowhere else.
    there = [(2, "auipc s8, 0xffc00", "170cc0ff", {"p": "li s8, 2048"}), (2, "addi s8, s8, 2040", "130c8c7f", {})]
    passes("encoding stage accepts li s8, 2048 expanded through auipc for its address 0x400008", run("pseudo", ["li a0, 2048", "li s8, 2048"], li + there), 2)
    rejects("encoding stage rejects the same expansion of li s8, 2048 at the code base", run("pseudo", ["li s8, 2048"], [(1,) + there[0][1:], (1,) + there[1][1:]]),
            "its effect at the address of the line differs")
    # Clang assembles each line for the address of the line: lla a1, _start at 0x400008 is auipc a1, 0 and
    # addi a1, a1, -8, and these bytes are identical to Clang's only when Clang places the line there.
    lla = [(2, "auipc a1, 0x0", "97050000", {"p": "lla a1, _start"}), (2, "addi a1, a1, -8", "938585ff", {})]
    passes("encoding stage has Clang assemble the line lla a1, _start for its address 0x400008", run("pseudo", ["li a0, 2048", "lla a1, _start"], li + lla), 1)
    # Expansions with the registers of Clang's that also store, to the data region and to the code region.
    res = run("pseudo", ["li a0, 0x10000000"], [(1, "lui a0, 0x10000", "37050010", {"p": "li a0, 0x10000000"}), (1, "sw a0, 0(a0)", "2320a500", {})])
    rejects("encoding stage rejects li a0, 0x10000000 expanded with a store to the address it loads", res, "its effect at the address of the line differs")
    res = run("pseudo", ["li a0, 0x400100"], [(1, "lui a0, 0x400", "37054000", {"p": "li a0, 0x400100"}), (1, "addi a0, a0, 256", "13050510", {}),
                                              (1, "sw a0, 0(a0)", "2320a500", {})])
    rejects("encoding stage rejects li a0, 0x400100 expanded with a store into the code region", res, "its effect at the address of the line differs")
    # An expansion that never reaches its end: the run is bounded by the length of the expansion.
    res = run("pseudo", ["li a0, 5"], [(1, "addi a0, zero, 5", "13055000", {"p": "li a0, 5"}), (1, "jal zero, 0x00400004", "6f000000", {})])
    rejects("encoding stage rejects li a0, 5 expanded with a jump to itself", res, "its effect at the address of the line differs")
    # Directives that change how Clang reads the lines after them: its bytes of the whole text are then not its
    # bytes of the lines, also when every line on its own gives this tool's bytes.
    res = run("pseudo", ["li a0, 2048", ".section .data", "li a1, 5"], li + [(3, "addi a1, zero, 5", "93055000", {"p": "li a1, 5"})])
    rejects("encoding stage rejects a program whose line li a1, 5 Clang places in another section", res, "Clang's bytes of the whole text differ")
    res = run("pseudo", [".set reorder", "jr $ra"], [(2, "jr $ra", "0800e003", {})], "mips")
    rejects("encoding stage rejects a MIPS program after whose line jr $ra Clang inserts a delay-slot instruction", res, "Clang's bytes of the whole text differ")
    # Equivalent expansions on the other targets with pseudoinstruction programs: Clang encodes the MIPS move with or
    # and the AArch64 register move with orr.
    passes("encoding stage accepts the MIPS move $a0, $a1 expanded as addu $a0, $a1, $zero",
           run("pseudo", ["move $a0, $a1"], [(1, "addu $a0, $a1, $zero", "2120a000", {"p": "move $a0, $a1"})], "mips"), 1)
    rejects("encoding stage rejects the MIPS move $a0, $a1 expanded as addu $a0, $a2, $zero",
            run("pseudo", ["move $a0, $a1"], [(1, "addu $a0, $a2, $zero", "2120c000", {"p": "move $a0, $a1"})], "mips"), "its effect at the address of the line differs")
    passes("encoding stage accepts the AArch64 mov w0, w1 expanded as add w0, w1, #0",
           run("pseudo", ["mov w0, w1"], [(1, "add w0, w1, #0", "20000011", {"p": "mov w0, w1"})], "aarch64"), 1)
    rejects("encoding stage rejects the AArch64 mov w0, w1 expanded as add w0, w2, #0",
            run("pseudo", ["mov w0, w1"], [(1, "add w0, w2, #0", "40000011", {"p": "mov w0, w1"})], "aarch64"), "its effect at the address of the line differs")
    return results


# ---- execution ----------------------------------------------------------------------

def first_case(cases, mnemonic, ok=lambda c: True):
    """The first exported case of the mnemonic that does not fault and satisfies `ok`."""
    case = next((c for c in cases if c["text"].split()[0] == mnemonic and c["expect"]["fault"] is None and ok(c)), None)
    if case is None:
        raise LookupError("no exported case of '%s' with the required properties" % mnemonic)
    return case


def stores_beyond(address):
    """Predicate: the case changes memory only at or above `address` (beyond the first 4 KiB of the data region)."""
    return lambda c: bool(c["expect"]["memory"]) and all(r["address"] >= address for r in c["expect"]["memory"])


def flip_memory(case, address=None):
    """The expectation with one changed byte of this tool's stored bytes (at `address`, or the first stored byte)."""
    wrong = copy.deepcopy(case)
    runs = wrong["expect"]["memory"]
    run = next((r for r in runs if address is None or r["address"] <= address < r["address"] + len(r["bytes"]) // 2), None)
    if run is None:
        raise LookupError("case '%s' stores nothing at the address" % case["text"])
    k = 0 if address is None else address - run["address"]
    value = bytearray(bytes.fromhex(run["bytes"]))
    value[k] ^= 0x5A
    run["bytes"] = value.hex()
    return wrong


def initial_bytes(case, address, length):
    """Bytes of the initial memory of an exported case."""
    images = {base: bytearray(rv.region_pattern(base, size, case["salt"])) for base, size in rv.REGIONS}
    rv.put_runs(images, case["memoryInit"])
    for base, image in images.items():
        if base <= address and address + length <= base + len(image):
            return bytes(image[address - base: address - base + length])
    raise LookupError("0x%x is outside the data and stack regions" % address)


A64_LOAD = re.compile(r"^(ldrb|ldrh|ldr)\s+([wx])(\d+),\s*\[x(\d+),\s*#(\d+)\]$")


def a64_load(case):
    """Destination register, address, and size of an exported AArch64 load with an unsigned offset, or None."""
    match = A64_LOAD.match(case["text"])
    if match is None:
        return None
    mnemonic, width, rt, rn, offset = match.groups()
    return "x" + rt, int(case["regs"]["x" + rn], 16) + int(offset), {"ldrb": 1, "ldrh": 2}.get(mnemonic, 8 if width == "x" else 4)


def loads_from(low, high):
    """Predicate: an AArch64 load with an unsigned offset whose address lies in [low, high)."""
    def ok(case):
        load = a64_load(case)
        return load is not None and low <= load[1] < high
    return ok


# Distances by which the controls displace a load: every power of two from 1 byte to 16 KiB, so that the distances
# include multiples of 256 as well as smaller ones.
LOAD_DISTANCES = [1 << k for k in range(15)]


def control_fill(work, tmp):
    """The bytes that both sides write into the data and stack regions before an instruction-level case differ between
    any two addresses of a region whose distance is a power of two, with every salt. Every such pair of addresses is
    compared."""
    results = []
    for base, size in rv.REGIONS:
        pairs, equal = 0, []
        for salt in range(256):
            image = rv.region_pattern(base, size, salt)
            for k in range(size.bit_length() - 1):
                distance = 1 << k
                # The XOR of the region with itself moved by the distance has a zero byte where two addresses hold the same byte.
                moved = int.from_bytes(image[distance:], "little") ^ int.from_bytes(image[:size - distance], "little")
                same = moved.to_bytes(size - distance, "little").find(0)
                pairs += size - distance
                if same >= 0:
                    equal.append("0x%08x and 0x%08x with salt %d" % (base + same, base + same + distance, salt))
        results.append(("the fill of the region at 0x%08x gives different bytes to any two addresses a power of two apart, with every salt" % base,
                        not equal, "%d pairs compared; equal bytes with %d combinations of distance and salt, first at %s"
                        % (pairs, len(equal), ", ".join(equal[:1]))))
    return results


def control_execution(work, tmp):
    """The single-instruction stage compares every byte either side writes, the value of a load, which differs when
    the address of the load is wrong by a power of two, the full program counter, and the service instruction, also
    when this tool faults on it or omits its register writes."""
    results = []

    def check(label, target, document, case, expect_failure):
        res = run_stage("execution", target, with_cases(document, [case]), tmp)
        ok = res["failure_count"] > 0 if expect_failure else (res["failure_count"] == 0 and res["totals"]["passed"] == 1)
        detail = json.dumps(res["failures"][0]["diffs"] if res["failures"] and "diffs" in res["failures"][0] else res["failures"][:1])[:200]
        results.append((label, ok, detail))

    beyond = rv.DATA_BASE + 0x1000
    x86 = load(work, "x86", "execution")
    for mnemonic in ("push", "call"):
        case = first_case(x86["cases"], mnemonic)
        check("execution stage passes x86 '%s' as exported" % case["text"], "x86", x86, case, False)
        check("execution stage reports a wrong stack store of x86 '%s'" % case["text"], "x86", x86, flip_memory(case), True)
    case = first_case(x86["cases"], "mov", stores_beyond(beyond))
    check("execution stage reports a wrong store of x86 '%s'" % case["text"], "x86", x86, flip_memory(case), True)
    # A pop that read the quadword above the stack pointer instead of the one at it, with and without a code address
    # in the quadword at the stack pointer.
    for planted in (True, False):
        case = first_case(x86["cases"], "pop", lambda c: c["text"] != "pop rsp" and bool(c["memoryInit"]) == planted)
        wrong = copy.deepcopy(case)
        destination = case["text"].split()[1]
        wrong["expect"]["regs"][destination] = "%x" % int.from_bytes(initial_bytes(case, int(case["regs"]["rsp"], 16) + 8, 8), "little")
        state = "a code address" if planted else "pattern bytes"
        check("execution stage passes x86 '%s' with %s at the stack pointer" % (case["text"], state), "x86", x86, case, False)
        check("execution stage reports x86 '%s' loading from the wrong address, %s at the stack pointer" % (case["text"], state), "x86", x86, wrong, True)
    case = first_case(x86["cases"], "ret", lambda c: bool(c["memoryInit"]))
    check("execution stage passes x86 'ret' to the address on the stack", "x86", x86, case, False)
    wrong = copy.deepcopy(case)
    wrong["expect"]["pc"] = "%x" % (case["pc"] + case["length"])
    check("execution stage reports x86 'ret' that does not jump", "x86", x86, wrong, True)
    # SYSCALL writes the address of the next instruction to rcx and RFLAGS to r11.
    case = first_case(x86["cases"], "syscall", lambda c: c.get("service"))
    check("execution stage passes x86 'syscall' as exported", "x86", x86, case, False)
    for reg, value in (("rcx", "%x" % case["pc"]), ("r11", "%x" % (int(case["expect"]["regs"]["r11"], 16) & ~2))):
        wrong = copy.deepcopy(case)
        wrong["expect"]["regs"][reg] = value
        check("execution stage reports a wrong %s after x86 'syscall'" % reg, "x86", x86, wrong, True)

    a64 = load(work, "aarch64", "execution")
    for mnemonic in ("str", "strh", "strb"):
        case = first_case(a64["cases"], mnemonic, stores_beyond(beyond))
        check("execution stage passes AArch64 '%s' as exported" % case["text"], "aarch64", a64, case, False)
        check("execution stage reports a wrong store of AArch64 '%s'" % case["text"], "aarch64", a64, flip_memory(case), True)
    # A load whose address is wrong by a power of two, within and beyond the first 4 KiB of the data region: the
    # expectation holds the value that the load reads at each distance of LOAD_DISTANCES further on, and the stage must
    # report every one of them. A fill that repeats every 256 bytes hides the distances that are multiples of 256.
    for mnemonic in ("ldr", "ldrh", "ldrb"):
        for where, low, high in (("within", rv.DATA_BASE, beyond), ("beyond", beyond, rv.DATA_BASE + rv.DATA_SIZE)):
            case = first_case(a64["cases"], mnemonic, loads_from(low, high))
            destination, address, size = a64_load(case)
            check("execution stage passes AArch64 '%s' as exported" % case["text"], "aarch64", a64, case, False)
            unreported = []
            for distance in LOAD_DISTANCES:
                wrong = copy.deepcopy(case)
                wrong["expect"]["regs"][destination] = "%x" % int.from_bytes(initial_bytes(case, address + distance, size), "little")
                if run_stage("execution", "aarch64", with_cases(a64, [wrong]), tmp)["failure_count"] != 1:
                    unreported.append(hex(distance))
            results.append(("execution stage reports AArch64 '%s', a load %s the first 4 KiB, loading from each of %d distances further on (1 byte to 16 KiB)"
                            % (case["text"], where, len(LOAD_DISTANCES)), not unreported, "not reported at the distances %s" % ", ".join(unreported)))
    case = first_case(a64["cases"], "br", lambda c: int(c["expect"]["pc"], 16) >> 32)
    check("execution stage passes AArch64 '%s' to a target above 4 GiB" % case["text"], "aarch64", a64, case, False)
    wrong = copy.deepcopy(case)
    wrong["expect"]["pc"] = "%x" % (int(case["expect"]["pc"], 16) & 0xFFFFFFFF)
    check("execution stage reports AArch64 '%s' that drops the upper half of the target" % case["text"], "aarch64", a64, wrong, True)
    case = first_case(a64["cases"], "svc", lambda c: c.get("service"))
    check("execution stage passes AArch64 '%s' as exported" % case["text"], "aarch64", a64, case, False)

    mips = load(work, "mips", "execution")
    case = first_case(mips["cases"], "sw", stores_beyond(beyond))
    check("execution stage passes MIPS '%s' as exported" % case["text"], "mips", mips, case, False)
    check("execution stage reports a wrong store of MIPS '%s'" % case["text"], "mips", mips, flip_memory(case), True)
    case = first_case(mips["cases"], "syscall", lambda c: c.get("service"))
    check("execution stage passes MIPS '%s' as exported" % case["text"], "mips", mips, case, False)
    riscv = load(work, "riscv", "execution")
    # Exclusions are counted per reason: a rule that excludes the sb cases for one reason and the sh cases for another,
    # with more cases than the number of reported examples, must give both counts.
    stores = [c for c in riscv["cases"] if c["text"].split()[0] in ("sb", "sh")]
    want = {"control reason sb": sum(c["text"].startswith("sb ") for c in stores), "control reason sh": sum(c["text"].startswith("sh ") for c in stores)}
    entry = TARGETS["riscv"]
    saved = entry.get("exclude_execution")
    entry["exclude_execution"] = lambda c: "control reason " + c["text"].split()[0]
    try:
        res = run_stage("execution", "riscv", with_cases(riscv, stores), tmp)
    finally:
        entry["exclude_execution"] = saved
    results.append(("execution stage counts the excluded cases of each reason", res["exclusions"] == want and len(stores) > rv.MAX_REPORTED,
                    "counted %s, expected %s" % (json.dumps(res["exclusions"]), json.dumps(want))))
    case = first_case(riscv["cases"], "ecall", lambda c: c.get("service"))
    check("execution stage passes RISC-V 'ecall' as exported", "riscv", riscv, case, False)
    wrong = copy.deepcopy(case)
    wrong["expect"]["pc"] = "%x" % case["pc"]
    check("execution stage reports RISC-V 'ecall' that does not advance the program counter", "riscv", riscv, wrong, True)
    # A service instruction on which this tool faults is exported with the fault and without the service marker; the
    # reference completes the instruction, so the stage must report the case.
    for target, document, mnemonic in (("RISC-V", riscv, "ecall"), ("MIPS", mips, "syscall"), ("AArch64", a64, "svc")):
        case = first_case(document["cases"], mnemonic, lambda c: c.get("service"))
        wrong = copy.deepcopy(case)
        del wrong["service"]
        wrong["expect"]["fault"] = "unimplemented instruction"
        check("execution stage reports %s '%s' on which this tool faults" % (target, case["text"]), document["target"], document, wrong, True)
    # A SYSCALL that this tool executes without its writes to rcx and r11.
    case = first_case(x86["cases"], "syscall", lambda c: c.get("service") and all(c["regs"][r] != c["expect"]["regs"][r] for r in ("rcx", "r11")))
    wrong = copy.deepcopy(case)
    del wrong["service"]
    for reg in ("rcx", "r11"):
        wrong["expect"]["regs"][reg] = case["regs"][reg]
    check("execution stage reports x86 'syscall' that writes neither rcx nor r11", "x86", x86, wrong, True)
    return results


def control_partial_exclusions(work, tmp):
    """A case that the target entry excludes for a reason listed in its `partial_exclusions` is run and compared in
    every respect that the reason does not affect. For each such reason of the MIPS entry, a jalr and a jump with an
    executed delay-slot instruction pass as exported and count as compared and as partially compared; a link register
    that holds the address of the delay slot, a delay-slot result that is missing, and a wrong bit among the compared
    bits of the program counter are reported."""
    mips = load(work, "mips", "execution")
    entry = TARGETS["mips"]
    exclude, partial = entry["exclude_execution"], entry["partial_exclusions"]
    results = []

    def run(case):
        res = run_stage("execution", "mips", with_cases(mips, [case]), tmp)
        detail = json.dumps(res["failures"][0].get("diffs", res["failures"][0]["error"]) if res["failures"] else res["totals"])[:200]
        return res, detail

    def link_of(case):
        """The link register of a jalr case, when the case leaves the address after the delay slot in it."""
        words = case["text"].replace(",", " ").split()
        link = words[1] if len(words) == 3 else "$ra"
        return link if words[0] == "jalr" and link != "$zero" and int(case["expect"]["regs"][link], 16) == case["pc"] + 8 else None

    def slot_register(case):
        """A register that only the delay-slot instruction of a jr or jalr case changes."""
        changed = [name for name, value in case["regs"].items() if case["expect"]["regs"][name] != value and name != link_of(case)]
        return changed[0] if case["steps"] == 2 and changed else None

    for number, (reason, comparisons) in enumerate(partial.items(), start=1):
        mask = comparisons["pc_mask"]
        what = "partial exclusion %d of MIPS (bits %08x of the program counter compared)" % (number, mask)
        covered = [c for c in mips["cases"] if c["expect"]["fault"] is None and exclude(c) == reason]
        linked = next((c for c in covered if link_of(c)), None)
        slotted = next((c for c in covered if slot_register(c)), None)
        if linked is None or slotted is None:
            raise LookupError("%s has no exported jalr case with a link register, or no case with a delay-slot result" % what)
        for case in (linked, slotted):
            res, detail = run(case)
            t = res["totals"]
            results.append(("execution stage runs and passes '%s', %s" % (case["text"], what),
                            res["failure_count"] == 0 and (t["cases"], t["passed"], t["excluded"], t["partially_compared"]) == (1, 1, 0, 1)
                            and res["exclusions"] == {reason: 1} and res["partially_compared"] == {reason: 1}, detail))
        wrong = copy.deepcopy(linked)
        wrong["expect"]["regs"][link_of(linked)] = "%x" % (linked["pc"] + 4)
        res, detail = run(wrong)
        results.append(("execution stage reports '%s' that links to the delay slot, %s" % (linked["text"], what), res["failure_count"] == 1, detail))
        wrong = copy.deepcopy(slotted)
        wrong["expect"]["regs"][slot_register(slotted)] = slotted["regs"][slot_register(slotted)]
        res, detail = run(wrong)
        results.append(("execution stage reports '%s' without the result of its delay-slot instruction, %s" % (slotted["text"], what), res["failure_count"] == 1, detail))
        if mask:
            wrong = copy.deepcopy(slotted)
            wrong["expect"]["pc"] = "%x" % (int(slotted["expect"]["pc"], 16) ^ (mask & -mask))
            res, detail = run(wrong)
            results.append(("execution stage reports '%s' with a wrong compared bit of the program counter, %s" % (slotted["text"], what), res["failure_count"] == 1, detail))
    return results


X86_SHIFTS = ("shl", "sal", "shr", "sar")
X86_WIDE = ("rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi") + tuple("r%d" % n for n in range(8, 16))


def shift_by_cl(case):
    """For an exported x86-64 shift by cl that does not fault: the first word of its first operand, and the mask of the
    count, which has 6 bits for a 64-bit operand and 5 bits otherwise; None for any other case."""
    words = case["text"].replace(",", " ").split()
    if words[0] not in X86_SHIFTS or words[-1] != "cl" or case["expect"]["fault"] is not None:
        return None
    return words[1], 63 if words[1] in X86_WIDE or words[1] == "qword" else 31


def control_shift_flags(work, tmp):
    """The flags that the export marks as undefined after an x86-64 shift by cl follow the count in cl before the
    instruction: none with a masked count of 0, AF with a count of 1, OF and AF with a larger count (Intel SDM
    Vol. 2B, SAL/SAR/SHL/SHR). The execution stage therefore compares OF after a shift by one and every flag after a
    shift by zero."""
    x86 = load(work, "x86", "execution")

    def undefined(count):
        return [] if count == 0 else ["AF"] if count == 1 else ["OF", "AF"]

    shifts, different, own = [], [], 0
    for case in x86["cases"]:
        shift = shift_by_cl(case)
        if shift is None:
            continue
        operand, mask = shift
        count = int(case["regs"]["rcx"], 16) & mask
        shifts.append((case, count))
        if case["expect"]["undefinedFlags"] != undefined(count):
            different.append(case["text"])
        # A shift of ecx or rcx overwrites the count; the count after the instruction would give other flags.
        if operand in ("ecx", "rcx") and undefined(int(case["expect"]["regs"]["rcx"], 16) & mask) != undefined(count):
            own += 1
    classes = [sum(1 for _, count in shifts if undefined(count) == flags) for flags in ([], ["AF"], ["OF", "AF"])]
    results = [("the x86-64 export marks the undefined flags of each shift by cl by the count in cl before the instruction",
                not different and all(classes) and own > 0,
                "%d shifts by cl, %d with other flags (first '%s'); counts of 0, of 1, larger: %s; shifts of ecx or rcx whose result gives other flags: %d"
                % (len(shifts), len(different), (different + [""])[0], json.dumps(classes), own))]
    for count, flag, label in ((1, "OF", "a wrong OF after a shift by cl with a count of one"), (0, "AF", "a changed AF after a shift by cl with a count of zero")):
        case = next((c for c, n in shifts if n == count), None)
        if case is None:
            raise LookupError("no exported shift by cl with a masked count of %d" % count)
        res = run_stage("execution", "x86", with_cases(x86, [case]), tmp)
        wrong = copy.deepcopy(case)
        wrong["expect"]["flags"][flag] ^= 1
        reported = run_stage("execution", "x86", with_cases(x86, [wrong]), tmp)
        results.append(("execution stage passes x86 '%s' and reports %s" % (case["text"], label),
                        res["failure_count"] == 0 and res["totals"]["passed"] == 1 and reported["failure_count"] == 1,
                        "%d and %d failure(s)" % (res["failure_count"], reported["failure_count"])))
    return results


# The families of generated programs (src/core/gen/programs.ts); program k of a family is generated/<family>-<firstInit + k>.
GENERATED_FAMILIES = ("expr", "branch", "loop", "array", "mixed")
# The expectations of a program run that the controls make wrong, one per run, in turn.
RUN_EXPECTATIONS = ("value", "executed", "output", "status", "data", "home")


def corrupt_run(case, kind):
    """A copy of an exported program run with one wrong expectation of the given kind, and the beginning of the line
    with which the program stage reports that expectation; None when the run has no expectation of the kind."""
    wrong = copy.deepcopy(case)
    expect = wrong["expect"]
    if kind == "value":
        expect["returnValue" if expect["status"] == "exited" else "trapCode"] += 1
        return wrong, "value:"
    if kind == "executed":
        expect["executed"] += 1
        return wrong, "executed instructions:"
    if kind == "output":
        expect["output"] = expect["output"] + [1]
        return wrong, "output:"
    if kind == "status":
        expect["status"] = "trap" if expect["status"] == "exited" else "exited"
        return wrong, "status:"
    if kind == "data" and expect["dataAfter"]:
        expect["dataAfter"] = "%02x" % (int(expect["dataAfter"][:2], 16) ^ 0x5A) + expect["dataAfter"][2:]
        return wrong, "data region differs"
    if kind == "home" and expect["homes"]:
        name = sorted(expect["homes"])[0]
        expect["homes"][name] = "%x" % (int(expect["homes"][name], 16) ^ 1)
        return wrong, "register %s:" % name
    return None


def control_program_runs(work, tmp):
    """The export holds the argument tuples of the corpus: every hand-written tuple, read here from examples/index.json
    and validation/corpus/edge/args.json, and for every generated program the number of tuples that the exporter was
    asked for; the program export of every target holds the same runs. The program stage runs every run it is given
    and reports exactly the runs with a wrong expectation: it is given every exported RISC-V run, and every second run
    of each program group and outcome (normal end or runtime error) has one wrong expectation."""
    semantics = load(work, "common", "semantics")
    want = sorted((c["name"], json.dumps(c["args"])) for c in semantics["cases"])
    examples = json.load(open(os.path.join(REPO, "examples", "index.json"), encoding="utf-8"))["examples"]
    edge = json.load(open(os.path.join(REPO, "validation", "corpus", "edge", "args.json"), encoding="utf-8"))
    written = {("example/" + e["id"], json.dumps(a)) for e in examples if not e.get("expectDiagnostics") for a in e["args"]}
    written |= {("edge/" + name, json.dumps(a)) for name, tuples in edge.items() for a in tuples}
    results = [("the export holds every hand-written argument tuple of the corpus", written <= set(want),
                "%d of %d tuples" % (len(written & set(want)), len(written)))]
    exports = [("semantics export", semantics["cases"])]
    for target in sorted(d for d in os.listdir(work) if d != "common" and os.path.isdir(os.path.join(work, d))):
        cases = load(work, target, "programs")["cases"]
        exports.append(("program export of %s" % target, cases))
        got = sorted((c["name"], json.dumps(c["args"])) for c in cases)
        results.append(("the program export of %s holds the runs of the semantics export" % target, got == want, "%d of %d runs" % (len(got), len(want))))
    # The generated programs are counted against the settings that the exporter was given, not against another exported
    # file: the programs asked for of each family, each with the number of argument tuples asked for, or with one,
    # empty, tuple when the program has no parameters.
    corpus = semantics["corpus"]
    asked = corpus["argumentTuplesPerProgram"]
    names = {"generated/%s-%d" % (family, corpus["firstInit"] + k) for family in GENERATED_FAMILIES for k in range(corpus["programsPerFamily"])}
    for label, cases in exports:
        tuples = {}
        for c in cases:
            if c["name"].startswith("generated/"):
                tuples.setdefault(c["name"], []).append(c["args"])
        short = sorted(n for n, runs in tuples.items() if len(runs) != (asked if runs[0] else 1))
        results.append(("the %s holds the %d generated programs asked for, each with the %d argument tuples asked for, or with one when it has no parameters"
                        % (label, len(names), asked), set(tuples) == names and not short,
                        "%d programs, %d of them with another number of tuples: %s" % (len(tuples), len(short), ", ".join(short[:4]))))
    # The program stage is given every exported run of one target. The first, third, fifth, and so on run of each
    # program group and outcome has one wrong expectation. The kind of expectation changes from one such run to the
    # next, and a kind that no run has had so far comes first, so that every kind occurs when some run has it.
    programs = load(work, "riscv", "programs")
    cases, corrupted, seen, used = [], [], {}, dict.fromkeys(RUN_EXPECTATIONS, 0)
    for case in programs["cases"]:
        klass = (case["name"].split("/")[0], case["expect"]["status"])
        seen[klass] = seen.get(klass, 0) + 1
        made = None
        if seen[klass] % 2 == 1:
            turn = [RUN_EXPECTATIONS[(seen[klass] // 2 + step) % len(RUN_EXPECTATIONS)] for step in range(len(RUN_EXPECTATIONS))]
            for kind in sorted(turn, key=lambda k: used[k] > 0):
                made = corrupt_run(case, kind)
                if made:
                    used[kind] += 1
                    corrupted.append((klass, made[0]["name"], made[0]["args"], made[1], kind))
                    break
        cases.append(made[0] if made else case)
    saved = rv.MAX_REPORTED
    rv.MAX_REPORTED = len(cases)
    try:
        res = run_stage("programs", "riscv", with_cases(programs, cases), tmp)
    finally:
        rv.MAX_REPORTED = saved
    classes = {}
    for klass, _, _, _, _ in corrupted:
        classes[klass] = classes.get(klass, 0) + 1
    needed = [(group, status) for group in ("example", "edge") for status in ("exited", "trap")] + ([("generated", "exited")] if names else [])
    wrong_codes = sum(1 for klass, _, _, _, kind in corrupted if klass[1] == "trap" and kind == "value")
    counts = ", ".join("%s %s %d" % (group, "runtime error" if status == "trap" else "normal end", n) for (group, status), n in sorted(classes.items()))
    results.append(("the runs with a wrong expectation include runs of every program group, runs that end with a runtime error, a wrong error code, "
                    "and every kind of expectation", all(klass in classes for klass in needed) and wrong_codes > 0 and all(used.values()),
                    "%s; %s; wrong error codes %d" % (counts, ", ".join("%s %d" % item for item in used.items()), wrong_codes)))
    totals = res["totals"]
    results.append(("program stage runs each of the %d runs it is given and passes the %d runs without a wrong expectation"
                    % (len(cases), len(cases) - len(corrupted)),
                    totals["runs"] == len(cases) and totals["passed"] == len(cases) - len(corrupted) and res["failure_count"] == len(corrupted),
                    "%s, %d failure(s)" % (json.dumps(totals), res["failure_count"])))
    # The failures are reported in the order of the runs: each must be the next run with a wrong expectation, with that
    # expectation as its only difference.
    reported = [(f["program"], f["args"], f["diffs"]) for f in res["failures"]]
    different = [(name, args) for (_, name, args, line, _), got in zip(corrupted, reported)
                 if got[:2] != (name, args) or len(got[2]) != 1 or not got[2][0].startswith(line)]
    results.append(("program stage reports each of the %d runs with a wrong expectation, by that expectation alone, and no other run" % len(corrupted),
                    len(reported) == len(corrupted) and not different,
                    "%d reported; the first that differs: %s" % (len(reported), json.dumps(different[:1]))))
    return results


# ---- cross-engine agreement ---------------------------------------------------------------------

def control_crosscheck_limits(work, tmp):
    """scripts/crosscheck-corpus.ts counts a run as passed only when no engine disagrees and no engine stopped at its
    step limit. With a statement limit that some runs of the corpus exceed, the runs that stop at the limit are counted
    as incomplete and not as passed, every run is counted once, and the script exits with a failure status."""
    out = os.path.join(tmp, "crosscheck-limit.json")
    done = subprocess.run(["node", os.path.join(REPO, "scripts", "crosscheck-corpus.ts"), "--per-family", "1", "--max-steps", "40", "--out", out],
                          capture_output=True, text=True)
    if not os.path.exists(out):
        return [("crosscheck-corpus.ts writes a result with a low statement limit", False, (done.stdout + done.stderr).strip()[-300:])]
    result = json.load(open(out))
    t = result["totals"]
    # The runs in which the reference evaluator itself stopped at the limit.
    stopped = sum(g["limit"] for g in result["byGroup"].values())
    groups = all(g["passed"] + g["incomplete"] <= g["runs"] and g["incomplete"] >= g["limit"] and g["passed"] <= g["runs"] - g["limit"]
                 for g in result["byGroup"].values())
    targets = all(v["runs"] == t["runs"] and v["agreed"] + v["incomplete"] <= v["runs"] and v["agreed"] <= t["runs"] - stopped and v["incomplete"] >= stopped
                  for v in result["perTarget"].values())
    listed = len(result["incomplete"]) == min(t["incomplete"], 25) and all(r["limitReached"] for r in result["incomplete"])
    return [("crosscheck-corpus.ts counts the runs that stop at a step limit as incomplete, not as passed, and fails",
             done.returncode == 1 and stopped > 0 and t["passed"] > 0 and t["incomplete"] >= stopped
             and t["passed"] + t["failed"] + t["incomplete"] == t["runs"] and t["passed"] <= t["runs"] - stopped
             and result["failure_count"] == t["failed"] + t["incomplete"] and groups and targets and listed,
             "exit status %d, %s, %d run(s) in which the reference evaluator stopped at the limit" % (done.returncode, json.dumps(t), stopped))]


# ---- registration and source manifest -----------------------------------------------------------

def control_target_modules(work, tmp):
    """validation/targets.py registers every validation/targets_<id>.py next to it, also in a folder whose name holds
    a bracket expression, and no module of the folder that the expression would match as a glob pattern."""
    folder = os.path.join(tmp, "targets[1]")
    other = os.path.join(tmp, "targets1")
    for path, entry in ((folder, "control"), (other, "other")):
        os.makedirs(path)
        with open(os.path.join(path, "targets_%s.py" % entry), "w", newline="\n") as f:
            f.write("TARGET = {'reference': '%s entry'}\n" % entry)
    shutil.copy(os.path.join(HERE, "targets.py"), folder)
    code = "import sys; sys.path.insert(0, sys.argv[1]); from targets import TARGETS; print(' '.join(sorted(TARGETS)))"
    done = subprocess.run([sys.executable, "-c", code, folder], capture_output=True, text=True)
    names = done.stdout.split()
    return [("targets.py registers a new validation/targets_<id>.py in a folder named with brackets", "control" in names and "other" not in names,
             done.stdout.strip() or done.stderr.strip()[-200:])]


def summarize(results_folder, *options):
    """Run the summary on a folder of result files without writing anything (--check)."""
    return subprocess.run(["node", os.path.join(REPO, "scripts", "summarize-validation.ts"), "--check", "--results", results_folder] + list(options),
                          capture_output=True, text=True)


def control_missing_targets(work, tmp):
    """run_validation.py stops when the work folder holds inputs of a target without a reference-tool entry, when the
    target named has no entry, and when the work folder does not exist; the summary stops when a result file is
    missing, and names every missing one, unless a partial summary is asked for."""
    folder = os.path.join(tmp, "guard-work")
    for name in ("common", "riscv", "demo"):
        os.makedirs(os.path.join(folder, name))
    results = []
    for label, args, message in (
        ("run_validation.py --target all stops on inputs of a target without an entry", ["--target", "all", "--work", folder], "entry: demo"),
        ("run_validation.py --target demo stops on a target without an entry", ["--target", "demo", "--work", folder], "has no reference-tool entry"),
        ("run_validation.py stops when the work folder does not exist", ["--work", os.path.join(tmp, "no-work")], "does not exist"),
    ):
        done = subprocess.run([sys.executable, os.path.join(HERE, "run_validation.py")] + args + ["--results", os.path.join(tmp, "guard-results")],
                              capture_output=True, text=True)
        results.append((label, done.returncode == 2 and message in done.stderr, (done.stdout + done.stderr).strip()[-200:]))
    empty = os.path.join(tmp, "summary-results")
    os.makedirs(empty)
    done = summarize(empty)
    names = ["source manifest", "cross-engine agreement", "semantics"] + ["%s %s" % (t, s) for t in sorted(TARGETS) for s in rv.STAGES]
    missing = next((line for line in done.stderr.splitlines() if line.startswith("no result file for: ")), "")
    results.append(("the summary stops when result files are missing and names the manifest, the cross-engine agreement, the semantics, and every stage",
                    done.returncode == 1 and sorted(missing[len("no result file for: "):].split("; ")) == sorted(names) and "no summary was written" in done.stderr,
                    (done.stdout + done.stderr).strip()[-200:]))
    done = summarize(empty, "--partial")
    partial = next((line for line in done.stdout.splitlines() if line.startswith("the summary is partial")), "")
    results.append(("the summary accepts missing result files, and names them, when a partial summary is asked for",
                    done.stderr.strip() == "" and all(n in partial for n in names), (done.stdout + done.stderr).strip()[-200:]))
    return results


def manifest_script(root, *arguments):
    """Run the source-manifest script of a tree with the given arguments."""
    return subprocess.run(["node", os.path.join(root, "scripts", "source-manifest.mjs")] + list(arguments), capture_output=True, text=True)


def control_source_manifest(work, tmp):
    """The source manifest lists exactly the files that its patterns name, whatever .gitignore says and whatever else
    the tree holds; it is the same for a checkout with CRLF line endings; it combines the file hashes in path order;
    and --check accepts the tree it was recorded for, also after a change outside the patterns, and reports a changed,
    added, or removed file, a wrong file count, and a combined hash that is not the hash of the recorded entries or
    not that of the tree."""
    script = os.path.join(REPO, "scripts", "source-manifest.mjs")
    hashed = {
        "package.json": "{\"type\": \"module\"}\n",
        "package-lock.json": "{\"lockfileVersion\": 3}\n",
        "tsconfig.json": "{}\n",
        "src/core/a.ts": "export const a = 1;\n// line two\n",
        "src/core/target/b.ts": "export const b = 2;\n",
        # Three paths whose order by name differs from their order as whole paths.
        "src/core/order/b.ts": "1\n",
        "src/core/order-c.ts": "2\n",
        "src/core/order.ts": "3\n",
        "scripts/source-manifest.mjs": open(script, encoding="utf-8").read(),
        "scripts/validate-all.mjs": "// pipeline\n",
        "scripts/lib/corpus.ts": "export const c = 3;\n",
        "scripts/lib/deep/d.ts": "export const d = 4;\n",
        "validation/run_validation.py": "print('harness')\n",
        "validation/requirements.txt": "unicorn==2.1.4\n",
        "validation/corpus/edge/p.py": "def main():\n    return 0\n",
        "examples/index.json": "{\"examples\": []}\n",
        "examples/a.py": "def main():\n    return 1\n",
    }
    others = {
        # A pattern of .gitignore that names hashed files: the manifest does not read .gitignore.
        ".gitignore": "*.ts\nsrc/core/a.ts\nvalidation/\n",
        "README.md": "# Readme\n",
        "docs/validation.md": "# Validation methods\n",
        "docs/validation-results.md": "# Validation results\n",
        "docs/coverage.md": "# Instruction coverage\n",
        "src/app/data/support-matrix.json": "{\"source\": \"\"}\n",
        "src/cli/main.ts": "export const cli = 1;\n",
        "tests/a.test.ts": "export const t = 1;\n",
        "scripts/benchmark.ts": "export const bench = 1;\n",
        "examples/notes.txt": "notes\n",
        "examples/api/request.json": "{}\n",
        "validation/results/riscv/encoding.json": "{\"failure_count\": 0}\n",
        "validation/work/riscv/encoding.json": "{\"programs\": []}\n",
        "validation/run.log": "log of a run\n",
        "src/core/debug.log": "log\n",
        "node_modules/package/index.js": "export default 1;\n",
    }
    trees = {}
    for name, eol in (("lf", "\n"), ("crlf", "\r\n")):
        root = os.path.join(tmp, "tree-" + name)
        # The files outside the patterns differ between the two trees, and one tree has none of them.
        files = dict(hashed, **({rel: text + "tree %s\n" % name for rel, text in others.items()} if name == "crlf" else {".gitignore": others[".gitignore"]}))
        for rel, text in files.items():
            path = os.path.join(root, *rel.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", newline="") as f:
                f.write(text.replace("\n", eol))
        for rel, data in (("src/core/image.bin", b"\x00\x01\r\n\x02"), ("validation/__pycache__/run_validation.cpython-312.pyc", name.encode() + b"\x00")):
            os.makedirs(os.path.dirname(os.path.join(root, *rel.split("/"))), exist_ok=True)
            with open(os.path.join(root, *rel.split("/")), "wb") as f:
                f.write(data)
        trees[name] = root
    out, manifests = {}, {}
    for name, root in trees.items():
        dst = os.path.join(tmp, "manifest-%s.json" % name)
        done = manifest_script(root, "--out", dst)
        manifests[name] = json.load(open(dst)) if done.returncode == 0 and os.path.exists(dst) else {"sha256": done.stderr.strip()[-200:], "entries": []}
        out[name] = manifests[name]["sha256"]
    results = [("source manifest of a CRLF checkout with other files outside the patterns equals that of an LF checkout", out["lf"] == out["crlf"],
                "%s / %s" % (out["lf"], out["crlf"]))]
    entries = manifests["crlf"]["entries"]
    paths = [e["path"] for e in entries]
    expected = set(hashed) | {"src/core/image.bin"}
    results.append(("source manifest lists exactly the files of its patterns, without reading .gitignore", sorted(paths) == sorted(expected),
                    " ".join(sorted(set(paths) ^ expected))))
    # The combined hash, recomputed here from the entries in the byte order of their UTF-8 paths.
    ordered = sorted(entries, key=lambda e: e["path"].encode("utf-8"))
    combined = hashlib.sha256("".join("%s\0%s\n" % (e["path"], e["sha256"]) for e in ordered).encode("utf-8")).hexdigest()
    results.append(("source manifest lists the files and combines their hashes in path order",
                    entries == ordered and combined == out["crlf"] and manifests["crlf"]["files"] == len(entries), " ".join(paths)))
    printed = manifest_script(trees["crlf"], "--hash")
    results.append(("source-manifest.mjs --hash prints the combined hash", printed.stdout.strip() == out["crlf"], (printed.stdout + printed.stderr).strip()[-200:]))

    def check(label, recorded, expect_difference, tree="crlf"):
        done = manifest_script(trees[tree], "--check", recorded)
        ok = done.returncode == 0 if expect_difference is None else done.returncode == 1 and expect_difference in done.stdout
        results.append((label, ok, (done.stdout + done.stderr).strip()[-300:]))

    recorded = os.path.join(tmp, "manifest-lf.json")
    check("source-manifest.mjs --check accepts an unchanged tree", recorded, None)
    for rel in ("README.md", "docs/validation.md", "src/app/data/support-matrix.json", "tests/a.test.ts", "validation/results/riscv/encoding.json"):
        with open(os.path.join(trees["crlf"], *rel.split("/")), "a", newline="") as f:
            f.write("changed\r\n")
    check("source-manifest.mjs --check accepts a tree with changes outside the patterns only", recorded, None)

    def variant(name, change):
        """A copy of the recorded manifest with one change, as a file."""
        document = copy.deepcopy(manifests["lf"])
        change(document)
        path = os.path.join(tmp, "manifest-%s.json" % name)
        with open(path, "w", newline="\n") as f:
            json.dump(document, f)
        return path

    def reorder(document):
        document["entries"].reverse()
        document["sha256"] = hashlib.sha256("".join("%s\0%s\n" % (e["path"], e["sha256"]) for e in document["entries"]).encode("utf-8")).hexdigest()

    check("source-manifest.mjs --check reports a recorded file count that is not the number of entries",
          variant("count", lambda d: d.update(files=d["files"] + 1)), "the recorded file count")
    check("source-manifest.mjs --check reports a recorded combined hash that is not the hash of the recorded entries",
          variant("hash", lambda d: d.update(sha256="0" * 64)), "the recorded combined hash is not the hash of the recorded entries")
    check("source-manifest.mjs --check reports recorded entries in another order with their own combined hash", variant("order", reorder),
          "the recorded combined hash is not that of the tree")
    with open(os.path.join(trees["crlf"], "src", "core", "a.ts"), "a", newline="") as f:
        f.write("// changed\r\n")
    check("source-manifest.mjs --check reports a changed file", recorded, "changed  src/core/a.ts")
    with open(os.path.join(trees["lf"], "scripts", "lib", "new.ts"), "w", newline="\n") as f:
        f.write("export const n = 5;\n")
    os.remove(os.path.join(trees["lf"], "examples", "a.py"))
    done = manifest_script(trees["lf"], "--check", recorded)
    results.append(("source-manifest.mjs --check reports an added and a removed file",
                    done.returncode == 1 and "added    scripts/lib/new.ts" in done.stdout and "removed  examples/a.py" in done.stdout,
                    (done.stdout + done.stderr).strip()[-300:]))
    return results


IMPORTED = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)['"](\.{1,2}/[^'"]+)['"]""")


def control_manifest_coverage(work, tmp):
    """The source manifest of this tree covers every file that the validation reads or executes: the scripts that
    scripts/validate-all.mjs and the harness run, every module they import, directly or through another module, the
    modules of the harness, the corpus programs with their argument tuples, and package.json."""
    done = manifest_script(REPO, "--out", os.path.join(tmp, "manifest-tree.json"))
    covered = {e["path"] for e in json.load(open(os.path.join(tmp, "manifest-tree.json")))["entries"]} if done.returncode == 0 else set()

    def text_of(rel):
        return open(os.path.join(REPO, *rel.split("/")), encoding="utf-8").read()

    # The scripts that the pipeline starts, and those that the modules of the harness start.
    harness = sorted("validation/" + name for name in os.listdir(HERE) if name.endswith(".py"))
    started = {"scripts/validate-all.mjs"} | set(re.findall(r"'((?:scripts|validation)/[\w./-]+\.(?:ts|mjs|py))'", text_of("scripts/validate-all.mjs")))
    for rel in harness:
        started |= {"scripts/" + name for name in re.findall(r'"scripts", "([\w.-]+\.(?:ts|mjs))"', text_of(rel))}
    # Every module that a started script imports, followed through the modules it imports.
    modules, pending = set(), sorted(rel for rel in started if not rel.endswith(".py"))
    while pending:
        rel = pending.pop()
        if rel in modules or not os.path.exists(os.path.join(REPO, *rel.split("/"))):
            modules.add(rel)
            continue
        modules.add(rel)
        for target in IMPORTED.findall(text_of(rel)):
            pending.append(os.path.normpath(os.path.join(os.path.dirname(rel), target)).replace(os.sep, "/"))
    examples = json.load(open(os.path.join(REPO, "examples", "index.json"), encoding="utf-8"))["examples"]
    edge = os.path.join(REPO, "validation", "corpus", "edge")
    read = {"package.json", "examples/index.json"}
    read |= {"examples/" + e["file"] for e in examples if not e.get("expectDiagnostics")}
    read |= {"validation/corpus/edge/" + name for name in os.listdir(edge) if name.endswith(".py") or name == "args.json"}
    needed = started | modules | set(harness) | read
    missing = sorted(needed - covered)
    return [("the source manifest of this tree covers the %d files that the validation reads or executes (%d scripts started, %d modules imported)"
             % (len(needed), len(started), len(modules - started)), bool(covered) and not missing and len(modules) > len(started),
             "not covered: %s" % ", ".join(missing[:8]))]


def control_source_link(work, tmp):
    """A stage records the combined hash of the source tree in its result and stops on an input that was exported from
    another tree; the summary accepts a result that records the hash of the tree and refuses one that records another
    hash or none."""
    tree = manifest_script(REPO, "--hash").stdout.strip()
    other = "0" * 64
    programs = load(work, "riscv", "programs")
    results = []

    def stage(name, source):
        """Run the RISC-V program stage of run_validation.py on two exported runs that record `source` as their tree."""
        folder = os.path.join(tmp, "link-work-" + name)
        os.makedirs(os.path.join(folder, "riscv"))
        with open(os.path.join(folder, "riscv", "programs.json"), "w", newline="\n") as f:
            json.dump(dict(with_cases(programs, programs["cases"][:2]), source=source), f)
        out = os.path.join(tmp, "link-results-" + name)
        command = [sys.executable, os.path.join(HERE, "run_validation.py"), "--target", "riscv", "--stage", "programs", "--work", folder, "--results", out]
        return subprocess.run(command, capture_output=True, text=True), out

    done, recorded = stage("same", tree)
    path = os.path.join(recorded, "riscv", "programs.json")
    result = json.load(open(path)) if os.path.exists(path) else {}
    results.append(("a stage records the combined hash of the source tree and the result format in its result",
                    done.returncode == 0 and len(tree) == 64 and result.get("source") == tree and result.get("format") == rv.RESULT_FORMAT,
                    (done.stdout + done.stderr).strip()[-300:]))
    done, refused = stage("other", other)
    written = os.path.exists(os.path.join(refused, "riscv", "programs.json"))
    results.append(("a stage stops on an input that was exported from another source tree, and writes no result",
                    done.returncode == 2 and "was exported from the source tree " + other in done.stderr and not written,
                    (done.stdout + done.stderr).strip()[-300:]))

    def refusal(done, rel):
        """The line with which the summary refuses the result file `rel` for the source tree it records, or None."""
        return next((line for line in done.stderr.splitlines() if rel + " records the source tree " in line), None)

    done = summarize(recorded, "--partial")
    results.append(("the summary accepts a result that records the hash of the source tree", done.stderr.strip() == "" and "the summary is partial" in done.stdout,
                    (done.stdout + done.stderr).strip()[-300:]))
    for label, change in (("another source tree", lambda d: d.update(source=other)), ("no source tree", lambda d: d.pop("source", None))):
        document = dict(result)
        change(document)
        with open(path, "w", newline="\n") as f:
            json.dump(document, f)
        done = summarize(recorded, "--partial")
        line = refusal(done, "riscv/programs.json")
        recorded_as = other if "source" in document else "(none)"
        results.append(("the summary refuses a stage result that records %s" % label,
                        done.returncode == 1 and line is not None and recorded_as in line and "no summary was written" in done.stderr,
                        (done.stdout + done.stderr).strip()[-300:]))
    # The files that are not written by run_validation.py are held to the same hash.
    for rel, document in (("crosscheck.json", {"source": other}), ("source-manifest.json", {"sha256": other, "files": 0, "entries": []})):
        folder = os.path.join(tmp, "link-" + rel.split(".")[0])
        os.makedirs(folder)
        with open(os.path.join(folder, rel), "w", newline="\n") as f:
            json.dump(document, f)
        done = summarize(folder, "--partial")
        results.append(("the summary refuses %s when it records another source tree" % rel, done.returncode == 1 and refusal(done, rel) is not None,
                        (done.stdout + done.stderr).strip()[-300:]))
    return results


CONTROLS = [control_reencoding, control_wrong_rejections, control_relative_branch, control_unsupported_without_capstone,
            control_branch_pseudoinstructions, control_encoding, control_fill, control_execution, control_partial_exclusions, control_shift_flags,
            control_program_runs, control_crosscheck_limits, control_target_modules, control_missing_targets, control_source_manifest, control_manifest_coverage, control_source_link]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default=os.path.join(HERE, "work"))
    args = ap.parse_args()
    passed = total = 0
    with tempfile.TemporaryDirectory(prefix="isa-trace-lab-controls-") as tmp:
        for control in CONTROLS:
            try:
                results = control(args.work, tmp)
            except Exception as e:  # A control that cannot run counts as failed.
                results = [(control.__name__, False, "%s: %s" % (type(e).__name__, e))]
            for label, ok, detail in results:
                total += 1
                passed += bool(ok)
                print("%s  %s%s" % ("pass" if ok else "FAIL", label, "" if ok else "  (%s)" % detail))
    print("%d of %d controls pass" % (passed, total))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
