/**
 * Differential check of the parser against CPython's own parser and compiler,
 * using the pinned Pyodide runtime (CPython 3.14). For every corpus program
 * the tree built here, including the source range of every node, must equal
 * the tree CPython builds, and no diagnostic may be reported.
 *
 * The diagnostics are compared with CPython in one direction. Text that this
 * parser reports as a syntax error must be rejected by CPython, so valid
 * Python is never reported as a syntax error. The converse is not required:
 * `unsupported` means that a construct outside the source language was
 * recognized, and the rest of that construct is not checked, so text reported
 * only as unsupported can also contain errors that CPython reports
 * (docs/language.md, section 9). Every case set below is checked in that one
 * direction: where a syntax error is reported CPython must reject the text,
 * and where CPython compiles the text no syntax error may be reported.
 *
 * The same runtime also runs the independent Python evaluator of the
 * validation harness (validation/reference_eval.py) on range steps that the
 * corpus does not contain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { beforeAll, describe, expect, it } from 'vitest';
import { CORPUS_SETTINGS, loadCorpus, repoRoot } from '../scripts/lib/corpus.ts';
import { FAMILIES } from '../src/core/gen/programs.ts';
import { dumpAst } from '../src/core/lang/ast.ts';
import { check } from '../src/core/lang/check.ts';
import { parse } from '../src/core/lang/parser.ts';
import { evaluateReference } from '../src/core/lang/reference.ts';

const DUMP_PY = `
import ast

def _w(n):
    return "@%d:%d-%d:%d" % (n.lineno, n.col_offset, n.end_lineno, n.end_col_offset)

def _l(items):
    return "[" + ",".join(dump(x) for x in items) + "]"

def dump(n):
    t = type(n).__name__
    if t == "Module":
        return "Module(%s)" % _l(n.body)
    if t == "FunctionDef":
        return "FunctionDef%s(%s,[%s],%s)" % (_w(n), n.name, ",".join(a.arg for a in n.args.args), _l(n.body))
    if t == "Assign":
        return "Assign%s(%s,%s)" % (_w(n), dump(n.targets[0]), dump(n.value))
    if t == "AugAssign":
        return "AugAssign%s(%s,%s,%s)" % (_w(n), dump(n.target), type(n.op).__name__, dump(n.value))
    if t == "If":
        return "If%s(%s,%s,%s)" % (_w(n), dump(n.test), _l(n.body), _l(n.orelse))
    if t == "While":
        return "While%s(%s,%s)" % (_w(n), dump(n.test), _l(n.body))
    if t == "For":
        return "For%s(%s,%s,%s)" % (_w(n), dump(n.target), dump(n.iter), _l(n.body))
    if t == "Return":
        return "Return%s(%s)" % (_w(n), dump(n.value) if n.value is not None else "")
    if t == "Expr":
        return "Expr%s(%s)" % (_w(n), dump(n.value))
    if t in ("Pass", "Break", "Continue"):
        return t + _w(n)
    if t == "Constant":
        if n.value is True or n.value is False:
            return "Constant%s(%s)" % (_w(n), n.value)
        return "Constant%s(%d)" % (_w(n), n.value)
    if t == "Name":
        return "Name%s(%s)" % (_w(n), n.id)
    if t == "UnaryOp":
        return "UnaryOp%s(%s,%s)" % (_w(n), type(n.op).__name__, dump(n.operand))
    if t == "BinOp":
        return "BinOp%s(%s,%s,%s)" % (_w(n), dump(n.left), type(n.op).__name__, dump(n.right))
    if t == "BoolOp":
        return "BoolOp%s(%s,%s)" % (_w(n), type(n.op).__name__, _l(n.values))
    if t == "Compare":
        return "Compare%s(%s,[%s],%s)" % (_w(n), dump(n.left), ",".join(type(o).__name__ for o in n.ops), _l(n.comparators))
    if t == "Call":
        return "Call%s(%s,%s)" % (_w(n), dump(n.func), _l(n.args))
    if t == "Subscript":
        return "Subscript%s(%s,%s)" % (_w(n), dump(n.value), dump(n.slice))
    if t == "List":
        return "List%s(%s)" % (_w(n), _l(n.elts))
    raise ValueError("node outside the language: " + t)

def isa_dump(source):
    return dump(ast.parse(source))

def isa_parses(source):
    try:
        compile(source, "<source>", "exec", dont_inherit=True)
        return True
    except SyntaxError:
        return False
`;

let pyodide: PyodideInterface;
let cpythonDump: (source: string) => string;
let cpythonParses: (source: string) => boolean;
let pythonVersion = '';

beforeAll(async () => {
  pyodide = await loadPyodide();
  pyodide.runPython(DUMP_PY);
  cpythonDump = pyodide.globals.get('isa_dump') as (source: string) => string;
  cpythonParses = pyodide.globals.get('isa_parses') as (source: string) => boolean;
  pythonVersion = pyodide.runPython('import sys; sys.version.split()[0]') as string;
});

/** main with `levels` nested if statements, so that the innermost block is indented levels + 1 times. */
const nestedIfs = (levels: number): string => {
  let s = 'def main(n):\n';
  for (let k = 1; k <= levels; k++) s += '    '.repeat(k) + 'if n == 0:\n';
  return s + '    '.repeat(levels + 1) + 'return 1\n    return 0\n';
};

