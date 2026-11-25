/**
 * Recursive-descent parser for Python syntax.
 *
 * The parser accepts the statement and expression forms of the restricted
 * source language with Python's operator precedence. Python constructs outside
 * the language are recognized and reported with the category `unsupported`,
 * so that a reader is told what the construct is and why it is rejected.
 * Text reported with the category `syntax` is not valid Python: CPython
 * rejects it, so valid Python is never reported as a syntax error. The
 * converse does not hold. Some constructs outside the language are parsed to
 * their end before they are reported, and the others end their statement
 * where they are recognized, so that text reported only as unsupported can
 * also contain errors (docs/language.md, section 9).
 * Expressions deeper than MAX_EXPRESSION_DEPTH operations are reported with
 * the category `limit`, which bounds the recursion of every later stage.
 */
import type { Diagnostic, Pos, Span } from '../util/diag.ts';
import type {
  BinOpKind, CmpOpKind, Expr, FunctionDef, Module, Param, Stmt, UnaryOpKind,
} from './ast.ts';
import { MAX_NESTED_BRACKETS, tokenize, type Token } from './lexer.ts';

/**
 * Maximum depth of an expression in operations: each operator, call, index,
 * and list display is one level deeper than its deepest operand, so a chain
 * such as a + b + c is two levels deep. A chain of comparisons, or of one
 * Boolean operator such as a and b and c, is a single node and one level.
 */
export const MAX_EXPRESSION_DEPTH = 200;

export interface ParseResult {
  module: Module;
  diagnostics: Diagnostic[];
  tokens: Token[];
  /** Number of AST nodes; node identifiers are 0 .. nodeCount - 1. */
  nodeCount: number;
}

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const AUG_OPS: Record<string, BinOpKind> = {
  '+=': 'Add', '-=': 'Sub', '*=': 'Mult', '/=': 'Div', '//=': 'FloorDiv', '%=': 'Mod', '**=': 'Pow', '@=': 'MatMult',
  '<<=': 'LShift', '>>=': 'RShift', '|=': 'BitOr', '^=': 'BitXor', '&=': 'BitAnd',
};

/** Binary operators below `**`, and their precedence levels in Python's grammar, lowest first. */
const BINARY_OPS: Record<string, BinOpKind> = {
  '|': 'BitOr', '^': 'BitXor', '&': 'BitAnd', '<<': 'LShift', '>>': 'RShift', '+': 'Add', '-': 'Sub',
  '*': 'Mult', '/': 'Div', '//': 'FloorDiv', '%': 'Mod', '@': 'MatMult',
};
const BINARY_LEVEL: Record<string, number> = {
  '|': 0, '^': 1, '&': 2, '<<': 3, '>>': 3, '+': 4, '-': 4, '*': 5, '/': 5, '//': 5, '%': 5, '@': 5,
};

const UNSUPPORTED_SIMPLE: Record<string, string> = {
  import: 'import statements',
  from: 'import statements',
  global: 'global declarations',
  nonlocal: 'nonlocal declarations',
  del: 'del statements',
  assert: 'assert statements',
  raise: 'exceptions',
};

const UNSUPPORTED_COMPOUND: Record<string, string> = {
  class: 'class definitions',
  try: 'exception handling',
  with: 'with statements',
  async: 'asynchronous code',
};

const LANGUAGE_HINT = 'the language has one entry function with integer scalars, fixed-length integer arrays, if, while, and for over range';

/** Clauses that continue a compound statement; `case` is a soft keyword and continues only a match statement. */
const CONTINUATION_CLAUSES = new Set(['except', 'finally', 'else', 'elif']);

/** Keywords that can begin an expression. */
const EXPRESSION_KEYWORDS = new Set(['False', 'None', 'True', 'await', 'lambda', 'not']);

/**
 * An await expression, an asynchronous comprehension, or a yield expression.
 * Python allows each only in some scopes, which are known once the enclosing
 * construct has been parsed.
 */
interface ScopeUse {
  kind: 'await' | 'async comprehension' | 'yield';
  tok: Token;
}

/** A list, set, or dict comprehension, or a generator expression. */
type ComprehensionKind = 'list' | 'set' | 'dict' | 'generator';

/**
 * Scope of the expression being parsed, for the rules on await, asynchronous
 * comprehensions, and yield: a lambda body; a variable annotation, which
 * CPython 3.14 evaluates in a scope of its own; the own scope of a
 * comprehension or generator expression; or the first element in brackets,
 * which belongs to a comprehension only if comprehension clauses follow it.
 * The function or module of the statement lies outside all of them.
 */
type Scope =
  | { kind: 'lambda' | 'annotation' }
  | { kind: 'comprehension'; of: ComprehensionKind; coroutine: boolean; open: Token }
  | { kind: 'element'; uses: ScopeUse[] };

/** Names that a pattern binds, and the capture or wildcard that makes it match every subject. */
interface PatternInfo {
  names: Token[];
  irrefutable: Token | null;
}

/** An item of a sequence pattern: a pattern, or a star pattern `*name`. */
interface SequenceItem {
  star: Token | null;
  info: PatternInfo;
}

/** A pattern that binds no name and does not match every subject. */
const refutable = (): PatternInfo => ({ names: [], irrefutable: null });

/** True for an imaginary literal such as 2j. */
function isImaginary(t: Token): boolean {
  return t.kind === 'float' && /[jJ]$/.test(t.text);
}

/** A number as Python compares it: an integer exactly, a real or an imaginary part as a double. */
interface NumberValue {
  re: number | bigint;
  im: number;
}

/** Value of a numeric literal, negated when a minus sign precedes it. */
function numberValue(t: Token, negate: boolean): NumberValue {
  if (t.kind === 'int') return { re: negate ? -(t.value ?? 0n) : t.value ?? 0n, im: 0 };
  const digits = t.text.replace(/_/g, '');
  const sign = negate ? -1 : 1;
  return isImaginary(t) ? { re: 0, im: sign * Number(digits.slice(0, -1)) } : { re: sign * Number(digits), im: 0 };
}

/**
 * Text that is equal for numbers that Python considers equal: an integral
 * real value as its exact integer, another real value as its double, and a
 * value with an imaginary part as both parts.
 */
function numberKey(v: NumberValue): string {
  if (v.im !== 0) return `c${Number(v.re) === 0 ? 0 : Number(v.re)},${v.im}`;
  if (typeof v.re === 'bigint') return String(v.re);
  return Number.isInteger(v.re) ? String(BigInt(v.re)) : String(v.re);
}

/** Raised for text that is not valid Python. */
class SyntaxFailure extends Error {
  span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.span = span;
  }
}

/** Raised for valid Python that the source language does not include. */
class UnsupportedFailure extends Error {
  span: Span;
  what: string;
  hint: string | undefined;
  constructor(what: string, span: Span, hint?: string) {
    super(what);
    this.what = what;
    this.span = span;
    this.hint = hint;
  }
}

/** Raised for valid Python that exceeds an implementation limit of the parser. */
class LimitFailure extends Error {
  span: Span;
  code: string;
  hint: string;
  constructor(message: string, code: string, span: Span, hint: string) {
    super(message);
    this.code = code;
    this.span = span;
    this.hint = hint;
  }
}

class Parser {
  private toks: Token[];
  private p = 0;
  private nextId = 0;
  /** End position of the most recently consumed significant token. */
  private lastEnd: Pos;
  /** Brackets whose contents are being parsed. */
  private brackets = 0;
  /** Unary, `not`, `**`, and lambda-default operands being parsed by recursion, before their nodes exist. */
  private nesting = 0;
  /** Depth in operations of each expression node, by node identifier; names and literals have depth 0. */
  private depths: number[] = [];
  /** Function definitions enclosing the current statement. */
  private functions = 0;
  /** Scopes inside the current statement that the expression being parsed lies in, innermost last. */
  private scopes: Scope[] = [];
  /** Items of each tuple, by the identifier of its placeholder node, so that a tuple of targets can be checked. */
  private tupleItems = new Map<number, { items: Expr[]; stars: number }>();
  /**
   * First construct of the current statement that is valid Python outside the
   * language and was parsed completely. It is reported when the statement
   * ends without a syntax error.
   */
  private deferred: UnsupportedFailure | null = null;
  diagnostics: Diagnostic[] = [];

  constructor(tokens: Token[]) {
    this.toks = tokens;
    this.lastEnd = tokens[0]!.span.start;
  }

  get nodeCount(): number {
    return this.nextId;
  }

