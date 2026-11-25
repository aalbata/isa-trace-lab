"""Draws the diagram and plot figures of the article as vector PDF files.

    node scripts/figures/figure-data.ts
    python scripts/figures/figures.py [output-directory]

Inputs: experiments/results/figure-data.json (written by figure-data.ts) and
experiments/results/benchmark.json. Outputs, in experiments/figures by default:

    architecture.pdf   components of the software and the two translation paths
    validation.pdf     what each validation stage compares with which reference
    encodings.pdf      fields of the array load of the running example on each target
    alignment.pdf      the running example on the four targets, aligned at statement boundaries
    throughput.pdf     simulation throughput by target and recording mode

Requires Matplotlib (tested with 3.11.1, see requirements.txt in this folder).
"""

import json
import math
import sys
from pathlib import Path as FilePath

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, PathPatch, Rectangle  # noqa: E402
from matplotlib.path import Path  # noqa: E402

ROOT = FilePath(__file__).resolve().parents[2]
OUT = FilePath(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "experiments" / "figures"

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 6.5,
    "pdf.fonttype": 42,
    "axes.linewidth": 0.5,
    "axes.labelsize": 6.5,
    "xtick.labelsize": 6,
    "ytick.labelsize": 6,
    "xtick.major.width": 0.5,
    "ytick.major.width": 0.5,
    "xtick.major.size": 2.5,
    "ytick.major.size": 2.5,
    "legend.fontsize": 6,
    "legend.frameon": False,
})

# Every figure is printed at the 5.4 in (390 pt) width of the article's text block, so that the text sizes
# given in points are the printed sizes. The diagrams are laid out in a 7.0 in coordinate frame and drawn
# at this scale.
PRINT_WIDTH = 5.4
PRINT_SCALE = PRINT_WIDTH / 7.0

INK = "#222222"
# Flowchart roles: (top colour, bottom colour, border colour).
START = ("#F8D5E6", "#E07BAE", "#C0558E")
PROCESS = ("#B8E3DA", "#5FB3A3", "#3F8F80")
ALTERNATIVE = ("#C6E0FF", "#66AAFF", "#4A86D6")
SECONDARY = ("#D6D3F2", "#8F89DD", "#6C66B8")
DECISION = ("#C3E3A8", "#7DB84E", "#5E9A35")
MANUAL = ("#F9C9DE", "#EE6FA6", "#C9558A")
DISPLAY = ("#FFD9B0", "#FF9F40", "#E07B1A")
DATA_IO = ("#FFF2B3", "#FFD54F", "#D6B03A")
DOCUMENT = ("#E6D5EE", "#A780BF", "#8A63A3")

TARGETS = ["riscv", "mips", "aarch64", "x86"]
TARGET_NAMES = {"riscv": "RISC-V RV32I", "mips": "MIPS32 Release 2", "aarch64": "AArch64 (A64)", "x86": "x86-64"}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def mix(a, b, t):
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))


def save(fig, name):
    OUT.mkdir(parents=True, exist_ok=True)
    # Without a creation date the files are byte-identical when regenerated from the same data.
    fig.savefig(OUT / name, metadata={"Creator": "Matplotlib", "Producer": "Matplotlib", "CreationDate": None})
    plt.close(fig)
    print(f"wrote {OUT / name}")


def canvas(width, height):
    fig = plt.figure(figsize=(width * PRINT_SCALE, height * PRINT_SCALE))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_aspect("equal")
    ax.axis("off")
    return fig, ax


# Shapes, each given by its centre (cx, cy), width w and height h in inches.

def polygon(points):
    return Path(points + [points[0]], [Path.MOVETO] + [Path.LINETO] * (len(points) - 1) + [Path.CLOSEPOLY])


def rectangle(cx, cy, w, h):
    return polygon([(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)])


def rounded(cx, cy, w, h, r=None):
    r = h / 2 if r is None else r
    box = FancyBboxPatch((cx - w / 2, cy - h / 2), w, h, boxstyle=f"round,pad=0,rounding_size={r}")
    return box.get_path()


def diamond(cx, cy, w, h):
    return polygon([(cx - w / 2, cy), (cx, cy + h / 2), (cx + w / 2, cy), (cx, cy - h / 2)])


