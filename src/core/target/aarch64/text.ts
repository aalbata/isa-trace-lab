/**
 * A64 assembly text: formatting of the canonical instructions, parsing of one
 * line, and the architecture's aliases (mov, cmp, mul, lsl, cset, and others)
 * in both directions. The parser returns the canonical instruction of an alias
 * with the alias text recorded as its pseudoinstruction; the decoder reports
 * the preferred alias of a canonical instruction through `aliasOf`.
 */
import { hex } from '../../util/int32.ts';
import { splitOperands } from '../assemble.ts';
import type { AsmOperand, Insn, InsnMeta, ParsedLine } from '../types.ts';
import type { RegRef } from './isa.ts';
import { COND_NAMES, SPEC_BY_MNEMONIC, condIndex, encodeBitmask, parseReg, regName } from './isa.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const TWO64 = 1n << 64n;

const hexImm = (v: number | bigint): string => `#0x${v.toString(16)}`;

/** Absolute address as text; an address below zero is printed as the wrapped 64-bit value. */
function formatAddress(value: number): string {
  return value < 0 ? `0x${(TWO64 + BigInt(value)).toString(16)}` : hex(value);
}

function formatOperand(o: AsmOperand): string {
  switch (o.t) {
    case 'reg':
      return o.name;
    case 'imm':
      return `#${o.value}`;
    case 'shift':
      return `${o.kind} #${o.amount}`;
    case 'cond':
      return o.name;
    case 'label':
      return o.name;
    case 'addr':
      return o.label ?? formatAddress(o.value);
    case 'mem': {
      if (o.index === undefined) return o.disp === 0 ? `[${o.base}]` : `[${o.base}, #${o.disp}]`;
      const amount = o.shift === undefined ? '' : ` #${o.shift}`;
      if (o.ext === 'lsl' && o.shift === undefined) return `[${o.base}, ${o.index}]`;
      return `[${o.base}, ${o.index}, ${o.ext}${amount}]`;
    }
  }
}

/** Value of the logical immediate carried by operand 2 (and operand 3 for the 64-bit form). */
export function logicalImmediate(insn: Insn): bigint | null {
  const lo = insn.operands[2];
  const hi = insn.operands[3];
  if (!lo || lo.t !== 'imm') return null;
  if (hi && hi.t === 'imm') return (BigInt(hi.value >>> 0) << 32n) | BigInt(lo.value >>> 0);
  return BigInt(lo.value >>> 0);
}

/** Canonical A64 text of an instruction. */
export function format(insn: Insn): string {
  const o = insn.operands;
  if (o.length === 0) return insn.mnemonic;
  const klass = SPEC_BY_MNEMONIC.get(insn.mnemonic)?.klass;
  if (klass === 'logic' && o[2]?.t === 'imm') {
    return `${insn.mnemonic} ${formatOperand(o[0]!)}, ${formatOperand(o[1]!)}, ${hexImm(logicalImmediate(insn)!)}`;
  }
  if (klass === 'movw' && o[1]?.t === 'imm') {
    const rest = o.slice(2).map((x) => `, ${formatOperand(x)}`).join('');
    return `${insn.mnemonic} ${formatOperand(o[0]!)}, ${hexImm(o[1].value)}${rest}`;
  }
  return `${insn.mnemonic} ${o.map(formatOperand).join(', ')}`;
}

// ---- constants ------------------------------------------------------------------

/**
 * MOVZ or MOVN fields that load `value` into a register of `bits` bits, or null
 * when neither can: MOVZ when every set bit of the value lies in one aligned
 * 16-bit halfword, otherwise MOVN when every set bit of its complement does.
 */
function wideMove(value: bigint, bits: 32 | 64): { mnemonic: 'movz' | 'movn'; imm16: number; shift: number } | null {
  const mask = (1n << BigInt(bits)) - 1n;
  const single = (x: bigint): { imm16: number; shift: number } | null => {
    for (let shift = 0; shift < bits; shift += 16) {
      if ((x & ~(0xffffn << BigInt(shift)) & mask) === 0n) return { imm16: Number((x >> BigInt(shift)) & 0xffffn), shift };
    }
    return null;
  };
  const z = single(value & mask);
  if (z) return { mnemonic: 'movz', ...z };
  const n = single(~value & mask);
  if (n) return { mnemonic: 'movn', ...n };
  return null;
}

