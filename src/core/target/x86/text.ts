/**
 * x86-64 assembly text in Intel syntax: formatting of instructions and
 * parsing of one line. Registers are written without a prefix, the
 * destination comes first, and a memory operand is written as
 * `dword ptr [base + index*scale + displacement]`.
 */
import { hexAddress } from '../../util/int32.ts';
import { parseNumber, splitOperands } from '../assemble.ts';
import type { AsmOperand, Insn, ParsedLine } from '../types.ts';
import { ALU_EXT, BASE_MNEMONICS, CC_NAMES, ccNumber, isReg16, regRef, SHIFT_EXT } from './isa.ts';

const SIZE_WORD: Record<number, string> = { 8: 'byte', 32: 'dword', 64: 'qword' };
const WORD_SIZE: Record<string, number> = { byte: 8, dword: 32, qword: 64 };

/** Displacement text: small values in decimal, addresses in hexadecimal. */
function dispText(v: number): string {
  const a = Math.abs(v);
  return a >= 0x10000 ? `0x${a.toString(16)}` : String(a);
}

function formatMem(o: Extract<AsmOperand, { t: 'mem' }>): string {
  const terms: string[] = [];
  if (o.base !== null) terms.push(o.base);
  if (o.index !== undefined) terms.push(`${o.index}*${o.scale ?? 1}`);
  let inner = terms.join(' + ');
  if (terms.length === 0) inner = o.disp < 0 ? `-${dispText(o.disp)}` : `0x${o.disp.toString(16).padStart(8, '0')}`;
  else if (o.disp !== 0) inner += ` ${o.disp < 0 ? '-' : '+'} ${dispText(o.disp)}`;
  const size = o.size !== undefined ? `${SIZE_WORD[o.size] ?? '?'} ptr ` : '';
  return `${size}[${inner}]`;
}

function formatOperand(o: AsmOperand): string {
  switch (o.t) {
    case 'reg':
      return o.name;
    case 'imm':
      return String(o.value);
    case 'mem':
      return formatMem(o);
    case 'label':
      return o.name;
    case 'addr':
      return o.label ?? hexAddress(o.value);
    default:
      return '?';
  }
}

export function format(insn: Insn): string {
  if (insn.operands.length === 0) return insn.mnemonic;
  return `${insn.mnemonic} ${insn.operands.map(formatOperand).join(', ')}`;
}

/** Parse the inside of the brackets of a memory operand. */
function parseAddress(text: string): { base: string | null; index?: string; scale?: number; disp: number } | string {
  let base: string | null = null;
  let index: string | undefined;
  let scale = 1;
  let disp = 0;
  const terms = text.replace(/\s+/g, '').match(/[+-]*[^+-]+/g);
  if (!terms || terms.join('') !== text.replace(/\s+/g, '')) return `cannot read the address '${text.trim()}'`;
  for (const term of terms) {
    const body = term.replace(/^[+-]*/, '');
    // A term may carry several signs, as in `+ -8`; it is negative when the number of minus signs is odd.
    const negative = (term.length - body.length - term.slice(0, term.length - body.length).replace(/-/g, '').length) % 2 === 1;
    const scaled = /^([A-Za-z0-9]+)\*([A-Za-z0-9]+)$/.exec(body);
    if (scaled) {
      const [regText, numText] = regRef(scaled[1]!) ? [scaled[1]!, scaled[2]!] : [scaled[2]!, scaled[1]!];
      const r = regRef(regText);
      const n = parseNumber(numText);
      if (!r || n === null) return `cannot read the scaled index '${body}'`;
      if (negative) return 'an index register cannot be subtracted';
      if (index !== undefined) return 'an address has at most one scaled index register';
      if (r.size !== 64) return `index register '${regText}' must be a 64-bit register`;
      index = regText.toLowerCase();
      scale = n;
      continue;
    }
    const r = regRef(body);
    if (r) {
      if (negative) return 'a register cannot be subtracted in an address';
      if (r.size !== 64) return `address register '${body}' must be a 64-bit register`;
      if (base === null) base = body.toLowerCase();
      else if (index === undefined) index = body.toLowerCase();
      else return 'an address has at most a base and an index register';
      continue;
    }
    if (isReg16(body)) return `'${body}' is a 16-bit register and cannot be used in an address`;
    const n = parseNumber(body);
    if (n === null) return body === 'rip' ? 'RIP-relative addressing is outside the subset' : `cannot read the address term '${body}'`;
    disp += negative ? -n : n;
  }
  // rsp cannot be an index; with scale 1 the two registers may be exchanged.
  if (index === 'rsp' && scale === 1 && base !== null && base !== 'rsp') [base, index] = [index, base];
  const out: { base: string | null; index?: string; scale?: number; disp: number } = { base, disp };
  if (index !== undefined) {
    out.index = index;
    out.scale = scale;
  }
  return out;
}