def parallelogram(cx, cy, w, h, s=0.14):
    return polygon([(cx - w / 2, cy - h / 2), (cx + w / 2 - s, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2 + s, cy + h / 2)])


def manual(cx, cy, w, h, s=0.12):
    return polygon([(cx - w / 2, cy + h / 2), (cx + w / 2, cy + h / 2), (cx + w / 2 - s, cy - h / 2), (cx - w / 2 + s, cy - h / 2)])


def document(cx, cy, w, h):
    a = 0.12 * h
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - h / 2 + a, cy + h / 2
    points = [(x0, y1), (x1, y1), (x1, y0)]
    n = 40
    for i in range(1, n + 1):
        x = x1 - (x1 - x0) * i / n
        points.append((x, y0 + a * math.sin(2 * math.pi * (x1 - x) / (x1 - x0))))
    return polygon(points)


def display(cx, cy, w, h):
    x0, x1, y0, y1 = cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2
    p = 0.32 * h
    verts = [(x0, cy), (x0 + p, y1), (x1 - p, y1), (x1 + 0.1 * h, y1), (x1 + 0.1 * h, y0), (x1 - p, y0), (x0 + p, y0), (x0, cy)]
    codes = [Path.MOVETO, Path.LINETO, Path.LINETO, Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO, Path.CLOSEPOLY]
    return Path(verts, codes)


SHAPES = {
    "start": (rounded, START), "process": (rectangle, PROCESS), "alternative": (rounded, ALTERNATIVE),
    "decision": (diamond, DECISION), "manual": (manual, MANUAL), "display": (display, DISPLAY),
    "io": (parallelogram, DATA_IO), "document": (document, DOCUMENT),
}


def shape(ax, kind, cx, cy, w, h, text, size=6.5):
    make, (top, bottom, border) = SHAPES[kind]
    path = make(cx, cy, w, h)
    clip = PathPatch(path, transform=ax.transData)
    ext = path.get_extents()
    bands = 36
    for k in range(bands):
        hi = ext.y1 - (ext.y1 - ext.y0) * k / bands
        lo = ext.y1 - (ext.y1 - ext.y0) * (k + 1) / bands
        band = Rectangle((ext.x0, lo - 0.003), ext.x1 - ext.x0, hi - lo + 0.006, facecolor=mix(top, bottom, k / (bands - 1)), edgecolor="none", zorder=2)
        ax.add_patch(band)
        band.set_clip_path(clip)
    ax.add_patch(PathPatch(path, facecolor="none", edgecolor=border, linewidth=0.6, zorder=3))
    dx = 0.04 * h if kind == "display" else 0
    ax.text(cx + dx, cy - (0.04 * h if kind == "document" else 0), text, ha="center", va="center", fontsize=size, color="black", zorder=4, linespacing=1.15)


def arrow(ax, points, head=True):
    for (x0, y0), (x1, y1) in zip(points[:-2], points[1:-1]):
        ax.plot([x0, x1], [y0, y1], color=INK, linewidth=0.6, solid_capstyle="butt", zorder=1)
    style = "-|>,head_length=0.35,head_width=0.16" if head else "-"
    ax.add_patch(FancyArrowPatch(points[-2], points[-1], arrowstyle=style, mutation_scale=10, color=INK, linewidth=0.6, shrinkA=0, shrinkB=0, zorder=5))