/**
 * The single instruction that loads a constant, chosen in the order of the
 * `mov` alias: MOVZ, then MOVN, then ORR with a bitmask immediate. Returns
 * null when no single instruction can load the value.
 */
export function moveImmediate(rd: string, value: bigint): Insn | null {
  const reg = parseReg(rd);
  if (!reg) return null;
  const bits = reg.bits;
  const mask = (1n << BigInt(bits)) - 1n;
  const v = value & mask;
  const w = wideMove(v, bits);
  if (w) {
    const operands: AsmOperand[] = [R(rd), I(w.imm16)];
    if (w.shift !== 0) operands.push({ t: 'shift', kind: 'lsl', amount: w.shift });
    return { mnemonic: w.mnemonic, operands };
  }
  if (encodeBitmask(v, bits) !== null) {
    const operands: AsmOperand[] = [R(rd), R(regName(31, bits, 'zr')), I(Number(v & 0xffffffffn))];
    if (bits === 64) operands.push(I(Number(v >> 32n)));
    return { mnemonic: 'orr', operands };
  }
  return null;
}

/** Text of the `mov` alias that loads `value` into `rd`. */
export function moveImmediateText(rd: string, value: bigint): string {
  const bits = parseReg(rd)?.bits ?? 32;
  return `mov ${rd}, ${hexImm(value & ((1n << BigInt(bits)) - 1n))}`;
}

// ---- aliases of decoded instructions ------------------------------------------------

function invertCond(name: string): string {
  return COND_NAMES[condIndex(name) ^ 1]!;
}

/** Preferred alias of a canonical instruction as assembly text, or null when the instruction has none. */
export function aliasOf(insn: Insn): string | null {
  const o = insn.operands;
  const reg = (i: number): RegRef | null => (o[i]?.t === 'reg' ? parseReg((o[i] as { name: string }).name) : null);
  const name = (i: number): string => (o[i]?.t === 'reg' ? (o[i] as { name: string }).name : '');
  const imm = (i: number): number => (o[i]?.t === 'imm' ? (o[i] as { value: number }).value : NaN);
  const isZr = (i: number): boolean => reg(i)?.kind === 'zr';
  const isSp = (i: number): boolean => reg(i)?.kind === 'sp';
  const tail = (from: number): string => o.slice(from).map((x) => `, ${formatOperand(x)}`).join('');
  const bits = reg(0)?.bits ?? 32;
  const immForm = o[2]?.t === 'imm';
  switch (insn.mnemonic) {
    case 'add':
      if (immForm && imm(2) === 0 && o.length === 3 && (isSp(0) || isSp(1))) return `mov ${name(0)}, ${name(1)}`;
      return null;
    case 'adds':
      return isZr(0) ? `cmn ${name(1)}, ${formatOperand(o[2]!)}${tail(3)}` : null;
    case 'sub':
      return !immForm && isZr(1) ? `neg ${name(0)}, ${name(2)}${tail(3)}` : null;
    case 'subs':
      if (isZr(0)) return `cmp ${name(1)}, ${formatOperand(o[2]!)}${tail(3)}`;
      return !immForm && isZr(1) ? `negs ${name(0)}, ${name(2)}${tail(3)}` : null;
    case 'ands':
      if (!isZr(0)) return null;
      return immForm ? `tst ${name(1)}, ${hexImm(logicalImmediate(insn)!)}` : `tst ${name(1)}, ${name(2)}${tail(3)}`;
    case 'orr':
      if (!isZr(1)) return null;
      if (immForm) {
        // MOV (bitmask immediate) excludes the values that MOVZ or MOVN can load, because `mov` with such a
        // value assembles to MOVZ or MOVN. The test is exact: the MOVN bound of the MoveWidePreferred
        // pseudocode (width - 15) misses runs of 15 or 16 zeros and some rotations of shorter runs.
        const v = logicalImmediate(insn)!;
        return wideMove(v, bits) ? null : moveImmediateText(name(0), v);
      }
      return o.length === 3 ? `mov ${name(0)}, ${name(2)}` : null;
    case 'orn':
      return isZr(1) ? `mvn ${name(0)}, ${name(2)}${tail(3)}` : null;
    case 'movz': {
      const shift = o[2]?.t === 'shift' ? o[2].amount : 0;
      if (imm(1) === 0 && shift !== 0) return null;
      return moveImmediateText(name(0), BigInt(imm(1)) << BigInt(shift));
    }
    case 'movn': {
      const shift = o[2]?.t === 'shift' ? o[2].amount : 0;
      if (imm(1) === 0 && shift !== 0) return null;
      if (bits === 32 && imm(1) === 0xffff) return null;
      return moveImmediateText(name(0), ~(BigInt(imm(1)) << BigInt(shift)));
    }
    case 'madd':
      return isZr(3) ? `mul ${name(0)}, ${name(1)}, ${name(2)}` : null;
    case 'msub':
      return isZr(3) ? `mneg ${name(0)}, ${name(1)}, ${name(2)}` : null;
    case 'lslv': case 'lsrv': case 'asrv':
      return `${insn.mnemonic.slice(0, 3)} ${name(0)}, ${name(1)}, ${name(2)}`;
    case 'ubfm': case 'sbfm': {
      const signed = insn.mnemonic === 'sbfm';
      const immr = imm(2);
      const imms = imm(3);
      const d = name(0);
      const n = name(1);
      const n32 = regName(reg(1)?.n ?? 0, 32, 'zr');
      if (!signed && imms !== bits - 1 && imms + 1 === immr) return `lsl ${d}, ${n}, #${bits - 1 - imms}`;
      if (imms === bits - 1) return `${signed ? 'asr' : 'lsr'} ${d}, ${n}, #${immr}`;
      if (imms < immr) return `${signed ? 'sbfiz' : 'ubfiz'} ${d}, ${n}, #${bits - immr}, #${imms + 1}`;
      if (immr === 0 && imms === 7 && (signed || bits === 32)) return `${signed ? 'sxtb' : 'uxtb'} ${d}, ${n32}`;
      if (immr === 0 && imms === 15 && (signed || bits === 32)) return `${signed ? 'sxth' : 'uxth'} ${d}, ${n32}`;
      if (immr === 0 && imms === 31 && signed && bits === 64) return `sxtw ${d}, ${n32}`;
      return `${signed ? 'sbfx' : 'ubfx'} ${d}, ${n}, #${immr}, #${imms - immr + 1}`;
    }
    case 'csinc': {
      const cond = o[3]?.t === 'cond' ? o[3].name : '';
      if (condIndex(cond) >= 14 || name(1) !== name(2)) return null;
      return isZr(1) ? `cset ${name(0)}, ${invertCond(cond)}` : `cinc ${name(0)}, ${name(1)}, ${invertCond(cond)}`;
    }
    case 'ret':
      return name(0) === 'x30' ? 'ret' : null;
    default:
      return null;
  }
}