  // ---- token helpers -------------------------------------------------------

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.p + offset, this.toks.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (this.p < this.toks.length - 1) this.p++;
    if (t.kind !== 'newline' && t.kind !== 'indent' && t.kind !== 'dedent' && t.kind !== 'eof') this.lastEnd = t.span.end;
    return t;
  }

  private isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'op' && t.text === text;
  }

  private isKw(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'name' && t.text === word;
  }

  private describe(t: Token): string {
    switch (t.kind) {
      case 'newline':
        return 'end of line';
      case 'eof':
        return 'end of input';
      case 'indent':
        return 'indentation';
      case 'dedent':
        return 'end of block';
      default:
        return `'${t.text}'`;
    }
  }

  private fail(message: string, tok: Token = this.peek()): never {
    throw new SyntaxFailure(message, tok.span);
  }

  private expectOp(text: string, context?: string): Token {
    if (this.isOp(text)) return this.next();
    const t = this.peek();
    this.fail(context ?? `expected '${text}' but found ${this.describe(t)}`, t);
  }

  private id(): number {
    return this.nextId++;
  }

  private span(start: Pos): Span {
    return { start, end: this.lastEnd };
  }

  private unsupported(what: string, span: Span, hint?: string): never {
    throw new UnsupportedFailure(what, span, hint);
  }

  /**
   * Record a construct outside the language that has been parsed completely and
   * return a placeholder for it, so that the rest of the statement is still
   * checked for syntax errors.
   */
  private outside(what: string, start: Pos, at: Span, hint?: string): Expr {
    this.deferred ??= new UnsupportedFailure(what, at, hint);
    return { kind: 'UnsupportedExpr', id: this.id(), span: this.span(start), what };
  }

  /** Record the depth of a new node, one more than its deepest operand, and enforce the depth limit. */
  private nested<T extends Expr>(node: T, operands: readonly Expr[]): T {
    let depth = 0;
    for (const o of operands) depth = Math.max(depth, this.depths[o.id] ?? 0);
    if (depth >= MAX_EXPRESSION_DEPTH) this.tooDeep(node.span);
    this.depths[node.id] = depth + 1;
    return node;
  }

  /**
   * Start parsing the operand of an operator whose node is built after the
   * operand. Each such operand adds a level to the finished expression, so the
   * count bounds the recursion before the nodes exist.
   */
  private enterOperand(op: Token): void {
    if (this.nesting >= MAX_EXPRESSION_DEPTH) this.tooDeep(op.span);
    this.nesting++;
  }

  private tooDeep(span: Span): never {
    throw new LimitFailure(`an expression can nest at most ${MAX_EXPRESSION_DEPTH} operations`, 'expression-too-deep', span,
      'split the expression into several assignments');
  }

  /** Count a bracket whose contents are parsed next; CPython's tokenizer allows 200 levels. */
  private openBracket(open: Token): void {
    if (this.brackets >= MAX_NESTED_BRACKETS) this.fail('too many nested parentheses', open);
    this.brackets++;
  }

  /**
   * Apply Python's scope rules to an await expression, an asynchronous
   * comprehension, or a yield expression in the innermost scope being parsed.
   * Asynchronous functions are skipped whole, so no function or lambda that
   * is parsed here is asynchronous.
   */
  private scopeUse(use: ScopeUse): void {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope?.kind === 'element') {
      scope.uses.push(use);
      return;
    }
    if (scope?.kind === 'comprehension') {
      if (use.kind === 'yield') this.fail(`'yield' inside ${scope.of === 'generator' ? 'generator expression' : `${scope.of} comprehension`}`, use.tok);
      // An await or an asynchronous comprehension inside a comprehension makes it asynchronous.
      scope.coroutine = true;
      return;
    }
    if (use.kind === 'async comprehension') this.fail('asynchronous comprehension outside of an asynchronous function', use.tok);
    if (scope?.kind === 'annotation') this.fail(`${use.kind} expression cannot be used within an annotation`, use.tok);
    // A yield expression makes a function or lambda a generator, which is valid Python.
    const module = scope === undefined && this.functions === 0;
    if (use.kind === 'yield') {
      if (module) this.fail("'yield' outside function", use.tok);
      return;
    }
    this.fail(module ? "'await' outside function" : "'await' outside async function", use.tok);
  }

  /**
   * True while the annotation of an annotated assignment is being parsed.
   * CPython checks every annotation with its symbol table, but it compiles
   * only the annotation of a plain name at module or class level, and not
   * even that one under the annotations future import. The checks that
   * CPython makes when it compiles an expression are therefore not applied
   * inside an annotation, where they would reject valid Python.
   */
  private inAnnotation(): boolean {
    return this.scopes[0]?.kind === 'annotation';
  }

  /** Begin the first element in brackets, which belongs to a comprehension if comprehension clauses follow it. */
  private openElement(): void {
    this.scopes.push({ kind: 'element', uses: [] });
  }

  /** End an element that no comprehension clause follows; what it contains belongs to the enclosing scope. */
  private closeElement(): void {
    const element = this.scopes.pop() as Extract<Scope, { kind: 'element' }>;
    for (const use of element.uses) this.scopeUse(use);
  }

  /**
   * The syntax error that the scopes being parsed already make certain when a
   * construct outside the language ends the statement early: an asynchronous
   * list, set, or dict comprehension whose enclosing scopes, up to the
   * function, lambda, or annotation, are such comprehensions too. An element
   * whose comprehension clauses have not been reached leaves its scope
   * undecided, and a generator expression may be asynchronous anywhere.
   */
  private settledScopeError(): SyntaxFailure | null {
    for (let k = this.scopes.length - 1; k >= 0; k--) {
      const scope = this.scopes[k]!;
      if (scope.kind !== 'comprehension' || scope.of === 'generator' || !scope.coroutine) continue;
      let j = k;
      while (j > 0) {
        const below = this.scopes[j - 1]!;
        if (below.kind !== 'comprehension' || below.of === 'generator') break;
        j--;
      }
      const enclosing = this.scopes[j - 1];
      if (enclosing === undefined || enclosing.kind === 'lambda' || enclosing.kind === 'annotation') {
        const outermost = this.scopes[j] as Extract<Scope, { kind: 'comprehension' }>;
        return new SyntaxFailure('asynchronous comprehension outside of an asynchronous function', outermost.open.span);
      }
    }
    return null;
  }

  private report(e: unknown): Span {
    if (e instanceof SyntaxFailure) {
      this.diagnostics.push({ severity: 'error', category: 'syntax', code: 'syntax-error', message: e.message, span: e.span });
      return e.span;
    }
    if (e instanceof LimitFailure) {
      this.diagnostics.push({ severity: 'error', category: 'limit', code: e.code, message: e.message, span: e.span, hint: e.hint });
      return e.span;
    }
    if (e instanceof UnsupportedFailure) {
      const d: Diagnostic = {
        severity: 'error',
        category: 'unsupported',
        code: 'unsupported-construct',
        message: `${e.what} are not part of the source language`,
        span: e.span,
      };
      if (e.hint) d.hint = e.hint;
      this.diagnostics.push(d);
      return e.span;
    }
    throw e;
  }

  /** Skip the rest of the current logical line, and an indented block that follows it. */
  private skipLine(skipBlock: boolean): void {
    while (this.peek().kind !== 'newline' && this.peek().kind !== 'eof') {
      if (this.peek().kind === 'indent' || this.peek().kind === 'dedent') break;
      this.next();
    }
    if (this.peek().kind === 'newline') this.next();
    if (skipBlock && this.peek().kind === 'indent') this.skipBlock();
  }

  private skipBlock(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t.kind === 'indent') depth++;
      else if (t.kind === 'dedent') depth--;
      else if (t.kind === 'eof') return;
    } while (depth > 0);
  }

  // ---- statements ----------------------------------------------------------

  parseModule(): Module {
    const start = this.peek().span.start;
    const body: Stmt[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'newline') {
        this.next();
        continue;
      }
      if (this.peek().kind === 'dedent') {
        this.next();
        continue;
      }
      body.push(...this.parseStatement());
    }
    return { kind: 'Module', id: this.id(), span: { start, end: this.lastEnd }, body };
  }

  private parseStatement(): Stmt[] {
    const t = this.peek();
    if (t.kind === 'indent') {
      this.diagnostics.push({ severity: 'error', category: 'syntax', code: 'syntax-error', message: 'unexpected indent', span: t.span });
      this.next();
      const out: Stmt[] = [];
      while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
        if (this.peek().kind === 'newline') {
          this.next();
          continue;
        }
        out.push(...this.parseStatement());
      }
      if (this.peek().kind === 'dedent') this.next();
      return out;
    }
    const functions = this.functions;
    const outer = this.deferred;
    this.deferred = null;
    try {
      const stmts = this.parseStatementForm(t);
      if (this.deferred === null) return stmts;
      const span = this.report(this.deferred);
      return [{ kind: 'UnsupportedStmt', id: this.id(), span, what: 'unparsed statement' }];
    } catch (e) {
      // A construct outside the language can end a statement that the scope rules already make invalid.
      const failure = (e instanceof UnsupportedFailure ? this.settledScopeError() : null) ?? e;
      // No expression encloses a statement, so the counters of an abandoned expression start again from zero.
      this.brackets = 0;
      this.nesting = 0;
      this.scopes = [];
      this.functions = functions;
      // Of two constructs outside the language, the one that comes first in the text is reported.
      const span = this.report(failure instanceof UnsupportedFailure && this.deferred ? this.deferred : failure);
      const compoundHeader = this.lineEndsWithColon();
      this.skipLine(compoundHeader || failure instanceof UnsupportedFailure);
      // A construct outside the language or a limit ends the statement in text that can be valid Python,
      // so the clauses that continue the statement are skipped with it instead of being read as statements.
      if (!(failure instanceof SyntaxFailure)) this.skipClauses(t);
      return [{ kind: 'UnsupportedStmt', id: this.id(), span, what: 'unparsed statement' }];
    } finally {
      this.deferred = outer;
    }
  }

  /**
   * Skip the clauses that can continue an abandoned statement that began
   * with the token `first`: elif and else clauses after an if statement, and
   * an else clause after a loop.
   */
  private skipClauses(first: Token): void {
    if (first.kind !== 'name') return;
    if (first.text === 'if') while (this.isKw('elif')) this.skipLine(true);
    if ((first.text === 'if' || first.text === 'while' || first.text === 'for') && this.isKw('else')) this.skipLine(true);
  }

  private parseStatementForm(t: Token): Stmt[] {
    if (t.kind === 'name') {
      switch (t.text) {
        case 'def':
          return [this.parseFunctionDef()];
        case 'if':
          return [this.parseIf()];
        case 'while':
          return [this.parseWhile()];
        case 'for':
          return [this.parseFor()];
        default:
          break;
      }
      const compound = UNSUPPORTED_COMPOUND[t.text];
      if (compound !== undefined) {
        // async begins a function definition, or a for or with statement, which is valid only inside an
        // asynchronous function; those are skipped whole, so only a definition can be valid here.
        const after = this.peek(1);
        if (t.text === 'async' && !(after.kind === 'name' && after.text === 'def')) {
          if (after.kind === 'name' && (after.text === 'for' || after.text === 'with')) this.fail(`'async ${after.text}' outside async function`, t);
          this.fail('invalid syntax', after);
        }
        return [this.skipUnsupportedCompound(compound)];
      }
      if (CONTINUATION_CLAUSES.has(t.text)) this.fail('invalid syntax', t);
      // No simple statement ends with ':', so a logical line that starts with 'match' and ends with ':' is a match statement or is not Python.
      if (t.text === 'match' && this.lineEndsWithColon() && !this.isOp('=', 1)) return [this.parseMatch()];
    }
    if (t.kind === 'op' && t.text === '@') return [this.skipUnsupportedCompound('decorators')];
    return this.parseSimpleLine();
  }

  private lineEndsWithColon(): boolean {
    let k = 0;
    let last: Token | null = null;
    for (;;) {
      const t = this.peek(k);
      if (t.kind === 'newline' || t.kind === 'eof' || t.kind === 'indent' || t.kind === 'dedent') break;
      last = t;
      k++;
      if (this.p + k >= this.toks.length) break;
    }
    return last !== null && last.kind === 'op' && last.text === ':';
  }

  private skipUnsupportedCompound(what: string): Stmt {
    const start = this.peek().span.start;
    const first = this.peek();
    this.diagnostics.push({
      severity: 'error',
      category: 'unsupported',
      code: 'unsupported-construct',
      message: `${what} are not part of the source language`,
      span: first.span,
      hint: LANGUAGE_HINT,
    });
    this.skipLine(true);
    // Clauses that continue the same compound statement are skipped with it.
    while (this.peek().kind === 'name' && CONTINUATION_CLAUSES.has(this.peek().text)) this.skipLine(true);
    return { kind: 'UnsupportedStmt', id: this.id(), span: { start, end: this.lastEnd }, what };
  }

  /** Skip the rest of a block whose indentation has been consumed, through the dedent that closes it. */
  private skipBlockRest(): void {
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'indent') depth++;
      else if (t.kind === 'dedent') depth--;
      else if (t.kind === 'eof') return;
    }
  }

  /**
   * match statement: 'match' subject ':' NEWLINE INDENT case_block+ DEDENT.
   * The statement is outside the language. It is parsed completely, with the
   * checks that the CPython compiler applies to patterns, so that text that
   * is not valid Python is reported as a syntax error.
   */
  private parseMatch(): Stmt {
    const kw = this.next();
    const start = kw.span.start;
    this.deferred ??= new UnsupportedFailure('match statements', kw.span, LANGUAGE_HINT);
    this.matchSubject();
    if (!this.isOp(':')) this.fail('invalid syntax', this.peek());
    this.next();
    if (this.peek().kind !== 'newline') this.fail('invalid syntax', this.peek());
    this.next();
    if (this.peek().kind !== 'indent') this.fail(`expected an indented block after 'match' statement on line ${kw.span.start.line}`, this.peek());
    this.next();
    // A pattern that matches every subject without a guard must be in the last case block.
    let unreachable: Token | null = null;
    let previous: Token | null = null;
    while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
      if (this.peek().kind === 'newline') {
        this.next();
        continue;
      }
      unreachable ??= previous;
      try {
        previous = this.caseBlock();
      } catch (e) {
        const failure = (e instanceof UnsupportedFailure ? this.settledScopeError() : null) ?? e;
        this.brackets = 0;
        this.nesting = 0;
        this.scopes = [];
        previous = null;
        if (failure instanceof UnsupportedFailure) {
          // A construct outside the language in a guard or a one-line body ends its case block.
          this.skipLine(true);
          continue;
        }
        // A syntax error ends the statement; the rest of its block is skipped.
        this.report(failure);
        this.deferred = null;
        this.skipBlockRest();
        return { kind: 'UnsupportedStmt', id: this.id(), span: this.span(start), what: 'match statements' };
      }
    }
    if (this.peek().kind === 'dedent') this.next();
    if (unreachable) {
      this.report(new SyntaxFailure(this.unreachableMessage(unreachable), unreachable.span));
      this.deferred = null;
    }
    return { kind: 'UnsupportedStmt', id: this.id(), span: this.span(start), what: 'match statements' };
  }

  /** subject_expr: a named expression, or starred and plain expressions separated by commas. */
  private matchSubject(): void {
    for (let items = 1; ; items++) {
      if (this.isOp('*')) {
        const star = this.next();
        this.parseBitOr();
        // A starred subject must be an item of a tuple.
        if (items === 1 && !this.isOp(',')) this.fail('invalid syntax', star);
      } else {
        this.parseExpr();
        if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
      }
      if (!this.isOp(',')) return;
      this.next();
      if (this.isOp(':')) return;
    }
  }

  /**
   * case_block: 'case' patterns ['if' named_expression] ':' block. Returns the
   * capture or wildcard that makes an unguarded pattern match every subject.
   */
  private caseBlock(): Token | null {
    const kw = this.peek();
    if (kw.kind !== 'name' || kw.text !== 'case') this.fail(kw.kind === 'indent' ? 'unexpected indent' : 'invalid syntax', kw);
    this.next();
    const pattern = this.patterns();
    const guarded = this.isKw('if');
    if (guarded) {
      this.next();
      this.parseNamedExpr();
    }
    this.parseBlock("'case' statement", kw);
    return guarded ? null : pattern.irrefutable;
  }

  private unreachableMessage(irrefutable: Token): string {
    return irrefutable.text === '_' ? 'wildcard makes remaining patterns unreachable'
      : `name capture '${irrefutable.text}' makes remaining patterns unreachable`;
  }

  /** A name that a pattern binds; the CPython compiler rejects binding __debug__. */
  private captureName(t: Token): Token {
    if (t.text === '__debug__') this.fail('cannot assign to __debug__', t);
    return t;
  }

  /** Add the names that a subpattern binds; the CPython compiler rejects a name bound twice in one pattern. */
  private bindNames(names: Token[], more: readonly Token[]): void {
    for (const t of more) {
      if (names.some((n) => n.text === t.text)) this.fail(`multiple assignments to name '${t.text}' in pattern`, t);
      names.push(t);
    }
  }

  /** patterns: an open sequence pattern p, q, ... or one pattern. */
  private patterns(): PatternInfo {
    const first = this.maybeStarPattern();
    if (!this.isOp(',')) {
      // A star pattern is valid only as an item of a sequence.
      if (first.star) this.fail('invalid syntax', first.star);
      return first.info;
    }
    return this.sequenceItems([first], () => this.isOp(':') || this.isKw('if'));
  }

  /**
   * The items of a sequence pattern after the first one, separated by commas;
   * `atEnd` tells whether the token after a comma ends the sequence. The
   * CPython compiler allows one star pattern in a sequence.
   */
  private sequenceItems(items: SequenceItem[], atEnd: () => boolean): PatternInfo {
    while (this.isOp(',')) {
      this.next();
      if (atEnd()) break;
      items.push(this.maybeStarPattern());
    }
    const names: Token[] = [];
    let star = false;
    for (const item of items) {
      if (item.star) {
        if (star) this.fail('multiple starred names in sequence pattern', item.star);
        star = true;
      }
      this.bindNames(names, item.info.names);
    }
    return { names, irrefutable: null };
  }

  /** maybe_star_pattern: '*' and a capture name or _, or a pattern. */
  private maybeStarPattern(): SequenceItem {
    if (!this.isOp('*')) return { star: null, info: this.pattern() };
    const star = this.next();
    const t = this.peek();
    if (t.kind !== 'name' || KEYWORDS.has(t.text)) this.fail('invalid syntax', t);
    this.next();
    return { star, info: t.text === '_' ? refutable() : { names: [this.captureName(t)], irrefutable: null } };
  }

  /** pattern: an or-pattern, optionally followed by 'as' and a capture name. */
  private pattern(): PatternInfo {
    const p = this.orPattern();
    if (!this.isKw('as')) return p;
    this.next();
    const t = this.peek();
    if (t.kind === 'name' && t.text === '_') this.fail("cannot use '_' as a target", t);
    if (t.kind !== 'name' || KEYWORDS.has(t.text)) this.fail('invalid pattern target', t);
    this.next();
    const names = [...p.names];
    this.bindNames(names, [this.captureName(t)]);
    return { names, irrefutable: p.irrefutable };
  }

  /**
   * or_pattern: closed patterns separated by '|'. As in the CPython compiler,
   * only the last alternative may match every subject, and every alternative
   * binds the same names.
   */
  private orPattern(): PatternInfo {
    const at = this.peek();
    const first = this.closedPattern();
    if (!this.isOp('|')) return first;
    const alternatives = [first];
    while (this.isOp('|')) {
      this.next();
      alternatives.push(this.closedPattern());
    }
    const last = alternatives[alternatives.length - 1]!;
    for (const alt of alternatives) {
      if (alt !== last && alt.irrefutable) this.fail(this.unreachableMessage(alt.irrefutable), alt.irrefutable);
    }
    const names = new Set(first.names.map((t) => t.text));
    for (const alt of alternatives) {
      if (alt.names.length !== names.size || alt.names.some((t) => !names.has(t.text))) this.fail('alternative patterns bind different names', at);
    }
    return { names: first.names, irrefutable: last.irrefutable };
  }

  /** closed_pattern: a literal, capture, wildcard, value, group, sequence, mapping, or class pattern. */
  private closedPattern(): PatternInfo {
    const t = this.peek();
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string' || this.isOp('-')) {
      this.literalPattern();
      return refutable();
    }
    if (t.kind === 'name') {
      if (t.text === 'None' || t.text === 'True' || t.text === 'False') {
        this.next();
        return refutable();
      }
      if (KEYWORDS.has(t.text)) this.fail('invalid syntax', t);
      this.next();
      // The wildcard is taken before a value or class pattern, so _.x and _(x) are not patterns.
      if (t.text === '_') return { names: [], irrefutable: t };
      let dotted = false;
      while (this.isOp('.')) {
        this.next();
        const attr = this.peek();
        if (attr.kind !== 'name' || KEYWORDS.has(attr.text)) this.fail('invalid syntax', attr);
        this.next();
        dotted = true;
      }
      if (this.isOp('(')) return this.classPattern();
      if (dotted) return refutable();
      return { names: [this.captureName(t)], irrefutable: t };
    }
    if (this.isOp('(')) {
      this.openBracket(this.next());
      let info = refutable();
      if (!this.isOp(')')) {
        const first = this.maybeStarPattern();
        // A pattern in parentheses without a comma is a group, which matches as the pattern does.
        if (!first.star && this.isOp(')')) info = first.info;
        else {
          if (!this.isOp(',')) this.fail('invalid syntax', this.peek());
          info = this.sequenceItems([first], () => this.isOp(')'));
        }
      }
      this.expectOp(')', 'invalid syntax');
      this.brackets--;
      return info;
    }
    if (this.isOp('[')) {
      this.openBracket(this.next());
      const info = this.isOp(']') ? refutable() : this.sequenceItems([this.maybeStarPattern()], () => this.isOp(']'));
      this.expectOp(']', 'invalid syntax');
      this.brackets--;
      return info;
    }
    if (this.isOp('{')) return this.mappingPattern();
    this.fail('invalid syntax', t);
  }

  /**
   * The arguments of a class pattern: patterns, then keyword patterns
   * name=pattern. The CPython compiler rejects a repeated keyword name.
   */
  private classPattern(): PatternInfo {
    this.openBracket(this.next());
    const names: Token[] = [];
    const keywords: Token[] = [];
    while (!this.isOp(')')) {
      const t = this.peek();
      if (t.kind === 'name' && !KEYWORDS.has(t.text) && this.isOp('=', 1)) {
        keywords.push(t);
        this.next();
        this.next();
      } else if (keywords.length > 0) this.fail('positional patterns follow keyword patterns', t);
      this.bindNames(names, this.pattern().names);
      if (!this.isOp(',')) break;
      this.next();
    }
    this.expectOp(')', 'invalid syntax');
    this.brackets--;
    keywords.forEach((k, i) => {
      if (k.text === '__debug__') this.fail('cannot assign to __debug__', k);
      if (keywords.slice(0, i).some((p) => p.text === k.text)) this.fail(`attribute name repeated in class pattern: ${k.text}`, k);
    });
    return { names, irrefutable: null };
  }

  /**
   * mapping_pattern: '{' key: pattern, ... [**name] '}', where a key is a
   * literal or a dotted name. The CPython compiler rejects a literal key
   * equal to an earlier one.
   */
  private mappingPattern(): PatternInfo {
    this.openBracket(this.next());
    const names: Token[] = [];
    const keys = new Set<string>();
    while (!this.isOp('}')) {
      if (this.isOp('**')) {
        this.next();
        const t = this.peek();
        // The rest of the mapping is captured by a name other than _, after every key.
        if (t.kind !== 'name' || KEYWORDS.has(t.text) || t.text === '_') this.fail('invalid syntax', t);
        this.next();
        this.bindNames(names, [this.captureName(t)]);
        if (this.isOp(',')) this.next();
        break;
      }
      const keyStart = this.p;
      const keyTok = this.peek();
      if (keyTok.kind === 'name' && keyTok.text !== 'None' && keyTok.text !== 'True' && keyTok.text !== 'False') {
        // A name key is a dotted name, looked up when the pattern is matched.
        if (KEYWORDS.has(keyTok.text)) this.fail('invalid syntax', keyTok);
        this.next();
        if (!this.isOp('.')) this.fail('invalid syntax', this.peek());
        while (this.isOp('.')) {
          this.next();
          const attr = this.peek();
          if (attr.kind !== 'name' || KEYWORDS.has(attr.text)) this.fail('invalid syntax', attr);
          this.next();
        }
      } else {
        const key = this.literalPattern();
        if (key !== null && keys.has(key)) {
          const text = this.toks.slice(keyStart, this.p).map((k) => k.text).join('');
          this.fail(`mapping pattern checks duplicate key (${text})`, keyTok);
        }
        if (key !== null) keys.add(key);
      }
      this.expectOp(':', 'invalid syntax');
      this.bindNames(names, this.pattern().names);
      if (!this.isOp(',')) break;
      this.next();
    }
    this.expectOp('}', 'invalid syntax');
    this.brackets--;
    return { names, irrefutable: null };
  }

  /**
   * A literal pattern: a signed number, a complex number such as 1 + 2j,
   * strings, None, True, or False. Returns a text that is equal for values
   * that Python considers equal, or null when the value is not computed here.
   */
  private literalPattern(): string | null {
    const t = this.peek();
    if (t.kind === 'name') {
      if (t.text !== 'None' && t.text !== 'True' && t.text !== 'False') this.fail('invalid syntax', t);
      this.next();
      // True and False are equal to 1 and 0.
      return t.text === 'None' ? 'None' : t.text === 'True' ? '1' : '0';
    }
    if (t.kind === 'string') return this.stringPattern();
    const minus = this.isOp('-');
    if (minus) this.next();
    const real = this.peek();
    if (real.kind !== 'int' && real.kind !== 'float') this.fail('invalid syntax', real);
    this.next();
    const value = numberValue(real, minus);
    if (!this.isOp('+') && !this.isOp('-')) return numberKey(value);
    // complex_number: a real part, then + or - and an imaginary part.
    const op = this.next();
    if (isImaginary(real)) this.fail('real number required in complex literal', real);
    const imag = this.peek();
    if (imag.kind !== 'int' && imag.kind !== 'float') this.fail('invalid syntax', imag);
    if (!isImaginary(imag)) this.fail('imaginary number required in complex literal', imag);
    this.next();
    return numberKey({ re: value.re, im: numberValue(imag, op.text === '-').im });
  }

  /** Adjacent string literals in a pattern; returns their value as a key, or null when it is not computed here. */
  private stringPattern(): string | null {
    let bytes: boolean | null = null;
    let value: string | null = '';
    while (this.peek().kind === 'string') {
      const s = this.next();
      const prefix = /^[A-Za-z]*/.exec(s.text)![0].toLowerCase();
      if (prefix.includes('f') || prefix.includes('t')) this.fail('patterns may only match literals and attribute lookups', s);
      if (bytes !== null && bytes !== prefix.includes('b')) this.fail('cannot mix bytes and nonbytes literals', s);
      bytes = prefix.includes('b');
      const quote = s.text.startsWith(s.text[prefix.length]!.repeat(3), prefix.length) && s.text.length >= prefix.length + 6 ? 3 : 1;
      const body = s.text.slice(prefix.length + quote, s.text.length - quote);
      // The value of a literal with an escape sequence or a line break is not computed here.
      value = value !== null && (prefix.includes('r') || !body.includes('\\')) && !/[\r\n]/.test(body) ? value + body : null;
    }
    return value === null ? null : `${bytes ? 'b' : 's'}:${value}`;
  }

  /** simple_stmt (';' simple_stmt)* [';'] NEWLINE */
  private parseSimpleLine(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      out.push(this.parseSimple());
      if (this.isOp(';')) {
        this.next();
        if (this.peek().kind === 'newline' || this.peek().kind === 'eof') break;
        continue;
      }
      break;
    }
    const t = this.peek();
    if (t.kind === 'newline') this.next();
    else if (t.kind !== 'eof') this.fail('invalid syntax', t);
    return out;
  }

  private skipSimpleRest(): void {
    while (this.peek().kind !== 'newline' && this.peek().kind !== 'eof' && !this.isOp(';')) this.next();
  }

  private parseSimple(): Stmt {
    const t = this.peek();
    const start = t.span.start;
    if (t.kind === 'name') {
      if (t.text === 'pass') {
        this.next();
        return { kind: 'Pass', id: this.id(), span: this.span(start) };
      }
      if (t.text === 'break') {
        this.next();
        return { kind: 'Break', id: this.id(), span: this.span(start) };
      }
      if (t.text === 'continue') {
        this.next();
        return { kind: 'Continue', id: this.id(), span: this.span(start) };
      }
      if (t.text === 'return') {
        // The CPython compiler rejects a return statement outside a function, whatever its value.
        if (this.functions === 0) this.fail("'return' outside function", t);
        this.next();
        let value: Expr | null = null;
        if (this.peek().kind !== 'newline' && this.peek().kind !== 'eof' && !this.isOp(';')) {
          const valueStart = this.peek().span.start;
          value = this.isOp('*') ? this.starredValue() : this.parseExpr();
          if (this.isOp(',')) value = this.tupleRest(value, valueStart, 'tuples', 'return a single integer');
        }
        return { kind: 'Return', id: this.id(), span: this.span(start), value };
      }
      if (t.text === 'yield') {
        const value = this.yieldExpr();
        return { kind: 'Expr', id: this.id(), span: this.span(start), value };
      }
      if (t.text === 'nonlocal' && this.functions < 2) {
        // Outside a nested function no enclosing function scope exists, so CPython rejects the declaration.
        this.next();
        const first = this.peek();
        for (;;) {
          const nt = this.peek();
          if (nt.kind !== 'name' || KEYWORDS.has(nt.text)) this.fail('invalid syntax', nt);
          this.next();
          if (!this.isOp(',')) break;
          this.next();
        }
        if (this.peek().kind !== 'newline' && this.peek().kind !== 'eof' && !this.isOp(';')) this.fail('invalid syntax', this.peek());
        this.fail(this.functions === 0 ? 'nonlocal declaration not allowed at module level' : `no binding for nonlocal '${first.text}' found`, t);
      }
      // type is a soft keyword: before a name it begins a type alias statement, which is a simple statement
      // and can follow a semicolon or the colon of a compound statement.
      const alias = t.text === 'type' && this.peek(1).kind === 'name' && !KEYWORDS.has(this.peek(1).text);
      const what = alias ? 'type alias statements' : UNSUPPORTED_SIMPLE[t.text];
      if (what !== undefined) {
        const d: Diagnostic = {
          severity: 'error',
          category: 'unsupported',
          code: 'unsupported-construct',
          message: `${what} are not part of the source language`,
          span: t.span,
        };
        if (alias) d.hint = LANGUAGE_HINT;
        this.diagnostics.push(d);
        this.next();
        this.skipSimpleRest();
        return { kind: 'UnsupportedStmt', id: this.id(), span: this.span(start), what };
      }
    }
    let first = this.isOp('*') ? this.starredValue() : this.parseExpr();
    if (this.isOp(',')) first = this.tupleRest(first, start, 'tuple packing and unpacking', 'assign each variable in its own statement');
    if (this.isOp('=')) {
      this.checkAssignable(first, false);
      this.next();
      let value = this.assignedValue();
      while (this.isOp('=')) {
        // A chained assignment is outside the language; each target is checked before the next value is parsed.
        this.checkAssignable(value, false);
        this.deferred ??= new UnsupportedFailure('chained assignments', this.peek().span, 'assign each variable in its own statement');
        this.next();
        value = this.assignedValue();
      }
      return { kind: 'Assign', id: this.id(), span: this.span(start), target: first, value };
    }
    const opTok = this.peek();
    if (opTok.kind === 'op' && AUG_OPS[opTok.text] !== undefined) {
      this.checkAssignable(first, true);
      this.next();
      const valueStart = this.peek().span.start;
      const yielded = this.isKw('yield');
      let value = yielded ? this.yieldExpr() : this.isOp('*') ? this.starredValue() : this.parseExpr();
      // A yield expression takes the items after it as its own value, so no comma can follow it.
      if (!yielded && this.isOp(',')) value = this.tupleRest(value, valueStart, 'tuples');
      return { kind: 'AugAssign', id: this.id(), span: this.span(start), target: first, op: AUG_OPS[opTok.text]!, value };
    }
    if (this.isOp(':')) {
      const attribute = first.kind === 'UnsupportedExpr' && first.what === 'attribute access';
      if (first.kind !== 'Name' && first.kind !== 'Subscript' && !attribute) this.fail('illegal target for annotation', opTok);
      // The annotation and the value are parsed, so that an incomplete annotation is reported as a syntax error.
      this.deferred ??= new UnsupportedFailure('variable annotations', opTok.span, 'write a plain assignment such as x = 0');
      this.next();
      this.scopes.push({ kind: 'annotation' });
      this.parseExpr();
      this.scopes.pop();
      if (this.isOp('=')) {
        this.next();
        if (this.isKw('yield')) this.yieldExpr();
        else this.starExpressions();
      }
      return { kind: 'Expr', id: this.id(), span: this.span(start), value: first };
    }
    if (this.isOp(':=')) this.unsupported('assignment expressions', opTok.span);
    return { kind: 'Expr', id: this.id(), span: this.span(start), value: first };
  }

  /** The value of an assignment: a yield expression, a tuple, or an expression. */
  private assignedValue(): Expr {
    if (this.isKw('yield')) return this.yieldExpr();
    if (this.isOp('*')) return this.starredValue();
    const start = this.peek().span.start;
    const value = this.parseExpr();
    return this.isOp(',') ? this.tupleRest(value, start, 'tuple packing and unpacking', 'assign each variable in its own statement') : value;
  }

  /**
   * The items after the first one of a tuple without parentheses, which is
   * outside the language. They are parsed completely, and recorded so that a
   * tuple of targets can be checked.
   */
  private tupleRest(first: Expr, start: Pos, what: string, hint?: string): Expr {
    const comma = this.peek();
    const items = [first];
    let stars = 0;
    while (this.isOp(',')) {
      this.next();
      if (this.isOp(',')) this.fail('invalid syntax', this.peek());
      if (!this.startsExpression()) break;
      if (this.isOp('*')) {
        this.next();
        stars++;
        items.push(this.parseBitOr());
      } else items.push(this.parseExpr());
    }
    const tuple = this.outside(what, start, comma.span, hint);
    this.tupleItems.set(tuple.id, { items, stars });
    return tuple;
  }

  /** star_expressions that begin with a starred item; they are parsed completely and are outside the language. */
  private starredValue(): Expr {
    const star = this.peek();
    const tuple = this.starExpressions();
    const value = this.outside('starred expressions', star.span.start, star.span);
    this.tupleItems.set(value.id, tuple);
    return value;
  }

  /**
   * star_expressions: expressions and starred expressions separated by
   * commas, with an optional trailing comma. A starred item is valid only in
   * a tuple, that is, with a comma; the CPython compiler enforces this, so it
   * does not hold inside an annotation. Returns the items and the number of
   * starred ones.
   */
  private starExpressions(): { items: Expr[]; stars: number } {
    let star: Token | null = null;
    let tuple = false;
    const items: Expr[] = [];
    let stars = 0;
    for (;;) {
      if (this.isOp('*')) {
        const s = this.next();
        star ??= s;
        stars++;
        items.push(this.parseBitOr());
      } else items.push(this.parseExpr());
      if (!this.isOp(',')) break;
      tuple = true;
      this.next();
      if (this.isOp(',')) this.fail('invalid syntax', this.peek());
      if (!this.startsExpression()) break;
    }
    if (star && !tuple && !this.inAnnotation()) this.fail("can't use starred expression here", star);
    return { items, stars };
  }

  /** True when the next token can begin an expression or a starred item. */
  private startsExpression(): boolean {
    const t = this.peek();
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string') return true;
    if (t.kind === 'name') return !KEYWORDS.has(t.text) || EXPRESSION_KEYWORDS.has(t.text);
    return t.kind === 'op' && ['(', '[', '{', '-', '+', '~', '*', '...'].includes(t.text);
  }

  /** True when the next token can begin a primary: a name, a literal, or a bracket. */
  private startsPrimary(): boolean {
    const t = this.peek();
    if (t.kind === 'int' || t.kind === 'float' || t.kind === 'string') return true;
    if (t.kind === 'name') return !KEYWORDS.has(t.text) || t.text === 'True' || t.text === 'False' || t.text === 'None';
    return t.kind === 'op' && ['(', '[', '{', '...'].includes(t.text);
  }

  /**
   * yield_expr: 'yield' 'from' expression, or 'yield' with optional
   * star_expressions. Generators are outside the language.
   */
  private yieldExpr(): Expr {
    const kw = this.next();
    // The scope rules do not depend on the value, so they are applied first.
    this.scopeUse({ kind: 'yield', tok: kw });
    if (this.isKw('from')) {
      this.next();
      this.parseExpr();
    } else if (this.startsExpression()) this.starExpressions();
    return this.outside('generators', kw.span.start, kw.span);
  }

  /** Python rejects assignment to anything other than a name, subscript, attribute, or sequence of targets. */
  private checkAssignable(e: Expr, augmented: boolean): void {
    const bad = (what: string): never => {
      throw new SyntaxFailure(
        augmented ? `'${what}' is an illegal expression for augmented assignment` : `cannot assign to ${what} here. Maybe you meant '==' instead of '='?`,
        e.span,
      );
    };
    switch (e.kind) {
      case 'Name':
        // CPython's compiler rejects every binding of the built-in constant __debug__.
        if (e.name === '__debug__') throw new SyntaxFailure('cannot assign to __debug__', e.span);
        return;
      case 'Subscript':
        return;
      case 'UnsupportedExpr':
        if (e.what === 'attribute access') return;
        if (e.what === 'generators') {
          throw new SyntaxFailure(augmented ? "'yield expression' is an illegal expression for augmented assignment" : 'assignment to yield expression not possible', e.span);
        }
        // A tuple of targets may contain one starred target; its items are checked as targets. The CPython
        // compiler enforces the limit of one, so it does not hold for a comprehension inside an annotation.
        if (this.tupleItems.has(e.id)) {
          if (augmented) throw new SyntaxFailure("'tuple' is an illegal expression for augmented assignment", e.span);
          const tuple = this.tupleItems.get(e.id)!;
          if (tuple.stars > 1 && !this.inAnnotation()) throw new SyntaxFailure('multiple starred expressions in assignment', e.span);
          tuple.items.forEach((x) => this.checkAssignable(x, false));
          return;
        }
        return bad('expression');
      case 'List':
        if (augmented) return bad('list');
        e.elts.forEach((x) => this.checkAssignable(x, false));
        throw new UnsupportedFailure('tuple packing and unpacking', e.span, 'assign each variable in its own statement');
      case 'Constant':
        if (e.ctype === 'bool') throw new SyntaxFailure(`cannot assign to ${e.value === 1n ? 'True' : 'False'}`, e.span);
        if (e.ctype === 'none') throw new SyntaxFailure('cannot assign to None', e.span);
        if (e.ctype === 'ellipsis') throw new SyntaxFailure('cannot assign to ellipsis here', e.span);
        return bad('literal');
      case 'Call':
        return bad('function call');
      case 'Compare':
        return bad('comparison');
      default:
        return bad('expression');
    }
  }

  private parseBlock(owner: string, ownerTok: Token): Stmt[] {
    if (!this.isOp(':')) this.fail("expected ':'", this.peek());
    this.next();
    if (this.peek().kind !== 'newline') {
      if (this.peek().kind === 'eof') this.fail('invalid syntax');
      return this.parseSimpleLine();
    }
    this.next();
    if (this.peek().kind !== 'indent') {
      this.fail(`expected an indented block after ${owner} on line ${ownerTok.span.start.line}`, this.peek());
    }
    this.next();
    const body: Stmt[] = [];
    while (this.peek().kind !== 'dedent' && this.peek().kind !== 'eof') {
      if (this.peek().kind === 'newline') {
        this.next();
        continue;
      }
      body.push(...this.parseStatement());
    }
    if (this.peek().kind === 'dedent') this.next();
    return body;
  }

  private parseFunctionDef(): FunctionDef {
    const defTok = this.next();
    const start = defTok.span.start;
    const nameTok = this.peek();
    if (nameTok.kind !== 'name' || KEYWORDS.has(nameTok.text)) this.fail('invalid syntax', nameTok);
    if (nameTok.text === '__debug__') this.fail('cannot assign to __debug__', nameTok);
    this.next();
    if (this.isOp('[')) this.unsupported('type parameters', this.peek().span);
    if (!this.isOp('(')) this.fail("expected '('", this.peek());
    this.next();
    const params: Param[] = [];
    while (!this.isOp(')')) {
      const pt = this.peek();
      if (pt.kind === 'op' && (pt.text === '*' || pt.text === '**' || pt.text === '/')) {
        this.unsupported('variadic, keyword-only, and positional-only parameters', pt.span);
      }
      if (pt.kind !== 'name' || KEYWORDS.has(pt.text)) this.fail('invalid syntax', pt);
      if (pt.text === '__debug__') this.fail('cannot assign to __debug__', pt);
      this.next();
      if (this.isOp(':')) this.unsupported('parameter annotations', this.peek().span, 'every parameter is a 32-bit integer');
      if (this.isOp('=')) this.unsupported('default parameter values', this.peek().span);
      params.push({ name: pt.text, span: pt.span });
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      if (!this.isOp(')')) this.fail('invalid syntax', this.peek());
    }
    this.next();
    if (this.isOp('->')) this.unsupported('return annotations', this.peek().span, 'the entry function returns a 32-bit integer');
    this.functions++;
    const body = this.parseBlock('function definition', defTok);
    this.functions--;
    return { kind: 'FunctionDef', id: this.id(), span: this.span(start), name: nameTok.text, nameSpan: nameTok.span, params, body };
  }

  /**
   * if statement. An elif clause is an if statement in the else branch of the
   * clause before it. The clauses are parsed in a loop and their nodes are
   * built afterwards, innermost first as recursion would build them, so that
   * a long elif chain does not deepen the recursion.
   */
  private parseIf(): Stmt {
    const clauses: { kw: Token; test: Expr; body: Stmt[] }[] = [];
    let orelse: Stmt[] = [];
    for (;;) {
      const kw = this.next();
      const test = this.parseNamedExpr();
      const body = this.parseBlock(`'${kw.text}' statement`, kw);
      clauses.push({ kw, test, body });
      if (this.isKw('elif')) continue;
      if (this.isKw('else')) {
        const elseTok = this.next();
        orelse = this.parseBlock("'else' statement", elseTok);
      }
      break;
    }
    const end = this.lastEnd;
    for (let k = clauses.length - 1; k >= 0; k--) {
      const { kw, test, body } = clauses[k]!;
      orelse = [{ kind: 'If', id: this.id(), span: { start: kw.span.start, end }, test, body, orelse }];
    }
    return orelse[0]!;
  }

  private parseWhile(): Stmt {
    const kw = this.next();
    const start = kw.span.start;
    const test = this.parseNamedExpr();
    const body = this.parseBlock("'while' statement", kw);
    if (this.isKw('else')) this.unsupported('else clauses on loops', this.peek().span);
    return { kind: 'While', id: this.id(), span: this.span(start), test, body };
  }

  private parseFor(): Stmt {
    const kw = this.next();
    const start = kw.span.start;
    const tstart = this.peek().span.start;
    // Several loop targets separated by commas, of which one may be starred, are outside the language.
    const items: Expr[] = [];
    let stars = 0;
    let leadingStar: Token | null = null;
    let comma: Token | null = null;
    for (;;) {
      if (this.isOp('*')) {
        if (items.length === 0) leadingStar = this.peek();
        this.next();
        stars++;
      }
      items.push(this.parseBitOr());
      if (!this.isOp(',')) break;
      comma ??= this.peek();
      this.next();
      if (this.isKw('in')) break;
    }
    let target = items[0]!;
    if (stars > 0 && !comma) this.fail('starred assignment target must be in a list or tuple', leadingStar ?? this.peek());
    if (comma) {
      target = leadingStar
        ? this.outside('starred expressions', tstart, leadingStar.span)
        : this.outside('tuple packing and unpacking', tstart, comma.span, 'use a single loop variable');
      this.tupleItems.set(target.id, { items, stars });
    }
    this.checkAssignable(target, false);
    if (!this.isKw('in')) this.fail("expected 'in'", this.peek());
    this.next();
    const istart = this.peek().span.start;
    let iter = this.isOp('*') ? this.starredValue() : this.parseExpr();
    if (this.isOp(',')) iter = this.tupleRest(iter, istart, 'tuples', 'iterate over range(...)');
    const body = this.parseBlock("'for' statement", kw);
    if (this.isKw('else')) this.unsupported('else clauses on loops', this.peek().span);
    return { kind: 'For', id: this.id(), span: this.span(start), target, iter, body };
  }

  // ---- expressions ---------------------------------------------------------

  /**
   * Condition position of `if`, `while`, and a case guard, where Python also
   * allows an assignment expression NAME := expression. Assignment
   * expressions are outside the language; one is parsed completely first.
   */
  private parseNamedExpr(): Expr {
    const start = this.peek().span.start;
    const e = this.parseExpr();
    if (!this.isOp(':=')) return e;
    const op = this.next();
    // The target is a name that is not in parentheses.
    if (e.kind !== 'Name' || e.span.start.offset !== start.offset) {
      this.fail(`cannot use assignment expressions with ${e.kind === 'Constant' ? 'literal' : 'expression'}`, op);
    }
    if (e.name === '__debug__') this.fail('cannot assign to __debug__', op);
    const assignment = this.outside('assignment expressions', start, op.span);
    this.parseExpr();
    return assignment;
  }

  /**
   * expression: a disjunction, a conditional expression, or a lambda
   * expression. Conditional and lambda expressions are outside the language;
   * they are parsed completely first, so that incomplete text is reported as
   * a syntax error. The alternative of a conditional expression and the body
   * of a lambda expression are again expressions, parsed by the same loop.
   */
  parseExpr(): Expr {
    const start = this.peek().span.start;
    const scopes = this.scopes.length;
    let outside: { what: string; at: Span; hint?: string } | null = null;
    for (;;) {
      const t = this.peek();
      if (t.kind === 'name' && t.text === 'lambda') {
        outside ??= { what: 'lambda expressions', at: t.span };
        this.lambdaHeader();
        // The body of a lambda expression, which extends to the end of this expression, is a scope of its own.
        this.scopes.push({ kind: 'lambda' });
        continue;
      }
      const e = this.parseOr();
      if (!this.isKw('if')) {
        this.scopes.length = scopes;
        return outside ? this.outside(outside.what, start, outside.at, outside.hint) : e;
      }
      const ifTok = this.next();
      outside ??= { what: 'conditional expressions', at: ifTok.span, hint: 'use an if statement' };
      this.parseOr();
      if (!this.isKw('else')) this.fail("expected 'else' after 'if' expression", this.peek());
      this.next();
    }
  }

  /** Parameters of a lambda expression through the colon, with Python's rules for their order. */
  private lambdaHeader(): void {
    this.next();
    const names = new Set<string>();
    let positional = 0;
    let defaults = false;
    let slash = false;
    let star = false;
    let bareStar: Token | null = null;
    let keywordOnly = false;
    let kwargs = false;
    while (!this.isOp(':')) {
      const t = this.peek();
      if (kwargs) this.fail('arguments cannot follow var-keyword argument', t);
      if (this.isOp('/')) {
        if (positional === 0) this.fail('at least one argument must precede /', t);
        if (slash) this.fail('/ may appear only once', t);
        if (star) this.fail('/ must be ahead of *', t);
        slash = true;
        this.next();
      } else if (this.isOp('*') || this.isOp('**')) {
        if (t.text === '*' && star) this.fail('* argument may appear only once', t);
        this.next();
        if (t.text === '*' && (this.isOp(',') || this.isOp(':'))) bareStar = t;
        else {
          this.lambdaParam(names);
          if (this.isOp('=')) this.fail(`${t.text === '*' ? 'var-positional' : 'var-keyword'} argument cannot have default value`, this.peek());
        }
        if (t.text === '*') star = true;
        else kwargs = true;
      } else {
        if (this.isOp('(')) this.fail('Lambda expression parameters cannot be parenthesized', t);
        this.lambdaParam(names);
        if (this.isOp('=')) {
          this.next();
          this.enterOperand(t);
          this.parseExpr();
          this.nesting--;
          if (!star) defaults = true;
        } else if (defaults && !star) {
          this.fail('parameter without a default follows parameter with a default', t);
        }
        if (star) keywordOnly = true;
        else positional++;
      }
      if (this.isOp(',')) this.next();
      else if (!this.isOp(':')) this.fail('invalid syntax', this.peek());
    }
    if (bareStar && !keywordOnly) this.fail('named arguments must follow bare *', bareStar);
    this.next();
  }

  private lambdaParam(names: Set<string>): void {
    const t = this.peek();
    if (t.kind !== 'name' || KEYWORDS.has(t.text)) this.fail('invalid syntax', t);
    if (t.text === '__debug__') this.fail('cannot assign to __debug__', t);
    if (names.has(t.text)) this.fail(`duplicate argument '${t.text}' in function definition`, t);
    names.add(t.text);
    this.next();
  }

  private parseOr(): Expr {
    const start = this.peek().span.start;
    const first = this.parseAnd();
    if (!this.isKw('or')) return first;
    const values = [first];
    while (this.isKw('or')) {
      this.next();
      values.push(this.parseAnd());
    }
    return this.nested({ kind: 'BoolOp', id: this.id(), span: this.span(start), op: 'Or', values }, values);
  }

  private parseAnd(): Expr {
    const start = this.peek().span.start;
    const first = this.parseNot();
    if (!this.isKw('and')) return first;
    const values = [first];
    while (this.isKw('and')) {
      this.next();
      values.push(this.parseNot());
    }
    return this.nested({ kind: 'BoolOp', id: this.id(), span: this.span(start), op: 'And', values }, values);
  }

  private parseNot(): Expr {
    if (this.isKw('not')) {
      const kw = this.next();
      this.enterOperand(kw);
      const operand = this.parseNot();
      this.nesting--;
      return this.nested({ kind: 'UnaryOp', id: this.id(), span: this.span(kw.span.start), op: 'Not', operand }, [operand]);
    }
    return this.parseComparison();
  }

  private comparisonOp(): CmpOpKind | null {
    const t = this.peek();
    if (t.kind === 'op') {
      switch (t.text) {
        case '==': this.next(); return 'Eq';
        case '!=': this.next(); return 'NotEq';
        case '<': this.next(); return 'Lt';
        case '<=': this.next(); return 'LtE';
        case '>': this.next(); return 'Gt';
        case '>=': this.next(); return 'GtE';
        default: return null;
      }
    }
    if (t.kind === 'name') {
      if (t.text === 'in') {
        this.next();
        return 'In';
      }
      if (t.text === 'is') {
        this.next();
        if (this.isKw('not')) {
          this.next();
          return 'IsNot';
        }
        return 'Is';
      }
      if (t.text === 'not' && this.isKw('in', 1)) {
        this.next();
        this.next();
        return 'NotIn';
      }
    }
    return null;
  }

  private parseComparison(): Expr {
    const start = this.peek().span.start;
    const left = this.parseBinary(0);
    const ops: CmpOpKind[] = [];
    const comparators: Expr[] = [];
    for (;;) {
      const op = this.comparisonOp();
      if (op === null) break;
      ops.push(op);
      comparators.push(this.parseBinary(0));
    }
    if (ops.length === 0) return left;
    return this.nested({ kind: 'Compare', id: this.id(), span: this.span(start), left, ops, comparators }, [left, ...comparators]);
  }

  /** bitwise_or: every binary operator below the comparisons. */
  private parseBitOr(): Expr {
    return this.parseBinary(0);
  }

  /**
   * Binary operators of precedence `min` or higher, all left-associative, by
   * precedence climbing. The tree is the one that one function per precedence
   * level builds, with the nodes created in the same order, but a bracketed
   * operand costs one stack frame here instead of one per level.
   */
  private parseBinary(min: number): Expr {
    const start = this.peek().span.start;
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      const level = t.kind === 'op' ? BINARY_LEVEL[t.text] : undefined;
      if (level === undefined || level < min) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      left = this.nested({ kind: 'BinOp', id: this.id(), span: this.span(start), op: BINARY_OPS[t.text]!, left, right }, [left, right]);
    }
  }

  private parseFactor(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '~')) {
      this.next();
      this.enterOperand(t);
      const operand = this.parseFactor();
      this.nesting--;
      const op: UnaryOpKind = t.text === '-' ? 'USub' : t.text === '+' ? 'UAdd' : 'Invert';
      return this.nested({ kind: 'UnaryOp', id: this.id(), span: this.span(t.span.start), op, operand }, [operand]);
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    const start = this.peek().span.start;
    let base: Expr;
    if (this.isKw('await')) {
      // await_primary: 'await' primary. The scope rules do not depend on the operand, so they are applied
      // once the operand is known to begin.
      const kw = this.next();
      if (!this.startsPrimary()) this.fail('invalid syntax', this.peek());
      this.scopeUse({ kind: 'await', tok: kw });
      this.parsePrimary();
      base = this.outside('asynchronous code', start, kw.span);
    } else base = this.parsePrimary();
    if (this.isOp('**')) {
      const op = this.next();
      this.enterOperand(op);
      const exponent = this.parseFactor();
      this.nesting--;
      return this.nested({ kind: 'BinOp', id: this.id(), span: this.span(start), op: 'Pow', left: base, right: exponent }, [base, exponent]);
    }
    return base;
  }

  private parsePrimary(): Expr {
    const start = this.peek().span.start;
    let e = this.parseAtom();
    for (;;) {
      if (this.isOp('(')) {
        this.openBracket(this.next());
        const args: Expr[] = [];
        let hasKeywords = false;
        while (!this.isOp(')')) {
          const a = this.peek();
          const starred = a.kind === 'op' && (a.text === '*' || a.text === '**');
          const keyword = a.kind === 'name' && !KEYWORDS.has(a.text) && this.isOp('=', 1);
          if (starred) {
            hasKeywords = true;
            this.next();
          } else if (keyword) {
            if (a.text === '__debug__') this.fail('cannot assign to __debug__', a);
            hasKeywords = true;
            this.next();
            this.next();
          }
          this.openElement();
          args.push(this.parseExpr());
          if (this.isKw('for') || this.isKw('async')) {
            // A generator expression without its own parentheses must be the only argument.
            const at = this.peek();
            this.comprehension('generator', a);
            if (starred || keyword || args.length > 1 || !this.isOp(')')) this.fail('Generator expression must be parenthesized', at);
            args[args.length - 1] = this.outside('generator expressions', a.span.start, at.span);
          } else this.closeElement();
          if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
          if (this.isOp(',')) {
            this.next();
            continue;
          }
          if (!this.isOp(')')) this.fail('invalid syntax. Perhaps you forgot a comma?', this.peek());
        }
        this.next();
        this.brackets--;
        e = this.nested({ kind: 'Call', id: this.id(), span: this.span(start), func: e, args, hasKeywords }, [e, ...args]);
        continue;
      }
      if (this.isOp('[')) {
        const open = this.next();
        this.openBracket(open);
        if (this.isOp(':')) this.unsupported('slices', open.span, 'read one element at a time with an integer index');
        if (this.isOp(']')) this.fail('invalid syntax', this.peek());
        if (this.isOp('*')) this.unsupported('starred expressions', this.peek().span);
        const index = this.parseExpr();
        if (this.isOp(':')) this.unsupported('slices', this.peek().span, 'read one element at a time with an integer index');
        if (this.isOp(',')) this.unsupported('tuple subscripts', this.peek().span, 'arrays have one dimension');
        if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
        this.expectOp(']', undefined);
        this.brackets--;
        e = this.nested({ kind: 'Subscript', id: this.id(), span: this.span(start), value: e, index }, [e, index]);
        continue;
      }
      if (this.isOp('.')) {
        this.next();
        const nt = this.peek();
        if (nt.kind !== 'name' || KEYWORDS.has(nt.text)) this.fail('invalid syntax', nt);
        this.next();
        e = this.nested({ kind: 'UnsupportedExpr', id: this.id(), span: this.span(start), what: 'attribute access' }, [e]);
        continue;
      }
      return e;
    }
  }

  /**
   * The for and if clauses of a comprehension or generator expression, which
   * are outside the language: [async] for targets in disjunction
   * (if disjunction)*, repeated. The element before the clauses, which was
   * parsed in an element scope, and every part of the clauses except the
   * first iterable belong to the comprehension's own scope; the first
   * iterable is evaluated in the enclosing scope. The caller checks the
   * closing bracket.
   */
  private comprehension(of: ComprehensionKind, open: Token): void {
    const element = this.scopes.pop() as Extract<Scope, { kind: 'element' }>;
    const own: Extract<Scope, { kind: 'comprehension' }> = { kind: 'comprehension', of, coroutine: false, open };
    this.scopes.push(own);
    for (const use of element.uses) this.scopeUse(use);
    let first = true;
    while (this.isKw('for') || this.isKw('async')) {
      if (this.isKw('async')) {
        own.coroutine = true;
        this.next();
        if (!this.isKw('for')) this.fail('invalid syntax', this.peek());
      }
      this.next();
      // The targets are assignment targets: one starred target is allowed, in a tuple or list of targets.
      // The CPython compiler enforces both rules, so they do not hold inside an annotation.
      const compiled = !this.inAnnotation();
      let star: Token | null = null;
      let tuple = false;
      for (;;) {
        if (this.isOp('*')) {
          if (star && compiled) this.fail('multiple starred expressions in assignment', this.peek());
          star = this.next();
        }
        this.checkComprehensionTarget(this.parseBitOr());
        if (!this.isOp(',')) break;
        tuple = true;
        this.next();
        if (this.isKw('in')) break;
      }
      if (!this.isKw('in')) this.fail("'in' expected after for-loop variables", this.peek());
      if (star && !tuple && compiled) this.fail('starred assignment target must be in a list or tuple', star);
      this.next();
      if (first) {
        this.scopes.pop();
        this.parseOr();
        this.scopes.push(own);
        first = false;
      } else this.parseOr();
      while (this.isKw('if')) {
        this.next();
        this.parseOr();
      }
    }
    this.scopes.pop();
    // An asynchronous comprehension makes the enclosing scope asynchronous; a generator expression does not.
    if (of !== 'generator' && own.coroutine) this.scopeUse({ kind: 'async comprehension', tok: open });
  }

  /**
   * A dict or set display or comprehension, outside the language: items
   * key: value or **mapping, or items that are expressions or *iterable,
   * separated by commas, or one item followed by comprehension clauses. It is
   * parsed completely, so that the rest of the statement is still checked.
   */
  private dictOrSet(open: Token): Expr {
    const start = open.span.start;
    this.openBracket(this.next());
    let dict = false;
    if (!this.isOp('}')) {
      if (this.isOp('**') || this.isOp('*')) {
        const star = this.next();
        this.parseBitOr();
        if (this.isKw('for') || this.isKw('async')) {
          this.fail(star.text === '**' ? 'dict unpacking cannot be used in dict comprehension' : 'iterable unpacking cannot be used in comprehension', star);
        }
        dict = star.text === '**';
      } else {
        this.openElement();
        this.parseExpr();
        dict = this.isOp(':');
        if (dict) {
          this.next();
          this.parseExpr();
        } else if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
        if (this.isKw('for') || this.isKw('async')) {
          this.comprehension(dict ? 'dict' : 'set', open);
          this.expectOp('}', 'invalid syntax');
          this.brackets--;
          return this.outside('dictionaries and sets', start, open.span);
        }
        this.closeElement();
      }
      while (this.isOp(',')) {
        this.next();
        if (this.isOp('}')) break;
        if (this.isOp(dict ? '**' : '*')) {
          this.next();
          this.parseBitOr();
        } else if (dict) {
          this.parseExpr();
          this.expectOp(':', "':' expected after dictionary key");
          this.parseExpr();
        } else {
          this.parseExpr();
          if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
        }
      }
    }
    this.expectOp('}', 'invalid syntax');
    this.brackets--;
    return this.outside('dictionaries and sets', start, open.span);
  }

  /** A comprehension target is checked as an assignment target; a list of targets is valid there. */
  private checkComprehensionTarget(target: Expr): void {
    if (target.kind === 'List') target.elts.forEach((x) => this.checkComprehensionTarget(x));
    else this.checkAssignable(target, false);
  }

  private parseAtom(): Expr {
    const t = this.peek();
    const start = t.span.start;
    switch (t.kind) {
      case 'int':
        this.next();
        return { kind: 'Constant', id: this.id(), span: this.span(start), ctype: 'int', value: t.value ?? 0n, raw: t.text };
      case 'float':
        this.next();
        return { kind: 'Constant', id: this.id(), span: this.span(start), ctype: 'float', value: 0n, raw: t.text };
      case 'string': {
        this.next();
        while (this.peek().kind === 'string') this.next();
        return { kind: 'Constant', id: this.id(), span: this.span(start), ctype: 'str', value: 0n, raw: t.text };
      }
      case 'name': {
        if (t.text === 'True' || t.text === 'False') {
          this.next();
          return { kind: 'Constant', id: this.id(), span: this.span(start), ctype: 'bool', value: t.text === 'True' ? 1n : 0n, raw: t.text };
        }
        if (t.text === 'None') {
          this.next();
          return { kind: 'Constant', id: this.id(), span: this.span(start), ctype: 'none', value: 0n, raw: t.text };
        }
        // Python allows lambda and yield only where a whole expression begins, and await only before a primary.
        if (t.text === 'lambda' || t.text === 'yield' || t.text === 'await') this.fail('invalid syntax', t);
        if (KEYWORDS.has(t.text)) this.fail('invalid syntax', t);
        this.next();
        return { kind: 'Name', id: this.id(), span: this.span(start), name: t.text };
      }
      case 'op': {
        if (t.text === '(') {
          this.openBracket(t);
          this.next();
          if (this.isOp(')')) {
            // The empty tuple.
            this.next();
            this.brackets--;
            const empty = this.outside('tuples', start, this.span(start));
            this.tupleItems.set(empty.id, { items: [], stars: 0 });
            return empty;
          }
          if (this.isKw('yield')) {
            const value = this.yieldExpr();
            this.expectOp(')', undefined);
            this.brackets--;
            return value;
          }
          const items: Expr[] = [];
          let stars = 0;
          if (this.isOp('*')) {
            // A starred item is valid in a tuple, but not alone in parentheses or before comprehension clauses.
            const star = this.next();
            items.push(this.parseBitOr());
            stars++;
            if (this.isKw('for') || this.isKw('async')) this.fail('iterable unpacking cannot be used in comprehension', star);
            if (this.isOp(')')) this.fail('cannot use starred expression here', star);
            if (!this.isOp(',')) this.fail('invalid syntax', this.peek());
            this.outside('starred expressions', star.span.start, star.span);
          } else {
            this.openElement();
            const inner = this.parseExpr();
            if (this.isKw('for') || this.isKw('async')) {
              const at = this.peek();
              this.comprehension('generator', t);
              if (!this.isOp(')')) this.fail('invalid syntax', this.peek());
              this.next();
              this.brackets--;
              return this.outside('generator expressions', start, at.span);
            }
            this.closeElement();
            if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
            if (!this.isOp(',')) {
              this.expectOp(')', undefined);
              this.brackets--;
              return inner;
            }
            items.push(inner);
          }
          // A tuple, outside the language: the items after the first one are parsed completely.
          const comma = this.peek();
          while (this.isOp(',')) {
            this.next();
            if (this.isOp(')')) break;
            if (this.isOp('*')) {
              this.next();
              items.push(this.parseBitOr());
              stars++;
            } else {
              items.push(this.parseExpr());
              if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
            }
          }
          this.expectOp(')', undefined);
          this.brackets--;
          const tuple = this.outside('tuples', start, comma.span);
          this.tupleItems.set(tuple.id, { items, stars });
          return tuple;
        }
        if (t.text === '[') {
          this.openBracket(t);
          this.next();
          const elts: Expr[] = [];
          while (!this.isOp(']')) {
            if (this.isOp('*')) {
              const star = this.next();
              this.parseBitOr();
              if (this.isKw('for') || this.isKw('async')) this.fail('iterable unpacking cannot be used in comprehension', star);
              if (!this.isOp(',') && !this.isOp(']')) this.fail('invalid syntax', this.peek());
              this.unsupported('starred expressions', star.span);
            }
            this.openElement();
            elts.push(this.parseExpr());
            if (this.isKw('for') || this.isKw('async')) {
              // Only the first element can be followed by comprehension clauses.
              const at = this.peek();
              if (elts.length > 1) this.fail('did you forget parentheses around the comprehension target?', at);
              this.comprehension('list', t);
              if (!this.isOp(']')) this.fail('invalid syntax', this.peek());
              this.next();
              this.brackets--;
              return this.outside('list comprehensions', start, at.span, 'fill the array with a loop');
            }
            this.closeElement();
            if (this.isOp(':=')) this.unsupported('assignment expressions', this.peek().span);
            if (this.isOp(',')) {
              this.next();
              continue;
            }
            if (!this.isOp(']')) this.fail('invalid syntax. Perhaps you forgot a comma?', this.peek());
          }
          this.next();
          this.brackets--;
          return this.nested({ kind: 'List', id: this.id(), span: this.span(start), elts }, elts);
        }
        if (t.text === '{') return this.dictOrSet(t);
        if (t.text === '...') {
          this.next();
          return { kind: 'Constant', id: this.id(), span: this.span(start), ctype: 'ellipsis', value: 0n, raw: t.text };
        }
        break;
      }
      default:
        break;
    }
    this.fail('invalid syntax', t);
  }
}

/** Parse Python source text into a tree, reporting every diagnostic found. */
export function parse(source: string): ParseResult {
  const lexed = tokenize(source);
  const parser = new Parser(lexed.tokens);
  const module = parser.parseModule();
  // The parser stops at bracket nesting that the tokenizer has already reported; the report is kept once.
  const key = (d: Diagnostic): string => `${d.span?.start.offset}:${d.message}`;
  const lexical = new Set(lexed.diagnostics.map(key));
  const diagnostics = [...lexed.diagnostics, ...parser.diagnostics.filter((d) => !lexical.has(key(d)))];
  diagnostics.sort((a, b) => (a.span?.start.offset ?? 0) - (b.span?.start.offset ?? 0));
  return { module, diagnostics, tokens: lexed.tokens, nodeCount: parser.nodeCount };
}
