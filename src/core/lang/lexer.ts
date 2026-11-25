/**
 * Tokenizer for Python source text.
 *
 * The tokenizer follows the lexical rules of Python 3 that matter for the
 * restricted source language: logical lines, INDENT and DEDENT from an
 * indentation stack, implicit line joining inside brackets, explicit joining
 * with a backslash, comments, integer literals in four bases, and the complete
 * operator set. Floating-point, imaginary, and string literals are recognized
 * so that the parser can report them as unsupported instead of as malformed;
 * this includes f-strings and t-strings, whose replacement fields can hold
 * quotes and line breaks. An identifier with characters outside ASCII is valid
 * Python and is reported as unsupported.
 * CPython's tokenizer limits also apply: NUL characters are rejected anywhere,
 * brackets nest at most 200 deep, and blocks at most 99 indentation levels.
 */
import type { Diagnostic, Pos, Span } from '../util/diag.ts';

export type TokenKind = 'name' | 'int' | 'float' | 'string' | 'op' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  span: Span;
  /** Exact value of an integer literal. */
  value?: bigint;
}

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

const OPERATORS = [
  '**=', '//=', '>>=', '<<=', '...',
  '!=', '==', '<=', '>=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', ':=', '**', '//', '<<', '>>',
  '+', '-', '*', '/', '%', '@', '&', '|', '^', '~', '<', '>', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '=',
];

const STRING_PREFIXES = new Set(['r', 'u', 'b', 'f', 't', 'br', 'rb', 'fr', 'rf', 'tr', 'rt']);
const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Brackets that may be open at once; CPython's tokenizer rejects deeper nesting. */
export const MAX_NESTED_BRACKETS = 200;
/** Indentation levels above the first column; CPython's tokenizer rejects deeper blocks. */
export const MAX_INDENT_LEVELS = 99;
/** f-strings and t-strings that may lie inside one another; CPython's tokenizer rejects deeper nesting. */
const MAX_NESTED_INTERPOLATED = 149;
/** Format specifications that may lie inside one another through the fields that they hold. */
const MAX_FORMAT_SPEC_NESTING = 2;
/** Keywords before which CPython ends a numeric literal with a warning instead of rejecting it. */
const KEYWORDS_AFTER_NUMBER = ['and', 'else', 'for', 'or', 'not'];
/**
 * Characters outside ASCII that can begin and that can continue a Python
 * identifier. A code point that the Unicode version of the JavaScript engine
 * does not know is taken as one, since a later version can define it as a
 * letter.
 */
const IDENTIFIER_START = /^[\p{XID_Start}\p{Cn}]$/u;
const IDENTIFIER_PART = /^[\p{XID_Continue}\p{Cn}]$/u;

function isNameStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isNameChar(c: string): boolean {
  return isNameStart(c) || isDigit(c);
}