describe('parser against CPython', () => {
  it('builds the same tree as CPython for every corpus program', () => {
    expect(pythonVersion).toMatch(/^3\.14\./);
    const corpus = loadCorpus();
    expect(corpus.filter((p) => p.group === 'generated').length).toBe(FAMILIES.length * CORPUS_SETTINGS.programsPerFamily);
    let compared = 0;
    for (const p of corpus) {
      const mine = parse(p.source);
      expect(mine.diagnostics, p.name).toEqual([]);
      expect(dumpAst(mine.module), p.name).toBe(cpythonDump(p.source));
      compared++;
    }
    expect(compared).toBe(corpus.length);
  });

  it('ends a numeric literal before a keyword, as CPython does', () => {
    // CPython accepts these with a SyntaxWarning, which is not under test here.
    pyodide.runPython('import warnings; warnings.simplefilter("ignore", SyntaxWarning)');
    for (const source of [
      'def main(a, b):\n    if a == 1and b == 2:\n        return 1\n    return 0\n',
      'def main(a):\n    if a == 0x1for a > 2:\n        return 1\n    return 0\n',
      'def main(a):\n    if a == 0b1or a == 0o7or not a == 2:\n        return 1\n    return 0\n',
    ]) {
      expect(cpythonParses(source), source).toBe(true);
      const mine = parse(source);
      expect(mine.diagnostics, source).toEqual([]);
      expect(dumpAst(mine.module), source).toBe(cpythonDump(source));
    }
  });

  const INVALID = [
    'def main():\n    x = = 1\n',
    'def main()\n    return 0\n',
    'def main():\nreturn 0\n',
    'def main():\n    x = (1 + 2\n    return x\n',
    'def main():\n    x = 1 +\n    return x\n',
    'def main():\n    x = 012\n',
    'def main():\n    1 = x\n',
    'def main():\n    x + 1 = 2\n',
    'def main():\n    if x\n        pass\n',
    'def main():\n    for in range(3):\n        pass\n',
    'def main():\n    x = 1 2\n',
    'def main():\n    return 0\n  y = 1\n',
    'def main():\n    a[] = 1\n',
    'def main():\n    x = [1, 2\n',
    'def main():\n    x = 1abc\n',
    'def main():\n    True = 1\n',
    'def main():\n    else:\n        pass\n',
    'def main():\n    x = 3 $ 4\n',
    'def main():\n    while:\n        pass\n',
    'def 1main():\n    pass\n',
    'def main():\n    x += \n',
    'def main():\n    print(1,, 2)\n',
    'def main():\n    __debug__ = 1\n    return __debug__\n',
    'def main(__debug__):\n    return __debug__\n',
    'def main():\n    for __debug__ in range(3):\n        pass\n    return 0\n',
    'def main():\n    __debug__ += 1\n    return 0\n',
    'def main():\n    return 0 \\\n',
    'def main():\n    return 0  # a\u0000b\n',
    nestedIfs(99),
    'def main(a):\n    return ' + '('.repeat(201) + 'a' + ')'.repeat(201) + '\n',
    'def main(a):\n    x = 1 if a\n    return 0\n',
    'def main(a):\n    x = 1 if a else 2 3\n    return 0\n',
    'def main():\n    x = lambda\n    return 0\n',
    'def main():\n    x = lambda y=1, z: 0\n    return 0\n',
    'def main(a):\n    x = [a for]\n    return 0\n',
    'def main(a):\n    print(a for)\n    return 0\n',
    'def main(a):\n    print(a, a for b in a)\n    return 0\n',
    'def main():\n    x = 1 + lambda: 0\n    return 0\n',
    'def main():\n    x = 1 + yield\n    return 0\n',
    'def main():\n    nonlocal x\n    return 0\n',
    'nonlocal x\ndef main():\n    return 0\n',
    'def main(a):\n    x = await a\n    return 0\n',
    'def main(x):\n    match (x) y:\n        case 1:\n            pass\n    return 0\n',
    'def main(x):\n    match [x] y:\n        case 1:\n            pass\n    return 0\n',
    'def main(x):\n    match (x) +:\n        case 1:\n            pass\n    return 0\n',
    'def main(x):\n    match (x):\n        pass\n    return 0\n',
    'def main(x):\n    match (x):\n    return 0\n',
    'def main(x):\n    match (x):\n        case 1 2:\n            pass\n    return 0\n',
    'def main(x):\n    match (x):\n        case:\n            pass\n    return 0\n',
    'def main(x):\n    match (x):\n        case 1:\n            pass\n    else:\n        pass\n    return 0\n',
    'def main(x):\n    match x:\n        case y:\n            pass\n        case 1:\n            pass\n    return 0\n',
    'def main(x):\n    match x:\n        case {1: y, True: z}:\n            pass\n    return 0\n',
    'def main(x):\n    match x:\n        case [y] | (z,):\n            pass\n    return 0\n',
    'def main(a):\n    x = [await a for a in a]\n    return 0\n',
    'def main(a):\n    x = [a for a in a if (await a, 1)]\n    return 0\n',
    'def main(a):\n    x = (a for a in await a)\n    return 0\n',
    'def main(a):\n    x = ((yield) for a in a)\n    return 0\n',
    'def main(a):\n    x = [a for *a in a]\n    return 0\n',
    'def main(a):\n    x = (*a for a in a)\n    return 0\n',
    'def main(a):\n    x = yield 1 2\n    return 0\n',
    'def main(a):\n    x = (yield) 3\n    return 0\n',
    'def main(a):\n    x = yield if a else 1\n    return 0\n',
    'def main(a):\n    x = yield = 1\n    return 0\n',
    'def main(a):\n    a += yield, 1\n    return 0\n',
    'def main(a):\n    async x\n    return 0\n',
    'def main(a):\n    x:\n    return 0\n',
    'def main(a):\n    x = (1, 2) 3\n    return 0\n',
    'def main(a):\n    x = {1: 2, 3}\n    return 0\n',
    'def main(a):\n    a, 1 = 1, 2\n    return 0\n',
    'def main(a):\n    for i, x in a:\n        y = = 1\n    return 0\n',
    'def main(a):\n    match (a, a):\n        case 1:\n            y = = 1\n    return 0\n',
    'return 0\ndef main():\n    return 0\n',
    // CPython compiles the value of an annotated assignment, and its symbol table checks the annotation.
    'def main(a):\n    x: int = [b for *b in a]\n    return 0\n',
    'def main(a):\n    x: int = lambda: (yield *a)\n    return 0\n',
    'def main(a, x):\n    x: lambda: (yield *a) = lambda: (yield *a)\n    return 0\n',
    'def main(a, x):\n    x: lambda: await a\n    return 0\n',
    'def main(a, x):\n    x: [(yield) for b in a]\n    return 0\n',
    // A dot after a hexadecimal, octal, or binary literal begins an attribute name, not a fraction.
    'def main():\n    x = 0x1.5\n    return 0\n',
    'def main():\n    x = 0b1.\n    return 0\n',
    'def main():\n    x = 0o7.and\n    return 0\n',
    // A clause that continues no statement.
    'def main(a):\n    x = a[1:2]\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    while a[1:2]:\n        pass\n    elif a:\n        pass\n    return 0\n',
    'def main(a):\n    for i in a[1:2]:\n        pass\n    else:\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    type X = int\n        pass\n    return 0\n',
    // Characters that cannot be part of an identifier, or cannot begin one.
    'def main():\n    x\u00b2 = 1\n    return 0\n',
    'def main():\n    x = 1\u00a0+ 2\n    return 0\n',
    'def main():\n    x = \u0663\n    return 0\n',
    'def main():\n    x = \u00e9\u00b2\n    return 0\n',
    'def main(a, b):\n    x = a \u2260 b\n    return 0\n',
    // A line break in the format specification of a single-quoted f-string, and in a string inside a field.
    'def main(a):\n    x = f"{a:\n}"\n    return 0\n',
    'def main(a):\n    x = f"{\'a\n\'}"\n    return 0\n',
    'def main(a):\n    x = f"{a\n    return 0\n',
    // A doubled brace in a format specification before any field inside it has closed.
    'def main(a):\n    x = f"{a:{{}"\n    return 0\n',
    // A line that holds only a backslash is joined to the next line: the block stays empty, or the
    // column of the backslash is an indentation that fits no block.
    'def main(a):\n    if a > 0:\n            \\\n\n    return a\n',
    'def main(a):\n    if a > 0:\n    \\\n        a = 1\n    return a\n',
    'def main(a):\n    x = a\n  \\\n      return x\n',
    'def main(a):\n    x = a\n        \\\nreturn x\n',
    'def main(a):\n    return a\n    \\',
    // More f-strings inside one another, and format specifications nested deeper, than CPython's tokenizer allows.
    `def main(a):\n    x = ${'f"{'.repeat(150)}a${'}"'.repeat(150)}\n    return 0\n`,
    'def main(a):\n    x = f"{a:{a:{a:{a}}}}"\n    return 0\n',
  ];

  it('reports as syntax errors only text that CPython also rejects', () => {
    for (const source of INVALID) {
      const diags = check(source).diagnostics;
      expect(diags.some((d) => d.category === 'syntax'), source).toBe(true);
      expect(cpythonParses(source), source).toBe(false);
    }
  });

  const UNSUPPORTED = [
    'import os\ndef main():\n    return 0\n',
    'def main():\n    x = 7 / 2\n    return 0\n',
    'def main():\n    x = 7 // 2 % 3 ** 2\n    return 0\n',
    'def main():\n    s = "text"\n    return 0\n',
    'def main():\n    x = 1.5\n    return 0\n',
    'def main():\n    x = 1 if True else 2\n    return 0\n',
    'def main():\n    a, b = 1, 2\n    return 0\n',
    'def main():\n    a = b = 1\n    return 0\n',
    'def main():\n    x = [i for i in range(3)]\n    return 0\n',
    'def main():\n    x = {1: 2}\n    return 0\n',
    'def main():\n    x = lambda: 0\n    return 0\n',
    'class A:\n    pass\ndef main():\n    return 0\n',
    'def main():\n    try:\n        pass\n    except Exception:\n        pass\n    return 0\n',
    'def main():\n    with open("f") as f:\n        pass\n    return 0\n',
    'def main():\n    x: int = 3\n    return x\n',
    'def main() -> int:\n    return 0\n',
    'def main(a=1):\n    return a\n',
    'def main(*args):\n    return 0\n',
    'def main():\n    x = 1 < 2 < 3\n    return 0\n',
    'def main():\n    a = [1, 2, 3]\n    return a[0:2][0]\n',
    'def main():\n    x = None\n    return 0\n',
    'def main():\n    for i in range(3):\n        pass\n    else:\n        pass\n    return 0\n',
    'def main():\n    assert True\n    return 0\n',
    'def main():\n    global g\n    return 0\n',
    'def main():\n    x = (y := 3)\n    return x\n',
    'def main():\n    x = a.b\n    return 0\n',
    '@decorator\ndef main():\n    return 0\n',
    'def main():\n    x = 3 in [1, 2]\n    return 0\n',
    'def main():\n    x = (1, 2)\n    return 0\n',
    'def main():\n    del x\n    return 0\n',
    'def main(x):\n    match (x):\n        case 1:\n            pass\n    return 0\n',
    'def main(x):\n    match [x]:\n        case [1]:\n            pass\n    return 0\n',
    'def main(a):\n    x = 1 if a else 2 if a else 3\n    return 0\n',
    'def main():\n    x = lambda y, /, z=1, *w, k, **kw: 0\n    return 0\n',
    'def main(a):\n    print(a for a in range(3))\n    return 0\n',
    'def main():\n    x = [a for a in range(3) if a for b in range(a)]\n    return 0\n',
    'def main():\n    x = yield\n    return 0\n',
    'def main():\n    x = 1\n    def f():\n        nonlocal x\n    return 0\n',
    'def main(a):\n    x = (a async for a in a)\n    return 0\n',
    'def main(a):\n    print(a async for a in a)\n    return 0\n',
    'def main(a):\n    x = (await a for a in a)\n    return 0\n',
    'def main(a):\n    x = (a for a in a if await a)\n    return 0\n',
    'def main(a):\n    x = [b for b in (a async for a in a)]\n    return 0\n',
    'def main(a):\n    x = ([a async for a in a] for b in a)\n    return 0\n',
    'def main(a):\n    x = ((await a, 1) for b in a)\n    return 0\n',
    'x = (await a for a in a)\ndef main():\n    return 0\n',
    'def main(x):\n    match x,:\n        case [1] | (2, *_) as y if y:\n            pass\n        case {1: z, b\'1\': w, **r}:\n            pass\n        case C(1, k=-1 + 2j) | C(2, k=a.b):\n            pass\n        case _:\n            pass\n    return 0\n',
    'def main(a):\n    x = *a, a\n    return 0\n',
    'def main(a):\n    return *a, a\n',
    'def main(a):\n    for b in *a, a:\n        pass\n    return 0\n',
    'def main(a):\n    x: int = 1, *a\n    return 0\n',
    'def main(a):\n    for i, *j in a:\n        pass\n    return 0\n',
    'def main(a):\n    x = {a: b for a in c}\n    return 0\n',
    'def main(a):\n    a, b = c, d = 1, 2\n    return 0\n',
    'def main(a):\n    a += yield a, 1\n    a += (yield), 1\n    a += yield\n    return 0\n',
    'def main():\n    x = 0x1.real\n    return 0\n',
    'def main():\n    x = 0b1.real + 0o7.imag\n    return 0\n',
    // The clauses that continue an if statement or a loop whose header or one-line body is outside the language.
    'def main(a):\n    if a[1:2]:\n        pass\n    elif a:\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    if a:\n        pass\n    elif a[1:2]:\n        pass\n    elif a:\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    if a: x = a[1:2]\n    else: pass\n    return 0\n',
    'def main(a):\n    if a: pass\n    elif a: x = a[1:2]\n    elif a: pass\n    else: pass\n    return 0\n',
    'def main(a):\n    if (y := a):\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    if [*a]:\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    while a[1:2]:\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    for i in a[1:2]:\n        pass\n    else:\n        pass\n    return 0\n',
    'def main(a):\n    for [i, j] in a:\n        pass\n    else:\n        pass\n    return 0\n',
    `def main(a):\n    if ${'-'.repeat(201)}a > 0:\n        pass\n    else:\n        pass\n    return 0\n`,
    // A type alias statement after a semicolon and after the colon of a compound statement, and type parameters.
    'def main(a):\n    type X = int\n    x = 1; type Y[T] = list[T]; x = 2\n    if a > 0: type Z = int\n    else: type W = int\n    return 0\n',
    'def main(a):\n    for i in range(3): type X = int\n    while a > 0: a -= 1; type Y = int\n    return 0\n',
    'def main(a):\n    def f[T](p): pass\n    return 0\n',
    'def main[T](a):\n    return 0\n',
    // Identifiers with letters outside ASCII.
    'def main():\n    caf\u00e9 = 1\n    return caf\u00e9\n',
    'def main():\n    \u03c0 = 3\n    x_\u0663 = \u03c0\n    \ud835\udc9c = \u00aa = 1\n    return 0\n',
    'def \u00e9t\u00e9(\u00e0):\n    return \u00e0\ndef main():\n    return 0\n',
    // f-strings and t-strings whose replacement fields hold quotes, braces, comments, and line breaks.
    'def main(a):\n    x = f"{a["k"]}" + f\'{a[\'k\']}\' + f"{f"{a}"}" + f"{a:{"x"}}"\n    return 0\n',
    'def main(a):\n    x = f"{a\n    + 1}" + f"{a # note "\n    }" + f"{"}"}" + f"{\'"\'}"\n    return 0\n',
    'def main(a):\n    x = t"{a["k"]}"\n    return 0\n',
    'def main(a):\n    x = rf"\\{a["\\\\"]}" + f"\\N{BULLET}{a["k"]}" + f"{a:\\N{BULLET}}" + f"{a:\\"}"\n    return 0\n',
    'def main(a, b, c, w):\n    x = f\'\'\'{a:\n}\'\'\' + f"{a:{b:{c}}}" + f"{a!r:>{w}}" + f"{{}}{a}}}" + f"{ {"k": 1}["k"] }"\n    return 0\n',
    'def main(a, b):\n    x = f"{(lambda: "}")()}" + f"""{a}"{b}" """ + f"{\'\'\'\n\'\'\'}"\n    return 0\n',
    `def main(a):\n    x = ${'f"{'.repeat(149)}a${'}"'.repeat(149)} + f"{a:{a:{a}}}"\n    return 0\n`,
    // A doubled brace after a field that has closed inside a format specification is literal text.
    'def main(a, b):\n    x = f"{a:{b}{{}" + f"{a:>{b}{{<}" + f"{a:{b}{{{a}}" + rt\'\'\'{a:{b}{{}\'\'\'\n    return 0\n',
    'def main(a, b):\n    print(f"{a:{b}{{}", t\'{a:{b}{{}\')\n    return 0\n',
  ];

  it('reports valid Python outside the language as unsupported, never as a syntax error', () => {
    for (const source of UNSUPPORTED) {
      expect(cpythonParses(source), source).toBe(true);
      const diags = check(source).diagnostics.filter((d) => d.severity === 'error');
      expect(diags.length, source).toBeGreaterThan(0);
      expect(diags.filter((d) => d.category === 'syntax'), source).toEqual([]);
    }
  });

  /** Programs of the language in which a line that holds only a backslash is joined to the indentation of the next line. */
  const JOINED_INDENTATION = [
    'def main(a):\n    x = a\n\\\n    return x\n',
    'def main(a):\n    x = a\n\\\n\n    return x\n',
    'def main(a):\n    x = a\n\\\r\n\\\n    return x\n',
    'def main(a):\n    if a > 0:\n        \\\n  a = 1\n    return a\n',
    'def main(a):\n    if a > 0:\n\\\n        a = 1\n            \\\n    # note\n    return a\n',
    'def main(a):\n    while a > 3:\n\t\\\n        a -= 1\n    \\\n\t\t\treturn a\n',
  ];

  it('accepts a program whose indentation holds line continuations and builds the tree that CPython builds', () => {
    for (const source of JOINED_INDENTATION) {
      const mine = parse(source);
      expect(mine.diagnostics, source).toEqual([]);
      expect(check(source).diagnostics, source).toEqual([]);
      expect(dumpAst(mine.module), source).toBe(cpythonDump(source));
    }
  });

  /**
   * Annotations that break a rule which CPython enforces only when it compiles
   * an expression: a starred comprehension target outside a tuple or list, two
   * starred targets, and a starred value of yield without a comma.
   */
  const UNCOMPILED = [
    '[b for *b in a]', '[b for *b, *c in a]', '(b for *b in a)', '{b for *b in a}', '{b: 1 for *b in a}', '[b for b, *c, *d in a]',
    '[b for (*b, *c) in a]', '[b for b in a for *c in b]', 'lambda: [b for *b in a]', 'lambda: (yield *a)', 'lambda: {b for b, *c, *d in a}',
    '[(lambda: (yield *a)) for b in a]',
  ];
  /** CPython never compiles the annotation of a local variable, whatever the target is. */
  const LOCAL_ANNOTATIONS = UNCOMPILED.flatMap((annotation) => [
    `def main(a, x):\n    x: ${annotation}\n    return 0\n`,
    `def main(a, x):\n    x: ${annotation} = 1\n    return 0\n`,
    `def main(a, x):\n    a.b: ${annotation}\n    return 0\n`,
    `def main(a, x):\n    a[0]: ${annotation}\n    return 0\n`,
  ]);
  /** At module level it compiles the annotation of a plain name only, and not under the annotations future import. */
  const MODULE_ANNOTATIONS = UNCOMPILED.flatMap((annotation) => [
    `a.b: ${annotation}\ndef main(a):\n    return 0\n`,
    `a[0]: ${annotation}\ndef main(a):\n    return 0\n`,
    `(x): ${annotation}\ndef main(a):\n    return 0\n`,
    `from __future__ import annotations\nx: ${annotation}\ndef main(a):\n    return 0\n`,
  ]);

  it('reports no syntax error inside an annotation that CPython does not compile', () => {
    for (const source of LOCAL_ANNOTATIONS) {
      expect(cpythonParses(source), source).toBe(true);
      expect(check(source).diagnostics.map((d) => `${d.category}: ${d.message}`), source).toEqual([
        'unsupported: variable annotations are not part of the source language',
      ]);
    }
    for (const source of MODULE_ANNOTATIONS) {
      expect(cpythonParses(source), source).toBe(true);
      const diags = check(source).diagnostics;
      expect(diags.filter((d) => d.category === 'syntax'), source).toEqual([]);
      expect(diags.map((d) => d.message), source).toContain('variable annotations are not part of the source language');
    }
  });
});

