import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../scripts/lib/corpus.ts';
import { compileFrontEnd } from '../src/core/compile.ts';
import { ArgumentCountError } from '../src/core/exec.ts';
import { check, LIMITS } from '../src/core/lang/check.ts';
import { tokenize } from '../src/core/lang/lexer.ts';
import { parse } from '../src/core/lang/parser.ts';
import { evaluateReference } from '../src/core/lang/reference.ts';
import { dumpAst } from '../src/core/lang/ast.ts';

const run = (body: string, args: number[] = []) => {
  const p = check(body);
  expect(p.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return evaluateReference(p, args);
};
const codes = (source: string): string[] => check(source).diagnostics.map((d) => d.code);
const categories = (source: string): string[] => check(source).diagnostics.map((d) => d.category);
const messages = (source: string): string[] => check(source).diagnostics.map((d) => `${d.category}: ${d.message}`);
/** main containing `levels` nested if statements, so that the innermost block is indented levels + 1 times. */
const nestedIfs = (levels: number): string => {
  let s = 'def main(n):\n';
  for (let k = 1; k <= levels; k++) s += '    '.repeat(k) + 'if n == 0:\n';
  return s + '    '.repeat(levels + 1) + 'return 1\n    return 0\n';
};

describe('lexer', () => {
  it('produces indentation tokens and joins lines inside brackets', () => {
    const { tokens, diagnostics } = tokenize('def main():\n    a = [1,\n         2]\n    return 0\n');
    expect(diagnostics).toEqual([]);
    expect(tokens.map((t) => t.kind).filter((k) => k === 'indent' || k === 'dedent')).toEqual(['indent', 'dedent']);
    expect(tokens.filter((t) => t.kind === 'newline')).toHaveLength(3);
  });

  it('reads integer literals in four bases with underscores', () => {
    const values = tokenize('0x1F 0b101 0o17 1_000 0 00').tokens.filter((t) => t.kind === 'int').map((t) => t.value);
    expect(values).toEqual([31n, 5n, 15n, 1000n, 0n, 0n]);
  });

  it('rejects malformed literals as Python does', () => {
    expect(tokenize('x = 012\n').diagnostics[0]?.message).toMatch(/leading zeros/);
    expect(tokenize('x = 1abc\n').diagnostics[0]?.message).toMatch(/invalid decimal literal/);
    expect(tokenize('x = 0x\n').diagnostics[0]?.message).toMatch(/invalid hexadecimal literal/);
  });

  it('reports inconsistent indentation and unclosed brackets', () => {
    expect(tokenize('if x:\n        y = 1\n    z = 2\n').diagnostics[0]?.message).toMatch(/unindent does not match/);
    expect(tokenize('x = (1 +\n').diagnostics[0]?.message).toMatch(/was never closed/);
    expect(tokenize('x = 1)\n').diagnostics[0]?.message).toMatch(/unmatched/);
  });

  it('recognizes strings and floats so that they can be reported as unsupported', () => {
    const kinds = tokenize('a = "x" + 1.5 + 2e3 + 3j + f"{a}"\n').tokens.map((t) => t.kind);
    expect(kinds.filter((k) => k === 'string')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'float')).toHaveLength(3);
  });

  it('ends a numeric literal before a keyword, as CPython does', () => {
    const lexed = tokenize('x = 1and 0b1if 0o7or 0xfor 2else 3in 4is 5not 6jif\n');
    expect(lexed.diagnostics).toEqual([]);
    expect(lexed.tokens.filter((t) => t.kind !== 'newline' && t.kind !== 'eof').map((t) => t.text)).toEqual([
      'x', '=', '1', 'and', '0b1', 'if', '0o7', 'or', '0xf', 'or', '2', 'else', '3', 'in', '4', 'is', '5', 'not', '6j', 'if',
    ]);
    expect(tokenize('x = 1andy\n').diagnostics[0]?.message).toMatch(/invalid decimal literal/);
    expect(tokenize('x = 1as\n').diagnostics[0]?.message).toMatch(/invalid decimal literal/);
  });

  it('ends a hexadecimal, octal, or binary literal before a dot', () => {
    const lexed = tokenize('x = 0x1.real + 0b1.imag + 0o7.e5\n');
    expect(lexed.diagnostics).toEqual([]);
    expect(lexed.tokens.filter((t) => t.kind !== 'newline' && t.kind !== 'eof').map((t) => t.text)).toEqual([
      'x', '=', '0x1', '.', 'real', '+', '0b1', '.', 'imag', '+', '0o7', '.', 'e5',
    ]);
    expect(categories('def main():\n    x = 0x1.real\n    return 0\n')).toEqual(['unsupported']);
    // A fraction after such a literal is a second number, which the parser rejects.
    expect(tokenize('x = 0x1.5\n').diagnostics).toEqual([]);
    expect(messages('def main():\n    x = 0x1.5\n    return 0\n')).toEqual(['syntax: invalid syntax']);
    expect(tokenize('x = 1.real\n').diagnostics[0]?.message).toMatch(/invalid decimal literal/);
  });

  it('reports an identifier with characters outside ASCII as unsupported, as it is valid Python', () => {
    const lexed = tokenize('caf\u00e9 = \u03c0 + x_\u0663 + \ud835\udc9c\n');
    expect(lexed.diagnostics.map((d) => `${d.category}: ${d.message} @${d.span?.start.col}-${d.span?.end.col}`)).toEqual([
      'unsupported: identifiers with characters outside ASCII are not part of the source language @0-4',
      'unsupported: identifiers with characters outside ASCII are not part of the source language @7-8',
      'unsupported: identifiers with characters outside ASCII are not part of the source language @11-14',
      'unsupported: identifiers with characters outside ASCII are not part of the source language @17-19',
    ]);
    expect(lexed.tokens.filter((t) => t.kind === 'name').map((t) => t.text)).toEqual(['caf\u00e9', '\u03c0', 'x_\u0663', '\ud835\udc9c']);
    expect(categories('def main():\n    caf\u00e9 = 1\n    return caf\u00e9\n')).toEqual(['unsupported', 'unsupported']);
    // A character that cannot be part of an identifier, or cannot begin one, is not Python.
    for (const source of ['x\u00b2 = 1\n', 'x = 1\u00a0+ 2\n', 'x = \u0663\n', 'x = \u00e9\u00b2\n', 'x = a \u2260 b\n']) {
      expect(tokenize(source).diagnostics.map((d) => d.category), source).toContain('syntax');
      expect(tokenize(source).diagnostics.map((d) => d.category), source).not.toContain('unsupported');
    }
  });

  it('scans a long run of letters outside ASCII once when a character ends it that no identifier can hold', () => {
    const letters = LIMITS.maxSourceLength - 8;
    const source = `x = ${'é'.repeat(letters)}€\n`;
    expect(source.length).toBeLessThanOrEqual(LIMITS.maxSourceLength);
    const started = performance.now();
    const lexed = tokenize(source);
    const elapsed = performance.now() - started;
    expect(lexed.diagnostics).toHaveLength(letters + 1);
    expect(lexed.diagnostics.every((d) => d.category === 'syntax' && d.code === 'invalid-character')).toBe(true);
    // The scan takes a fraction of a second; restarting it at every letter takes about a minute.
    expect(elapsed).toBeLessThan(10000);
  });

  it('joins a line that holds only a backslash to the indentation of the next line, as CPython does', () => {
    const texts = (source: string): string[] => tokenize(source).tokens.map((t) => `${t.kind}:${t.text === '\n' ? '' : t.text}`);
    const plain = 'def main(a):\n    x = a\n    if a > 0:\n        x = 1\n    return x\n';
    for (const source of [
      'def main(a):\n    x = a\n\\\n    if a > 0:\n        x = 1\n    return x\n',
      'def main(a):\n    x = a\n    if a > 0:\n        x = 1\n\\\n\n    return x\n',
      'def main(a):\n    x = a\n\\\r\n\\\n    if a > 0:\n        \\\n  x = 1\n    return x\n',
      'def main(a):\n    x = a\n    if a > 0:\n\\\n        x = 1\n            \\\n    # note\n    return x\n',
    ]) {
      expect(tokenize(source).diagnostics, source).toEqual([]);
      expect(texts(source), source).toEqual(texts(plain));
      expect(run(source, [5]).returnValue, source).toBe(1);
      expect(run(source, [-5]).returnValue, source).toBe(-5);
    }
    // Positions after the joined lines are those of the source text.
    const joined = tokenize('def main(a):\n\\\n    return a\n').tokens.find((t) => t.text === 'return')!;
    expect([joined.span.start.line, joined.span.start.col, joined.span.start.offset]).toEqual([3, 4, 19]);
    // The column of the first backslash, when it is not the first column, is the indentation of the logical line.
    expect(messages('def main(a):\n    if a > 0:\n    \\\n        a = 1\n    return a\n')).toEqual([
      "syntax: expected an indented block after 'if' statement on line 2",
    ]);
    expect(messages('def main(a):\n    x = a\n        \\\nreturn x\n')).toEqual(['syntax: unexpected indent']);
    expect(messages('def main(a):\n    x = a\n  \\\n      return x\n')[0]).toBe('syntax: unindent does not match any outer indentation level');
    // A joined line that is blank leaves the block of the statement before it empty.
    expect(messages('def main(a):\n    if a > 0:\n            \\\n\n    return a\n')).toEqual([
      "syntax: expected an indented block after 'if' statement on line 2",
    ]);
    expect(messages('def main(a):\n    return a\n    \\')).toEqual(['syntax: unexpected EOF while parsing']);
  });

  it('delimits f-strings and t-strings as CPython does since Python 3.12', () => {
    for (const literal of [
      'f"{a["k"]}"', "f'{a['k']}'", 'f"{f"{a}"}"', 'f"{a:{"x"}}"', 't"{a["k"]}"', 'f"{a\n + 1}"', 'f"{a # note "\n}"', 'f"{"}"}"', 'f"{\'"\'}"',
      'f"{{}}{a}}}"', 'rf"\\{a["\\\\"]}"', 'f"\\N{BULLET}{a["k"]}"', 'f"{a:\\N{BULLET}}"', 'f"{a:\\"}"', "f'''{a:\n}'''", 'f"{a:{b:{c}}}"', 'f"{a!r:>{w}}"',
      'f"{a:{b}{{}"', 'f"{a:>{b}{{<}"', 'f"{a:{b}{{{c}}"', "rt'''{a:{b}{{}'''",
      'f"{a[1:2]}"', 'f"{ {"k": 1}["k"] }"', 'f"{(lambda: "}")()}"', 'f"""{a}"{b}" """', 'f"{\'\'\'\n\'\'\'}"', 'F"{a}"', 'Rf"{a["k"]}"', '"{a["',
    ]) {
      const lexed = tokenize(`x = ${literal} + b\n`);
      expect(lexed.diagnostics, literal).toEqual([]);
      expect(lexed.tokens.filter((t) => t.kind !== 'newline' && t.kind !== 'eof').map((t) => t.text), literal).toEqual(['x', '=', literal, '+', 'b']);
    }
    expect(categories('def main(a):\n    x = f"{a["k"]}"\n    return 0\n')).toEqual(['unsupported']);
    // Text that CPython rejects: a line break in a format specification, and one in a string inside a field.
    expect(tokenize('x = f"{a:\n}"\n').diagnostics[0]?.message).toMatch(/unterminated string literal/);
    expect(tokenize('x = f"{\'a\n\'}"\n').diagnostics[0]?.message).toMatch(/unterminated string literal/);
    expect(tokenize('x = f"{a\n').diagnostics[0]?.message).toMatch(/unterminated string literal/);
    // A doubled brace is literal text in a format specification only after a field inside it has closed.
    expect(tokenize('x = f"{a:{{}"\n').diagnostics[0]?.message).toMatch(/unterminated string literal/);
    // CPython's limits on nesting, which also bound the recursion of the tokenizer: 149 literals inside one
    // another, and format specifications two deep.
    const nested = (depth: number): string => `x = ${'f"{'.repeat(depth)}a${'}"'.repeat(depth)}\n`;
    const specs = (depth: number): string => `x = t"{a${':{a'.repeat(depth)}${'}'.repeat(depth)}}"\n`;
    const only = (source: string): string[] => tokenize(source).diagnostics.map((d) => `${d.category}: ${d.message}`);
    expect(only(nested(149))).toEqual([]);
    expect(only(specs(2))).toEqual([]);
    for (const depth of [150, 151, 12000]) expect(only(nested(depth)), String(depth)).toEqual(['syntax: too many nested f-strings or t-strings']);
    for (const depth of [3, 4, 12000]) expect(only(specs(depth)), String(depth)).toEqual(['syntax: t-string: expressions nested too deeply']);
    expect(nested(12000).length).toBeLessThan(LIMITS.maxSourceLength);
  });

  it('rejects text that the CPython tokenizer rejects', () => {
    const only = (source: string): string[] => tokenize(source).diagnostics.map((d) => d.message);
    expect(only('def main():\n    return 0 \\\n')).toEqual(['unexpected EOF while parsing']);
    expect(only('def main():\n    return 0\n\\')).toEqual(['unexpected EOF while parsing']);
    expect(only('def main():\n    return 0 \\\n\n')).toEqual([]);
    expect(only('def main():\n    return 0  # a\u0000b\u0000\n')).toEqual(['source code cannot contain null bytes']);
    expect(only('def main():\n    # \u0000\n    return 0\n')).toEqual(['source code cannot contain null bytes']);
    expect(only('x = "\u0000"\n')).toEqual(['source code cannot contain null bytes']);
    expect(only(nestedIfs(98))).toEqual([]);
    expect(only(nestedIfs(99))).toEqual(['too many levels of indentation']);
    expect(only('x = ' + '('.repeat(200) + '1' + ')'.repeat(200) + '\n')).toEqual([]);
    expect(only('x = ' + '[('.repeat(150) + '1' + ')]'.repeat(150) + '\n')).toEqual(['too many nested parentheses']);
  });
});