export function tokenize(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 0;
  let atLineStart = true;
  const indents: { col: number; alt: number }[] = [{ col: 0, alt: 0 }];
  const brackets: { ch: string; pos: Pos }[] = [];

  const pos = (): Pos => ({ line, col, offset: i });
  const error = (message: string, span: Span, code = 'syntax-error'): void => {
    diagnostics.push({ severity: 'error', category: 'syntax', code, message, span });
  };
  const isNewlineAt = (k: number): boolean => source[k] === '\n' || source[k] === '\r';
  /** Consume one line terminator, treating CR LF as a single terminator. */
  const consumeNewline = (): void => {
    if (source[i] === '\r' && source[i + 1] === '\n') i += 2;
    else i += 1;
    line += 1;
    col = 0;
  };
  const advance = (count: number): void => {
    i += count;
    col += count;
  };
  const push = (kind: TokenKind, text: string, start: Pos, value?: bigint): void => {
    const tok: Token = { kind, text, span: { start, end: pos() } };
    if (value !== undefined) tok.value = value;
    tokens.push(tok);
  };
  /** f-strings and t-strings around the string literal being scanned. */
  let interpolatedDepth = 0;
  /** Nesting limits already reported for the string token being scanned; each is reported once per token. */
  let nestingReported = false;
  let specNestingReported = false;
  let nulReported = false;
  /** CPython rejects source text that contains a NUL character anywhere, including comments and strings. */
  const nul = (): void => {
    if (nulReported) return;
    nulReported = true;
    error('source code cannot contain null bytes', { start: pos(), end: { line, col: col + 1, offset: i + 1 } });
  };
  /** Skip the rest of a comment. */
  const skipComment = (): void => {
    while (i < n && !isNewlineAt(i)) {
      if (source[i] === '\u0000') nul();
      advance(1);
    }
  };
  /**
   * Bounds of the last run of identifier characters that ended at a character which cannot continue
   * an identifier. No position inside the run begins a valid identifier, since a character that
   * cannot continue an identifier cannot begin one either, so the run is scanned once.
   */
  let rejectedFrom = 0;
  let rejectedAt = -1;
  /**
   * Length in code units of the identifier at position `from` when it has characters outside ASCII
   * and is a valid Python identifier, and 0 otherwise. CPython takes every character outside ASCII
   * as part of an identifier token and then requires that the first character can begin an
   * identifier and that the others can continue one.
   */
  const nonAsciiIdentifier = (from: number): number => {
    if (from >= rejectedFrom && from <= rejectedAt) return 0;
    let j = from;
    while (j < n) {
      const cp = source.codePointAt(j)!;
      if (cp < 0x80) {
        if (!isNameChar(source[j]!)) break;
        j++;
      } else {
        const character = String.fromCodePoint(cp);
        if (!(j === from ? IDENTIFIER_START : IDENTIFIER_PART).test(character)) {
          if (j > from) {
            rejectedFrom = from;
            rejectedAt = j;
          }
          return 0;
        }
        j += character.length;
      }
    }
    return j - from;
  };
  /**
   * True when a keyword follows the end of a numeric literal at the current position. CPython
   * then ends the literal before the keyword: `1if` is `1 if`. The two-letter keywords `if`,
   * `in`, and `is` are recognized from their first two characters, as CPython does.
   */
  const keywordFollows = (): boolean => {
    if (source[i] === 'i') return source[i + 1] === 'f' || source[i + 1] === 'n' || source[i + 1] === 's';
    return KEYWORDS_AFTER_NUMBER.some((kw) => source.startsWith(kw, i) && !isNameChar(source[i + kw.length] ?? ''));
  };

  const lexNumber = (): void => {
    const start = pos();
    const begin = i;
    let kind: TokenKind = 'int';
    let malformed: string | null = null;
    const digitsWithUnderscores = (ok: (c: string) => boolean): number => {
      let count = 0;
      for (;;) {
        if (i < n && ok(source[i]!)) {
          advance(1);
          count++;
        } else if (source[i] === '_' && i + 1 < n && ok(source[i + 1]!)) {
          advance(2);
          count++;
        } else break;
      }
      return count;
    };
    const c0 = source[i]!;
    const c1 = (source[i + 1] ?? '').toLowerCase();
    if (c0 === '0' && (c1 === 'x' || c1 === 'o' || c1 === 'b')) {
      advance(2);
      const ok =
        c1 === 'x'
          ? (c: string) => isDigit(c) || (c.toLowerCase() >= 'a' && c.toLowerCase() <= 'f')
          : c1 === 'o'
            ? (c: string) => c >= '0' && c <= '7'
            : (c: string) => c === '0' || c === '1';
      const count = digitsWithUnderscores(ok);
      const base = c1 === 'x' ? 'hexadecimal' : c1 === 'o' ? 'octal' : 'binary';
      // A dot ends the literal, as any character that is not part of a name does: 0x1.real is an attribute of 0x1.
      if (count === 0) malformed = `invalid ${base} literal`;
      else if (i < n && isNameChar(source[i]!) && !keywordFollows()) {
        while (i < n && isNameChar(source[i]!)) advance(1);
        malformed = `invalid digit in ${base} literal`;
      }
    } else {
      if (c0 !== '.') digitsWithUnderscores(isDigit);
      // A fraction, an exponent, or an imaginary suffix makes the literal non-integer.
      if (source[i] === '.' && !(source[i + 1] === '.' && source[i + 2] === '.')) {
        kind = 'float';
        advance(1);
        digitsWithUnderscores(isDigit);
      }
      if (source[i] === 'e' || source[i] === 'E') {
        const signed = source[i + 1] === '+' || source[i + 1] === '-';
        const d = source[i + (signed ? 2 : 1)];
        if (d !== undefined && isDigit(d)) {
          kind = 'float';
          advance(signed ? 2 : 1);
          digitsWithUnderscores(isDigit);
        }
      }
      if (source[i] === 'j' || source[i] === 'J') {
        kind = 'float';
        advance(1);
      }
      if (i < n && isNameChar(source[i]!) && !keywordFollows()) {
        while (i < n && isNameChar(source[i]!)) advance(1);
        malformed = 'invalid decimal literal';
      }
    }
    const text = source.slice(begin, i);
    if (malformed) {
      error(malformed, { start, end: pos() });
      push('int', text, start, 0n);
      return;
    }
    if (kind === 'float') {
      push('float', text, start);
      return;
    }
    const plain = text.replace(/_/g, '');
    if (/^0[0-9]/.test(plain) && /[1-9]/.test(plain)) {
      error('leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers', {
        start,
        end: pos(),
      });
      push('int', text, start, 0n);
      return;
    }
    push('int', text, start, BigInt(plain));
  };

  /**
   * Scan a string literal from its opening quote at the current position
   * through its closing quote; `prefix` holds its prefix letters in lower
   * case. In an f-string or t-string the replacement fields are delimited as
   * CPython's tokenizer delimits them since Python 3.12: a field can contain
   * brackets, comments, line breaks, and string literals with any quotes, and
   * a colon outside brackets begins a format specification, which can contain
   * further fields. CPython's limits on nesting apply, which also bound the
   * recursion here. Returns false when the literal is not closed.
   */
  const scanString = (prefix: string): boolean => {
    const quote = source[i]!;
    const triple = source[i + 1] === quote && source[i + 2] === quote;
    const kind = prefix.includes('t') ? 't-string' : 'f-string';
    let interpolated = prefix.includes('f') || prefix.includes('t');
    if (interpolated && interpolatedDepth >= MAX_NESTED_INTERPOLATED) {
      // Beyond the limit the text is not Python; the literal is scanned as a plain one.
      if (!nestingReported) error('too many nested f-strings or t-strings', { start: pos(), end: { line, col: col + 1, offset: i + 1 } });
      nestingReported = true;
      interpolated = false;
    }
    const raw = prefix.includes('r');
    advance(triple ? 3 : 1);
    const atClosingQuote = (): boolean => source[i] === quote && (!triple || (source[i + 1] === quote && source[i + 2] === quote));
    /**
     * Skip a backslash and the character that it escapes. In an f-string or
     * t-string a backslash does not escape a brace, and \N{name} is one escape.
     */
    const escape = (): void => {
      advance(1);
      if (i >= n) return;
      if (isNewlineAt(i)) {
        consumeNewline();
        return;
      }
      if (interpolated && (source[i] === '{' || source[i] === '}')) return;
      if (source[i] === '\u0000') nul();
      if (interpolated && !raw && source[i] === 'N' && source[i + 1] === '{') {
        while (i < n && source[i] !== '}' && !isNewlineAt(i) && !atClosingQuote()) advance(1);
        if (source[i] !== '}') return;
      }
      advance(1);
    };
    /**
     * Scan a format specification from after its colon through the brace that
     * closes its field; `level` counts the format specifications around it.
     * Once a field inside the specification has closed, CPython reads the rest
     * of the specification as it reads the text of the string, where the
     * doubled brace {{ is literal text.
     */
    const formatSpec = (level: number): boolean => {
      let fieldClosed = false;
      for (;;) {
        if (i >= n) return false;
        const c = source[i]!;
        if (c === '\u0000') nul();
        if (c === '\\') escape();
        else if (isNewlineAt(i)) {
          if (!triple) return false;
          consumeNewline();
        } else if (atClosingQuote()) return true;
        else if (c === '{' && fieldClosed && source[i + 1] === '{') advance(2);
        else if (c === '{' && level < MAX_FORMAT_SPEC_NESTING) {
          advance(1);
          if (!field(level + 1)) return false;
          fieldClosed = true;
        } else {
          if (c === '{' && !specNestingReported) {
            specNestingReported = true;
            error(`${kind}: expressions nested too deeply`, { start: pos(), end: { line, col: col + 1, offset: i + 1 } });
          }
          advance(1);
          if (c === '}') return true;
        }
      }
    };
    /**
     * Scan a replacement field from after its opening brace through its
     * closing brace; `level` counts the format specifications around it.
     */
    const field = (level: number): boolean => {
      let depth = 0;
      for (;;) {
        if (i >= n) return false;
        const c = source[i]!;
        if (c === '\u0000') nul();
        if (isNewlineAt(i)) consumeNewline();
        else if (c === '#') skipComment();
        else if (c === '"' || c === "'") {
          if (!scanString('')) return false;
        } else if (isNameStart(c)) {
          let j = i;
          while (j < n && isNameChar(source[j]!)) j++;
          const word = source.slice(i, j).toLowerCase();
          advance(j - i);
          if ((source[i] === '"' || source[i] === "'") && STRING_PREFIXES.has(word) && !scanString(word)) return false;
        } else if (c === '}' && depth === 0) {
          advance(1);
          return true;
        } else if (c === ':' && depth === 0) {
          advance(1);
          return formatSpec(level);
        } else {
          if (c === '(' || c === '[' || c === '{') depth++;
          else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
          advance(1);
        }
      }
    };
    const body = (): boolean => {
      for (;;) {
        if (i >= n) return false;
        const c = source[i]!;
        if (c === '\u0000') nul();
        if (c === '\\') escape();
        else if (isNewlineAt(i)) {
          if (!triple) return false;
          consumeNewline();
        } else if (atClosingQuote()) {
          advance(triple ? 3 : 1);
          return true;
        } else if (interpolated && c === '{' && source[i + 1] !== '{') {
          advance(1);
          if (!field(0)) return false;
        } else {
          // Any other character. The doubled brace {{ is skipped whole, so that its second brace begins no field.
          advance(interpolated && c === '{' ? 2 : 1);
        }
      }
    };
    if (interpolated) interpolatedDepth++;
    const closed = body();
    if (interpolated) interpolatedDepth--;
    return closed;
  };

  const lexString = (start: Pos): void => {
    // The caller has consumed any prefix letters; source[i] is the opening quote.
    const begin = start.offset;
    const triple = source[i + 1] === source[i] && source[i + 2] === source[i];
    nestingReported = false;
    specNestingReported = false;
    if (!scanString(source.slice(begin, i).toLowerCase())) {
      error(triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal', {
        start,
        end: pos(),
      });
    }
    push('string', source.slice(begin, i), start);
  };

  for (;;) {
    if (atLineStart && brackets.length === 0) {
      // Measure the indentation of the next logical line.
      // A backslash at the end of a line joins the next line to the indentation, as in CPython: the
      // count goes on over the joined lines, and the column of the first such backslash, when it is
      // not the first column, is the indentation of the logical line.
      let c = 0;
      let alt = 0;
      let joinedAt = 0;
      for (;;) {
        const ch = source[i];
        if (ch === ' ') {
          c++;
          alt++;
        } else if (ch === '\t') {
          c = (Math.floor(c / 8) + 1) * 8;
          alt++;
        } else if (ch === '\f') {
          c = 0;
          alt = 0;
        } else if (ch === '\\' && (i + 1 >= n || isNewlineAt(i + 1))) {
          if (joinedAt === 0) joinedAt = c;
          const start = pos();
          advance(1);
          if (i < n) consumeNewline();
          // A continuation must be followed by another line; CPython reads the end of input as an error.
          if (i >= n) error('unexpected EOF while parsing', { start, end: pos() });
          continue;
        } else break;
        advance(1);
      }
      const ch = source[i];
      if (ch === undefined || ch === '\n' || ch === '\r' || ch === '#') {
        // Blank and comment-only lines produce no tokens.
        skipComment();
        if (i >= n) break;
        consumeNewline();
        continue;
      }
      if (joinedAt > 0) {
        c = joinedAt;
        alt = joinedAt;
      }
      const top = indents[indents.length - 1]!;
      const here = pos();
      const zero: Span = { start: { line, col: 0, offset: i - col }, end: here };
      if (c === top.col) {
        if (alt !== top.alt) error('inconsistent use of tabs and spaces in indentation', zero, 'tab-error');
      } else if (c > top.col) {
        if (alt <= top.alt) error('inconsistent use of tabs and spaces in indentation', zero, 'tab-error');
        if (indents.length > MAX_INDENT_LEVELS) error('too many levels of indentation', zero, 'indentation-error');
        indents.push({ col: c, alt });
        tokens.push({ kind: 'indent', text: '', span: zero });
      } else {
        while (indents.length > 1 && c < indents[indents.length - 1]!.col) {
          indents.pop();
          tokens.push({ kind: 'dedent', text: '', span: { start: here, end: here } });
        }
        const now = indents[indents.length - 1]!;
        if (c !== now.col) {
          error('unindent does not match any outer indentation level', zero, 'indentation-error');
          // Recover by treating the line as belonging to the enclosing level.
        } else if (alt !== now.alt) {
          error('inconsistent use of tabs and spaces in indentation', zero, 'tab-error');
        }
      }
      atLineStart = false;
    }

    while (i < n && (source[i] === ' ' || source[i] === '\t' || source[i] === '\f')) advance(1);
    if (i >= n) break;
    const ch = source[i]!;

    if (ch === '#') {
      skipComment();
      continue;
    }
    if (isNewlineAt(i)) {
      if (brackets.length > 0) {
        consumeNewline();
        continue;
      }
      const start = pos();
      consumeNewline();
      tokens.push({ kind: 'newline', text: '\n', span: { start, end: { line: start.line, col: start.col + 1, offset: start.offset + 1 } } });
      atLineStart = true;
      continue;
    }
    if (ch === '\\') {
      const start = pos();
      advance(1);
      if (i >= n || isNewlineAt(i)) {
        if (i < n) consumeNewline();
        // A continuation must be followed by another line; CPython reads the end of input as an error.
        if (i >= n) error('unexpected EOF while parsing', { start, end: pos() });
        continue;
      }
      error('unexpected character after line continuation character', { start, end: pos() });
      continue;
    }
    if (isNameStart(ch) || ch >= '\u0080') {
      const start = pos();
      let j = i;
      while (j < n && isNameChar(source[j]!)) j++;
      // An identifier with characters outside ASCII is valid Python that the language does not include.
      const length = j < n && source[j]! >= '\u0080' ? nonAsciiIdentifier(i) : 0;
      if (length > 0) {
        advance(length);
        diagnostics.push({
          severity: 'error',
          category: 'unsupported',
          code: 'unsupported-construct',
          message: 'identifiers with characters outside ASCII are not part of the source language',
          span: { start, end: pos() },
          hint: 'identifiers use ASCII letters, digits, and underscores',
        });
        push('name', source.slice(start.offset, i), start);
        continue;
      }
      if (j > i) {
        const word = source.slice(i, j);
        const q = source[j];
        if ((q === '"' || q === "'") && STRING_PREFIXES.has(word.toLowerCase())) {
          advance(j - i);
          lexString(start);
          continue;
        }
        advance(j - i);
        push('name', word, start);
        continue;
      }
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      lexNumber();
      continue;
    }
    if (ch === '"' || ch === "'") {
      lexString(pos());
      continue;
    }
    let matched: string | null = null;
    for (const op of OPERATORS) {
      if (source.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      const start = pos();
      advance(matched.length);
      if (matched === '(' || matched === '[' || matched === '{') {
        // Reported once, at the first bracket beyond the limit.
        if (brackets.length === MAX_NESTED_BRACKETS) error('too many nested parentheses', { start, end: pos() });
        brackets.push({ ch: matched, pos: start });
      } else if (matched === ')' || matched === ']' || matched === '}') {
        const open = brackets.pop();
        if (!open) {
          error(`unmatched '${matched}'`, { start, end: pos() });
        } else if (CLOSER[open.ch] !== matched) {
          error(`closing parenthesis '${matched}' does not match opening parenthesis '${open.ch}'`, { start, end: pos() });
        }
      }
      push('op', matched, start);
      continue;
    }
    if (ch === '\u0000') {
      nul();
      advance(1);
      continue;
    }
    {
      const start = pos();
      const cp = source.codePointAt(i)!;
      const len = cp > 0xffff ? 2 : 1;
      advance(len);
      const shown = cp < 0x80 ? `'${String.fromCodePoint(cp)}'` : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      error(
        cp < 0x80
          ? `invalid character ${shown}`
          : `invalid character ${shown}; identifiers are limited to ASCII letters, digits, and underscores`,
        { start, end: pos() },
        'invalid-character',
      );
    }
  }

  // End of input: close an open logical line, report unclosed brackets, unwind the indentation.
  const end = pos();
  if (brackets.length > 0) {
    const open = brackets[brackets.length - 1]!;
    error(`'${open.ch}' was never closed`, {
      start: open.pos,
      end: { line: open.pos.line, col: open.pos.col + 1, offset: open.pos.offset + 1 },
    });
  }
  const last = tokens[tokens.length - 1];
  if (last && last.kind !== 'newline' && last.kind !== 'indent' && last.kind !== 'dedent') {
    tokens.push({ kind: 'newline', text: '', span: { start: end, end } });
  }
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ kind: 'dedent', text: '', span: { start: end, end } });
  }
  tokens.push({ kind: 'eof', text: '', span: { start: end, end } });
  return { tokens, diagnostics };
}