// ---- parsing ----------------------------------------------------------------------

type Arg =
  | { t: 'reg'; name: string; ref: RegRef }
  | { t: 'imm'; value: bigint }
  | { t: 'shift'; kind: string; amount: number }
  | { t: 'ident'; name: string }
  | { t: 'mem'; op: AsmOperand };

/** Integer in decimal, hexadecimal (0x), or binary (0b), with an optional `#` and sign. */
function parseInteger(text: string): bigint | null {
  const m = /^#?\s*([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)$/.exec(text.trim());
  if (!m) return null;
  const v = BigInt(m[2]!);
  if (v >= TWO64) return null;
  return m[1] === '-' ? -v : v;
}

function parseRegister(text: string): { name: string; ref: RegRef } | null {
  const ref = parseReg(text.trim());
  if (!ref) return null;
  return { name: regName(ref.n, ref.bits, ref.kind === 'sp' ? 'sp' : 'zr'), ref };
}

function parseMemory(text: string): AsmOperand | string {
  const parts = splitOperands(text.slice(1, -1));
  const base = parseRegister(parts[0] ?? '');
  if (!base) return `'${(parts[0] ?? '').trim()}' is not a base register`;
  if (parts.length === 1) return { t: 'mem', base: base.name, disp: 0 };
  if (parts.length === 2) {
    const disp = parseInteger(parts[1]!);
    if (disp !== null) {
      if (disp < -0x100000n || disp > 0x100000n) return `offset ${disp} is out of range`;
      return { t: 'mem', base: base.name, disp: Number(disp) };
    }
  }
  const index = parseRegister(parts[1]!);
  if (!index) return `'${parts[1]!.trim()}' is not an offset or an index register`;
  if (parts.length === 2) return { t: 'mem', base: base.name, disp: 0, index: index.name, ext: 'lsl' };
  if (parts.length > 3) return 'too many components in the memory operand';
  const m = /^(lsl|uxtw|sxtw|sxtx)(?:\s+#?\s*([0-9]+))?$/i.exec(parts[2]!.trim());
  if (!m) return `'${parts[2]!.trim()}' is not lsl, uxtw, sxtw, or sxtx with an optional amount`;
  const mem: AsmOperand = { t: 'mem', base: base.name, disp: 0, index: index.name, ext: m[1]!.toLowerCase() };
  if (m[2] !== undefined) mem.shift = Number(m[2]);
  return mem;
}

function parseArg(text: string): Arg | string {
  const t = text.trim();
  if (t === '') return 'missing operand';
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) return `memory operand '${t}' has no closing bracket`;
    const op = parseMemory(t);
    return typeof op === 'string' ? op : { t: 'mem', op };
  }
  const sh = /^(lsl|lsr|asr|ror)\s+#?\s*([0-9]+)$/i.exec(t);
  if (sh) return { t: 'shift', kind: sh[1]!.toLowerCase(), amount: Number(sh[2]) };
  const r = parseRegister(t);
  if (r) return { t: 'reg', name: r.name, ref: r.ref };
  const n = parseInteger(t);
  if (n !== null) return { t: 'imm', value: n };
  if (/^[A-Za-z_.$][\w.$]*$/.test(t)) return { t: 'ident', name: t };
  return `cannot read operand '${t}'`;
}

