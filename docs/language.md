# Source language specification

ISA Trace Lab compiles a restricted language that is written with Python
syntax. Every program in the language is syntactically valid Python, but the
language is not Python: it has 32-bit integers, a static type for each
variable, fixed-length arrays, and one function. This document defines the
language. Version 1.0.

The CPython bytecode view of the application is a separate path. It shows what
the CPython compiler produces for the same text and plays no part in the
compilation described here.

## 1. Program

A program is one function definition at module level:

```python
def main(a, b):
    ...
```

- The function must be named `main` and takes zero to four parameters. Each
  parameter is an integer supplied by the run configuration.
- Nothing else may appear at module level except comments and blank lines.
- Source text is limited to 65,536 characters (Unicode code points, so a
  character such as an emoji in a comment counts once). Identifiers use ASCII
  letters, digits, and underscores. `print`, `range`, `len`, and `main` are
  reserved.
- As in CPython, brackets nest at most 200 deep and blocks at most 99
  indentation levels; deeper text is a syntax error. An expression nests at
  most 200 operations deep: each operator, call, index, and list display is
  one level deeper than its deepest operand, so `a + b + c` is two levels
  deep. A chain of comparisons such as `a < b < c`, or of one Boolean operator
  such as `a and b and c`, is a single level however long it is. A deeper
  expression is rejected as an implementation limit; split it into several
  assignments. The number of `elif` clauses of an `if` statement is limited
  only by the size of the source text.

## 2. Values and types

There are two value types.

- Integer: a 32-bit two's-complement value in the range -2^31 to 2^31 - 1.
- Boolean: `True` or `False`, produced by comparisons and Boolean operators.

Every variable has one static type, fixed by its first assignment in source
order. An integer variable cannot later hold a Boolean value, or the reverse.

### Integer arithmetic

For an operation whose exact mathematical result is z, the stored result is

    u = z mod 2^32,    value = u if u < 2^31 else u - 2^32.

This rule applies to every arithmetic operation and to integer literals. It is
the main difference from Python, whose integers have unlimited precision. For
example, `2147483647 + 1` is `-2147483648`, and `65536 * 65536` is `0`.

An integer literal may be written in decimal, hexadecimal (`0x`), octal
(`0o`), or binary (`0b`), with optional underscores, and must lie in the range
0 to 4294967295. A literal of 2^31 or more denotes the negative value given by
the rule above, so `0xFFFFFFFF` is `-1`.

## 3. Expressions

| Form | Operands | Result |
| --- | --- | --- |
| `x + y`, `x - y`, `x * y` | integers | integer, wrapped |
| `x & y`, `x \| y`, `x ^ y`, `~x` | integers | integer |
| `-x`, `+x` | integer | integer, wrapped |
| `x << n` | integers, 0 <= n <= 31 | integer, `x * 2^n` wrapped |
| `x >> n` | integers, 0 <= n <= 31 | integer, floor of `x / 2^n` (the sign bit is shifted in) |
| `x == y`, `!=`, `<`, `<=`, `>`, `>=` | integers | Boolean; signed comparison |
| `p and q`, `p or q`, `not p` | Booleans | Boolean |
| `a[i]` | array, integer | integer |
| `len(a)` | array | integer constant |

Rules:

- Operands are evaluated from left to right.
- `and` and `or` evaluate their right operand only when the left operand does
  not decide the result.
- Conditions of `if` and `while` must be Boolean. An integer is not a
  condition; write `n != 0`. Arithmetic on Booleans is not allowed.
- A shift count outside 0 to 31 is an error. When the count is a literal the
  error is reported at compile time; otherwise the program ends with runtime
  error 2. Python accepts larger counts, and 32-bit shift instructions use
  only the low five bits of the count; the language rejects the case instead
  of choosing either behaviour.
- Comparisons cannot be chained (`a < b < c`); write `a < b and b < c`.

Not part of the language: `/`, `//`, `%`, `**`, `@`, conditional expressions,
`is`, `in`, strings, floating-point numbers, `None`, tuples, dictionaries,
sets, slices, comprehensions, lambda, attribute access, and calls other than
`print`, `range`, and `len`. Division and remainder are excluded because the
RV32I profile has no divide instruction and because Python floor division
differs from the truncating division of the other targets.

## 4. Arrays

An array is a fixed-length sequence of integers, defined once, at the top
level of `main`:

```python
a = [3, 1, 4, 1, 5]     # five elements
b = [0] * 16            # sixteen elements with the same initial value
```

- The length is fixed when the program is compiled: the number of listed
  elements, or the positive integer literal after `*`. A listed array has at
  least one element. An array holds at most 4,096 elements and all arrays
  together at most 16,384.
- Elements are read and written with `a[i]`. The index must satisfy
  `0 <= i < len(a)`. A literal index outside this range is a compile-time
  error; any other index is checked at run time, and a violation ends the
  program with runtime error 1. Negative indexes are errors. This differs from
  Python, which counts negative indexes from the end.
- An array name can be used only with an index or as the argument of `len`.
  Arrays cannot be reassigned, copied, compared, or passed around.
- Elements whose initializer is an integer literal are placed in the initial
  data image, as a C compiler does for a static array. Other elements are
  stored by generated code when the definition executes. In `[e] * n`, the
  expression `e` is evaluated once.

## 5. Statements

| Statement | Notes |
| --- | --- |
| `x = e` | Declares `x` on its first assignment. |
| `x op= e`, `a[i] op= e` | `op` is one of `+ - * & \| ^ << >>`. The index is evaluated once. |
| `a[i] = e` | The right-hand side is evaluated before the index. |
| `if` / `elif` / `else` | |
| `while c:` | No `else` clause. |
| `for v in range(...)` | See below. No `else` clause. |
| `break`, `continue` | Inside a loop only. |
| `return e`, `return` | See section 6. |
| `print(e)` | Writes one integer to the output. |
| `pass` | |

