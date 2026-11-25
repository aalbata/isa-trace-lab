"""Independent validation of ISA Trace Lab against reference tools.

Usage:
    python validation/run_validation.py [--target <id>|all]
                                        [--stage encoding|decoding|execution|programs|semantics|all]
                                        [--work validation/work] [--results validation/results]

Inputs are produced by `node scripts/export-validation.ts`. Stages:

  encoding   Each program is assembled by Clang's integrated assembler and linked by LLD at
             the load address; the bytes must equal the bytes produced by this tool. A
             pseudoinstruction program whose bytes differ is compared line by line: each line
             of its text is assembled on its own for the address that the line has in this
             tool's program, and Clang's bytes of the whole text must be its bytes of the
             lines in source order. An expansion that differs from Clang's is accepted only
             when both expansions, run in Unicorn at the address of the line from each of
             several initial states, leave every register, every flag, and every byte of the
             mapped memory outside the two expansions equal. The program's bytes must equal
             Clang's bytes of its lines in source order, with this tool's expansion in place
             of Clang's for each accepted line.
  decoding   Byte sequences accepted by this tool's decoder are reassembled from the decoded
             text by the reference assembler and must give the original bytes; Capstone must
             name the same instruction. Alternate encodings are checked for equivalence.
             Rejected byte sequences must not be encodings of implemented instructions. The
             rejections as unsupported that Capstone does not decode are counted; where the
             target entry states which of them are defined encodings, any other one fails.
  execution  Single instructions run in Unicorn from the same initial state; registers, flags,
             the full-width program counter, and every byte of the data and stack regions must
             match. Both regions start with bytes that differ between any two addresses a power
             of two apart, so a load from an address that is wrong by such a distance gives
             another value. The address of a load into a zero register is not observable here;
             the encoding and decoding stages cover the operand fields of such an instruction.
             A case that the target entry excludes is left out, or, when the entry states which
             comparisons its reason affects, compared in every other respect.
  programs   Compiled programs run in Unicorn with every argument tuple of the corpus; output,
             exit value, error code, executed instruction count, data memory, and variable home
             registers must match.
  semantics  The Python reference evaluator, and plain CPython where values stay in range,
             must agree with the TypeScript reference evaluator and the IR interpreter.

Every stage writes a JSON result with denominators, passes, failures, and exclusions with the
number of cases for each reason, the number of the result format, and the combined hash of the
source tree (scripts/source-manifest.mjs). The hash is computed when the stage starts; a stage
stops when its input was exported from a tree with another hash. scripts/summarize-validation.ts
checks the format and the hash of every result.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import capstone as cs  # noqa: E402
import unicorn as uc  # noqa: E402
from elftools.elf.elffile import ELFFile  # noqa: E402
from unicorn import x86_const  # noqa: E402

from reference_eval import run_cpython, run_reference  # noqa: E402
from targets import TARGETS  # noqa: E402

CODE_BASE = 0x00400000
CODE_SIZE = 0x10000
DATA_BASE = 0x10000000
DATA_SIZE = 0x10000
STACK_TOP = 0x7FFFF000
STACK_SIZE = 0x10000
STACK_BASE = STACK_TOP - STACK_SIZE
# The writable regions; the code region is read-only for this tool.
REGIONS = ((DATA_BASE, DATA_SIZE), (STACK_BASE, STACK_SIZE))
LINKER_SCRIPT = "SECTIONS {\n  .text 0x00400000 : { *(.text) }\n}\n"
MAX_REPORTED = 25
# Longest x86-64 instruction; reassembled lines placed this far apart cannot overlap.
MAX_INSTRUCTION_LENGTH = 15
# Format of the result files; scripts/summarize-validation.ts reads this format only.
RESULT_FORMAT = 4


class StaleInput(Exception):
    """An input file of a stage was exported from another source tree than the one the stage runs in."""


def source_tree_hash():
    """Combined hash of the files that the validation reads or executes, computed now by scripts/source-manifest.mjs
    from the tree that contains this file (docs/validation.md, section 5)."""
    done = subprocess.run(["node", os.path.join(REPO, "scripts", "source-manifest.mjs"), "--hash"], capture_output=True, text=True)
    value = done.stdout.strip()
    if done.returncode != 0 or len(value) != 64:
        raise RuntimeError("scripts/source-manifest.mjs --hash failed: " + (done.stderr or done.stdout)[:800])
    return value


def read_input(work, folder, name, source):
    """An input file that `node scripts/export-validation.ts` wrote. When `source` is given, the file must record that
    hash as the source tree it was exported from; this tool's results in it would otherwise be those of another tree."""
    path = os.path.join(work, folder, name + ".json")
    with open(path) as f:
        data = json.load(f)
    if source is not None and data.get("source") != source:
        raise StaleInput("%s was exported from the source tree %s, and the source tree is now %s; run node scripts/export-validation.ts again"
                         % (path, data.get("source", "(not recorded)"), source))
    return data


def tool_versions():
    import ziglang
    zig = [sys.executable, "-m", "ziglang"]
    clang = subprocess.run(zig + ["cc", "--version"], capture_output=True, text=True).stdout.splitlines()[0]
    from importlib.metadata import version as installed
    # Installed package versions; the module strings are recorded as well because Capstone 5.0.9's
    # Python module reports "5.0.7" in __version__ and its core library reports 5.0.
    return {
        "python": sys.version.split()[0],
        "ziglang": installed("ziglang"),
        "zig": subprocess.run(zig + ["version"], capture_output=True, text=True).stdout.strip(),
        "clang": clang,
        "capstone": installed("capstone"),
        "capstone_module_string": cs.__version__,
        "capstone_core": "%d.%d" % cs.cs_version()[:2],
        "unicorn": installed("unicorn"),
        "unicorn_core": ".".join(str(x) for x in uc.uc_version()[:2]),
        "pyelftools": installed("pyelftools"),
    }


def assemble(target, text, workdir, tag, symbols=None):
    """Assemble and link `text` at the code base; return the bytes of the .text section.

    `symbols` maps names of branch targets outside the program to absolute addresses. They are
    defined in the linker script, so the assembler emits a relocation and the linker resolves it.
    """
    cfg = TARGETS[target]
    src = os.path.join(workdir, tag + ".s")
    elf = os.path.join(workdir, tag + ".elf")
    script = os.path.join(workdir, tag + ".ld")
    with open(script, "w", newline="\n") as f:
        for name, value in (symbols or {}).items():
            f.write("%s = 0x%08x;\n" % (name, value))
        f.write(LINKER_SCRIPT)
    with open(src, "w", newline="\n") as f:
        f.write(text)
    cmd = [sys.executable, "-m", "ziglang", "cc", "-target", cfg["triple"], "-mcpu=" + cfg["cpu"], "-g0", "-nostdlib", "-static",
           "-Wl,-T," + script, "-Wl,-e,_start", "-o", elf, src] + cfg.get("cc_flags", [])
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode != 0 or not os.path.exists(elf):
        return None, done.stderr.strip()
    with open(elf, "rb") as f:
        section = ELFFile(f).get_section_by_name(".text")
        if section is None or section["sh_addr"] != CODE_BASE:
            return None, "linked image has no .text section at the code base"
        return section.data(), ""