def architecture():
    fig, ax = canvas(7.0, 3.6)
    r0, r1, r2, r3 = 3.05, 2.05, 1.22, 0.42
    c1, c2, c3 = 2.35, 3.95, 5.6
    ax.add_patch(FancyBboxPatch((1.52, 0.08), 5.42, 2.56, boxstyle="round,pad=0,rounding_size=0.08", facecolor="none", edgecolor="#777777", linewidth=0.6, linestyle=(0, (4, 2)), zorder=0))
    ax.text(1.62, 2.49, "Path B, native compilation in the headless TypeScript core", fontsize=6.5, style="italic", va="center")
    ax.text(1.62, 3.42, "Path A, inspection only, in which CPython compiles the program and never executes it", fontsize=6.5, style="italic", va="center")

    shape(ax, "io", 0.72, r1, 1.18, 0.62, "Source program\n(Python syntax)")
    shape(ax, "alternative", c1, r0, 1.45, 0.44, "CPython compile()\nin Pyodide")
    shape(ax, "alternative", c2, r0, 1.15, 0.44, "dis module")
    shape(ax, "display", c3, r0, 1.5, 0.44, "Bytecode listing")

    shape(ax, "process", c1, r1, 1.3, 0.46, "Parser and checker")
    shape(ax, "process", c2, r1, 1.2, 0.46, "IR builder and\nverifier")
    shape(ax, "process", c3, r1, 1.45, 0.46, "Instruction selection\n(four back ends)")
    shape(ax, "process", c3, r2, 1.45, 0.46, "Assembler and\nencoder")
    shape(ax, "document", c2, r2, 1.4, 0.5, "Machine code and listing\nwith provenance")
    shape(ax, "process", c1, r2, 1.3, 0.46, "Processor model:\nfetch, decode, execute")
    shape(ax, "document", c1, r3, 1.3, 0.5, "Step events and\nstatement boundaries")
    shape(ax, "display", c2 + 0.05, r3, 1.55, 0.46, "Views, trace export,\ncomparison of targets")
    shape(ax, "manual", c3, r3, 1.45, 0.46, "Step, run, edit\nbytes or registers")
    shape(ax, "display", 0.72, r2, 1.18, 0.46, "Diagnostics with\nsource locations")

    arrow(ax, [(0.72, r1 + 0.31), (0.72, r0), (c1 - 0.725, r0)])
    arrow(ax, [(c1 + 0.725, r0), (c2 - 0.575, r0)])
    arrow(ax, [(c2 + 0.575, r0), (c3 - 0.75, r0)])
    arrow(ax, [(0.72 + 0.59, r1), (c1 - 0.65, r1)])
    arrow(ax, [(c1 + 0.65, r1), (c2 - 0.6, r1)])
    arrow(ax, [(c2 + 0.6, r1), (c3 - 0.725, r1)])
    arrow(ax, [(c3, r1 - 0.23), (c3, r2 + 0.23)])
    arrow(ax, [(c3 - 0.725, r2), (c2 + 0.7, r2)])
    arrow(ax, [(c2 - 0.7, r2), (c1 + 0.65, r2)])
    arrow(ax, [(c1, r2 - 0.23), (c1, r3 + 0.25)])
    arrow(ax, [(c1 + 0.65, r3), (c2 + 0.05 - 0.775, r3)])
    arrow(ax, [(c3, r3 + 0.23), (c3, 0.82), (c1 + 0.42, 0.82), (c1 + 0.42, r2 - 0.23)])
    arrow(ax, [(c1 - 0.65, r1 - 0.1), (1.6, r1 - 0.1), (1.6, r2), (0.72 + 0.65, r2)])
    ax.text(1.64, (r1 + r2) / 2 - 0.05, "errors", fontsize=6, style="italic", ha="left", va="center")
    save(fig, "architecture.pdf")


