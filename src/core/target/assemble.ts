/**
 * Target-independent assembler driver: label resolution, branch relaxation,
 * encoding through the target encoder, and construction of the listing.
 */
import { LAYOUT } from './memory.ts';
import type { AsmItem, AssembledInsn, AssembledProgram, Backend, Insn, InsnMeta } from './types.ts';
import { AsmError } from './types.ts';

interface Entry {
  item: AsmItem;
  long: boolean;
  address: number;
  size: number;
  /** Index of the item in the caller's list, for error reporting. */
  origin: number;
}

function labelOperand(insn: Insn): string | null {
  for (const o of insn.operands) if (o.t === 'label') return o.name;
  return null;
}

/**
 * Assemble a list of items at the given load address.
 * Throws AsmError for undefined or duplicate labels, operands that cannot be
 * encoded, and programs larger than the code region.
 */
export function assembleItems(items: readonly AsmItem[], backend: Backend, base: number = LAYOUT.codeBase): AssembledProgram {
  const asm = backend.asm;
  let entries: Entry[] = items.map((item, origin) => ({ item, long: false, address: 0, size: 0, origin }));
  // The table has no prototype, so a label named like an Object.prototype member is an ordinary label.
  let symbols: Record<string, number> = Object.create(null);
  // Labels that the items define or refer to; the labels that relaxation adds are chosen outside this set.
  const taken = new Set<string>();
  let relaxable = 0;
  for (const it of items) {
    if (it.kind === 'label') taken.add(it.name);
    else if (it.kind === 'insn') {
      for (const o of it.insn.operands) if (o.t === 'label') taken.add(o.name);
      if (asm.relaxable(it.insn)) relaxable++;
    }
  }
  let skipCounter = 0;
  const skipLabel = (): string => {
    let name = `.Lrelax${skipCounter++}`;
    while (taken.has(name)) name = `.Lrelax${skipCounter++}`;
    return name;
  };

  // Each round that changes anything lengthens at least one relaxable instruction
  // of the input, since a replacement sequence reaches its targets in its short
  // forms, and nothing is shortened again. The layout is therefore final after at
  // most one round more than there are such instructions.
  for (let round = 0; ; round++) {
    if (round > relaxable) throw new AsmError('branch relaxation did not converge');
    symbols = Object.create(null);
    let addr = base;
    for (const en of entries) {
      en.address = addr;
      const it = en.item;
      if (it.kind === 'label') {
        if (symbols[it.name] !== undefined) throw new AsmError(`label '${it.name}' is defined more than once`, en.origin);
        symbols[it.name] = addr;
      } else if (it.kind === 'insn') {
        try {
          en.size = asm.size(it.insn, en.long);
        } catch (e) {
          throw new AsmError((e as Error).message, en.origin);
        }
        addr += en.size;
      } else if (it.kind === 'data') {
        en.size = it.bytes.length;
        addr += en.size;
      }
    }
    if (addr - base > LAYOUT.codeSize) throw new AsmError(`the program needs ${addr - base} bytes of code; the code region holds ${LAYOUT.codeSize}`);

    let changed = false;
    const next: Entry[] = [];
    for (const en of entries) {
      const it = en.item;
      if (it.kind === 'insn' && !en.long && asm.relaxable(it.insn)) {
        const name = labelOperand(it.insn);
        if (name !== null) {
          const target = symbols[name];
          if (target === undefined) throw new AsmError(`label '${name}' is not defined`, en.origin);
          if (!asm.shortFits(it.insn, en.address, target)) {
            changed = true;
            const repl = asm.relaxLong(it.insn, skipLabel());
            if (repl === null) {
              en.long = true;
              next.push(en);
            } else {
              for (const r of repl) {
                const item: AsmItem = r.kind === 'insn' ? { kind: 'insn', insn: r.insn, meta: { ...it.meta } } : r;
                next.push({ item, long: false, address: 0, size: 0, origin: en.origin });
              }
            }
            continue;
          }
        }
      }
      next.push(en);
    }
    entries = next;
    if (!changed) break;
  }

  const total = entries.reduce((n, en) => n + en.size, 0);
  const bytes = new Uint8Array(total);
  const insns: AssembledInsn[] = [];
  const boundaries: { address: number; stmts: number[] }[] = [];
  let pendingLabels: string[] = [];
  let pendingMarks: number[] = [];

  const flushMarks = (address: number): void => {
    if (pendingMarks.length === 0) return;
    const last = boundaries[boundaries.length - 1];
    if (last && last.address === address) last.stmts.push(...pendingMarks);
    else boundaries.push({ address, stmts: pendingMarks });
    pendingMarks = [];
  };

  for (const en of entries) {
    const it = en.item;
    if (it.kind === 'label') {
      pendingLabels.push(it.name);
      continue;
    }
    if (it.kind === 'mark') {
      pendingMarks.push(it.stmt);
      continue;
    }
    flushMarks(en.address);
    let encoded: Uint8Array;
    let resolved: Insn | null = null;
    let text: string;
    let meta: InsnMeta;
    if (it.kind === 'data') {
      encoded = it.bytes;
      text = it.text;
      meta = it.meta;
    } else {
      resolved = {
        mnemonic: it.insn.mnemonic,
        operands: it.insn.operands.map((o) => {
          if (o.t !== 'label') return o;
          const value = symbols[o.name];
          if (value === undefined) throw new AsmError(`label '${o.name}' is not defined`, en.origin);
          return { t: 'addr', value, label: o.name };
        }),
      };
      try {
        encoded = asm.encode(resolved, en.address, en.long);
      } catch (e) {
        throw new AsmError((e as Error).message, en.origin);
      }
      if (encoded.length !== en.size) throw new AsmError(`internal error: size of '${it.insn.mnemonic}' changed during encoding`, en.origin);
      text = backend.format(resolved);
      meta = it.meta;
    }
    bytes.set(encoded, en.address - base);
    insns.push({ address: en.address, length: encoded.length, insn: resolved, text, meta, labels: pendingLabels });
    pendingLabels = [];
  }
  flushMarks(base + total);
  return { base, bytes, insns, symbols, boundaries };
}

