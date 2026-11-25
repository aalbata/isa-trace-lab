/**
 * Abstract syntax tree of the source language.
 *
 * Node kinds and field names follow the classes of CPython's `ast` module so
 * that the tree can be compared directly with the tree CPython produces for
 * the same text. Every node carries a stable identifier (assigned in parse
 * order) and the source range that CPython reports for it.
 */
import type { Span } from '../util/diag.ts';

interface NodeBase {
  id: number;
  span: Span;
}

export type BinOpKind =
  | 'Add' | 'Sub' | 'Mult' | 'Div' | 'FloorDiv' | 'Mod' | 'Pow' | 'MatMult'
  | 'LShift' | 'RShift' | 'BitOr' | 'BitXor' | 'BitAnd';
export type UnaryOpKind = 'USub' | 'UAdd' | 'Invert' | 'Not';
export type BoolOpKind = 'And' | 'Or';
export type CmpOpKind = 'Eq' | 'NotEq' | 'Lt' | 'LtE' | 'Gt' | 'GtE' | 'Is' | 'IsNot' | 'In' | 'NotIn';

export interface Constant extends NodeBase {
  kind: 'Constant';
  /** Category of the literal; only `int` and `bool` belong to the source language. */
  ctype: 'int' | 'bool' | 'none' | 'float' | 'str' | 'ellipsis';
  /** Exact value for integers, 0n or 1n for booleans, 0n otherwise. */
  value: bigint;
  raw: string;
}
export interface Name extends NodeBase {
  kind: 'Name';
  name: string;
}
export interface UnaryOp extends NodeBase {
  kind: 'UnaryOp';
  op: UnaryOpKind;
  operand: Expr;
}
export interface BinOp extends NodeBase {
  kind: 'BinOp';
  op: BinOpKind;
  left: Expr;
  right: Expr;
}
export interface BoolOp extends NodeBase {
  kind: 'BoolOp';
  op: BoolOpKind;
  values: Expr[];
}
export interface Compare extends NodeBase {
  kind: 'Compare';
  left: Expr;
  ops: CmpOpKind[];
  comparators: Expr[];
}
export interface Call extends NodeBase {
  kind: 'Call';
  func: Expr;
  args: Expr[];
  /** True when the call uses keyword, starred, or double-starred arguments. */
  hasKeywords: boolean;
}
export interface Subscript extends NodeBase {
  kind: 'Subscript';
  value: Expr;
  index: Expr;
}
export interface ListExpr extends NodeBase {
  kind: 'List';
  elts: Expr[];
}
/** Valid Python expression forms that the source language does not include. */
export interface UnsupportedExpr extends NodeBase {
  kind: 'UnsupportedExpr';
  what: string;
}

export type Expr = Constant | Name | UnaryOp | BinOp | BoolOp | Compare | Call | Subscript | ListExpr | UnsupportedExpr;

export interface Param {
  name: string;
  span: Span;
}
export interface FunctionDef extends NodeBase {
  kind: 'FunctionDef';
  name: string;
  nameSpan: Span;
  params: Param[];
  body: Stmt[];
}
export interface Assign extends NodeBase {
  kind: 'Assign';
  target: Expr;
  value: Expr;
}
export interface AugAssign extends NodeBase {
  kind: 'AugAssign';
  target: Expr;
  op: BinOpKind;
  value: Expr;
}
export interface If extends NodeBase {
  kind: 'If';
  test: Expr;
  body: Stmt[];
  orelse: Stmt[];
}
export interface While extends NodeBase {
  kind: 'While';
  test: Expr;
  body: Stmt[];
}
export interface For extends NodeBase {
  kind: 'For';
  target: Expr;
  iter: Expr;
  body: Stmt[];
}
export interface Return extends NodeBase {
  kind: 'Return';
  value: Expr | null;
}
export interface ExprStmt extends NodeBase {
  kind: 'Expr';
  value: Expr;
}
export interface Pass extends NodeBase {
  kind: 'Pass';
}
export interface Break extends NodeBase {
  kind: 'Break';
}
export interface Continue extends NodeBase {
  kind: 'Continue';
}
/** Valid Python statement forms that the source language does not include. */
export interface UnsupportedStmt extends NodeBase {
  kind: 'UnsupportedStmt';
  what: string;
}

export type Stmt =
  | FunctionDef | Assign | AugAssign | If | While | For | Return | ExprStmt | Pass | Break | Continue | UnsupportedStmt;

export interface Module extends NodeBase {
  kind: 'Module';
  body: Stmt[];
}

