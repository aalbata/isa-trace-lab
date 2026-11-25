/**
 * Semantic validation of a parsed program against the source-language rules:
 * program shape, static types, definite assignment, array rules, and the
 * compile-time range checks for literals, shift counts, and array indexes.
 */
import type { Diagnostic, Span } from '../util/diag.ts';
import type { BinOpKind, Expr, For, FunctionDef, Module, Stmt } from './ast.ts';
import { binOpSymbol, cmpOpSymbol } from './ast.ts';
import { MAX_EXPRESSION_DEPTH, parse } from './parser.ts';

export type ValueType = 'int' | 'bool';

export const LIMITS = {
  /** Maximum size of the source text in characters (Unicode code points). */
  maxSourceLength: 65536,
  /** Maximum depth of an expression in operations (see MAX_EXPRESSION_DEPTH). */
  maxExpressionDepth: MAX_EXPRESSION_DEPTH,
  maxParams: 4,
  /** Maximum number of elements in one array. */
  maxArrayLength: 4096,
  /** Maximum total number of array elements; 4 bytes each in the data region. */
  maxArrayElements: 16384,
} as const;

export interface VarInfo {
  id: number;
  name: string;
  type: ValueType;
  isParam: boolean;
  /** True for compiler-created variables such as loop counters. */
  hidden: boolean;
  span?: Span;
}

export interface ArrayInfo {
  id: number;
  name: string;
  length: number;
  /** Statement node that defines the array. */
  declNode: number;
  span: Span;
  /**
   * Initial contents placed in the data image: the signed value of each
   * element whose initializer is an integer literal, and 0 for elements that
   * the generated code stores at run time.
   */
  image: number[];
  /** `literal` for [a, b, c] and `repeat` for [a] * n. */
  form: 'literal' | 'repeat';
}

export interface ForInfo {
  /** Signed nonzero step of the range. */
  step: number;
  start: Expr | null;
  stop: Expr;
}

export interface CheckedProgram {
  source: string;
  module: Module;
  main: FunctionDef | null;
  vars: VarInfo[];
  arrays: ArrayInfo[];
  /** Static type of every checked expression node, by node identifier. */
  exprType: Map<number, ValueType>;
  /** Array defined by an assignment statement, by statement node identifier. */
  arrayDefs: Map<number, ArrayInfo>;
  forInfo: Map<number, ForInfo>;
  nodeCount: number;
  diagnostics: Diagnostic[];
  ok: boolean;
}

const RESERVED = new Set(['print', 'range', 'len', 'main']);

const SUPPORTED_BINOPS = new Set<BinOpKind>(['Add', 'Sub', 'Mult', 'BitAnd', 'BitOr', 'BitXor', 'LShift', 'RShift']);

const UNSUPPORTED_BINOP_HINT: Partial<Record<BinOpKind, string>> = {
  Div: 'true division produces a floating-point value; the language has 32-bit integers only',
  FloorDiv: 'division is outside the language because the RV32I profile has no divide instruction and Python floor division differs from hardware division',
  Mod: 'remainder is outside the language for the same reason as division',
  Pow: 'write repeated multiplication instead',
  MatMult: 'matrix multiplication has no meaning for integers',
};

/** Value of an integer literal with optional unary signs, or null for any other expression. */
export function literalInt(e: Expr): bigint | null {
  if (e.kind === 'Constant' && e.ctype === 'int') return e.value;
  if (e.kind === 'UnaryOp' && (e.op === 'USub' || e.op === 'UAdd')) {
    const v = literalInt(e.operand);
    if (v === null) return null;
    return e.op === 'USub' ? -v : v;
  }
  return null;
}

/**
 * Language value of an integer literal with optional unary signs: the exact
 * value reduced to signed 32 bits, since literals of 2^31 or more and every
 * negation wrap. Null for any other expression and for a literal above
 * 4294967295, which is reported as out of range where it is typed.
 */
function literalValue(e: Expr): bigint | null {
  const v = literalInt(e);
  if (v === null || v < -4294967295n || v > 4294967295n) return null;
  return BigInt.asIntN(32, v);
}

type Defined = Set<string> | null;