type RegArg = Extract<Arg, { t: 'reg' }>;
const isReg = (a: Arg | undefined): a is RegArg => a !== undefined && a.t === 'reg';
const isImm = (a: Arg | undefined): a is Extract<Arg, { t: 'imm' }> => a !== undefined && a.t === 'imm';
const isShift = (a: Arg | undefined): a is Extract<Arg, { t: 'shift' }> => a !== undefined && a.t === 'shift';

function small(v: bigint): number | null {
  return v >= -0x80000000n && v <= 0xffffffffn ? Number(v) : null;
}

function targetOf(a: Arg | undefined): AsmOperand | string {
  if (!a) return 'missing branch target';
  if (a.t === 'ident') return { t: 'label', name: a.name };
  if (a.t === 'imm') {
    // An address at or above 2^63 is a target below zero in the wrapped 64-bit address space.
    const v = a.value >= 1n << 63n ? a.value - TWO64 : a.value;
    if (v < -(1n << 40n) || v > 1n << 40n) return `branch target ${a.value} is outside the supported address range`;
    return { t: 'addr', value: Number(v) };
  }
  return 'expected a label or an address';
}

function plain(a: Arg): AsmOperand | string {
  switch (a.t) {
    case 'reg': return R(a.name);
    case 'imm': {
      const v = small(a.value);
      return v === null ? `immediate ${a.value} is out of range` : I(v);
    }
    case 'shift': return { t: 'shift', kind: a.kind, amount: a.amount };
    case 'ident': return condIndex(a.name) >= 0 ? { t: 'cond', name: COND_NAMES[condIndex(a.name)]! } : { t: 'label', name: a.name };
    case 'mem': return a.op;
  }
}

function operands(args: Arg[]): AsmOperand[] | string {
  const out: AsmOperand[] = [];
  for (const a of args) {
    const o = plain(a);
    if (typeof o === 'string') return o;
    out.push(o);
  }
  return out;
}

interface Built {
  insn: Insn;
  /** True when the text was a shorthand of the returned canonical instruction. */
  alias: boolean;
}

const done = (mnemonic: string, ops: AsmOperand[], alias = false): Built => ({ insn: { mnemonic, operands: ops }, alias });

/**
 * Add or subtract with an immediate, accepting what the reference assembler
 * accepts: a negative immediate selects the opposite operation, and a multiple
 * of 4096 up to 0xfff000 selects the form shifted left by 12.
 */