describe('parser', () => {
  it('follows Python operator precedence', () => {
    const dump = dumpAst(parse('x = 1 + 2 * 3 << 4 & 5 | 6 ^ 7\n').module);
    // | is lowest, then ^, then &, then <<, then +, then *.
    expect(dump).toMatch(/^Module\(\[Assign@[^(]+\(Name@[^(]+\(x\),BinOp@[^(]+\(BinOp@[^(]+\(BinOp@[^(]+\(BinOp@[^(]+\(Constant@[^(]+\(1\),Add,BinOp/);
    expect(dump).toContain(',BitOr,BinOp');
  });

  it('gives unary minus lower precedence than a following comparison but higher than multiplication operands', () => {
    expect(dumpAst(parse('x = -a * b\n').module)).toContain('BinOp@1:4-1:10(UnaryOp@1:4-1:6(USub,Name@1:5-1:6(a)),Mult,Name@1:9-1:10(b))');
    expect(dumpAst(parse('x = not a == b\n').module)).toContain('UnaryOp@1:4-1:14(Not,Compare');
  });

  it('flattens Boolean operator chains like CPython', () => {
    expect(dumpAst(parse('x = a and b and c or d\n').module)).toContain('BoolOp@1:4-1:22(Or,[BoolOp@1:4-1:17(And,[Name@1:4-1:5(a),Name@1:10-1:11(b),Name@1:16-1:17(c)]),Name@1:21-1:22(d)])');
  });

  it('reports syntax errors with positions', () => {
    const d = parse('def main():\n    x = = 1\n').diagnostics[0]!;
    expect(d.category).toBe('syntax');
    expect(d.span?.start.line).toBe(2);
    expect(parse('def main()\n    pass\n').diagnostics[0]?.message).toMatch(/expected ':'/);
    expect(parse('def main():\npass\n').diagnostics[0]?.message).toMatch(/expected an indented block/);
    expect(parse('1 = x\n').diagnostics[0]?.message).toMatch(/cannot assign to literal/);
    expect(parse('f() = 1\n').diagnostics[0]?.message).toMatch(/cannot assign to function call/);
  });

  it('recognizes unsupported Python and keeps parsing', () => {
    const r = parse('import os\nclass A:\n    pass\ndef main():\n    x = 1 if a else 2\n    return 0\n');
    expect(r.diagnostics.map((d) => d.category)).toEqual(['unsupported', 'unsupported', 'unsupported']);
    expect(r.module.body.some((s) => s.kind === 'FunctionDef')).toBe(true);
  });

  it('reports no syntax error for valid Python around a construct outside the language', () => {
    const inMain = (body: string): string => `def main(a):\n    ${body}\n    return 0\n`;
    const slices = 'unsupported: slices are not part of the source language';
    const annotations = 'unsupported: variable annotations are not part of the source language';
    const aliases = 'unsupported: type alias statements are not part of the source language';
    const valid: [string, string[]][] = [
      // The clauses that continue an abandoned if statement or loop belong to it.
      ['if a[1:2]:\n        pass\n    elif a:\n        pass\n    else:\n        pass', [slices]],
      ['if a > 0:\n        pass\n    elif a[1:2]:\n        pass\n    elif a > 1:\n        pass\n    else:\n        pass', [slices]],
      ['if a > 0: x = a[1:2]\n    else: pass', [slices]],
      ['if a > 0: pass\n    elif a > 1: x = a[1:2]\n    elif a > 2: pass\n    else: pass', [slices]],
      ['while a[1:2]:\n        pass\n    else:\n        pass', [slices]],
      ['for i in a[1:2]:\n        pass\n    else:\n        pass', [slices]],
      ['if (y := a):\n        pass\n    else:\n        pass', ['unsupported: assignment expressions are not part of the source language']],
      [`if ${'-'.repeat(201)}a > 0:\n        pass\n    else:\n        pass`, ['limit: an expression can nest at most 200 operations']],
      // A type alias statement is a simple statement: it can follow a semicolon or a colon.
      ['type X = int', [aliases]],
      ['x = 1; type X[T] = list[T]; x = 2', [aliases]],
      ['if a > 0: type X = int\n    else: type Y = int', [aliases, aliases]],
      ['type = 1; type += a', []],
      // Type parameters of a function definition.
      ['def f[T](p): pass', ['unsupported: type parameters are not part of the source language']],
      // CPython does not compile an annotation, so the rules of its compiler do not hold there.
      ['x: [b for *b in a]', [annotations]],
      ['x: [b for *b, *c in a] = 1', [annotations]],
      ['a.b: [b for (*b, *c) in a]', [annotations]],
      ['a[0]: lambda: (yield *a)', [annotations]],
      ['x: {b: 1 for b, *c, *d in a}', [annotations]],
    ];
    for (const [body, expected] of valid) expect(messages(inMain(body)), body).toEqual(expected);
    expect(messages('a.b: [b for *b in a]\nx: (b for *b in a)\ndef main():\n    return 0\n').filter((m) => m.startsWith('syntax'))).toEqual([]);
    // The same rules hold where CPython compiles the expression, and a clause that continues nothing is not Python.
    const invalid: [string, RegExp][] = [
      ['x: int = [b for *b in a]', /starred assignment target must be in a list or tuple/],
      ['x: lambda: (yield *a) = lambda: (yield *a)', /can't use starred expression here/],
      ['x = [b for *b, *c in a]', /multiple starred expressions in assignment/],
      ['x = a[1:2]\n    else:\n        pass', /invalid syntax/],
      ['while a[1:2]:\n        pass\n    elif a:\n        pass', /invalid syntax/],
      ['for i in a[1:2]:\n        pass\n    else:\n        pass\n    else:\n        pass', /invalid syntax/],
      ['type X = int\n        pass', /unexpected indent/],
    ];
    for (const [body, message] of invalid) {
      expect(messages(inMain(body)).filter((m) => m.startsWith('syntax')).join('; '), body).toMatch(message);
    }
  });

  it('parses the constructs that the specification lists completely before reporting them as unsupported', () => {
    const inMain = (line: string): string => `def main(a):\n    ${line}\n    return 0\n`;
    const invalid: [string, RegExp][] = [
      ['x = 1 if a', /expected 'else' after 'if' expression/],
      ['x = 1 if a else', /invalid syntax/],
      ['x = 1 if a else 2 3', /invalid syntax/],
      ['x = lambda', /invalid syntax/],
      ['x = lambda y', /invalid syntax/],
      ['x = lambda y=1, z: 0', /parameter without a default follows parameter with a default/],
      ['x = lambda *: 0', /named arguments must follow bare \*/],
      ['x = 1 + lambda: 0', /invalid syntax/],
      ['x = 1 + yield', /invalid syntax/],
      ['print(yield)', /invalid syntax/],
      ['x = [a for]', /invalid syntax/],
      ['x = [a for a]', /'in' expected after for-loop variables/],
      ['x = [a for a in b,]', /invalid syntax/],
      ['x = [a, b for a in c]', /did you forget parentheses around the comprehension target/],
      ['x = [*a for a in b]', /iterable unpacking cannot be used in comprehension/],
      ['print(a for)', /invalid syntax/],
      ['print(a, b for b in a)', /Generator expression must be parenthesized/],
      ['x = (a for)', /invalid syntax/],
      ['x = [a async for a in b]', /asynchronous comprehension outside of an asynchronous function/],
      ['nonlocal x', /no binding for nonlocal 'x' found/],
      ['x = await a', /'await' outside async function/],
      ['await a', /'await' outside async function/],
      ['x = await', /invalid syntax/],
      // A list comprehension, unlike a generator expression, runs in the function that contains it.
      ['x = [await a for a in b]', /asynchronous comprehension outside of an asynchronous function/],
      ['x = [[a async for a in a] for b in a]', /asynchronous comprehension outside of an asynchronous function/],
      ['x = [(a for a in await b) for b in a]', /asynchronous comprehension outside of an asynchronous function/],
      ['x = [a for a in a if (await a, 1)]', /asynchronous comprehension outside of an asynchronous function/],
      // The first iterable of a generator expression and a lambda body are not in the generator's own scope.
      ['x = (a for a in await b)', /'await' outside async function/],
      ['x = (lambda: await a for a in b)', /'await' outside async function/],
      ['x = (await a, 1)', /'await' outside async function/],
      ['x = ((yield) for a in b)', /'yield' inside generator expression/],
      ['x = [(yield) for a in b]', /'yield' inside list comprehension/],
      ['x = (*a for a in b)', /iterable unpacking cannot be used in comprehension/],
      ['x = (*a)', /cannot use starred expression here/],
      ['x = [*a or b]', /invalid syntax/],
      ['x = [a for *a in b]', /starred assignment target must be in a list or tuple/],
      ['x = [a for *a, *b in c]', /multiple starred expressions in assignment/],
      ['x = yield 1 2', /invalid syntax/],
      ['x = (yield) 3', /invalid syntax/],
      ['x = yield if a else 1', /invalid syntax/],
      ['x = yield = 1', /assignment to yield expression not possible/],
      ['x += yield, 1', /invalid syntax/],
      ['yield from', /invalid syntax/],
      ['yield *a', /can't use starred expression here/],
      ['x = *a', /can't use starred expression here/],
      ['x = y = 1 2', /invalid syntax/],
      ['async x', /invalid syntax/],
      ['async for b in a: pass', /'async for' outside async function/],
      ['x:', /invalid syntax/],
      ['x: int, y', /invalid syntax/],
      ['x: int = await a', /'await' outside async function/],
      ['x: await a', /await expression cannot be used within an annotation/],
      // Tuples, dicts, and sets are parsed completely, and tuples of targets are checked item by item.
      ['x = (1, 2) 3', /invalid syntax/],
      ['x = 1, , 2', /invalid syntax/],
      ['x = {1: 2} 3', /invalid syntax/],
      ['x = {1: 2, 3}', /':' expected after dictionary key/],
      ['x = {**a for a in b}', /dict unpacking cannot be used in dict comprehension/],
      ['x = {a async for a in b}', /asynchronous comprehension outside of an asynchronous function/],
      ['x = {(yield) for a in b}', /'yield' inside set comprehension/],
      ['a, 1 = 1, 2', /cannot assign to literal/],
      ['a, *b, *c = d', /multiple starred expressions in assignment/],
      ['(a, b) += 1', /'tuple' is an illegal expression for augmented assignment/],
      ['for i, 1 in a: pass', /cannot assign to literal/],
      ['for *i in a: pass', /starred assignment target must be in a list or tuple/],
      ['if (b) := 1: pass', /cannot use assignment expressions/],
    ];
    for (const [line, message] of invalid) {
      const diags = check(inMain(line)).diagnostics;
      expect(diags.filter((d) => d.category === 'syntax').map((d) => d.message).join('; '), line).toMatch(message);
      expect(diags.filter((d) => d.category === 'unsupported'), line).toEqual([]);
    }
    expect(messages('nonlocal x\ndef main():\n    return 0\n')).toContain('syntax: nonlocal declaration not allowed at module level');
    expect(messages('await x\ndef main():\n    return 0\n')).toContain("syntax: 'await' outside function");
    expect(messages('x = yield\ndef main():\n    return 0\n')).toContain("syntax: 'yield' outside function");
    expect(messages('x = [b for b in (yield)]\ndef main():\n    return 0\n')).toContain("syntax: 'yield' outside function");
    expect(messages('return 0\ndef main():\n    return 0\n')).toEqual(["syntax: 'return' outside function"]);
    // The construct outside the language ends the statement only after the statement is checked.
    expect(messages(inMain('for i, x in a:\n        y = = 1'))).toContain('syntax: invalid syntax');
    expect(messages('def main(a):\n    match (a, a):\n        case 1:\n            y = = 1\n    return 0\n')).toContain('syntax: invalid syntax');
    // A generator expression may contain async for and await, in any function and at module level.
    for (const source of [
      inMain('x = (a async for a in a)'),
      inMain('print(a async for a in a)'),
      inMain('x = (await a for a in a)'),
      inMain('print(await a for a in a)'),
      inMain('x = (a for a in a if await a)'),
      inMain('x = (a for a in a for b in await a)'),
      inMain('x = lambda: (await a for a in a)'),
      inMain('x = [(await a for a in a) for b in a]'),
      inMain('x = [b for b in (a async for a in a)]'),
      inMain('x = ([a async for a in a] for b in a)'),
      inMain('x = ((await a, 1) for b in a)'),
      inMain('x = (lambda b=await a: 0 for a in a)'),
      inMain('x = [b for b in (yield)]'),
      inMain('x = lambda: (yield)'),
      'x = (await a for a in a)\ndef main():\n    return 0\n',
      'x = lambda: (yield)\ndef main():\n    return 0\n',
      // A starred item is valid in a tuple.
      inMain('x = *a, a'),
      inMain('x += *a,'),
      inMain('for b in *a, a: pass'),
      inMain('x = (yield *a, a)'),
      inMain('yield a,'),
      'def main(a):\n    return *a, a\n',
      inMain('x: int = 1, *a'),
      inMain('a.b: int'),
      inMain('x: (await a for a in a)'),
      inMain('a, b = c, d = 1, 2'),
      inMain('a, (b, *c) = d'),
      inMain('() = []'),
      inMain('for i, *j in a: pass'),
      inMain('x = {a: b for a in c}'),
      inMain('x = {**a, 1: 2}'),
      inMain('x = {*a, 1}'),
      inMain('while b := 1: pass'),
      inMain('x = (y := 1, 2)'),
    ]) {
      const diags = check(source).diagnostics.filter((d) => d.severity === 'error');
      expect(diags.map((d) => d.category), source).toContain('unsupported');
      expect(diags.filter((d) => d.category !== 'unsupported').map((d) => d.message), source).toEqual([]);
    }
    const valid: [string, string][] = [
      ['x = 1 if a else 2 if a else 3', 'conditional expressions'],
      ['x = 1 if a else lambda: 0', 'conditional expressions'],
      ['x = lambda y, /, z=1, *w, k, **kw: 0 if y else 1', 'lambda expressions'],
      ['x = [a for a in range(3) if a for b in range(a)]', 'list comprehensions'],
      ['x = [a for [b, c] in d]', 'list comprehensions'],
      ['print(a for a in range(3))', 'generator expressions'],
      ['x = (a for a in range(3))', 'generator expressions'],
      ['x = yield', 'generators'],
      ['x += yield a', 'generators'],
      ['x = (yield)', 'generators'],
    ];
    for (const [line, what] of valid) {
      const diags = check(inMain(line)).diagnostics.filter((d) => d.category === 'syntax' || d.category === 'unsupported');
      expect(diags.map((d) => `${d.category}: ${d.message}`), line).toEqual([`unsupported: ${what} are not part of the source language`]);
    }
    expect(messages('def main():\n    x = 1\n    def f():\n        nonlocal x\n    return 0\n')).toContain('unsupported: nonlocal declarations are not part of the source language');
  });

  it('parses a match statement completely before reporting it as unsupported', () => {
    const match = (header: string, block: string): string => `def main(x):\n    ${header}\n${block}    return 0\n`;
    const caseBlock = '        case 1:\n            pass\n';
    for (const subject of ['(x)', '[x]', 'x', '-x', 'x,', '*x, x', 'lambda: x', '(x).y']) {
      expect(messages(match(`match ${subject}:`, caseBlock)), subject).toEqual([
        'unsupported: match statements are not part of the source language',
      ]);
    }
    const patterns = [
      '        case [1, 2] | [3, *_] | (4 | 5) as z:\n            pass\n',
      "        case -1j | 1.5 | 'a' 'b' | None | True | b'x' | -1 - 2j:\n            pass\n",
      '        case a.b.c | C.D(_=1):\n            pass\n',
      "        case {'k': [y, *rest], a.b: _, **kw} if y > 0:\n            pass\n",
      '        case C(y, k=z, w=[*q]) | C(y, k=z, w=[*q]):\n            pass\n',
      '        case (y, *_) | [*_, y]:\n            pass\n',
      '        case y if y:\n            pass\n',
      '        case _:\n            pass\n',
    ].join('');
    expect(messages(match('match x:', patterns))).toEqual(['unsupported: match statements are not part of the source language']);
    // Text that CPython rejects, in the header, in a case block, or by the checks of the CPython compiler.
    const invalid: [string, string, RegExp][] = [
      ['match (x) y:', caseBlock, /invalid syntax/],
      ['match [x] y:', caseBlock, /invalid syntax/],
      ['match (x) +:', caseBlock, /invalid syntax/],
      ['match (x) = 1:', caseBlock, /invalid syntax/],
      ['match *x:', caseBlock, /invalid syntax/],
      ['match (x):', '        pass\n', /invalid syntax/],
      ['match (x):', '', /expected an indented block after 'match' statement/],
      ['match (x):', '        case 1 2:\n            pass\n', /expected ':'/],
      ['match (x):', '        case:\n            pass\n', /invalid syntax/],
      ['match x:', `        case y:\n            pass\n${caseBlock}`, /name capture 'y' makes remaining patterns unreachable/],
      ['match x:', `        case _:\n            pass\n${caseBlock}`, /wildcard makes remaining patterns unreachable/],
      ['match x:', '        case y | 1:\n            pass\n', /name capture 'y' makes remaining patterns unreachable/],
      ['match x:', '        case [y, y]:\n            pass\n', /multiple assignments to name 'y' in pattern/],
      ['match x:', '        case [y] | [z]:\n            pass\n', /alternative patterns bind different names/],
      ['match x:', '        case [*y, *z]:\n            pass\n', /multiple starred names in sequence pattern/],
      ['match x:', '        case C(k=1, k=2):\n            pass\n', /attribute name repeated in class pattern: k/],
      ['match x:', '        case C(k=1, 2):\n            pass\n', /positional patterns follow keyword patterns/],
      ['match x:', '        case {1: y, 1.0: z}:\n            pass\n', /mapping pattern checks duplicate key/],
      ['match x:', "        case {'a': y, r'a': z}:\n            pass\n", /mapping pattern checks duplicate key/],
      ['match x:', '        case 1 + 2:\n            pass\n', /imaginary number required in complex literal/],
      ['match x:', "        case f'x':\n            pass\n", /patterns may only match literals and attribute lookups/],
      ['match x:', '        case _.y:\n            pass\n', /expected ':'/],
      ['match x:', '        case __debug__:\n            pass\n', /cannot assign to __debug__/],
    ];
    for (const [header, block, message] of invalid) {
      const diags = check(match(header, block)).diagnostics;
      expect(diags.filter((d) => d.category === 'syntax').map((d) => d.message).join('; '), header + block).toMatch(message);
      expect(diags.filter((d) => d.category === 'unsupported'), header + block).toEqual([]);
    }
    // A statement after the match statement, or in a case block, is checked as any statement is.
    expect(messages(match('match (x):', `${caseBlock}    else:\n        pass\n`))).toContain('syntax: invalid syntax');
    expect(messages(match('match x:', '        case 1:\n            x = = 1\n'))).toContain('syntax: invalid syntax');
    // Duplicate keys are equal values, not equal texts.
    expect(categories(match('match x:', "        case {1: y, b'1': z, '1': w}:\n            pass\n"))).toEqual(['unsupported']);
    // match and case are soft keywords, which are ordinary names outside a match statement.
    expect(run('def main(a):\n    case = a\n    case += 1\n    match = case\n    return match\n', [4]).returnValue).toBe(5);
    expect(codes(match('match x:', `${caseBlock}    case = 1\n`))).toEqual(['unsupported-construct']);
    expect(categories('def main(x):\n    case[0]:\n    return 0\n')).toEqual(['syntax']);
    expect(codes('def main(a, b):\n    if a == 1and b == 2:\n        return 1\n    return 0\n')).toEqual([]);
    expect(run('def main(a, b):\n    if a == 1and b == 2:\n        return 1\n    return 0\n', [1, 2]).returnValue).toBe(1);
  });

  it('rejects every binding of __debug__, as the CPython compiler does', () => {
    for (const source of [
      'def main():\n    __debug__ = 1\n    return __debug__\n',
      'def main(__debug__):\n    return __debug__\n',
      'def main():\n    t = 0\n    for __debug__ in range(3):\n        t = t + __debug__\n    return t\n',
      'def main():\n    __debug__ += 1\n    return 0\n',
      'def __debug__():\n    return 0\n',
      'def main():\n    x = lambda __debug__: 0\n    return 0\n',
      'def main():\n    print(__debug__=1)\n    return 0\n',
    ]) {
      expect(messages(source), source).toContain('syntax: cannot assign to __debug__');
    }
    expect(categories('def main():\n    if __debug__:\n        return 1\n    return 0\n')).toEqual(['semantic']);
  });

  it('limits the nesting of expressions instead of exhausting the stack', () => {
    const sum = (terms: number): string => 'def main(a):\n    return ' + Array(terms).fill('a').join(' + ') + '\n';
    const signs = (count: number): string => 'def main(a):\n    return ' + '-'.repeat(count) + 'a\n';
    const parens = (count: number): string => 'def main(a):\n    return ' + '('.repeat(count) + 'a' + ')'.repeat(count) + '\n';
    // Beyond the limits, and up to the size limit of the source text, the result is a diagnostic.
    for (const source of [sum(16000), signs(16000), sum(202), signs(201), 'def main(a):\n    return ' + 'not '.repeat(201) + 'a > 0\n']) {
      expect(source.length).toBeLessThanOrEqual(LIMITS.maxSourceLength);
      const p = check(source);
      expect(p.diagnostics.map((d) => `${d.category}/${d.code}`)).toEqual(['limit/expression-too-deep']);
      expect(compileFrontEnd(source).ok).toBe(false);
    }
    for (const source of [parens(5000), parens(201)]) {
      expect(check(source).diagnostics.map((d) => `${d.category}: ${d.message}`)).toEqual(['syntax: too many nested parentheses']);
    }
    // At the limits, the expressions are accepted and evaluated.
    expect(run(sum(201), [1]).returnValue).toBe(201);
    expect(run(signs(200), [5]).returnValue).toBe(5);
    expect(run(parens(200), [5]).returnValue).toBe(5);
    expect(run('def main(a):\n    return ' + '-('.repeat(200) + 'a' + ')'.repeat(200) + '\n', [5]).returnValue).toBe(5);
    expect(LIMITS.maxExpressionDepth).toBe(200);
  });

  it('handles an elif chain as long as the size limit allows, in a 2 GB heap and without deepening the recursion', () => {
    // Each elif clause is an if statement in the else branch of the one before; 3,800 clauses fill the size limit.
    const [head, clause, tail] = ['def main(a):\n if a<0:\n  a=0\n', ' elif a<0:\n  a=0\n', ' elif a<9:\n  a=a+5\n return a\n'];
    const length = (clauses: number): number => head.length + (clauses - 2) * clause.length + tail.length;
    expect(length(3800)).toBeGreaterThan(LIMITS.maxSourceLength - 1000);
    expect(length(3800)).toBeLessThanOrEqual(LIMITS.maxSourceLength);
    // The chain goes through the front end and the engines in a new process with two limits. The heap is
    // limited to 2 GB: the 7,601 blocks of the chain fit only when the memory of the IR verifier grows
    // linearly with the number of blocks. The stack is limited to 200 KB: a parser, checker, IR builder,
    // tree dump, or reference evaluator that recursed once per clause would exhaust it.
    const script = [
      "import { compileFrontEnd } from './src/core/compile.ts';",
      "import { interpretIR } from './src/core/ir/interp.ts';",
      "import { dumpAst } from './src/core/lang/ast.ts';",
      "import { evaluateReference } from './src/core/lang/reference.ts';",
      "import { availableBackends } from './src/core/target/index.ts';",
      "import { crossCheck } from './src/core/trace/crosscheck.ts';",
      `const chain = (clauses) => ${JSON.stringify(head)} + ${JSON.stringify(clause)}.repeat(clauses - 2) + ${JSON.stringify(tail)};`,
      'const source = chain(3800);',
      'const front = compileFrontEnd(source);',
      "const clausesDumped = dumpAst(front.checked.module).split('If@').length - 1;",
      'const runs = front.ok ? [1, -1, 20].map((a) => [evaluateReference(front.checked, [a]).returnValue, interpretIR(front.ir, [a]).returnValue]) : [];',
      // Every simulator runs a chain whose machine code fits in the code region.
      'const cc = crossCheck(chain(3000), [1], availableBackends());',
      'const agreement = { ok: cc.ok, failures: cc.failures, returnValue: cc.reference?.returnValue };',
      'console.log(JSON.stringify({ length: source.length, diagnostics: front.diagnostics, blocks: front.ir?.blocks.length, clausesDumped, runs, agreement }));',
    ].join(' ');
    const child = spawnSync(process.execPath, ['--max-old-space-size=2048', '--stack-size=200', '--input-type=module', '-e', script], {
      cwd: repoRoot(), encoding: 'utf8', timeout: 150_000,
    });
    expect(child.status, `${child.error?.message ?? ''}\n${child.stderr}`).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      length: length(3800),
      diagnostics: [],
      blocks: 7601,
      clausesDumped: 3800,
      runs: [[6, 6], [0, 0], [20, 20]],
      agreement: { ok: true, failures: [], returnValue: 6 },
    });
  });
});

describe('checker', () => {
  it('accepts the documented language', () => {
    const p = check('def main(n):\n    a = [1, 2, 3]\n    t = 0\n    for i in range(len(a)):\n        t += a[i] << 1\n    ok = t > n and not (t == 0)\n    if ok:\n        print(t)\n    return t\n');
    expect(p.ok).toBe(true);
    expect(p.vars.map((v) => `${v.name}:${v.type}`)).toEqual(['n:int', 't:int', 'i:int', 'ok:bool']);
  });

  it('requires exactly one entry function', () => {
    expect(codes('x = 1\n')).toContain('module-level-statement');
    expect(codes('def helper():\n    return 1\n')).toContain('unsupported-function');
    expect(codes('# nothing\n')).toContain('missing-main');
    expect(codes('def main(a, b, c, d, e):\n    return 0\n')).toContain('too-many-parameters');
  });

  it('enforces static types', () => {
    expect(codes('def main():\n    x = 1\n    x = 2 < 3\n    return 0\n')).toContain('type-mismatch');
    expect(codes('def main(n):\n    while n:\n        n -= 1\n    return 0\n')).toContain('type-mismatch');
    expect(codes('def main(n):\n    return n < 1\n')).toContain('type-mismatch');
    expect(codes('def main(n):\n    x = (n < 1) + 1\n    return x\n')).toContain('type-mismatch');
  });

  it('checks definite assignment conservatively', () => {
    expect(codes('def main(n):\n    if n > 0:\n        x = 1\n    return x\n')).toContain('maybe-unassigned');
    expect(codes('def main(n):\n    if n > 0:\n        x = 1\n    else:\n        x = 2\n    return x\n')).toEqual([]);
    expect(codes('def main(n):\n    for i in range(n):\n        pass\n    return i\n')).toContain('maybe-unassigned');
    expect(codes('def main():\n    return y\n')).toContain('undefined-name');
  });

  it('checks literal ranges at compile time', () => {
    expect(codes('def main():\n    return 4294967296\n')).toContain('literal-range');
    expect(codes('def main():\n    return 4294967295\n')).toEqual([]);
    expect(codes('def main(n):\n    return n << 32\n')).toContain('shift-count');
    expect(codes('def main(n):\n    return n >> -1\n')).toContain('shift-count');
    expect(codes('def main():\n    a = [1, 2]\n    return a[2]\n')).toContain('index-range');
    expect(codes('def main():\n    a = [1, 2]\n    return a[-1]\n')).toContain('index-range');
  });

  it('restricts arrays to fixed-length definitions at the top level', () => {
    expect(codes('def main(n):\n    if n > 0:\n        a = [1]\n    return 0\n')).toContain('array-nested-definition');
    expect(codes('def main(n):\n    a = [0] * n\n    return 0\n')).toContain('array-definition');
    expect(codes('def main():\n    a = []\n    return 0\n')).toContain('array-definition');
    expect(codes('def main():\n    a = [1]\n    a = [2]\n    return 0\n')).toContain('array-reassigned');
    expect(codes('def main():\n    a = [1]\n    b = a\n    return 0\n')).toContain('array-as-value');
    expect(codes('def main():\n    a = [0] * 5000\n    return 0\n')).toContain('array-too-long');
  });

  it('applies the compile-time checks to the 32-bit value that a literal denotes', () => {
    // 0xFFFFFFFF is -1, and -4294967295 is 1 (section 2 of the specification).
    expect(codes('def main():\n    t = 0\n    for i in range(10, 0, 0xFFFFFFFF):\n        t += i\n    return t\n')).toEqual([]);
    expect(codes('def main(x):\n    return x << -4294967295\n')).toEqual([]);
    expect(codes('def main():\n    a = [1, 2]\n    return a[-4294967295]\n')).toEqual([]);
    expect(codes('def main():\n    for i in range(10, 0, 0x80000000):\n        pass\n    return 0\n')).toEqual([]);
    expect(messages('def main(x):\n    return x << -4294967264\n')).toEqual(['semantic: shift count 32 is outside the range 0 to 31']);
    expect(messages('def main():\n    a = [1, 2]\n    return a[0xFFFFFFFF]\n')).toEqual(['semantic: index -1 is negative']);
    expect(codes('def main():\n    for i in range(0, 5, 0x100000000):\n        pass\n    return 0\n')).toEqual(['literal-range']);
    expect(codes('def main():\n    for i in range(0, 5, -(-0)):\n        pass\n    return 0\n')).toEqual(['range-step']);
  });

  it('counts the size limit of the source text in characters', () => {
    const head = 'def main():\n    return 0\n# ';
    const emoji = String.fromCodePoint(0x1f600);
    const fill = LIMITS.maxSourceLength - head.length - 1;
    const atLimit = head + emoji.repeat(fill) + '\n';
    expect(atLimit.length).toBeGreaterThan(2 * LIMITS.maxSourceLength - 100);
    expect(check(atLimit).ok).toBe(true);
    expect(codes(head + emoji.repeat(fill + 1) + '\n')).toEqual(['source-too-long']);
    expect(codes(head + 'x'.repeat(fill + 1) + '\n')).toEqual(['source-too-long']);
    expect(check(head + 'x'.repeat(fill) + '\n').ok).toBe(true);
  });

  it('explains unsupported operators and constructs', () => {
    const p = check('def main(a):\n    x = a / 2\n    y = a // 2\n    z = a % 2\n    w = a ** 2\n    return 0\n');
    expect(p.diagnostics.map((d) => d.code)).toEqual(['unsupported-operator', 'unsupported-operator', 'unsupported-operator', 'unsupported-operator']);
    expect(p.diagnostics[0]?.hint).toMatch(/floating-point/);
    expect(categories('def main(a):\n    return a < 1 < 2\n')).toContain('unsupported');
    expect(codes('def main(a):\n    return abs(a)\n')).toContain('unsupported-call');
    expect(codes('def main():\n    break\n')).toContain('outside-loop');
    expect(codes('def main(a):\n    for i in range(0, a, 0):\n        pass\n    return 0\n')).toContain('range-step');
    expect(codes('def main(a):\n    for i in range(0, 5, a):\n        pass\n    return 0\n')).toContain('range-step');
  });
});

describe('reference semantics', () => {
  it('wraps arithmetic modulo 2^32', () => {
    expect(run('def main():\n    return 2147483647 + 1\n').returnValue).toBe(-2147483648);
    expect(run('def main():\n    return -2147483648 - 1\n').returnValue).toBe(2147483647);
    expect(run('def main():\n    return 65536 * 65536\n').returnValue).toBe(0);
    expect(run('def main():\n    return 46341 * 46341\n').returnValue).toBe(-2147479015);
    expect(run('def main():\n    return -(-2147483648)\n').returnValue).toBe(-2147483648);
    expect(run('def main():\n    return 0xFFFFFFFF\n').returnValue).toBe(-1);
    expect(run('def main():\n    return 1 << 31\n').returnValue).toBe(-2147483648);
  });

  it('shifts right arithmetically and complements bitwise', () => {
    expect(run('def main():\n    return -5 >> 1\n').returnValue).toBe(-3);
    expect(run('def main():\n    return ~0\n').returnValue).toBe(-1);
    expect(run('def main():\n    return -1 >> 31\n').returnValue).toBe(-1);
  });

  it('reports whether the run coincides with unbounded Python integers', () => {
    expect(run('def main():\n    return 1 + 2\n').pythonCoincident).toBe(true);
    expect(run('def main():\n    return 2147483647 + 1\n').pythonCoincident).toBe(false);
    expect(run('def main():\n    return 0x80000000\n').pythonCoincident).toBe(false);
  });

  it('ends with defined runtime errors', () => {
    const idx = run('def main(i):\n    a = [1, 2, 3]\n    return a[i]\n', [3]);
    expect(idx.status).toBe('trap');
    expect(idx.trap).toMatchObject({ code: 1, line: 3 });
    expect(run('def main(i):\n    a = [1, 2, 3]\n    return a[i]\n', [-1]).trap?.code).toBe(1);
    expect(run('def main(s):\n    return 1 << s\n', [32]).trap).toMatchObject({ code: 2, line: 2 });
    expect(run('def main(s):\n    return 1 << s\n', [31]).returnValue).toBe(-2147483648);
  });

  it('evaluates the right-hand side before the target index', () => {
    // Both the shift and the index are invalid; the shift on the right-hand side is evaluated first.
    expect(run('def main(i, s):\n    a = [1]\n    a[i] = 1 << s\n    return 0\n', [5, 40]).trap?.code).toBe(2);
  });

  it('iterates range exactly as Python for boundary values', () => {
    const r = run('def main():\n    n = 0\n    i = 0\n    for i in range(2147483600, 2147483647, 7):\n        n += 1\n    print(i)\n    return n\n');
    expect(r.returnValue).toBe(7);
    expect(r.output).toEqual([2147483642]);
    expect(run('def main():\n    n = 0\n    for i in range(-2147483648, 2147483647, 1000000000):\n        n += 1\n    return n\n').returnValue).toBe(5);
    expect(run('def main():\n    n = 0\n    for i in range(5, 0, -2):\n        n += i\n    return n\n').returnValue).toBe(9);
  });

  it('steps a range by the 32-bit value of its step literal', () => {
    const down = run('def main():\n    t = 0\n    for i in range(10, 0, 0xFFFFFFFF):\n        t += i\n    return t\n');
    expect(down.returnValue).toBe(55);
    // Python would step by 4294967295, so the run does not coincide with Python.
    expect(down.pythonCoincident).toBe(false);
    const nested = run('def main():\n    t = 0\n    for i in range(0, 10, -(-3)):\n        t += i\n    return t\n');
    expect(nested.returnValue).toBe(18);
    expect(nested.pythonCoincident).toBe(true);
    expect(run('def main():\n    n = 0\n    for i in range(-1, -2, -2147483648):\n        n += 1\n    return n\n').pythonCoincident).toBe(true);
  });

  it('keeps the range sequence when the loop variable is reassigned', () => {
    const r = run('def main():\n    t = 0\n    i = -1\n    for i in range(3):\n        i = i * 10\n        t += i\n    print(i)\n    return t\n');
    expect(r.returnValue).toBe(30);
    expect(r.output).toEqual([20]);
  });

  it('short-circuits and and or', () => {
    expect(run('def main(i):\n    a = [1]\n    if i < 1 and a[i] == 1:\n        return 1\n    return 0\n', [7]).returnValue).toBe(0);
    expect(run('def main(i):\n    a = [1]\n    if i > 0 or a[i] == 1:\n        return 1\n    return 0\n', [7]).returnValue).toBe(1);
  });

  it('requires one argument for each parameter of main', () => {
    const three = check('def main(zeta, alpha, c):\n    print(c)\n    return zeta + alpha\n');
    expect(three.ok).toBe(true);
    // No missing parameter is filled in, and no extra argument is dropped.
    for (const args of [[], [5], [5, 6], [5, 6, 7, 8]]) {
      const run = (): unknown => evaluateReference(three, args);
      expect(run, JSON.stringify(args)).toThrow(ArgumentCountError);
      expect(run, JSON.stringify(args)).toThrow(`main takes 3 parameters (zeta, alpha, c), but ${args.length} argument${args.length === 1 ? ' was' : 's were'} given`);
    }
    expect(() => evaluateReference(three)).toThrow(ArgumentCountError);
    expect(evaluateReference(three, [5, 6, 7])).toMatchObject({ status: 'exited', returnValue: 11, output: [7] });
    const none = check('def main():\n    return 3\n');
    expect(() => evaluateReference(none, [1])).toThrow('main takes no parameters, but 1 argument was given');
    expect(evaluateReference(none).returnValue).toBe(3);
    expect(evaluateReference(none, []).returnValue).toBe(3);
  });

  it('returns 0 when main ends without a value and stops at the step limit', () => {
    expect(run('def main():\n    pass\n').returnValue).toBe(0);
    expect(run('def main():\n    pass\n').implicitReturn).toBe(true);
    const p = check('def main():\n    while True:\n        pass\n');
    expect(evaluateReference(p, [], { limits: { maxSteps: 1000 } }).status).toBe('limit');
  });
});