def validation():
    fig, ax = canvas(7.0, 4.05)
    lanes = [
        ("Program\nsemantics", "Corpus of programs\nand argument tuples", "Reference evaluator", "Python evaluator, CPython", "Output and result\nor error code\nof every run"),
        ("Encoding", "Instruction sweeps\nand compiled programs", "Encoders", "Clang assembler, LLD", "Bytes of the\ntext section"),
        ("Decoding", "Random instruction\nwords or byte strings", "Decoders", "Capstone, Clang", "Instruction, and\nbytes on reassembly"),
        ("Instruction\nexecution", "Each instruction from\nfour random states", "Processor models", "Unicorn", "Registers, flags,\nprogram counter,\ndata and stack"),
        ("Program\nexecution", "Compiled programs with\nall argument tuples", "Simulators", "Unicorn", "Output, result,\ninstruction count,\nfinal data"),
    ]
    top = 3.38
    step = 0.76
    cx_doc, cx_tool, cx_cmp, x_text = 1.85, 3.75, 5.3, 5.9
    half = 0.85
    ax.text(cx_doc, 3.9, "Input", ha="center", fontsize=6.5, style="italic")
    ax.text(cx_tool, 3.9, "This tool (upper) and\nindependent reference (lower)", ha="center", va="center", fontsize=6.5, style="italic")
    ax.text(cx_cmp, 3.9, "Comparison", ha="center", fontsize=6.5, style="italic")
    ax.text(x_text, 3.9, "Compared quantities", ha="left", fontsize=6.5, style="italic")
    for i, (label, data, tool, reference, compared) in enumerate(lanes):
        y = top - i * step
        ax.text(0.08, y, label, ha="left", va="center", fontsize=6.5, linespacing=1.15)
        shape(ax, "document", cx_doc, y, 1.45, 0.52, data)
        shape(ax, "process", cx_tool, y + 0.165, 2 * half, 0.27, tool)
        shape(ax, "alternative", cx_tool, y - 0.165, 2 * half, 0.27, reference)
        shape(ax, "decision", cx_cmp, y, 0.95, 0.56, "Equal?")
        ax.text(x_text, y, compared, ha="left", va="center", fontsize=6.5, linespacing=1.15)
        arrow(ax, [(cx_doc + 0.725, y), (2.74, y), (2.74, y + 0.165), (cx_tool - half, y + 0.165)])
        arrow(ax, [(2.74, y), (2.74, y - 0.165), (cx_tool - half, y - 0.165)])
        arrow(ax, [(cx_tool + half, y + 0.165), (4.7, y + 0.165), (4.7, y)], head=False)
        arrow(ax, [(cx_tool + half, y - 0.165), (4.7, y - 0.165), (4.7, y)], head=False)
        arrow(ax, [(4.7, y), (cx_cmp - 0.475, y)])
    save(fig, "validation.pdf")


ROLE_COLOURS = {"operation": "#E6D5EE", "register": "#B8E3DA", "immediate": "#FFF2B3", "modifier": "#C6E0FF", "prefix": "#F9C9DE"}
REGISTER_FIELDS = {"rs1", "rs2", "rd", "rs", "rt", "base", "Rn", "Rm", "Rt", "Rd"}
IMMEDIATE_FIELDS = {"imm[11:0]", "offset", "imm12", "imm16", "imm9"}
MODIFIER_FIELDS = {"option", "S", "shift", "sh"}


def field_role(name):
    if name in REGISTER_FIELDS:
        return "register"
    if name in IMMEDIATE_FIELDS or name.startswith("imm"):
        return "immediate"
    if name in MODIFIER_FIELDS:
        return "modifier"
    return "operation"


def plain(text):
    """Text shown literally: dollar signs of MIPS register names are not mathematics."""
    return text.replace("$", r"\$")


def field_note(field):
    text = field.get("text", "")
    text = text.replace(" (sign-extended)", "")
    return plain(text) if len(text) <= 12 else ""