function addSubImmediate(mnemonic: string, rd: RegArg, rn: RegArg, imm: bigint, shift: Arg | undefined): Built | string {
  if (shift !== undefined) {
    if (!isShift(shift) || shift.kind !== 'lsl' || (shift.amount !== 0 && shift.amount !== 12)) return 'the immediate may only be shifted by lsl #0 or lsl #12';
    if (imm < 0n || imm > 4095n) return `immediate ${imm} with an explicit shift must be in 0 to 4095`;
    const ops: AsmOperand[] = [R(rd.name), R(rn.name), I(Number(imm))];
    if (shift.amount === 12) ops.push({ t: 'shift', kind: 'lsl', amount: 12 });
    return done(mnemonic, ops);
  }
  let m = mnemonic;
  let v = imm;
  let alias = false;
  if (v < 0n) {
    v = -v;
    m = { add: 'sub', sub: 'add', adds: 'subs', subs: 'adds' }[mnemonic]!;
    alias = true;
  }
  if (v <= 4095n) return done(m, [R(rd.name), R(rn.name), I(Number(v))], alias);
  if ((v & 0xfffn) === 0n && v <= 0xfff000n) return done(m, [R(rd.name), R(rn.name), I(Number(v >> 12n)), { t: 'shift', kind: 'lsl', amount: 12 }], true);
  return `immediate ${imm} is not encodable: the magnitude must be in 0 to 4095, or a multiple of 4096 up to 16773120`;
}

function logicalOperands(rd: RegArg, rn: string, imm: bigint): AsmOperand[] | string {
  const bits = rd.ref.bits;
  const lim = 1n << BigInt(bits);
  if (imm < -(lim >> 1n) || imm >= lim) return `immediate ${imm} does not fit in ${bits} bits`;
  const v = imm & (lim - 1n);
  const ops: AsmOperand[] = [R(rd.name), R(rn), I(Number(v & 0xffffffffn))];
  if (bits === 64) ops.push(I(Number(v >> 32n)));
  return ops;
}

/** Canonical instruction for the text of a canonical mnemonic. */
function canonical(mnemonic: string, a: Arg[]): Built | string {
  const spec = SPEC_BY_MNEMONIC.get(mnemonic)!;
  switch (spec.klass) {
    case 'addsub':
      if (isReg(a[0]) && isReg(a[1]) && isImm(a[2]) && a.length <= 4) return addSubImmediate(mnemonic, a[0], a[1], a[2].value, a[3]);
      break;
    case 'logic':
      // The instruction text takes one immediate; the pair of immediates of a 64-bit value exists only in the Insn.
      if (isImm(a[2]) && a.length !== 3) return 'the immediate form takes two registers and one immediate';
      if (isReg(a[0]) && isReg(a[1]) && isImm(a[2]) && a.length === 3) {
        const ops = logicalOperands(a[0], a[1].name, a[2].value);
        return typeof ops === 'string' ? ops : done(mnemonic, ops);
      }
      break;
    case 'b': case 'bcond': {
      if (a.length !== 1) return `'${mnemonic}' takes a target`;
      const t = targetOf(a[0]);
      return typeof t === 'string' ? t : done(mnemonic, [t]);
    }
    case 'cb': {
      if (a.length !== 2 || !isReg(a[0])) return `'${mnemonic}' takes a register and a target`;
      const t = targetOf(a[1]);
      return typeof t === 'string' ? t : done(mnemonic, [R(a[0].name), t]);
    }
    case 'breg':
      if (mnemonic === 'ret' && a.length === 0) return done('ret', [R('x30')], true);
      break;
    case 'mem': {
      // A shift amount of zero is the unshifted form, except for byte accesses, where it sets the S bit.
      const m = a[1];
      if (m && m.t === 'mem' && m.op.t === 'mem' && m.op.shift === 0 && !mnemonic.endsWith('b')) {
        const { shift: _unused, ...rest } = m.op;
        const ops = operands([a[0]!]);
        return typeof ops === 'string' ? ops : done(mnemonic, [...ops, rest]);
      }
      break;
    }
    default:
      break;
  }
  const ops = operands(a);
  return typeof ops === 'string' ? ops : done(mnemonic, ops);
}

const zr = (r: RegArg): string => regName(31, r.ref.bits, 'zr');