### `for` loops

`range` takes one, two, or three integer arguments: `range(stop)`,
`range(start, stop)`, or `range(start, stop, step)`. The step must be a
nonzero integer literal, which bounds the number of iterations by the distance
between `start` and `stop`. Like every literal it denotes its 32-bit value
(section 2), so `range(10, 0, 0xFFFFFFFF)` steps by -1. The loop behaves as in
Python for every 32-bit value of the bounds:

- `start` and `stop` are evaluated once, before the first iteration.
- The loop variable receives each element of the range in turn. Assigning to
  it inside the body does not change the sequence.
- After the loop the variable keeps the value it had when the loop ended: the
  last element it received, or the value that the body assigned to it after
  receiving that element. If the range is empty the variable is not assigned
  by the loop.

### Definite assignment

A variable may be read only where it has been assigned on every path from the
start of `main`. The check is static and conservative: an assignment inside a
loop body or inside one branch of an `if` does not count after the loop or the
`if`. Python defers this check to run time. Storage is never zeroed
implicitly.

## 6. Results, output, and errors

- `main` returns an integer. `return` without a value, and reaching the end of
  `main`, return 0. (Python would return `None`.)
- `print(e)` appends the integer `e` to the output, which is a sequence of
  signed 32-bit integers. It is not Python's `print`: it takes exactly one
  integer and performs no formatting.
- A run ends in one of four ways: `exited` with the return value; `trap` with
  runtime error 1 (index out of range) or 2 (shift count out of range) and the
  source line of the failing operation; `limit` when the configured bound on
  steps or output is reached; `fault` when a simulated machine cannot continue.
  Compiler-generated code does not fault; faults arise from hand-written
  assembly or edited bytes.

## 7. Relationship to Python

A program of this language that runs to completion without a runtime error,
in which every literal is below 2^31 and no exact intermediate result leaves
the signed 32-bit range, produces under CPython the same sequence of printed
integers and the same return value (with `None` read as 0). The validation
harness checks this property on the test corpus by executing such programs
directly in CPython. Outside these conditions the two languages differ as
stated above: wraparound, large literals, shift counts above 31, negative
indexes, and the result of a function that returns no value.

## 8. Boundaries

A boundary marks the point just before a source statement executes. It
occurs before a simple statement, before the condition of an `if`, before each
evaluation of a `while` condition, before the `range` arguments of a `for`
statement are evaluated, and before each later advance of that loop. The
boundary sequence of a run is the same on every engine and is the basis of
source stepping and of cross-architecture comparison.

## 9. Text outside the language

A text that is not a program of the language is rejected with diagnostics.
Two categories of diagnostics separate text that is not Python from Python
that the language does not include.

- `syntax`: the text is not valid Python.
- `unsupported`: a Python construct outside the language was recognized.

Two guarantees hold for every text.

1. A text that is reported as a syntax error is rejected by CPython 3.14.
   Valid Python is never reported as a syntax error.
2. A program of the language is reported with neither category.

The converse of the first guarantee does not hold. Once a construct outside
the language has been recognized, the rest of that construct is not
necessarily checked, so a text that is reported only as unsupported can also
contain errors that CPython would report.

The parser reads the following constructs to their end before it reports
them, and goes on to check the rest of the statement. A syntax error that it
finds there is reported instead.

- Conditional expressions, and lambda expressions with their parameter lists.
- List, set, and dict comprehensions and generator expressions, with their
  targets and conditions.
- `await` and `yield` expressions and `yield` statements, with Python's rules
  on the scopes in which they may appear.
- Tuples with or without parentheses, dict and set displays, starred values
  such as `x = *a, b`, and chained assignments such as `a = b = 1`.
- An assignment expression that is the whole condition of an `if` or `while`
  statement or the whole guard of a `case` block.
- Annotated assignments such as `x: int = 1`, with the annotation and the
  value. CPython does not compile the annotation of a local variable, so the
  checks that it makes only when it compiles an expression are not applied
  inside an annotation.
- `match` statements, with the subject, the patterns, the guards, and the
  statements of every `case` block.
- Attribute access, operators and literals that the language does not
  include, identifiers with letters outside ASCII, calls, and function
  definitions other than `main`, which are reported after the whole statement
  has been parsed. A string literal is read to its closing quote; the
  replacement fields of an f-string or t-string are not checked.

The parser reports the following constructs where it recognizes them. It
skips the rest of the statement without checking it, together with the block
of the statement and the `elif` and `else` clauses that continue it.

- `class`, `try`, `with`, and `async def` statements, with their blocks and
  the clauses that continue them, and the line of a decorator.
- `import`, `from`, `global`, `del`, `assert`, `raise`, and `type`
  statements, and `nonlocal` in a nested function. At module level and
  directly in `main`, `nonlocal` is not valid Python and is reported as a
  syntax error.
- A function definition whose header has type parameters, an annotation, a
  default value, or a `*`, `**`, or `/` parameter, with its body.
- The `else` clause of a loop, with its block.
- Slices, subscripts with several items or with a starred item, starred
  items of a list display, list targets such as `[a, b] = c`, and assignment
  expressions in any position other than the three named above.

A construct of the second list has the same effect when it occurs inside a
construct of the first list. Errors in the tokens themselves, such as a
malformed number, an invalid character, or a bracket that is never closed,
are reported as syntax errors wherever they occur outside comments and
string literals.