function intersect(a: Defined, b: Defined): Defined {
  if (a === null) return b === null ? null : new Set(b);
  if (b === null) return new Set(a);
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

class Checker {
  diagnostics: Diagnostic[] = [];
  vars: VarInfo[] = [];
  arrays: ArrayInfo[] = [];
  exprType = new Map<number, ValueType>();
  arrayDefs = new Map<number, ArrayInfo>();
  forInfo = new Map<number, ForInfo>();
  private varByName = new Map<string, VarInfo>();
  private arrayByName = new Map<string, ArrayInfo>();
  private totalElements = 0;

  private error(category: Diagnostic['category'], code: string, message: string, span: Span, hint?: string): void {
    const d: Diagnostic = { severity: 'error', category, code, message, span };
    if (hint) d.hint = hint;
    this.diagnostics.push(d);
  }

  private unsupported(what: string, span: Span, hint?: string): void {
    this.error('unsupported', 'unsupported-construct', `${what} are not part of the source language`, span, hint);
  }

  checkModule(module: Module): FunctionDef | null {
    let main: FunctionDef | null = null;
    for (const s of module.body) {
      if (s.kind === 'UnsupportedStmt') continue;
      if (s.kind === 'FunctionDef') {
        if (s.name !== 'main') {
          this.error('unsupported', 'unsupported-function', `only the entry function 'main' can be defined, found '${s.name}'`, s.nameSpan,
            'user-defined helper functions and recursion are outside the language');
          continue;
        }
        if (main) {
          this.error('semantic', 'duplicate-main', "the entry function 'main' is defined more than once", s.nameSpan);
          continue;
        }
        main = s;
        continue;
      }
      this.error('unsupported', 'module-level-statement', "statements outside the entry function are not part of the source language", s.span,
        "place the program inside 'def main():'; the simulators call main when execution starts");
    }
    if (!main) {
      if (!this.diagnostics.some((d) => d.severity === 'error')) {
        this.error('semantic', 'missing-main', "the program must define the entry function 'def main():'", module.span);
      }
      return null;
    }
    this.checkMain(main);
    return main;
  }

  private checkMain(fn: FunctionDef): void {
    if (fn.params.length > LIMITS.maxParams) {
      this.error('limit', 'too-many-parameters', `the entry function accepts at most ${LIMITS.maxParams} integer parameters`, fn.params[LIMITS.maxParams]!.span);
    }
    const defined = new Set<string>();
    for (const p of fn.params) {
      if (RESERVED.has(p.name)) {
        this.error('semantic', 'reserved-name', `'${p.name}' is reserved and cannot be a parameter name`, p.span);
        continue;
      }
      if (this.varByName.has(p.name)) {
        this.error('semantic', 'duplicate-parameter', `duplicate parameter '${p.name}'`, p.span);
        continue;
      }
      this.declareVar(p.name, 'int', true, p.span);
      defined.add(p.name);
    }
    this.checkBody(fn.body, defined, 0, 0);
  }

  private declareVar(name: string, type: ValueType, isParam: boolean, span: Span): VarInfo {
    const v: VarInfo = { id: this.vars.length, name, type, isParam, hidden: false, span };
    this.vars.push(v);
    this.varByName.set(name, v);
    return v;
  }

  /** Returns the set of names definitely assigned after the statements, or null when the end is unreachable. */
  private checkBody(stmts: Stmt[], defined: Defined, depth: number, loops: number): Defined {
    let cur = defined;
    for (const s of stmts) cur = this.checkStmt(s, cur, depth, loops);
    return cur;
  }

  private checkStmt(s: Stmt, defined: Defined, depth: number, loops: number): Defined {
    switch (s.kind) {
      case 'UnsupportedStmt':
        return defined;
      case 'FunctionDef':
        this.error('unsupported', 'unsupported-function', 'nested function definitions are not part of the source language', s.nameSpan);
        return defined;
      case 'Pass':
        return defined;
      case 'Break':
      case 'Continue':
        if (loops === 0) {
          this.error('semantic', 'outside-loop', `'${s.kind === 'Break' ? 'break' : 'continue'}' outside loop`, s.span);
          return defined;
        }
        return null;
      case 'Return':
        if (s.value) this.expect(s.value, 'int', defined, 'the entry function returns a 32-bit integer');
        return null;
      case 'Expr':
        this.checkExprStmt(s.value, defined);
        return defined;
      case 'Assign':
        return this.checkAssign(s, defined, depth);
      case 'AugAssign': {
        if (!SUPPORTED_BINOPS.has(s.op)) {
          this.unsupported(`'${binOpSymbol(s.op)}=' assignments`, s.span, UNSUPPORTED_BINOP_HINT[s.op]);
          this.typeOf(s.value, defined);
          return defined;
        }
        if (s.target.kind === 'Name') {
          const t = this.typeOf(s.target, defined);
          if (t === 'bool') this.error('semantic', 'type-mismatch', `'${binOpSymbol(s.op)}=' requires an integer variable`, s.target.span);
        } else if (s.target.kind === 'Subscript') {
          this.typeOf(s.target, defined);
        } else {
          this.unsupported('assignments to this kind of target', s.target.span);
        }
        this.expect(s.value, 'int', defined);
        this.checkShiftCount(s.op, s.value);
        return defined;
      }
      case 'If': {
        // An elif clause is an if statement in the else branch of the clause before it. The clauses of a
        // chain are checked in a loop, so that a long chain does not deepen the recursion; a name is
        // definitely assigned after the statement when every branch that reaches the end assigns it.
        let clause = s;
        let after: Defined = null;
        for (;;) {
          this.expect(clause.test, 'bool', defined, 'write an explicit comparison such as x != 0');
          after = intersect(after, this.checkBody(clause.body, defined === null ? null : new Set(defined), depth + 1, loops));
          const next = clause.orelse.length === 1 ? clause.orelse[0]! : null;
          if (next?.kind !== 'If') break;
          clause = next;
        }
        return intersect(after, this.checkBody(clause.orelse, defined === null ? null : new Set(defined), depth + 1, loops));
      }
      case 'While': {
        this.expect(s.test, 'bool', defined, 'write an explicit comparison such as n != 0');
        this.checkBody(s.body, defined === null ? null : new Set(defined), depth + 1, loops + 1);
        return defined;
      }
      case 'For':
        return this.checkFor(s, defined, depth, loops);
    }
  }

  private checkFor(s: For, defined: Defined, depth: number, loops: number): Defined {
    const it = s.iter;
    let info: ForInfo | null = null;
    if (it.kind !== 'Call' || it.func.kind !== 'Name' || it.func.name !== 'range') {
      this.error('unsupported', 'unsupported-iteration', "a for loop must iterate over range(...)", it.span,
        'iterate over indexes and read elements with a[i]');
      this.typeOfQuiet(it, defined);
    } else if (it.hasKeywords || it.args.length < 1 || it.args.length > 3) {
      this.error('semantic', 'range-arguments', 'range takes one, two, or three positional integer arguments', it.span);
    } else {
      let step = 1;
      for (const a of it.args.slice(0, 2)) this.expect(a, 'int', defined);
      if (it.args.length === 3) {
        const arg = it.args[2]!;
        if (literalInt(arg) === null) {
          this.error('semantic', 'range-step', 'the step of range must be an integer literal', arg.span,
            'a constant step keeps the loop bounded');
        } else {
          // The step is the language value of the literal, so 0xFFFFFFFF steps by -1.
          this.expect(arg, 'int', defined);
          const value = literalValue(arg);
          if (value === 0n) this.error('semantic', 'range-step', 'the step of range must not be zero', arg.span);
          else if (value !== null) step = Number(value);
        }
      }
      info = it.args.length === 1 ? { step, start: null, stop: it.args[0]! } : { step, start: it.args[0]!, stop: it.args[1]! };
      this.forInfo.set(s.id, info);
    }
    const inner: Defined = defined === null ? null : new Set(defined);
    if (s.target.kind !== 'Name') {
      this.unsupported('loop targets other than a single variable', s.target.span);
    } else {
      const name = s.target.name;
      if (RESERVED.has(name)) {
        this.error('semantic', 'reserved-name', `'${name}' is reserved and cannot be a variable name`, s.target.span);
      } else if (this.arrayByName.has(name)) {
        this.error('semantic', 'array-reassigned', `array '${name}' cannot be used as a loop variable`, s.target.span);
      } else {
        const existing = this.varByName.get(name);
        if (!existing) this.declareVar(name, 'int', false, s.target.span);
        else if (existing.type !== 'int') {
          this.error('semantic', 'type-mismatch', `loop variable '${name}' was assigned a Boolean value earlier and cannot change type`, s.target.span);
        }
        inner?.add(name);
      }
    }
    this.checkBody(s.body, inner, depth + 1, loops + 1);
    return defined;
  }

  private checkExprStmt(e: Expr, defined: Defined): void {
    if (e.kind === 'Call' && e.func.kind === 'Name' && e.func.name === 'print') {
      if (e.hasKeywords || e.args.length !== 1) {
        this.error('semantic', 'print-arguments', 'print takes exactly one integer argument', e.span,
          'the output service writes one signed 32-bit integer per call');
        e.args.forEach((a) => this.typeOfQuiet(a, defined));
        return;
      }
      this.expect(e.args[0]!, 'int', defined, 'print writes one signed 32-bit integer');
      return;
    }
    if (e.kind === 'Constant' && e.ctype === 'str') {
      this.unsupported('string literals and docstrings', e.span, 'use # comments');
      return;
    }
    this.typeOfQuiet(e, defined);
    if (!this.diagnostics.some((d) => d.span && d.span.start.offset >= e.span.start.offset && d.span.end.offset <= e.span.end.offset)) {
      this.error('unsupported', 'expression-statement', 'an expression used as a statement has no effect; only print(...) is a statement', e.span);
    }
  }

  private checkAssign(s: Extract<Stmt, { kind: 'Assign' }>, defined: Defined, depth: number): Defined {
    const { target, value } = s;
    if (target.kind === 'Subscript') {
      this.expect(value, 'int', defined, 'array elements are 32-bit integers');
      this.typeOf(target, defined);
      return defined;
    }
    if (target.kind !== 'Name') {
      if (target.kind === 'UnsupportedExpr') this.unsupported(target.what, target.span);
      else this.unsupported('assignments to this kind of target', target.span);
      this.typeOfQuiet(value, defined);
      return defined;
    }
    const name = target.name;
    if (RESERVED.has(name)) {
      this.error('semantic', 'reserved-name', `'${name}' is reserved and cannot be a variable name`, target.span);
      this.typeOfQuiet(value, defined);
      return defined;
    }
    const arrayForm = this.arrayInitForm(value);
    if (arrayForm) {
      if (this.arrayByName.has(name) || this.varByName.has(name)) {
        this.error('semantic', 'array-reassigned', `'${name}' is already defined; an array is defined once and keeps its length`, target.span);
        return defined;
      }
      if (depth > 0) {
        this.error('semantic', 'array-nested-definition', 'an array must be defined at the top level of main, outside if, while, and for', s.span,
          'arrays have a fixed length and a fixed place in the data region');
        return defined;
      }
      const info = this.defineArray(s.id, name, target.span, arrayForm, defined);
      if (info && defined) defined.add(name);
      return defined;
    }
    if (this.arrayByName.has(name)) {
      this.error('semantic', 'array-reassigned', `array '${name}' cannot be reassigned`, target.span, 'assign to its elements instead');
      this.typeOfQuiet(value, defined);
      return defined;
    }
    const t = this.typeOf(value, defined);
    const existing = this.varByName.get(name);
    if (t !== null) {
      if (!existing) this.declareVar(name, t, false, target.span);
      else if (existing.type !== t) {
        this.error('semantic', 'type-mismatch',
          `variable '${name}' holds ${existing.type === 'int' ? 'an integer' : 'a Boolean value'} and cannot be assigned ${t === 'int' ? 'an integer' : 'a Boolean value'}`,
          value.span, 'each variable has one static type');
      }
    } else if (!existing) {
      // Declare with a default type so that later uses do not cascade into further errors.
      this.declareVar(name, 'int', false, target.span);
    }
    defined?.add(name);
    return defined;
  }

  private arrayInitForm(value: Expr): { form: 'literal'; elts: Expr[] } | { form: 'repeat'; elt: Expr; count: Expr; node: Expr } | { form: 'bad'; node: Expr } | null {
    if (value.kind === 'List') return { form: 'literal', elts: value.elts };
    if (value.kind === 'BinOp' && value.op === 'Mult') {
      if (value.left.kind === 'List') {
        if (value.left.elts.length === 1) return { form: 'repeat', elt: value.left.elts[0]!, count: value.right, node: value };
        return { form: 'bad', node: value };
      }
      if (value.right.kind === 'List') return { form: 'bad', node: value };
    }
    return null;
  }

  private defineArray(
    stmtId: number, name: string, span: Span,
    init: NonNullable<ReturnType<Checker['arrayInitForm']>>, defined: Defined,
  ): ArrayInfo | null {
    let length = 0;
    const image: number[] = [];
    let form: ArrayInfo['form'] = 'literal';
    if (init.form === 'bad') {
      this.error('semantic', 'array-definition', 'an array is defined as [e1, e2, ...] or as [e] * n with a positive integer literal n', init.node.span);
      return null;
    }
    if (init.form === 'literal') {
      length = init.elts.length;
      if (length === 0) {
        this.error('semantic', 'array-definition', 'an array must have at least one element', span);
        return null;
      }
      for (const e of init.elts) {
        this.expect(e, 'int', defined, 'array elements are 32-bit integers');
        const lit = literalInt(e);
        image.push(lit !== null && lit >= -4294967295n && lit <= 4294967295n ? Number(BigInt.asIntN(32, lit)) : 0);
      }
    } else {
      form = 'repeat';
      const count = init.count.kind === 'Constant' && init.count.ctype === 'int' ? init.count.value : null;
      this.expect(init.elt, 'int', defined, 'array elements are 32-bit integers');
      if (count === null || count <= 0n) {
        this.error('semantic', 'array-definition', 'the length in [e] * n must be a positive integer literal', init.count.span,
          'arrays have a fixed length known when the program is compiled');
        return null;
      }
      this.exprType.set(init.count.id, 'int');
      if (count > BigInt(LIMITS.maxArrayLength)) {
        this.error('limit', 'array-too-long', `an array holds at most ${LIMITS.maxArrayLength} elements`, init.count.span);
        return null;
      }
      length = Number(count);
      const lit = literalInt(init.elt);
      const v = lit !== null && lit >= -4294967295n && lit <= 4294967295n ? Number(BigInt.asIntN(32, lit)) : 0;
      for (let k = 0; k < length; k++) image.push(v);
    }
    if (length > LIMITS.maxArrayLength) {
      this.error('limit', 'array-too-long', `an array holds at most ${LIMITS.maxArrayLength} elements`, span);
      return null;
    }
    if (this.totalElements + length > LIMITS.maxArrayElements) {
      this.error('limit', 'data-region-full', `all arrays together hold at most ${LIMITS.maxArrayElements} elements`, span);
      return null;
    }
    this.totalElements += length;
    const info: ArrayInfo = { id: this.arrays.length, name, length, declNode: stmtId, span, image, form };
    this.arrays.push(info);
    this.arrayByName.set(name, info);
    this.arrayDefs.set(stmtId, info);
    return info;
  }

  private checkShiftCount(op: BinOpKind, count: Expr): void {
    if (op !== 'LShift' && op !== 'RShift') return;
    const lit = literalValue(count);
    if (lit !== null && (lit < 0n || lit > 31n)) {
      this.error('semantic', 'shift-count', `shift count ${lit} is outside the range 0 to 31`, count.span,
        'a 32-bit shift instruction uses only five bits of the count, so larger counts are rejected instead of being reduced silently');
    }
  }

  private expect(e: Expr, want: ValueType, defined: Defined, hint?: string): void {
    const got = this.typeOf(e, defined);
    if (got !== null && got !== want) {
      this.error('semantic', 'type-mismatch',
        want === 'int' ? 'expected an integer expression but found a Boolean expression' : 'expected a Boolean condition but found an integer expression',
        e.span, hint);
    }
  }

  /** Type-check an expression whose result is not used, to report problems inside it. */
  private typeOfQuiet(e: Expr, defined: Defined): void {
    this.typeOf(e, defined);
  }

  private typeOf(e: Expr, defined: Defined): ValueType | null {
    const t = this.typeOfInner(e, defined);
    if (t !== null) this.exprType.set(e.id, t);
    return t;
  }

  private typeOfInner(e: Expr, defined: Defined): ValueType | null {
    switch (e.kind) {
      case 'Constant':
        switch (e.ctype) {
          case 'int':
            if (e.value > 4294967295n) {
              this.error('semantic', 'literal-range', `integer literal ${e.raw} does not fit in 32 bits`, e.span,
                'values are 32-bit two\'s-complement integers; literals range from 0 to 4294967295');
              return 'int';
            }
            return 'int';
          case 'bool':
            return 'bool';
          case 'float':
            this.unsupported('floating-point and imaginary literals', e.span, 'the language has 32-bit integers only');
            return null;
          case 'str':
            this.unsupported('string literals', e.span, 'the language has 32-bit integers only');
            return null;
          case 'none':
            this.unsupported('None values', e.span);
            return null;
          case 'ellipsis':
            this.unsupported('ellipsis literals', e.span);
            return null;
        }
        return null;
      case 'Name': {
        const name = e.name;
        if (this.arrayByName.has(name)) {
          this.error('semantic', 'array-as-value', `array '${name}' can only be used with an index, as in ${name}[i], or with len(${name})`, e.span);
          return null;
        }
        const v = this.varByName.get(name);
        if (!v) {
          if (RESERVED.has(name)) {
            this.error('semantic', 'reserved-name', `'${name}' cannot be used as a value`, e.span);
          } else {
            this.error('semantic', 'undefined-name', `name '${name}' is not defined`, e.span, 'assign a value before the first use');
          }
          return null;
        }
        if (defined !== null && !defined.has(name)) {
          this.error('semantic', 'maybe-unassigned', `variable '${name}' may be used before it is assigned`, e.span,
            'assign it on every path that reaches this use; storage is not zeroed implicitly');
        }
        return v.type;
      }
      case 'UnaryOp':
        if (e.op === 'Not') {
          this.expect(e.operand, 'bool', defined, "'not' applies to a condition");
          return 'bool';
        }
        this.expect(e.operand, 'int', defined);
        return 'int';
      case 'BinOp': {
        if (!SUPPORTED_BINOPS.has(e.op)) {
          this.error('unsupported', 'unsupported-operator', `operator '${binOpSymbol(e.op)}' is not part of the source language`, e.span, UNSUPPORTED_BINOP_HINT[e.op]);
          this.typeOfQuiet(e.left, defined);
          this.typeOfQuiet(e.right, defined);
          return null;
        }
        if (e.left.kind === 'List' || e.right.kind === 'List') {
          this.error('semantic', 'array-definition', 'an array expression can only appear as the whole right-hand side of an array definition', e.span);
          return null;
        }
        this.expect(e.left, 'int', defined);
        this.expect(e.right, 'int', defined);
        this.checkShiftCount(e.op, e.right);
        return 'int';
      }
      case 'BoolOp':
        for (const v of e.values) this.expect(v, 'bool', defined, "'and' and 'or' combine conditions");
        return 'bool';
      case 'Compare': {
        if (e.ops.length > 1) {
          this.unsupported('chained comparisons', e.span, "combine two comparisons with 'and'");
          this.typeOfQuiet(e.left, defined);
          e.comparators.forEach((c) => this.typeOfQuiet(c, defined));
          return 'bool';
        }
        const op = e.ops[0]!;
        if (op === 'Is' || op === 'IsNot' || op === 'In' || op === 'NotIn') {
          this.error('unsupported', 'unsupported-operator', `operator '${cmpOpSymbol(op)}' is not part of the source language`, e.span);
          this.typeOfQuiet(e.left, defined);
          this.typeOfQuiet(e.comparators[0]!, defined);
          return 'bool';
        }
        this.expect(e.left, 'int', defined, 'comparisons apply to integers');
        this.expect(e.comparators[0]!, 'int', defined, 'comparisons apply to integers');
        return 'bool';
      }
      case 'Call': {
        if (e.func.kind !== 'Name') {
          this.unsupported('calls through expressions', e.span);
          return null;
        }
        const fname = e.func.name;
        if (fname === 'len') {
          const a = e.args[0];
          if (e.hasKeywords || e.args.length !== 1 || !a || a.kind !== 'Name' || !this.arrayByName.has(a.name)) {
            this.error('semantic', 'len-argument', 'len takes the name of one array', e.span);
            return 'int';
          }
          if (defined !== null && !defined.has(a.name)) {
            this.error('semantic', 'maybe-unassigned', `array '${a.name}' is used before its definition`, a.span);
          }
          return 'int';
        }
        if (fname === 'range') {
          this.error('semantic', 'range-outside-for', 'range can only appear as the iterable of a for loop', e.span);
          return null;
        }
        if (fname === 'print') {
          this.error('semantic', 'print-as-value', 'print is a statement and has no value', e.span);
          return null;
        }
        this.error('unsupported', 'unsupported-call', `calls to '${fname}' are not part of the source language`, e.span,
          'only print, range, and len are available; user-defined calls and recursion are outside the language');
        e.args.forEach((a) => this.typeOfQuiet(a, defined));
        return null;
      }
      case 'Subscript': {
        if (e.value.kind !== 'Name' || !this.arrayByName.has(e.value.name)) {
          if (e.value.kind === 'Name' && this.varByName.has(e.value.name)) {
            this.error('semantic', 'not-an-array', `'${e.value.name}' is not an array`, e.value.span);
          } else if (e.value.kind === 'Name') {
            this.error('semantic', 'undefined-name', `name '${e.value.name}' is not defined`, e.value.span);
          } else {
            this.unsupported('indexing of expressions other than an array name', e.value.span);
          }
          this.typeOfQuiet(e.index, defined);
          return 'int';
        }
        const info = this.arrayByName.get(e.value.name)!;
        if (defined !== null && !defined.has(info.name)) {
          this.error('semantic', 'maybe-unassigned', `array '${info.name}' is used before its definition`, e.value.span);
        }
        this.expect(e.index, 'int', defined, 'an index is an integer');
        const lit = literalValue(e.index);
        if (lit !== null) {
          if (lit < 0n) {
            this.error('semantic', 'index-range', `index ${lit} is negative`, e.index.span,
              'Python counts negative indexes from the end; this language treats them as out of range');
          } else if (lit >= BigInt(info.length)) {
            this.error('semantic', 'index-range', `index ${lit} is outside array '${info.name}' of length ${info.length}`, e.index.span);
          }
        }
        return 'int';
      }
      case 'List':
        this.error('semantic', 'array-definition', 'an array expression can only appear as the whole right-hand side of an array definition', e.span);
        e.elts.forEach((x) => this.typeOfQuiet(x, defined));
        return null;
      case 'UnsupportedExpr':
        this.unsupported(e.what, e.span);
        return null;
    }
  }
}

/** Number of characters (Unicode code points) in a text; a character outside the Basic Multilingual Plane is two UTF-16 code units. */
function characterCount(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** True for the error that a JavaScript engine raises when its call stack is exhausted. */
function isStackOverflow(e: unknown): boolean {
  if (e instanceof RangeError) return /call stack/i.test(e.message);
  return e instanceof Error && e.name === 'InternalError' && /recursion/i.test(e.message);
}

/** Result for a program rejected as a whole, with one diagnostic at the start of the text. */
function rejected(source: string, code: string, message: string, hint?: string): CheckedProgram {
  const pos = { line: 1, col: 0, offset: 0 };
  const d: Diagnostic = { severity: 'error', category: 'limit', code, message, span: { start: pos, end: pos } };
  if (hint) d.hint = hint;
  const empty: Module = { kind: 'Module', id: 0, span: { start: pos, end: pos }, body: [] };
  return {
    source, module: empty, main: null, vars: [], arrays: [], exprType: new Map(), arrayDefs: new Map(), forInfo: new Map(),
    nodeCount: 1, diagnostics: [d], ok: false,
  };
}

/** Parse and validate a program. `ok` is true when no error was reported. */
export function check(source: string): CheckedProgram {
  const diagnostics: Diagnostic[] = [];
  // source.length counts UTF-16 code units, never fewer than the characters, so most texts need no character count.
  if (source.length > LIMITS.maxSourceLength && characterCount(source) > LIMITS.maxSourceLength) {
    return rejected(source, 'source-too-long', `the source text is limited to ${LIMITS.maxSourceLength} characters`);
  }
  let parsed: ReturnType<typeof parse>;
  let checker: Checker;
  let main: FunctionDef | null;
  try {
    parsed = parse(source);
    checker = new Checker();
    main = checker.checkModule(parsed.module);
  } catch (e) {
    // The nesting limits bound the recursion; on an engine with a smaller stack than Node.js the result is still a diagnostic.
    if (!isStackOverflow(e)) throw e;
    return rejected(source, 'stack-exhausted', 'the program is nested too deeply to be checked', 'reduce the nesting of expressions and blocks');
  }
  diagnostics.push(...parsed.diagnostics);
  diagnostics.push(...checker.diagnostics);
  diagnostics.sort((a, b) => (a.span?.start.offset ?? 0) - (b.span?.start.offset ?? 0));
  const ok = !diagnostics.some((d) => d.severity === 'error') && main !== null;
  return {
    source, module: parsed.module, main, vars: checker.vars, arrays: checker.arrays, exprType: checker.exprType,
    arrayDefs: checker.arrayDefs, forInfo: checker.forInfo, nodeCount: parsed.nodeCount, diagnostics, ok,
  };
}