/** Canonical instruction of an alias, an error text, or null when the mnemonic is not an alias. */
function fromAlias(mnemonic: string, a: Arg[]): Built | string | null {
  const shiftTail = (from: number): AsmOperand[] | string => {
    if (a.length === from) return [];
    const s = a[from];
    if (a.length !== from + 1 || !isShift(s)) return 'expected an optional shift such as lsl #3 after the registers';
    return s.kind === 'lsl' && s.amount === 0 ? [] : [{ t: 'shift', kind: s.kind, amount: s.amount }];
  };
  const withShift = (m: string, head: AsmOperand[], from: number): Built | string => {
    const t = shiftTail(from);
    return typeof t === 'string' ? t : done(m, [...head, ...t], true);
  };
  switch (mnemonic) {
    case 'mov': {
      if (a.length !== 2 || !isReg(a[0])) return 'expected a register and a register or an immediate';
      const d = a[0];
      const s = a[1];
      if (isReg(s)) {
        if (d.ref.kind === 'sp' || s.ref.kind === 'sp') return done('add', [R(d.name), R(s.name), I(0)], true);
        return done('orr', [R(d.name), R(zr(d)), R(s.name)], true);
      }
      if (!isImm(s)) return 'expected a register or an immediate as the source';
      const lim = 1n << BigInt(d.ref.bits);
      if (s.value < -(lim >> 1n) || s.value >= lim) return `${s.value} does not fit in ${d.ref.bits} bits`;
      const insn = moveImmediate(d.name, s.value);
      if (!insn) return `${s.value} cannot be loaded by one instruction; use movz followed by movk`;
      return { insn, alias: true };
    }
    case 'cmp': case 'cmn': {
      const m = mnemonic === 'cmp' ? 'subs' : 'adds';
      if (!isReg(a[0])) return 'expected a register and a register or an immediate';
      if (isImm(a[1])) {
        if (a.length > 3) return 'expected a register, an immediate, and an optional shift lsl #0 or lsl #12';
        const b = addSubImmediate(m, { ...a[0], name: zr(a[0]) }, a[0], a[1].value, a[2]);
        return typeof b === 'string' ? b : { insn: b.insn, alias: true };
      }
      if (!isReg(a[1])) return 'expected a register or an immediate as the second operand';
      return withShift(m, [R(zr(a[0])), R(a[0].name), R(a[1].name)], 2);
    }
    case 'tst': {
      if (!isReg(a[0])) return 'expected a register and a register or an immediate';
      if (isImm(a[1]) && a.length === 2) {
        const ops = logicalOperands({ ...a[0], name: zr(a[0]) }, a[0].name, a[1].value);
        return typeof ops === 'string' ? ops : done('ands', ops, true);
      }
      if (!isReg(a[1])) return 'expected a register or an immediate as the second operand';
      return withShift('ands', [R(zr(a[0])), R(a[0].name), R(a[1].name)], 2);
    }
    case 'neg': case 'negs': case 'mvn': {
      if (!isReg(a[0]) || !isReg(a[1])) return 'expected two registers';
      const m = mnemonic === 'neg' ? 'sub' : mnemonic === 'negs' ? 'subs' : 'orn';
      return withShift(m, [R(a[0].name), R(zr(a[0])), R(a[1].name)], 2);
    }
    case 'mul': case 'mneg':
      if (a.length !== 3 || !isReg(a[0]) || !isReg(a[1]) || !isReg(a[2])) return 'expected three registers';
      return done(mnemonic === 'mul' ? 'madd' : 'msub', [R(a[0].name), R(a[1].name), R(a[2].name), R(zr(a[0]))], true);
    case 'lsl': case 'lsr': case 'asr': {
      if (a.length !== 3 || !isReg(a[0]) || !isReg(a[1])) return 'expected two registers and a register or an immediate';
      const s = a[2];
      if (isReg(s)) return done(`${mnemonic}v`, [R(a[0].name), R(a[1].name), R(s.name)], true);
      if (!isImm(s)) return 'expected a register or an immediate as the shift amount';
      const w = a[0].ref.bits;
      if (s.value < 0n || s.value >= BigInt(w)) return `shift amount ${s.value} is outside 0 to ${w - 1}`;
      const n = Number(s.value);
      const head = [R(a[0].name), R(a[1].name)];
      if (mnemonic === 'lsl') return done('ubfm', [...head, I((w - n) % w), I(w - 1 - n)], true);
      return done(mnemonic === 'lsr' ? 'ubfm' : 'sbfm', [...head, I(n), I(w - 1)], true);
    }
    case 'ubfiz': case 'sbfiz': case 'ubfx': case 'sbfx': {
      if (a.length !== 4 || !isReg(a[0]) || !isReg(a[1]) || !isImm(a[2]) || !isImm(a[3])) return 'expected two registers, a bit position, and a width';
      const w = a[0].ref.bits;
      const lsb = Number(a[2].value);
      const width = Number(a[3].value);
      if (!(lsb >= 0 && lsb < w)) return `bit position ${a[2].value} is outside 0 to ${w - 1}`;
      if (!(width >= 1 && width <= w - lsb)) return `width ${a[3].value} is outside 1 to ${w - lsb}`;
      const m = mnemonic.startsWith('u') ? 'ubfm' : 'sbfm';
      const head = [R(a[0].name), R(a[1].name)];
      if (mnemonic.endsWith('iz')) return done(m, [...head, I((w - lsb) % w), I(width - 1)], true);
      return done(m, [...head, I(lsb), I(lsb + width - 1)], true);
    }
    case 'uxtb': case 'uxth': case 'sxtb': case 'sxth': case 'sxtw': {
      if (a.length !== 2 || !isReg(a[0]) || !isReg(a[1])) return 'expected two registers';
      if (a[1].ref.bits !== 32 || a[1].ref.kind === 'sp' || a[0].ref.kind === 'sp') return 'the source must be a W register';
      if (mnemonic.startsWith('u') && a[0].ref.bits !== 32) return `'${mnemonic}' takes W registers`;
      if (mnemonic === 'sxtw' && a[0].ref.bits !== 64) return "'sxtw' takes an X destination";
      const top = mnemonic.endsWith('b') ? 7 : mnemonic.endsWith('h') ? 15 : 31;
      const src = regName(a[1].ref.n, a[0].ref.bits, 'zr');
      return done(mnemonic.startsWith('u') ? 'ubfm' : 'sbfm', [R(a[0].name), R(src), I(0), I(top)], true);
    }
    case 'cset': case 'cinc': {
      const n = mnemonic === 'cset' ? 2 : 3;
      const c = a[n - 1];
      if (a.length !== n || !isReg(a[0]) || (n === 3 && !isReg(a[1])) || !c || c.t !== 'ident') return `expected ${n === 2 ? 'a register' : 'two registers'} and a condition`;
      const ci = condIndex(c.name);
      if (ci < 0 || ci >= 14) return `'${c.name}' is not a condition accepted by '${mnemonic}' (al and nv are excluded)`;
      const src = n === 2 ? zr(a[0]) : (a[1] as RegArg).name;
      return done('csinc', [R(a[0].name), R(src), R(src), { t: 'cond', name: COND_NAMES[ci ^ 1]! }], true);
    }
    default:
      return null;
  }
}