def assemble_many(target, jobs, workdir):
    """jobs: list of (tag, text, symbols). Returns {tag: (bytes or None, message)}."""
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(2, (os.cpu_count() or 4) - 2)) as pool:
        futures = {pool.submit(assemble, target, text, workdir, tag, symbols): tag for tag, text, symbols in jobs}
        for fut in concurrent.futures.as_completed(futures):
            out[futures[fut]] = fut.result()
    return out


def first_difference(ours, ref, insns):
    limit = min(len(ours), len(ref))
    at = next((i for i in range(limit) if ours[i] != ref[i]), limit)
    address = CODE_BASE + at
    for ins in insns:
        if ins["a"] <= address < ins["a"] + ins["l"]:
            o = ours[ins["a"] - CODE_BASE: ins["a"] - CODE_BASE + ins["l"]].hex()
            r = ref[ins["a"] - CODE_BASE: ins["a"] - CODE_BASE + ins["l"] + 4].hex()
            return {"address": hex(ins["a"]), "text": ins["t"], "ours": o, "reference_from_here": r}
    return {"address": hex(address), "text": "(past the listing)", "ours_length": len(ours), "reference_length": len(ref)}


def initial_states(cfg, registers):
    """Initial states of the equivalence check, as (register values, flag values), built from the boundary values
    zero, one, all ones, and the most negative and the most positive value of the register width and of 32 bits.

    In the first states every register holds the same boundary value. In the next states the registers hold two
    different boundary values, chosen by one bit of their position in `registers`: for every bit of the position and
    every ordered pair of distinct boundary values, a register whose position has the bit set holds the first value
    and every other register the second. Two registers differ in some bit of their position, so for any two registers
    and any two distinct boundary values, some state gives the first register one value and the second register the
    other; an expansion that reads another register than the one named is therefore told apart, also when the two
    differ only for zero or negative inputs. In the last states the registers hold pseudo-random values. The flags
    hold pseudo-random values in every state."""
    bits = cfg["register_bits"]
    mask = (1 << bits) - 1
    flag_names = list(cfg["flags"]["bits"]) if cfg["flags"] else []
    rng = random.Random(20261121)

    def flags():
        return {name: rng.getrandbits(1) for name in flag_names}

    boundary = list(dict.fromkeys([0, 1, mask, 1 << (bits - 1), (1 << (bits - 1)) - 1, 0x80000000, 0x7FFFFFFF, 0xFFFFFFFF]))
    states = [([value] * len(registers), flags()) for value in boundary]
    for bit in range((len(registers) - 1).bit_length()):
        for first in boundary:
            for second in boundary:
                if first != second:
                    states.append(([first if (k >> bit) & 1 else second for k in range(len(registers))], flags()))
    for _ in range(8):
        states.append(([rng.getrandbits(bits) for _ in registers], flags()))
    return states


def same_effect(target, ours, ref, registers, address=CODE_BASE):
    """Run two straight-line code sequences in Unicorn, each placed at `address`, from each of the initial states of
    `initial_states`, and compare every register in `registers`, every flag the target entry names, and every byte of
    the mapped memory after both have run: the data region, the stack region, and the code region outside the two
    sequences. In each state both runs start with the same bytes in the three regions (the fill of the
    instruction-level cases, with the number of the state as its salt), so a sequence that stores bytes the other does
    not store differs. The sequences also count as different when either of them faults or does not run to its end."""
    cfg = TARGETS[target]
    ids = [cfg["registers"][name] for name in registers]
    mask = (1 << cfg["register_bits"]) - 1
    mapped = ((CODE_BASE, CODE_SIZE),) + REGIONS
    longest = max(len(ours), len(ref))
    for salt, (values, flags) in enumerate(initial_states(cfg, registers)):
        finals = []
        for code in (ours, ref):
            mu = new_machine(cfg)
            for base, size in mapped:
                mu.mem_write(base, region_pattern(base, size, salt))
            mu.mem_write(address, code)
            for ident, value in zip(ids, values):
                mu.reg_write(ident, value)
            write_flags(mu, cfg, flags)
            ends = []
            mu.hook_add(uc.UC_HOOK_CODE, lambda m, at, size, user, ends=ends: ends.append(at + size))
            try:
                mu.emu_start(address | cfg.get("pc_or", 0), address + len(code), count=len(code) + 1)
            except uc.UcError:
                return False
            # A straight-line sequence executes at most one instruction for each of its bytes, and its last
            # instruction ends where the sequence ends. A sequence that the instruction limit stopped has not ended.
            if not ends or len(ends) > len(code) or ends[-1] != address + len(code):
                return False
            memory = [bytearray(mu.mem_read(base, size)) for base, size in mapped]
            # The bytes of the two sequences themselves differ; the place they occupy is left out.
            memory[0][address - CODE_BASE: address - CODE_BASE + longest] = bytes(longest)
            finals.append(([mu.reg_read(ident) & mask for ident in ids], read_flags(mu, cfg), memory))
        if finals[0] != finals[1]:
            return False
    return True


# ---- stage: encoding ---------------------------------------------------------------