function parseOperand(text: string): AsmOperand | string {
  const t = text.trim();
  if (t === '') return 'missing operand';
  const mm = /^(?:([A-Za-z]+)\s+ptr\s*)?\[(.*)\]$/i.exec(t);
  if (mm) {
    let size: number | undefined;
    if (mm[1] !== undefined) {
      size = WORD_SIZE[mm[1].toLowerCase()];
      if (size === undefined) return mm[1].toLowerCase() === 'word' ? '16-bit memory operands (word ptr) are outside the subset' : `unknown operand size '${mm[1]} ptr'`;
    }
    const a = parseAddress(mm[2]!);
    if (typeof a === 'string') return a;
    const o: AsmOperand = { t: 'mem', base: a.base, disp: a.disp };
    if (a.index !== undefined) {
      o.index = a.index;
      o.scale = a.scale!;
    }
    if (size !== undefined) o.size = size;
    return o;
  }
  if (regRef(t)) return { t: 'reg', name: t.toLowerCase() };
  if (isReg16(t)) return `'${t}' is a 16-bit register; the subset has 8-bit, 32-bit, and 64-bit registers only`;
  // Sixteen hexadecimal digits with the top bit set denote a negative 64-bit value, such as a jump
  // target below address zero.
  if (/^0x[89a-f][0-9a-f]{15}$/i.test(t)) {
    const v = Number(BigInt.asIntN(64, BigInt(t)));
    if (Number.isSafeInteger(v)) return { t: 'imm', value: v };
  }
  const n = parseNumber(t);
  if (n !== null) return { t: 'imm', value: n };
  if (/^[A-Za-z_.$][\w.$]*$/.test(t)) return { t: 'label', name: t };
  return `cannot read operand '${t}'`;
}

/** Canonical mnemonic for an accepted spelling (jz becomes je, setnae becomes setb, sal becomes shl), or null. */
export function canonicalMnemonic(m: string): string | null {
  if ((BASE_MNEMONICS as readonly string[]).includes(m)) return m;
  if (m === 'sal') return 'shl';
  if (m.startsWith('set') && ccNumber(m.slice(3)) >= 0) return `set${CC_NAMES[ccNumber(m.slice(3))]}`;
  if (m.startsWith('j') && ccNumber(m.slice(1)) >= 0) return `j${CC_NAMES[ccNumber(m.slice(1))]}`;
  return null;
}

/**
 * Parse one instruction. A numeric jump or call target is an absolute address.
 * Three shorthands are normalized: `test reg, mem` becomes `test mem, reg`
 * (the same encoding), `imul reg, imm` becomes `imul reg, reg, imm`, and a
 * memory operand without a size keyword takes the size of the register operand.
 */
export function parseLine(text: string): ParsedLine {
  const m = /^([A-Za-z][A-Za-z0-9]*)\s*(.*)$/.exec(text.trim());
  if (!m) return { ok: false, message: `cannot read '${text.trim()}' as an instruction` };
  const mnemonic = canonicalMnemonic(m[1]!.toLowerCase());
  if (mnemonic === null) return { ok: false, message: `'${m[1]!.toLowerCase()}' is not an instruction of the implemented x86-64 subset` };
  let operands: AsmOperand[] = [];
  for (const part of splitOperands(m[2]!)) {
    const o = parseOperand(part);
    if (typeof o === 'string') return { ok: false, message: o };
    operands.push(o);
  }
  const isBranch = mnemonic === 'jmp' || mnemonic === 'call' || (mnemonic.startsWith('j') && mnemonic !== 'jmp');
  if (isBranch) {
    operands = operands.map((o) => (o.t === 'imm' ? { t: 'addr', value: o.value } : o));
    if (operands.some((o) => o.t === 'reg' || o.t === 'mem')) return { ok: false, message: `indirect '${mnemonic}' through a register or memory is outside the subset` };
  } else if (operands.some((o) => o.t === 'label')) {
    const bad = operands.find((o) => o.t === 'label') as { name: string };
    return { ok: false, message: `cannot read operand '${bad.name}'; symbols are accepted only as jump and call targets` };
  }
  if (mnemonic === 'test' && operands.length === 2 && operands[0]!.t === 'reg' && operands[1]!.t === 'mem') operands = [operands[1]!, operands[0]!];
  if (mnemonic === 'imul' && operands.length === 2 && operands[1]!.t === 'imm') operands = [operands[0]!, operands[0]!, operands[1]!];
  // A memory operand without a size keyword takes the size that the instruction implies.
  const sized = mnemonic in ALU_EXT || mnemonic === 'mov' || mnemonic === 'test' || mnemonic === 'imul';
  const reg = operands.find((o) => o.t === 'reg');
  const implied = mnemonic === 'movsxd' ? 32 : mnemonic.startsWith('set') ? 8 : sized && reg && !(mnemonic in SHIFT_EXT) ? regRef((reg as { name: string }).name)!.size : 0;
  if (implied !== 0) {
    operands = operands.map((o) => (o.t === 'mem' && o.size === undefined ? { ...o, size: implied } : o));
  }
  if (mnemonic === 'lea') {
    operands = operands.map((o) => {
      if (o.t !== 'mem' || o.size === undefined) return o;
      const { size: _size, ...rest } = o;
      return rest;
    });
  }
  return { ok: true, items: [{ kind: 'insn', insn: { mnemonic, operands }, meta: { region: 'main', irOps: [] } }] };
}