/** Mnemonics of the accepted aliases, for the catalog and the diagnostics. */
export const ALIAS_MNEMONICS = [
  'mov', 'mvn', 'cmp', 'cmn', 'tst', 'neg', 'negs', 'mul', 'mneg', 'lsl', 'lsr', 'asr', 'cset', 'cinc',
  'ubfiz', 'ubfx', 'sbfiz', 'sbfx', 'uxtb', 'uxth', 'sxtb', 'sxth', 'sxtw',
] as const;

/** Parse one instruction or alias. Numeric branch targets are absolute addresses. */
export function parseLine(text: string): ParsedLine {
  const m = /^([A-Za-z][A-Za-z0-9.]*)\s*(.*)$/.exec(text.trim());
  if (!m) return { ok: false, message: `cannot read '${text.trim()}' as an instruction` };
  let mnemonic = m[1]!.toLowerCase();
  if (mnemonic === 'b.cs') mnemonic = 'b.hs';
  if (mnemonic === 'b.cc') mnemonic = 'b.lo';
  const args: Arg[] = [];
  for (const part of splitOperands(m[2]!)) {
    const a = parseArg(part);
    if (typeof a === 'string') return { ok: false, message: a };
    args.push(a);
  }
  let built: Built | string | null;
  if (SPEC_BY_MNEMONIC.has(mnemonic)) built = canonical(mnemonic, args);
  else {
    built = fromAlias(mnemonic, args);
    if (built === null) return { ok: false, message: `'${mnemonic}' is not an A64 instruction or alias implemented by this profile` };
  }
  if (typeof built === 'string') return { ok: false, message: `'${mnemonic}': ${built}` };
  const meta: InsnMeta = { region: 'main', irOps: [] };
  if (built.alias) meta.pseudo = { text: text.trim().replace(/\s+/g, ' '), index: 0, count: 1 };
  return { ok: true, items: [{ kind: 'insn', insn: built.insn, meta }] };
}