def encodings(data):
    rows = {e["target"]: e["instruction"] for e in data["encodings"]}
    fig, ax = canvas(7.0, 4.1)
    x0, x1 = 0.12, 6.88
    bit = (x1 - x0) / 32
    row_y = {"riscv": 3.47, "mips": 2.62, "aarch64": 1.77, "x86": 0.92}
    for target in TARGETS:
        insn = rows[target]
        y = row_y[target]
        ax.text(x0, y + 0.47, TARGET_NAMES[target], ha="left", va="center", fontsize=6.5)
        ax.text(x0 + 1.12, y + 0.47, plain(insn["text"].replace("dword ptr ", "")), ha="left", va="center", fontsize=6, family="monospace")
        memory = " ".join(insn["bytes"][i:i + 2] for i in range(0, len(insn["bytes"]), 2))
        if insn.get("fields"):
            ax.text(x1, y + 0.47, f"bytes in memory, lowest address first: {memory}", ha="right", va="center", fontsize=6)
            word = int("".join(insn["bytes"][i:i + 2] for i in range(len(insn["bytes"]) - 2, -1, -2)), 16)
            for f in insn["fields"]:
                left = x0 + (31 - f["hi"]) * bit
                width = (f["hi"] - f["lo"] + 1) * bit
                value = (word >> f["lo"]) & ((1 << (f["hi"] - f["lo"] + 1)) - 1)
                bits = format(value, f"0{f['hi'] - f['lo'] + 1}b")
                fixed = f["name"] == "opcode" and "fixed" in f.get("text", "")
                role = "operation" if fixed else field_role(f["name"])
                ax.add_patch(Rectangle((left, y - 0.11), width, 0.22, facecolor=ROLE_COLOURS[role], edgecolor="#555555", linewidth=0.5))
                ax.text(left + width / 2, y, " ".join(bits), ha="center", va="center", fontsize=6, family="monospace")
                name = "" if fixed else f["name"]
                ax.text(left + width / 2, y + 0.17, name, ha="center", va="center", fontsize=6)
                ax.text(left + width / 2, y - 0.2, field_note(f), ha="center", va="center", fontsize=6)
                ax.text(left + 0.015, y + 0.3, str(f["hi"]), ha="left", va="center", fontsize=6, color="#555555")
                if f["lo"] != f["hi"]:
                    ax.text(left + width - 0.015, y + 0.3, str(f["lo"]), ha="right", va="center", fontsize=6, color="#555555")
        else:
            ax.text(x1, y + 0.47, f"bytes in memory, in instruction order: {memory}", ha="right", va="center", fontsize=6)
            byte = (x1 - x0) / len(insn["bytes"]) * 2
            for g in insn["byteFields"]:
                left = x0 + g["offset"] * byte
                width = g["length"] * byte
                role = "prefix" if g["name"] == "REX" else "register" if g["name"] in ("ModR/M", "SIB") else "immediate" if "isp" in g["name"] or "mm" in g["name"] else "operation"
                ax.add_patch(Rectangle((left, y - 0.11), width, 0.22, facecolor=ROLE_COLOURS[role], edgecolor="#555555", linewidth=0.5))
                group = [insn["bytes"][2 * k:2 * k + 2] for k in range(g["offset"], g["offset"] + g["length"])]
                ax.text(left + width / 2, y, " ".join(group).upper(), ha="center", va="center", fontsize=6, family="monospace")
                ax.text(left + width / 2, y + 0.17, g["name"], ha="center", va="center", fontsize=6)
                notes = [f"{b['name']} = {format(b['value'], '0' + str(b['hi'] - b['lo'] + 1) + 'b')}" for b in g.get("bits", []) if b["name"] != "0100"]
                if role == "immediate":
                    notes = [f"value 0x{''.join(reversed(group)).upper()}"]
                elif role == "operation" and ":" in g.get("text", ""):
                    notes = [g["text"].split(":", 1)[1].split(";", 1)[0].strip()]
                for n, note in enumerate(notes):
                    ax.text(left + width / 2, y - 0.2 - 0.14 * n, note, ha="center", va="center", fontsize=6)
    handles = [Rectangle((0, 0), 1, 1, facecolor=c, edgecolor="#555555", linewidth=0.5) for c in ROLE_COLOURS.values()]
    labels = ["operation", "register", "immediate or displacement", "modifier", "prefix"]
    fig.legend(handles, labels, loc="lower center", ncol=5, bbox_to_anchor=(0.5, 0.0), handlelength=1.2, columnspacing=1.4)
    save(fig, "encodings.pdf")


STATEMENT_COLOURS = {6: "#C6E0FF", 7: "#5FB3A3", 8: "#D6D3F2", 9: "#FFD54F"}