export type Node = Module | Stmt | Expr;

const BINOP_SYMBOL: Record<BinOpKind, string> = {
  Add: '+', Sub: '-', Mult: '*', Div: '/', FloorDiv: '//', Mod: '%', Pow: '**', MatMult: '@',
  LShift: '<<', RShift: '>>', BitOr: '|', BitXor: '^', BitAnd: '&',
};
const CMPOP_SYMBOL: Record<CmpOpKind, string> = {
  Eq: '==', NotEq: '!=', Lt: '<', LtE: '<=', Gt: '>', GtE: '>=', Is: 'is', IsNot: 'is not', In: 'in', NotIn: 'not in',
};

export function binOpSymbol(op: BinOpKind): string {
  return BINOP_SYMBOL[op];
}

export function cmpOpSymbol(op: CmpOpKind): string {
  return CMPOP_SYMBOL[op];
}

function where(node: NodeBase): string {
  const s = node.span;
  return `@${s.start.line}:${s.start.col}-${s.end.line}:${s.end.col}`;
}

/**
 * Canonical one-line dump of a tree, including the source range of every node.
 * The Python code `DUMP_PY` in `tests/syntax-cpython.test.ts` prints the same
 * format from CPython's tree, so equality of the two strings is the
 * differential parser check.
 */
export function dumpAst(node: Node): string {
  const list = (items: readonly Node[]): string => '[' + items.map(dumpAst).join(',') + ']';
  switch (node.kind) {
    case 'Module':
      return `Module(${list(node.body)})`;
    case 'FunctionDef':
      return `FunctionDef${where(node)}(${node.name},[${node.params.map((p) => p.name).join(',')}],${list(node.body)})`;
    case 'Assign':
      return `Assign${where(node)}(${dumpAst(node.target)},${dumpAst(node.value)})`;
    case 'AugAssign':
      return `AugAssign${where(node)}(${dumpAst(node.target)},${node.op},${dumpAst(node.value)})`;
    case 'If': {
      // An elif chain nests each clause in the else branch of the one before; it is dumped in a loop.
      let head = '';
      let nested = 0;
      let clause = node;
      for (;;) {
        head += `If${where(clause)}(${dumpAst(clause.test)},${list(clause.body)},`;
        const next = clause.orelse.length === 1 ? clause.orelse[0]! : null;
        if (next?.kind !== 'If') return `${head}${list(clause.orelse)})${'])'.repeat(nested)}`;
        head += '[';
        nested++;
        clause = next;
      }
    }
    case 'While':
      return `While${where(node)}(${dumpAst(node.test)},${list(node.body)})`;
    case 'For':
      return `For${where(node)}(${dumpAst(node.target)},${dumpAst(node.iter)},${list(node.body)})`;
    case 'Return':
      return `Return${where(node)}(${node.value ? dumpAst(node.value) : ''})`;
    case 'Expr':
      return `Expr${where(node)}(${dumpAst(node.value)})`;
    case 'Pass':
      return `Pass${where(node)}`;
    case 'Break':
      return `Break${where(node)}`;
    case 'Continue':
      return `Continue${where(node)}`;
    case 'UnsupportedStmt':
      return `Unsupported${where(node)}`;
    case 'Constant':
      return node.ctype === 'int'
        ? `Constant${where(node)}(${node.value})`
        : node.ctype === 'bool'
          ? `Constant${where(node)}(${node.value === 1n ? 'True' : 'False'})`
          : `Constant${where(node)}(<${node.ctype}>)`;
    case 'Name':
      return `Name${where(node)}(${node.name})`;
    case 'UnaryOp':
      return `UnaryOp${where(node)}(${node.op},${dumpAst(node.operand)})`;
    case 'BinOp':
      return `BinOp${where(node)}(${dumpAst(node.left)},${node.op},${dumpAst(node.right)})`;
    case 'BoolOp':
      return `BoolOp${where(node)}(${node.op},${list(node.values)})`;
    case 'Compare':
      return `Compare${where(node)}(${dumpAst(node.left)},[${node.ops.join(',')}],${list(node.comparators)})`;
    case 'Call':
      return `Call${where(node)}(${dumpAst(node.func)},${list(node.args)})`;
    case 'Subscript':
      return `Subscript${where(node)}(${dumpAst(node.value)},${dumpAst(node.index)})`;
    case 'List':
      return `List${where(node)}(${list(node.elts)})`;
    case 'UnsupportedExpr':
      return `Unsupported${where(node)}`;
  }
}