/** Parse an integer written in decimal, hexadecimal (0x), binary (0b), or octal (0o), with an optional sign. */
export function parseNumber(text: string): number | null {
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[0-9]+)$/.exec(text.trim());
  if (!m) return null;
  const v = Number(m[2]);
  if (!Number.isSafeInteger(v)) return null;
  return m[1] === '-' ? -v : v;
}

/** Split an operand list at top-level commas, keeping bracketed groups together. */
export function splitOperands(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

export interface AssemblyError {
  line: number;
  message: string;
}

export type AssembleTextResult =
  | { ok: true; program: AssembledProgram }
  | { ok: false; errors: AssemblyError[] };

function stripComment(line: string, commentChars: readonly string[]): string {
  let cut = line.length;
  for (const c of commentChars) {
    const i = line.indexOf(c);
    if (i >= 0 && i < cut) cut = i;
  }
  return line.slice(0, cut);
}

const IGNORED_DIRECTIVES = new Set(['.text', '.globl', '.global', '.intel_syntax', '.set', '.option', '.type', '.size', '.file', '.ident', '.section']);

/**
 * Assemble a program written as assembly text in the target's syntax.
 * Each line may hold labels followed by one instruction, pseudoinstruction, or
 * data directive (.word, .half, .byte). The load address is the start of the code region.
 */
export function assembleText(backend: Backend, text: string, base: number = LAYOUT.codeBase): AssembleTextResult {
  const errors: AssemblyError[] = [];
  const items: AsmItem[] = [];
  const itemLine: number[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    let rest = stripComment(raw, backend.profile.commentChars).trim();
    for (;;) {
      const m = /^([A-Za-z_.$][\w.$]*)\s*:/.exec(rest);
      if (!m) break;
      items.push({ kind: 'label', name: m[1]! });
      itemLine.push(lineNo);
      rest = rest.slice(m[0].length).trim();
    }
    if (rest === '') return;
    const dm = /^(\.[A-Za-z_0-9]+)\b\s*(.*)$/.exec(rest);
    if (dm) {
      const dir = dm[1]!.toLowerCase();
      if (IGNORED_DIRECTIVES.has(dir)) return;
      const unit = dir === '.word' || dir === '.4byte' || dir === '.long' ? 4 : dir === '.byte' ? 1 : dir === '.half' || dir === '.2byte' ? 2 : 0;
      if (unit === 0) {
        errors.push({ line: lineNo, message: `directive '${dm[1]}' is not supported; use .word, .half, or .byte for data` });
        return;
      }
      const values = splitOperands(dm[2]!);
      const out: number[] = [];
      for (const vt of values) {
        const v = parseNumber(vt);
        const lim = 2 ** (8 * unit);
        if (v === null || v < -lim / 2 || v >= lim) {
          errors.push({ line: lineNo, message: `'${vt}' is not a ${8 * unit}-bit value` });
          return;
        }
        for (let k = 0; k < unit; k++) out.push(Math.floor((v < 0 ? v + lim : v) / 2 ** (8 * k)) & 0xff);
      }
      if (out.length === 0) {
        errors.push({ line: lineNo, message: `directive '${dm[1]}' needs at least one value` });
        return;
      }
      items.push({ kind: 'data', bytes: Uint8Array.from(out), meta: { region: 'main', irOps: [], line: lineNo }, text: rest });
      itemLine.push(lineNo);
      return;
    }
    const parsed = backend.parseLine(rest);
    if (!parsed.ok) {
      errors.push({ line: lineNo, message: parsed.message });
      return;
    }
    for (const it of parsed.items) {
      if (it.kind === 'insn') it.meta.line = lineNo;
      items.push(it);
      itemLine.push(lineNo);
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  try {
    return { ok: true, program: assembleItems(items, backend, base) };
  } catch (e) {
    if (e instanceof AsmError) {
      return { ok: false, errors: [{ line: e.index !== undefined ? (itemLine[e.index] ?? 0) : 0, message: e.message }] };
    }
    throw e;
  }
}
