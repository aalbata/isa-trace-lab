/** Source positions and diagnostics shared by every stage of the pipeline. */

export interface Pos {
  /** One-based line number. */
  line: number;
  /** Zero-based column in UTF-16 code units. */
  col: number;
  /** Zero-based offset from the start of the source text. */
  offset: number;
}

/** Half-open source range; `end` is the position after the last character. */
export interface Span {
  start: Pos;
  end: Pos;
}

export type Severity = 'error' | 'warning' | 'info';

/**
 * Diagnostic categories.
 *  - syntax: the text is not valid Python. CPython rejects every text that is
 *    reported with this category, so valid Python is never reported as a
 *    syntax error.
 *  - unsupported: a Python construct outside the restricted source language
 *    was recognized. The rest of that construct is not necessarily checked,
 *    so the text can also contain errors that CPython would report
 *    (docs/language.md, section 9). A program of the source language is
 *    reported with neither of these two categories.
 *  - semantic: type, initialization, and range rules of the source language.
 *  - limit: an implementation limit of the compiler or execution environment.
 */
export type DiagnosticCategory = 'syntax' | 'unsupported' | 'semantic' | 'limit' | 'internal';

export interface Diagnostic {
  severity: Severity;
  category: DiagnosticCategory;
  /** Stable machine-readable code such as "unsupported-operator". */
  code: string;
  message: string;
  span?: Span;
  /** Optional explanation of how to rewrite the construct. */
  hint?: string;
}

export function spanOf(start: Pos, end: Pos): Span {
  return { start, end };
}

export function formatSpan(span: Span | undefined): string {
  if (!span) return '';
  return `${span.start.line}:${span.start.col + 1}`;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.span ? `line ${d.span.start.line}, column ${d.span.start.col + 1}: ` : '';
  const hint = d.hint ? ` (${d.hint})` : '';
  return `${d.severity} [${d.code}] ${where}${d.message}${hint}`;
}

export function hasErrors(diags: readonly Diagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}