describe('independent Python evaluator', () => {
  it('steps a range by the 32-bit value of the step literal, as the reference evaluator does', () => {
    const namespace = pyodide.globals.get('dict')();
    pyodide.runPython(readFileSync(join(repoRoot(), 'validation', 'reference_eval.py'), 'utf8'), { globals: namespace });
    const runReference = namespace.get('run_reference');
    const loop = (range: string): string => `def main():\n    t = 0\n    for i in ${range}:\n        t += i\n    return t\n`;
    for (const [range, expected] of [
      ['range(0, 10, -(-3))', 18],
      ['range(10, 0, +-3)', 22],
      ['range(3, 0, 0xFFFFFFFF)', 6],
      ['range(10, 0, -(-4294967295))', 55],
      ['range(0, 3, -4294967295)', 3],
      ['range(-1, -2, -2147483648)', -1],
    ] as const) {
      const source = loop(range);
      const ours = evaluateReference(check(source), []);
      const result = runReference(source, []);
      const python = result.toJs({ dict_converter: Object.fromEntries }) as { returnValue: number; inRange: boolean };
      result.destroy();
      expect(ours.returnValue, range).toBe(expected);
      expect(python.returnValue, range).toBe(expected);
      expect(python.inRange, range).toBe(ours.pythonCoincident);
    }
    runReference.destroy();
    namespace.destroy();
  });
});