def stage_encoding(target, work, tmp, source=None):
    data = read_input(work, target, "encoding", source)
    programs = data["programs"]
    results = assemble_many(target, [("enc%d" % i, p["asm"], p.get("symbols")) for i, p in enumerate(programs)], tmp)
    summary = {}
    failures = []
    by_mnemonic = {}
    by_pseudo = {}

    def count(entries, kind):
        # Instances per mnemonic of the listing, and per pseudoinstruction or alias written in the source.
        for ins in entries:
            counts = by_mnemonic.setdefault(ins["t"].split()[0].lower(), {})
            counts[kind] = counts.get(kind, 0) + 1
            if ins.get("p"):
                counts = by_pseudo.setdefault(ins["p"].split()[0].lower(), {})
                counts[kind] = counts.get(kind, 0) + 1

    by_lines = []
    for i, p in enumerate(programs):
        kind = p["kind"]
        # Data directives (padding placed as data) are bytes of the program, which the reference assembler copies
        # verbatim, but not instructions; they are left out of the instruction counts.
        code = [ins for ins in p["insns"] if not ins.get("d")]
        s = summary.setdefault(kind, dict({"programs": 0, "programs_passed": 0, "instructions": 0, "instructions_in_passed_programs": 0, "bytes": 0},
                                          **({"expansions_equivalent": 0} if kind == "pseudo" else {})))
        s["programs"] += 1
        s["instructions"] += len(code)
        ours = bytes.fromhex(p["bytes"])
        s["bytes"] += len(ours)
        ref, message = results["enc%d" % i]
        if ref is None:
            failures.append({"program": p["name"], "kind": kind, "error": "reference assembler rejected the program", "detail": message[:600]})
        elif ref == ours:
            s["programs_passed"] += 1
            s["instructions_in_passed_programs"] += len(code)
            count(code, kind)
        elif kind == "pseudo":
            by_lines.append((p, ref))
        else:
            failures.append({"program": p["name"], "kind": kind, "error": "bytes differ", "detail": first_difference(ours, ref, p["insns"])})
    if by_lines:
        # The reference assembler may expand a pseudoinstruction into a different, equally valid sequence. Each line of
        # the program text is then assembled on its own, placed with .org at the address that the line has in this
        # tool's program, so that an encoding that depends on its address is the one for that address. Clang's bytes
        # of the whole text must be its bytes of these lines in source order; a directive that changes how Clang reads
        # the lines after it would otherwise go unseen. A line whose bytes differ is accepted when both straight-line
        # expansions are nonempty and have the same effect at the address of the line from every initial state of
        # the equivalence check. The program's bytes must then equal Clang's bytes of its lines in source order, with
        # this tool's expansion in place of Clang's for each accepted line. The lines are taken from the program text,
        # not from this tool's listing, so a line that this tool drops, emits out of order, or extends with other
        # bytes is reported.
        preamble = data["preamble"]
        jobs, checks = [], []
        for p, whole in by_lines:
            text = p["asm"].split("\n")
            check = {"program": p, "whole": whole, "lines": [], "ok": text[:len(preamble)] == preamble}
            checks.append(check)
            if not check["ok"]:
                failures.append({"program": p["name"], "kind": "pseudo", "error": "the program text does not begin with the preamble"})
                continue
            ours = bytes.fromhex(p["bytes"])
            address = CODE_BASE
            for n, line in enumerate(text[len(preamble):], start=1):
                if not line.strip():
                    continue
                entries = [ins for ins in p["insns"] if ins.get("n") == n]
                mine = b"".join(ours[ins["a"] - CODE_BASE: ins["a"] - CODE_BASE + ins["l"]] for ins in entries)
                # A line without bytes in this tool's program has the address at which the bytes of the line before it end.
                if entries:
                    address = entries[0]["a"]
                tag = "line%d" % len(jobs)
                jobs.append((tag, "\n".join(preamble + [".org 0x%x" % (address - CODE_BASE), line]) + "\n", None))
                check["lines"].append((line.strip(), entries, mine, tag, address))
                address += len(mine)
        refs = assemble_many(target, jobs, tmp)
        s = summary["pseudo"]
        for check in checks:
            p, ok = check["program"], check["ok"]
            # Clang's bytes of each line in source order (`reference`), and the same with this tool's expansion for each
            # line accepted as equivalent (`expected`).
            reference, expected, identical, equivalent = [], [], [], 0
            for line, entries, mine, tag, address in check["lines"]:
                placed, message = refs[tag]
                if placed is None:
                    failures.append({"program": p["name"], "kind": "pseudo", "line": line, "error": "reference assembler rejected the line", "detail": message[:600]})
                    ok = False
                    continue
                ref = placed[address - CODE_BASE:]
                reference.append(ref)
                if ref == mine:
                    expected.append(ref)
                    identical += [ins for ins in entries if not ins.get("d")]
                elif not ref or not mine:
                    failures.append({"program": p["name"], "kind": "pseudo", "line": line, "error": "one of the two assemblers emits no bytes for the line",
                                     "ours": mine.hex(), "reference": ref.hex()})
                    ok = False
                elif same_effect(target, mine, ref, data["registers"], address):
                    expected.append(mine)
                    equivalent += 1
                else:
                    failures.append({"program": p["name"], "kind": "pseudo", "line": line, "address": hex(address),
                                     "error": "expansion differs and its effect at the address of the line differs", "ours": mine.hex(), "reference": ref.hex()})
                    ok = False
            ours = bytes.fromhex(p["bytes"])
            if ok and b"".join(reference) != check["whole"]:
                failures.append({"program": p["name"], "kind": "pseudo", "error": "Clang's bytes of the whole text differ from its bytes of the lines in source order",
                                 "whole_text": check["whole"].hex()[:200], "lines": b"".join(reference).hex()[:200]})
                ok = False
            if ok and b"".join(expected) != ours:
                failures.append({"program": p["name"], "kind": "pseudo", "error": "the bytes differ from Clang's bytes of the lines in source order",
                                 "detail": first_difference(ours, b"".join(expected), p["insns"])})
                ok = False
            if ok:
                s["programs_passed"] += 1
                s["instructions_in_passed_programs"] += sum(1 for ins in p["insns"] if not ins.get("d"))
                count(identical, "pseudo")
                s["expansions_equivalent"] += equivalent
                if equivalent:
                    s["equivalent_but_not_identical"] = s.get("equivalent_but_not_identical", 0) + 1
    return {"stage": "encoding", "target": target, "summary": summary, "by_mnemonic": by_mnemonic, "by_pseudo": by_pseudo,
            "failures": failures[:MAX_REPORTED], "failure_count": len(failures)}


# ---- stage: decoding ---------------------------------------------------------------