def alignment(data):
    example = next(e for e in data["examples"] if e["id"] == "array_traversal")
    lines = example["source"].splitlines()
    fig, ax = plt.subplots(figsize=(PRINT_WIDTH, 1.8))
    fig.subplots_adjust(left=0.165, right=0.99, top=0.78, bottom=0.21)
    ypos = {t: 3 - i for i, t in enumerate(TARGETS)}
    by_target = {t["target"]: t for t in example["targets"]}
    for t in TARGETS:
        run = by_target[t]
        steps = [b["step"] for b in run["boundaries"]]
        end = run["metrics"]["executedInstructions"]
        y = ypos[t]
        ax.add_patch(Rectangle((0, y - 0.18), steps[0], 0.36, facecolor="#E3E3E3", edgecolor="none"))
        for k, b in enumerate(run["boundaries"]):
            stop = steps[k + 1] if k + 1 < len(steps) else end
            colour = STATEMENT_COLOURS.get(b["line"], "#EFEFEF")
            ax.add_patch(Rectangle((b["step"], y - 0.18), stop - b["step"], 0.36, facecolor=colour, edgecolor="white", linewidth=0.3))
        ax.plot([end, end], [y - 0.24, y + 0.24], color=INK, linewidth=0.8)
    for k in range(len(by_target["riscv"]["boundaries"])):
        for upper, lower in zip(TARGETS[:-1], TARGETS[1:]):
            xs = [by_target[upper]["boundaries"][k]["step"], by_target[lower]["boundaries"][k]["step"]]
            ax.plot(xs, [ypos[upper] - 0.18, ypos[lower] + 0.18], color="#9A9A9A", linewidth=0.35, zorder=0)
    ax.set_yticks([ypos[t] for t in TARGETS], [TARGET_NAMES[t] for t in TARGETS])
    ax.set_ylim(-0.5, 3.5)
    ax.set_xlim(0, max(by_target[t]["metrics"]["executedInstructions"] for t in TARGETS) + 4)
    ax.set_xlabel("Executed instructions")
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.tick_params(axis="y", length=0)
    handles = [Rectangle((0, 0), 1, 1, facecolor=c, edgecolor="none") for c in STATEMENT_COLOURS.values()]
    handles += [Rectangle((0, 0), 1, 1, facecolor="#EFEFEF", edgecolor="none"), Rectangle((0, 0), 1, 1, facecolor="#E3E3E3", edgecolor="none")]
    labels = [f"line {n}: {lines[n - 1].strip()}" for n in STATEMENT_COLOURS] + ["other statements", "startup code"]
    fig.legend(handles, labels, loc="upper center", ncol=3, bbox_to_anchor=(0.56, 1.0), handlelength=1.2, columnspacing=1.2)
    save(fig, "alignment.pdf")


PROGRAM_NAMES = {"sum_loop": "Loop with shift and XOR", "array_passes": "Passes over an array", "multiply_loop": "Loop with multiplication"}
MODES = [("plainMips", "plain stepping", "#3F8F80", "o"), ("eventsMips", "with step events", "#4A86D6", "s"), ("traceMips", "with trace recording", "#6C66B8", "^")]


def throughput(bench):
    sim = bench["simulation"]
    programs = list(sim[TARGETS[0]].keys())
    fig, axes = plt.subplots(1, len(programs), figsize=(PRINT_WIDTH, 1.9), sharey=True)
    fig.subplots_adjust(left=0.085, right=0.995, top=0.78, bottom=0.15, wspace=0.08)
    offset = 0.18
    for ax, program in zip(axes, programs):
        for j, (key, label, colour, marker) in enumerate(MODES):
            xs, med, lo, hi = [], [], [], []
            for i, t in enumerate(TARGETS):
                s = sim[t][program][key]
                xs.append(i + (j - 1) * offset)
                med.append(s["median"])
                lo.append(s["median"] - s["p25"])
                hi.append(s["p75"] - s["median"])
            ax.errorbar(xs, med, yerr=[lo, hi], fmt=marker, color=colour, markersize=3.2, elinewidth=0.6, capsize=1.5, capthick=0.6, label=label)
        ax.set_yscale("log")
        ax.grid(axis="y", which="major", color="#DDDDDD", linewidth=0.4)
        ax.set_axisbelow(True)
        ax.set_xlim(-0.5, len(TARGETS) - 0.5)
        ax.set_ylim(0.2, 12)
        ax.set_xticks(range(len(TARGETS)), ["RISC-V", "MIPS", "AArch64", "x86-64"])
        ax.set_title(PROGRAM_NAMES.get(program, program), fontsize=6.5)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
    axes[0].set_ylabel("Million instructions\nper second")
    axes[0].set_yticks([0.2, 0.5, 1, 2, 5, 10], ["0.2", "0.5", "1", "2", "5", "10"])
    axes[0].yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, bbox_to_anchor=(0.53, 1.0), handlelength=1.2)
    save(fig, "throughput.pdf")


if __name__ == "__main__":
    figure_data = load(ROOT / "experiments" / "results" / "figure-data.json")
    benchmark = load(ROOT / "experiments" / "results" / "benchmark.json")
    architecture()
    validation()
    encodings(figure_data)
    alignment(figure_data)
    throughput(benchmark)
