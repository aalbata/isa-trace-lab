/**
 * Path A: genuine CPython bytecode of a source text.
 *
 * The source is compiled, never executed, by the CPython interpreter inside
 * the pinned Pyodide runtime, and disassembled with the standard `dis` module.
 * This path is independent of the restricted-language compiler: it accepts
 * any Python the runtime accepts and shows what CPython would run.
 */

/** Python program evaluated once in the runtime; it defines `isa_disassemble`. */
export const DISASSEMBLE_PY = `
import dis
import json
import sys
import types


def _instructions(code):
    out = []
    for ins in dis.get_instructions(code, adaptive=False):
        try:
            effect = dis.stack_effect(ins.opcode, ins.arg)
        except (ValueError, TypeError):
            try:
                effect = dis.stack_effect(ins.opcode)
            except (ValueError, TypeError):
                effect = None
        pos = ins.positions
        cache = getattr(ins, "cache_info", None) or []
        argrepr = ins.argrepr
        if isinstance(ins.argval, types.CodeType):
            # The default text contains a memory address, which differs from run to run.
            argrepr = "<code object %s>" % ins.argval.co_qualname
        out.append({
            "offset": ins.offset,
            "opname": ins.opname,
            "opcode": ins.opcode,
            "arg": ins.arg,
            "argrepr": argrepr,
            "line": getattr(ins, "line_number", None),
            "startsLine": bool(ins.starts_line),
            "positions": None if pos is None else [pos.lineno, pos.end_lineno, pos.col_offset, pos.end_col_offset],
            "isJumpTarget": bool(ins.is_jump_target),
            "jumpTarget": getattr(ins, "jump_target", None),
            "stackEffect": effect,
            "cacheUnits": sum(size for _name, size, _data in cache),
        })
    return out


def _walk(code, out):
    out.append({
        "name": code.co_qualname,
        "firstLine": code.co_firstlineno,
        "argCount": code.co_argcount,
        "localNames": list(code.co_varnames),
        "names": list(code.co_names),
        "constants": [repr(c) if not isinstance(c, types.CodeType) else "<code object %s>" % c.co_qualname for c in code.co_consts],
        "stackSize": code.co_stacksize,
        "byteLength": len(code.co_code),
        "instructions": _instructions(code),
    })
    for const in code.co_consts:
        if isinstance(const, types.CodeType):
            _walk(const, out)


def isa_disassemble(source):
    try:
        code = compile(source, "<source>", "exec", dont_inherit=True)
    except SyntaxError as e:
        return json.dumps({"ok": False, "error": {"message": e.msg, "line": e.lineno, "column": e.offset}})
    except (ValueError, RecursionError, MemoryError, OverflowError) as e:
        return json.dumps({"ok": False, "error": {"message": "%s: %s" % (type(e).__name__, e), "line": None, "column": None}})
    objects = []
    _walk(code, objects)
    return json.dumps({"ok": True, "python": sys.version.split()[0], "implementation": sys.implementation.name, "codeObjects": objects})
`;

export interface BytecodeInstruction {
  offset: number;
  opname: string;
  opcode: number;
  arg: number | null;
  argrepr: string;
  line: number | null;
  startsLine: boolean;
  /** [first line, last line, first column, last column], zero-based columns, or null. */
  positions: [number | null, number | null, number | null, number | null] | null;
  isJumpTarget: boolean;
  jumpTarget: number | null;
  /** Net change of the evaluation stack depth, when the runtime can state it. */
  stackEffect: number | null;
  /** Number of 16-bit inline cache entries that follow the instruction. */
  cacheUnits: number;
}

export interface CodeObjectListing {
  name: string;
  firstLine: number;
  argCount: number;
  localNames: string[];
  names: string[];
  constants: string[];
  stackSize: number;
  byteLength: number;
  instructions: BytecodeInstruction[];
}

export type DisassemblyResult =
  | { ok: true; python: string; implementation: string; pyodide: string; codeObjects: CodeObjectListing[] }
  | { ok: false; pyodide: string; error: { message: string; line: number | null; column: number | null } };

/** Longest source text passed to the CPython compiler, in characters (Unicode code points). */
export const MAX_BYTECODE_SOURCE = 65536;

interface PyodideLike {
  version: string;
  runPython(code: string): unknown;
  globals: { get(name: string): unknown };
}

export interface Disassembler {
  pyodideVersion: string;
  disassemble(source: string): DisassemblyResult;
}

/**
 * Prepare a loaded Pyodide runtime for disassembly. The submitted source is
 * passed to Python as a string argument and is only compiled.
 */
export function createDisassembler(pyodide: PyodideLike): Disassembler {
  pyodide.runPython(DISASSEMBLE_PY);
  const fn = pyodide.globals.get('isa_disassemble') as (source: string) => string;
  return {
    pyodideVersion: pyodide.version,
    disassemble(source: string): DisassemblyResult {
      // source.length counts UTF-16 code units, never fewer than the characters, so most texts need no character count.
      if (source.length > MAX_BYTECODE_SOURCE && [...source].length > MAX_BYTECODE_SOURCE) {
        return { ok: false, pyodide: pyodide.version, error: { message: `source is longer than ${MAX_BYTECODE_SOURCE} characters`, line: null, column: null } };
      }
      const parsed = JSON.parse(fn(source)) as Record<string, unknown>;
      return { ...parsed, pyodide: pyodide.version } as DisassemblyResult;
    },
  };
}