def reencode_with_this_tool(target, cases, tmp):
    """Assemble the reference disassembler's text of each case with this tool's assembler (through
    scripts/reencode.ts) and report, per case, whether the result is the original bytes."""
    if not cases:
        return []
    src = os.path.join(tmp, "reencode-in.json")
    dst = os.path.join(tmp, "reencode-out.json")
    with open(src, "w", newline="\n") as f:
        json.dump({"target": target, "cases": cases}, f)
    done = subprocess.run(["node", os.path.join(REPO, "scripts", "reencode.ts"), src, dst], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError("scripts/reencode.ts failed: " + done.stderr[:800])
    return json.load(open(dst))["results"]


def reencode_case(cfg, md, insn, raw):
    """Input of the re-encoding check for one instruction that Capstone decoded from `raw`: Capstone's text, rewritten
    by the target entry's `reencode_text` where Capstone's syntax differs from this tool's, and the bytes Capstone used."""
    text = (insn.mnemonic + " " + insn.op_str).strip()
    rewrite = cfg.get("reencode_text")
    if rewrite:
        text = rewrite(md, insn, text)
    return {"pc": insn.address, "text": text, "bytes": bytes(raw[:insn.size]).hex()}


def capstone_names(cfg, md, insn):
    """Capstone's printed mnemonic, and, where the target entry states that Capstone gives an alias the identifier of
    the instruction it stands for (`capstone_alias_ids`), the name of that identifier."""
    names = {insn.mnemonic.lower()}
    if cfg.get("capstone_alias_ids"):
        names.add(md.insn_name(insn.id).lower())
    return names


def capstone_text(md, raw, pc, normalize=None):
    """Capstone's text of the single instruction `raw`, after the target's normalization, or None."""
    insn = next(md.disasm(raw, pc, 1), None)
    if insn is None or insn.size != len(raw):
        return None
    text = (insn.mnemonic + " " + insn.op_str).strip()
    return normalize(text) if normalize else text


def reassemble_at_original_address(target, md, placements, tmp):
    """Reassemble decoded lines at the addresses of their original encodings.

    placements: list of (key, header lines, pc, line, original bytes). Each line follows `.org` at its offset from the
    code base, after the header (preamble and symbol definitions) of its group. Lines of one group share a program when
    they are at least MAX_INSTRUCTION_LENGTH + 1 bytes apart, so that a longer reference encoding of one line cannot
    reach the next. Returns the keys whose reference encoding at the original address equals the original bytes.
    """
    programs = []
    by_header = {}
    for key, header, pc, line, raw in placements:
        open_programs = by_header.setdefault(id(header), [])
        program = next((q for q in open_programs if q["last"] + MAX_INSTRUCTION_LENGTH + 1 <= pc), None)
        if program is None:
            program = {"header": header, "items": [], "last": -1}
            open_programs.append(program)
            programs.append(program)
        program["items"].append((key, pc, line, raw))
        program["last"] = pc
    jobs = []
    for n, q in enumerate(programs):
        body = []
        for key, pc, line, raw in q["items"]:
            body += [".org 0x%x" % (pc - CODE_BASE), line]
        jobs.append(("org%d" % n, "\n".join(q["header"] + body) + "\n", None))
    results = assemble_many(target, jobs, tmp)
    reproduced = set()
    for n, q in enumerate(programs):
        ref, _ = results["org%d" % n]
        if ref is None:
            continue
        for key, pc, line, raw in q["items"]:
            offset = pc - CODE_BASE
            insn = next(md.disasm(ref[offset: offset + MAX_INSTRUCTION_LENGTH], pc, 1), None)
            if insn is not None and bytes(insn.bytes) == raw:
                reproduced.add(key)
    return reproduced


def stage_decoding(target, work, tmp, source=None):
    cfg = TARGETS[target]
    data = read_input(work, target, "decoding", source)
    md = cs.Cs(*cfg["capstone"])
    if cfg["capstone"][0] == cs.CS_ARCH_X86:
        md.syntax = cs.CS_OPT_SYNTAX_INTEL
    synonyms = cfg.get("synonyms", {})
    fixed = cfg.get("fixed_length")
    normalize = cfg.get("normalize_capstone")
    groups = data["groups"]
    results = assemble_many(target, [("dec%d" % i, g["asm"], g.get("symbols")) for i, g in enumerate(groups) if g["accepted"]], tmp)
    out = {"stage": "decoding", "target": target, "failures": [], "failure_count": 0}
    totals = {"cases": 0, "accepted": 0, "rejected": 0, "reassembled_equal": 0, "reassembled_equal_at_original_address": 0,
              "reassembled_equivalent": 0, "equivalent_alternate": 0,
              "capstone_same_mnemonic": 0, "capstone_no_decode_of_accepted": 0, "rejected_as_invalid": 0, "rejected_as_unsupported": 0,
              "rejected_as_unsupported_not_decoded_by_capstone": 0, "rejected_but_capstone_decodes": 0, "rejected_checked_by_reencoding": 0, "rejected_not_encodable_by_this_tool": 0}
    failures = []
    exclusions = {}
    equivalent_examples = []
    unsupported_by_mnemonic = {}
    # A rejection as unsupported that Capstone does not decode cannot be checked against Capstone. These rejections
    # are counted. Capstone lacks recent extensions, so such a rejection is not a failure in itself; a target entry
    # may give `defined_without_capstone(raw)`, which returns the reason why the bytes are a defined encoding or None,
    # and with it a rejection as unsupported without a reason fails the check.
    defined_without_capstone = cfg.get("defined_without_capstone")
    defined_reasons = {}
    # The implemented instructions, named by Capstone from the encodings that this tool's encoder produced for every
    # sweep instruction. The names do not depend on the decoder under test. A byte sequence rejected as invalid that
    # Capstone decodes as one of them would be a wrongly rejected encoding. A rejection as unsupported states a boundary
    # of the implemented subset; instruction sets reuse mnemonics across instruction classes (for example A64 ldr for
    # integer and SIMD registers), so for those rejections the check is instead whether this tool's own assembler
    # produces the same bytes from Capstone's text.
    implemented = set()
    for encoding in data["implemented"]:
        insn = next(md.disasm(bytes.fromhex(encoding), CODE_BASE, 1), None)
        if insn is not None:
            implemented |= capstone_names(cfg, md, insn)
    # On a variable-length target, the reference assembler encodes a relative branch or call of the reassembled group
    # for the address the group gives it, which differs from the original one when earlier lines changed length, and
    # its relaxation keeps a long form once chosen. Such lines are assembled again at their original address before
    # they are counted as identical or equivalent.
    detailed = None
    if not fixed:
        detailed = cs.Cs(*cfg["capstone"])
        detailed.detail = True
        if cfg["capstone"][0] == cs.CS_ARCH_X86:
            detailed.syntax = cs.CS_OPT_SYNTAX_INTEL
    displaced = []
    reencode_cases = []
    reencode_origin = []
    for i, g in enumerate(groups):
        accepted, rejected = g["accepted"], g["rejected"]
        totals["cases"] += len(accepted) + len(rejected)
        totals["accepted"] += len(accepted)
        totals["rejected"] += len(rejected)
        for r in rejected:
            raw = bytes.fromhex(r["bytes"])
            totals["rejected_as_" + r["kind"]] = totals.get("rejected_as_" + r["kind"], 0) + 1
            theirs = next(md.disasm(raw, CODE_BASE, 1), None)
            if theirs is None:
                if r["kind"] == "unsupported":
                    totals["rejected_as_unsupported_not_decoded_by_capstone"] += 1
                    if defined_without_capstone:
                        reason = defined_without_capstone(raw)
                        if reason:
                            defined_reasons[reason] = defined_reasons.get(reason, 0) + 1
                        else:
                            failures.append({"group": g["name"], "bytes": r["bytes"], "kind": r["kind"],
                                             "error": "rejected as unsupported an encoding that Capstone does not decode and that the target entry does not state to be defined"})
                continue
            totals["rejected_but_capstone_decodes"] += 1
            text = (theirs.mnemonic + " " + theirs.op_str).strip()
            if theirs.size <= len(raw):
                # Variable-length input is a buffer of the maximum length; Capstone's instruction may use a prefix of it.
                reencode_cases.append(reencode_case(cfg, md, theirs, raw))
                reencode_origin.append((g["name"], r["kind"], text))
            if r["kind"] == "unsupported":
                key = theirs.mnemonic.lower()
                unsupported_by_mnemonic[key] = unsupported_by_mnemonic.get(key, 0) + 1
                continue
            if theirs.size <= len(raw) and capstone_names(cfg, md, theirs) & implemented:
                # The target entry may state why Capstone accepts an encoding that the profile does not define.
                lenient = cfg.get("lenient_capstone")
                reason = lenient(theirs, raw) if lenient else None
                if reason:
                    totals["capstone_accepts_reserved_encoding"] = totals.get("capstone_accepts_reserved_encoding", 0) + 1
                    exclusions[reason] = exclusions.get(reason, 0) + 1
                else:
                    failures.append({"group": g["name"], "error": "rejected as invalid an encoding that Capstone decodes as an implemented instruction",
                                     "bytes": r["bytes"], "kind": r["kind"], "capstone": text})
        if not accepted:
            continue
        ref, message = results["dec%d" % i]
        if ref is None:
            failures.append({"group": g["name"], "error": "reference assembler rejected the decoded text", "detail": message[:800]})
            continue
        # The k-th line of the decoded text is the k-th instruction of the reference program. Fixed-length
        # targets are split by offset; variable-length targets by Capstone, since the reference assembler may
        # choose a different length.
        if fixed:
            pieces = [(ref[k * fixed:(k + 1) * fixed], CODE_BASE + k * fixed) for k in range(len(accepted))]
        else:
            pieces = [(bytes(x.bytes), x.address) for x in md.disasm(ref, CODE_BASE)]
            if len(pieces) != len(accepted):
                failures.append({"group": g["name"], "error": "the reference program does not split into one instruction per decoded line",
                                 "decoded": len(accepted), "reference": len(pieces)})
                continue
        asm_lines = g["asm"].rstrip("\n").split("\n")
        header = asm_lines[:len(asm_lines) - len(accepted)]
        for k, a in enumerate(accepted):
            raw = bytes.fromhex(a["bytes"])
            names = {a["text"].split()[0].lower()}
            if a.get("alias"):
                names.add(a["alias"].split()[0].lower())
            insn = next(md.disasm(raw, a["pc"], 1), None)
            if insn is None:
                totals["capstone_no_decode_of_accepted"] += 1
                failures.append({"group": g["name"], "error": "Capstone does not decode an accepted encoding", "bytes": a["bytes"], "text": a["text"]})
            else:
                theirs = insn.mnemonic.lower()
                if theirs in names or synonyms.get(theirs) in names:
                    totals["capstone_same_mnemonic"] += 1
                else:
                    failures.append({"group": g["name"], "error": "Capstone names a different instruction", "bytes": a["bytes"],
                                     "text": a["text"], "capstone": (insn.mnemonic + " " + insn.op_str).strip()})
            piece, piece_pc = pieces[k]
            if g["exact"] and piece == raw:
                totals["reassembled_equal"] += 1
                continue
            # The reference assembler encodes the decoded text differently. The two encodings are equivalent
            # when Capstone disassembles both to the same instruction text.
            mine_text = capstone_text(md, raw, a["pc"], normalize)
            ref_text = capstone_text(md, piece, piece_pc, normalize)
            if mine_text is not None and mine_text == ref_text:
                if not g["exact"]:
                    totals["equivalent_alternate"] += 1
                    continue
                if detailed is not None and next(detailed.disasm(raw, a["pc"], 1)).group(cs.CS_GRP_BRANCH_RELATIVE):
                    displaced.append(((i, k), header, a["pc"], asm_lines[len(header) + k], raw, mine_text))
                    continue
                totals["reassembled_equivalent"] += 1
                if len(equivalent_examples) < 12:
                    equivalent_examples.append({"bytes": a["bytes"], "reference": piece.hex(), "text": a["text"], "capstone": mine_text})
            else:
                failures.append({"group": g["name"], "error": "reassembled encoding is neither identical nor equivalent", "bytes": a["bytes"],
                                 "text": a["text"], "reference": piece.hex(), "capstone_ours": mine_text, "capstone_reference": ref_text})
    if displaced:
        same = reassemble_at_original_address(target, md, [(key, header, pc, line, raw) for key, header, pc, line, raw, _ in displaced], tmp)
        for key, header, pc, line, raw, text in displaced:
            if key in same:
                totals["reassembled_equal"] += 1
                totals["reassembled_equal_at_original_address"] += 1
            else:
                totals["reassembled_equivalent"] += 1
                if len(equivalent_examples) < 12:
                    equivalent_examples.append({"bytes": raw.hex(), "text": line.strip(), "capstone": text})
    for (group, kind, text), res in zip(reencode_origin, reencode_with_this_tool(target, reencode_cases, tmp)):
        totals["rejected_checked_by_reencoding"] += 1
        if res["reproduced"]:
            failures.append({"group": group, "error": "this tool's assembler produces bytes that its decoder rejects", "kind": kind, "capstone": text})
        else:
            totals["rejected_not_encodable_by_this_tool"] += 1
    out["totals"] = totals
    out["exclusions"] = exclusions
    out["unsupported_not_decoded_by_capstone"] = {"checked_against_the_target_entry": bool(defined_without_capstone), "defined": defined_reasons}
    out["equivalent_examples"] = equivalent_examples
    out["unsupported_by_capstone_mnemonic"] = dict(sorted(unsupported_by_mnemonic.items(), key=lambda kv: -kv[1])[:25])
    out["failures"] = failures[:MAX_REPORTED]
    out["failure_count"] = len(failures)
    return out


# ---- Unicorn helpers ----------------------------------------------------------------

_ADDRESS_BYTES = {}


def address_bytes(base, size):
    """One byte per address of a region: (a + 37 * (a >> 8) + 101 * (a >> 16)) mod 256 for the address a, so the byte
    depends on every bit of the address that varies within a region. Within the data region and within the stack
    region, two addresses whose distance is a power of two hold different bytes; `validation/harness_controls.py`
    checks every such pair. Other pairs of addresses can hold the same byte, since each block of 256 addresses holds
    every byte value once. scripts/export-validation.ts computes the same bytes."""
    key = (base, size)
    if key not in _ADDRESS_BYTES:
        _ADDRESS_BYTES[key] = bytes((a + 37 * (a >> 8) + 101 * (a >> 16)) & 0xFF for a in range(base, base + size))
    return _ADDRESS_BYTES[key]


def region_pattern(base, size, salt):
    """Initial contents of a region for an instruction-level case: the address bytes XOR the low byte of the salt. The
    salt changes every byte in the same way, so two addresses hold different bytes in every case or in none."""
    return address_bytes(base, size).translate(bytes(b ^ (salt & 0xFF) for b in range(256)))


def put_runs(images, runs):
    """Write runs of bytes, given as {address, bytes}, into the region images {base: bytearray}."""
    for run in runs:
        value = bytes.fromhex(run["bytes"])
        for base, image in images.items():
            if base <= run["address"] and run["address"] + len(value) <= base + len(image):
                image[run["address"] - base: run["address"] - base + len(value)] = value
                break
        else:
            raise ValueError("bytes at 0x%x lie outside the data and stack regions" % run["address"])


def memory_differences(base, ours, theirs):
    """Addresses where the expected and the emulated region differ, with both bytes, as failure lines."""
    out = []
    for i in range(len(ours)):
        if ours[i] != theirs[i]:
            out.append("memory at 0x%08x: ours %02x, Unicorn %02x" % (base + i, ours[i], theirs[i]))
            if len(out) == 4:
                break
    return out


def new_machine(cfg):
    mu = uc.Uc(*cfg["unicorn"])
    mu.mem_map(CODE_BASE, CODE_SIZE)
    mu.mem_map(DATA_BASE, DATA_SIZE)
    mu.mem_map(STACK_BASE, STACK_SIZE)
    return mu


def read_flags(mu, cfg):
    spec = cfg["flags"]
    if not spec:
        return {}
    value = mu.reg_read(spec["register"])
    return {name: (value >> bit) & 1 for name, bit in spec["bits"].items()}


def write_flags(mu, cfg, flags):
    spec = cfg["flags"]
    if not spec:
        return
    value = mu.reg_read(spec["register"])
    for name, bit in spec["bits"].items():
        if name in flags:
            value = (value & ~(1 << bit)) | ((flags[name] & 1) << bit)
    mu.reg_write(spec["register"], value)


def instruction_hook_effect(cfg):
    """Register writes of a service instruction that Unicorn 2.1.4 replaces by the instruction hook, or None.

    SYSCALL saves the address of the next instruction in RCX and RFLAGS in R11 (Intel SDM Vol. 2B, SYSCALL).
    Unicorn calls the hook in place of SYSCALL and performs neither write, so the hook makes both writes from
    Unicorn's own state: the program counter, the length Capstone decodes there, and the flags register.
    """
    service = cfg["service"]
    if service["kind"] != "insn" or service["insn"] != x86_const.UC_X86_INS_SYSCALL:
        return None
    md = cs.Cs(*cfg["capstone"])
    regs = cfg["registers"]

    def effect(m):
        rip = m.reg_read(cfg["pc"])
        insn = next(md.disasm(bytes(m.mem_read(rip, min(MAX_INSTRUCTION_LENGTH, CODE_BASE + CODE_SIZE - rip))), rip, 1))
        m.reg_write(regs["rcx"], rip + insn.size)
        m.reg_write(regs["r11"], m.reg_read(cfg["flags"]["register"]))
    return effect


def install_service_hook(mu, cfg, state):
    """Hook of the service instruction for an instruction-level case, installed for every case. Unicorn reports the
    instruction as an interrupt, or calls an instruction hook in place of it. The case compares the instruction's
    effect on the processor, so the hook completes the instruction and lets the emulation continue at the next
    instruction; any other interrupt stops the emulation as a fault."""
    service = cfg["service"]
    if service["kind"] == "intr":
        def on_intr(m, intno, user):
            if intno in service["numbers"]:
                if service.get("advance", True):
                    m.reg_write(cfg["pc"], m.reg_read(cfg["pc"]) + service["length"])
            else:
                state["fault"] = "interrupt %d" % intno
                state["interrupt"] = intno
                m.emu_stop()
        mu.hook_add(uc.UC_HOOK_INTR, on_intr)
    else:
        effect = instruction_hook_effect(cfg)

        def on_insn(m, user):
            if effect:
                effect(m)
        mu.hook_add(uc.UC_HOOK_INSN, on_insn, None, 1, 0, service["insn"])


# ---- stage: execution (single instructions) ---------------------------------------------

def expect_fault(case):
    return case["expect"]["fault"]


def stage_execution(target, work, tmp, source=None):
    """Compare the instruction-level cases with Unicorn.

    The target entry's `exclude_execution(case)` gives the reason for which a case cannot be compared in full, or None.
    Every reason is counted in `exclusions`. A case with a reason is left out, unless `partial_exclusions` of the
    target entry maps the reason to the comparisons that it affects; such a case is run, counted as compared and as
    `partially_compared`, and compared in every other respect (registers, flags, memory):
      pc_mask             the bits of the program counter that are compared;
      unicorn_errors      Unicorn errors that, when this tool reports no fault, stand for the failed fetch of the
                          jump target, as UC_ERR_FETCH_UNMAPPED does for every case;
      unicorn_interrupts  optional; interrupt numbers that Unicorn passes to the interrupt hook for that failed fetch
                          before it reports the error, and that are then not a fault of the case. Without this
                          key, an interrupt that precedes one of `unicorn_errors` belongs to that error."""
    cfg = TARGETS[target]
    data = read_input(work, target, "execution", source)
    exported = [(r["base"], r["size"]) for r in data["memoryRegions"]]
    if exported != list(REGIONS):
        raise ValueError("the exported memory regions %s differ from the harness's %s" % (exported, list(REGIONS)))
    regs = cfg["registers"]
    mask = (1 << cfg["register_bits"]) - 1
    by_sweep = {}
    by_mnemonic = {}
    failures = []
    excluded = []
    exclusions = {}
    partially_compared = {}
    exclude = cfg.get("exclude_execution")
    partial_exclusions = cfg.get("partial_exclusions") or {}
    for case in data["cases"]:
        s = by_sweep.setdefault(case["sweep"], {"cases": 0, "passed": 0, "faults_agreed": 0, "excluded": 0, "partially_compared": 0})
        mn = by_mnemonic.setdefault(case["text"].split()[0].lower(), {"cases": 0, "passed": 0, "excluded": 0})
        reason = exclude(case) if exclude else None
        partial = None
        if reason:
            exclusions[reason] = exclusions.get(reason, 0) + 1
            partial = partial_exclusions.get(reason)
            if partial is None:
                s["excluded"] += 1
                mn["excluded"] += 1
                if len(excluded) < MAX_REPORTED:
                    excluded.append({"text": case["text"], "reason": reason})
                continue
            s["partially_compared"] += 1
            partially_compared[reason] = partially_compared.get(reason, 0) + 1
        s["cases"] += 1
        mn["cases"] += 1
        mu = new_machine(cfg)
        code = bytes.fromhex(case["code"])
        mu.mem_write(CODE_BASE, code)
        # Both sides fill the data and stack regions with the same bytes before the instruction.
        before = {base: bytearray(region_pattern(base, size, case["salt"])) for base, size in REGIONS}
        put_runs(before, case["memoryInit"])
        for base, image in before.items():
            mu.mem_write(base, bytes(image))
        for name, value in case["regs"].items():
            mu.reg_write(regs[name], int(value, 16))
        write_flags(mu, cfg, case["flags"])
        expect = case["expect"]
        state = {"fault": None}
        # The hook is installed whatever this tool did with the instruction, so a service instruction on which this
        # tool faults, or whose register effects it omits, differs from the reference.
        install_service_hook(mu, cfg, state)
        fault = None
        try:
            mu.emu_start(case["pc"] | cfg.get("pc_or", 0), CODE_BASE + CODE_SIZE, count=case["steps"])
        except uc.UcError as e:
            # A jump to an unmapped address completes in Unicorn and then fails on the fetch of the
            # following instruction. The jump itself has executed, so its effects are still compared.
            # For a partially compared case the target entry names the other errors with which Unicorn
            # reports that failed fetch, and the interrupts that it passes to the hook before the error.
            if expect_fault(case) is None and (e.errno == uc.UC_ERR_FETCH_UNMAPPED or (partial is not None and e.errno in partial["unicorn_errors"])):
                s["fetch_fault_after_jump"] = s.get("fetch_fault_after_jump", 0) + 1
                if partial is not None and "interrupt" in state:
                    named = partial.get("unicorn_interrupts")
                    if state["interrupt"] in named if named is not None else e.errno in partial["unicorn_errors"]:
                        state["fault"] = None
            else:
                fault = str(e)
        if fault is None:
            fault = state["fault"]
        if expect["fault"] is not None:
            if fault is not None:
                s["passed"] += 1
                mn["passed"] += 1
                s["faults_agreed"] += 1
            else:
                failures.append({"text": case["text"], "error": "this tool faults but Unicorn does not", "fault": expect["fault"]})
            continue
        if fault is not None:
            failures.append({"text": case["text"], "error": "Unicorn faults but this tool does not", "unicorn": fault, "regs": case["regs"]})
            continue
        diffs = []
        for name, value in expect["regs"].items():
            got = mu.reg_read(regs[name]) & mask
            if got != int(value, 16):
                diffs.append("%s: ours %s, Unicorn %x" % (name, value, got))
        got_flags = read_flags(mu, cfg)
        for name, value in expect["flags"].items():
            if name in expect["undefinedFlags"]:
                continue
            if got_flags.get(name) != value:
                diffs.append("flag %s: ours %d, Unicorn %s" % (name, value, got_flags.get(name)))
        pc = mu.reg_read(cfg["pc"]) & mask
        # A partially compared case compares the bits of the program counter that its reason leaves comparable.
        pc_mask = mask if partial is None else partial["pc_mask"]
        if pc & pc_mask != int(expect["pc"], 16) & pc_mask:
            diffs.append("pc: ours %s, Unicorn %x%s" % (expect["pc"], pc, "" if partial is None else " (bits %x compared)" % pc_mask))
        # Every byte of the writable regions is compared: the initial bytes with this tool's changes applied must
        # equal Unicorn's final bytes, which covers every byte that either side wrote.
        after = {base: bytearray(image) for base, image in before.items()}
        put_runs(after, expect["memory"])
        memory = []
        for base, size in REGIONS:
            theirs = bytes(mu.mem_read(base, size))
            if theirs != after[base]:
                memory += memory_differences(base, after[base], theirs)
        if memory:
            diffs += memory + ["our writes: %s" % json.dumps(expect["memWrites"])]
        if diffs:
            failures.append({"text": case["text"], "pc": hex(case["pc"]), "error": "state differs", "diffs": diffs[:6], "regs": case["regs"], "flags": case["flags"]})
        else:
            s["passed"] += 1
            mn["passed"] += 1
    totals = {k: sum(s[k] for s in by_sweep.values()) for k in ("cases", "passed", "faults_agreed", "excluded", "partially_compared")}
    return {"stage": "execution", "target": target, "totals": totals, "by_instruction": by_sweep, "by_mnemonic": by_mnemonic,
            "exclusions": exclusions, "partially_compared": partially_compared, "excluded_examples": excluded, "failures": failures[:MAX_REPORTED], "failure_count": len(failures)}


# ---- stage: programs -------------------------------------------------------------------

def run_program(cfg, data, case):
    regs = cfg["registers"]
    mu = new_machine(cfg)
    mu.mem_write(CODE_BASE, bytes.fromhex(case["code"]))
    if case["data"]:
        mu.mem_write(DATA_BASE, bytes.fromhex(case["data"]))
    mu.reg_write(regs[data["stackPointer"]], STACK_TOP)
    for name, value in zip(data["args"], case["args"]):
        mu.reg_write(regs[name], value & 0xFFFFFFFF)
    state = {"output": [], "status": None, "value": None, "executed": 0}
    service = cfg["service"]

    def signed(v):
        v &= 0xFFFFFFFF
        return v - (1 << 32) if v & 0x80000000 else v

    def do_service(m):
        number = m.reg_read(regs[data["serviceNumber"]]) & 0xFFFFFFFF
        argument = signed(m.reg_read(regs[data["serviceArg"]]))
        if number == 1:
            state["output"].append(argument)
            return True
        if number == 2:
            state["status"], state["value"] = "exited", argument
        elif number == 3:
            state["status"], state["value"] = "trap", argument
        else:
            state["status"], state["value"] = "fault", number
        m.emu_stop()
        return False

    def on_code(m, address, size, user):
        state["executed"] += 1

    mu.hook_add(uc.UC_HOOK_CODE, on_code)
    if service["kind"] == "intr":
        def on_intr(m, intno, user):
            if intno in service["numbers"]:
                if do_service(m) and service.get("advance", True):
                    m.reg_write(cfg["pc"], m.reg_read(cfg["pc"]) + service["length"])
            else:
                state["status"], state["value"] = "fault", "interrupt %d" % intno
                m.emu_stop()
        mu.hook_add(uc.UC_HOOK_INTR, on_intr)
    else:
        effect = instruction_hook_effect(cfg)

        def on_insn(m, user):
            if effect:
                effect(m)
            do_service(m)
        mu.hook_add(uc.UC_HOOK_INSN, on_insn, None, 1, 0, service["insn"])
    # The instruction budget bounds the run if the emulator and this tool diverge.
    budget = 2 * case["expect"]["executed"] + 1000
    try:
        mu.emu_start(case["entry"] | cfg.get("pc_or", 0), CODE_BASE + CODE_SIZE, count=budget)
        if state["status"] is None:
            state["status"], state["value"] = "limit", "instruction budget of %d exhausted" % budget
    except uc.UcError as e:
        if state["status"] is None:
            state["status"], state["value"] = "fault", str(e)
    homes = {name: mu.reg_read(regs[name]) & 0xFFFFFFFF for name in case["expect"]["homes"]}
    data_after = bytes(mu.mem_read(DATA_BASE, len(case["data"]) // 2)).hex() if case["data"] else ""
    return state, homes, data_after


def stage_programs(target, work, tmp, source=None):
    cfg = TARGETS[target]
    data = read_input(work, target, "programs", source)
    totals = {"runs": 0, "passed": 0, "exited": 0, "trap": 0, "instructions_executed": 0}
    failures = []
    for case in data["cases"]:
        totals["runs"] += 1
        expect = case["expect"]
        state, homes, data_after = run_program(cfg, data, case)
        diffs = []
        if state["status"] != expect["status"]:
            diffs.append("status: ours %s, Unicorn %s (%s)" % (expect["status"], state["status"], state["value"]))
        else:
            want = expect["returnValue"] if expect["status"] == "exited" else expect["trapCode"]
            if state["value"] != want:
                diffs.append("value: ours %s, Unicorn %s" % (want, state["value"]))
        if state["output"] != expect["output"]:
            diffs.append("output: ours %s, Unicorn %s" % (expect["output"][:8], state["output"][:8]))
        if state["executed"] != expect["executed"]:
            diffs.append("executed instructions: ours %d, Unicorn %d" % (expect["executed"], state["executed"]))
        if data_after != expect["dataAfter"]:
            diffs.append("data region differs")
        for name, value in expect["homes"].items():
            if homes[name] != int(value, 16):
                diffs.append("register %s: ours %s, Unicorn %x" % (name, value, homes[name]))
        if diffs:
            failures.append({"program": case["name"], "args": case["args"], "diffs": diffs[:6]})
        else:
            totals["passed"] += 1
            totals[expect["status"]] = totals.get(expect["status"], 0) + 1
            totals["instructions_executed"] += expect["executed"]
    return {"stage": "programs", "target": target, "totals": totals, "failures": failures[:MAX_REPORTED], "failure_count": len(failures)}


# ---- stage: semantics --------------------------------------------------------------------

def stage_semantics(work, source=None):
    data = read_input(work, "common", "semantics", source)
    totals = {"runs": 0, "python_reference_agrees": 0, "ir_agrees": 0, "cpython_direct_runs": 0, "cpython_direct_agrees": 0,
              "not_compared_with_cpython": 0, "exited": 0, "trap": 0}
    by_group = {}
    failures = []
    for case in data["cases"]:
        totals["runs"] += 1
        g = by_group.setdefault(case["group"], {"runs": 0, "passed": 0})
        g["runs"] += 1
        source = data["sources"][case["name"]]
        ours = case["reference"]
        ref = run_reference(source, case["args"])
        keys = ("status", "returnValue", "trapCode", "trapLine", "output")
        ok = True
        if all(ref[k] == ours[k] for k in keys):
            totals["python_reference_agrees"] += 1
        else:
            ok = False
            failures.append({"program": case["name"], "args": case["args"], "error": "Python reference evaluator disagrees",
                             "ours": {k: ours[k] for k in keys if k != "output"}, "python": {k: ref[k] for k in keys if k != "output"}})
        if all(case["ir"][k] == ours[k] for k in keys):
            totals["ir_agrees"] += 1
        else:
            ok = False
            failures.append({"program": case["name"], "args": case["args"], "error": "IR interpreter disagrees with the reference evaluator"})
        if ref["inRange"] != case["pythonCoincident"]:
            ok = False
            failures.append({"program": case["name"], "args": case["args"], "error": "the two evaluators disagree on whether values stayed in range"})
        if ref["inRange"]:
            totals["cpython_direct_runs"] += 1
            direct = run_cpython(source, case["args"])
            if direct["output"] == ours["output"] and direct["returnValue"] == ours["returnValue"]:
                totals["cpython_direct_agrees"] += 1
            else:
                ok = False
                failures.append({"program": case["name"], "args": case["args"], "error": "plain CPython execution disagrees",
                                 "ours": ours["returnValue"], "cpython": direct["returnValue"]})
        else:
            totals["not_compared_with_cpython"] += 1
        totals[ours["status"]] = totals.get(ours["status"], 0) + 1
        if ok:
            g["passed"] += 1
    return {"stage": "semantics", "target": "common", "corpus": data["corpus"], "programs": len(data["sources"]), "totals": totals,
            "by_group": by_group, "failures": failures[:MAX_REPORTED], "failure_count": len(failures)}


STAGES = {"encoding": stage_encoding, "decoding": stage_decoding, "execution": stage_execution, "programs": stage_programs}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", default="all")
    ap.add_argument("--stage", default="all")
    ap.add_argument("--work", default=os.path.join(HERE, "work"))
    ap.add_argument("--results", default=os.path.join(HERE, "results"))
    args = ap.parse_args()
    if not os.path.isdir(args.work):
        ap.error("the work folder %s does not exist; run node scripts/export-validation.ts first" % args.work)
    if args.target == "all":
        # Every exported target must have a reference-tool entry; a folder without one would otherwise be skipped.
        exported = [d for d in sorted(os.listdir(args.work)) if d != "common" and os.path.isdir(os.path.join(args.work, d))]
        unregistered = [d for d in exported if d not in TARGETS]
        if unregistered:
            ap.error("%s holds inputs of target(s) without a reference-tool entry: %s; define TARGET in validation/targets_<id>.py"
                     % (args.work, ", ".join(unregistered)))
        targets = [t for t in TARGETS if t in exported]
    elif args.target in TARGETS:
        targets = [args.target]
    else:
        ap.error("target '%s' has no reference-tool entry; the entries are %s" % (args.target, ", ".join(sorted(TARGETS))))
    stages = list(STAGES) + ["semantics"] if args.stage == "all" else [args.stage]
    os.makedirs(args.results, exist_ok=True)
    versions = tool_versions()
    failed = 0

    def run(stage, *arguments):
        """Run one stage on inputs exported from the source tree as it is when the stage starts, and record its hash."""
        source = source_tree_hash()
        try:
            result = stage(*arguments, source)
        except StaleInput as e:
            ap.error(str(e))
        result["format"] = RESULT_FORMAT
        result["source"] = source
        return result

    with tempfile.TemporaryDirectory(prefix="isa-trace-lab-") as tmp:
        if "semantics" in stages:
            started = time.time()
            result = run(stage_semantics, args.work)
            result["tools"] = versions
            result["seconds"] = round(time.time() - started, 1)
            with open(os.path.join(args.results, "semantics.json"), "w", newline="\n") as f:
                json.dump(result, f, indent=1)
            failed += result["failure_count"]
            print("semantics: %s, failures %d" % (json.dumps(result["totals"]), result["failure_count"]))
        for target in targets:
            for stage in stages:
                if stage == "semantics":
                    continue
                started = time.time()
                sub = os.path.join(tmp, target, stage)
                os.makedirs(sub, exist_ok=True)
                result = run(STAGES[stage], target, args.work, sub)
                result["tools"] = versions
                result["reference_configuration"] = TARGETS[target]["reference"]
                result["seconds"] = round(time.time() - started, 1)
                os.makedirs(os.path.join(args.results, target), exist_ok=True)
                with open(os.path.join(args.results, target, stage + ".json"), "w", newline="\n") as f:
                    json.dump(result, f, indent=1)
                failed += result["failure_count"]
                brief = result.get("totals") or result.get("summary")
                print("%s %s: %s, failures %d (%.1fs)" % (target, stage, json.dumps(brief), result["failure_count"], result["seconds"]))
                for failure in result["failures"][:3]:
                    print("   ", json.dumps(failure)[:700])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
