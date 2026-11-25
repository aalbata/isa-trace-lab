/**
 * MIPS assembly text: formatting of instructions, parsing of one line, and
 * expansion of the supported pseudoinstructions into MIPS32 instructions.
 * The expansions are the ones chosen by Clang's integrated assembler.
 */
import { hex } from '../../util/int32.ts';
import { parseNumber, splitOperands } from '../assemble.ts';
import type { AsmItem, AsmOperand, Insn, ParsedLine } from '../types.ts';
import { ENCODING_BY_MNEMONIC, REG_NAMES, regIndex } from './isa.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const ZERO = R('$zero');

function formatOperand(o: AsmOperand): string {
  switch (o.t) {
    case 'reg':
      return o.name;
    case 'imm':
      return String(o.value);
    case 'mem':
      return `${o.disp}(${o.base})`;
    case 'label':
      return o.name;
    case 'addr':
      return o.label ?? hex(o.value);
    default:
      return '?';
  }
}

/** Immediates of the logical instructions and of lui are bit patterns and are printed in hexadecimal. */
const HEX_IMMEDIATE = new Set(['andi', 'ori', 'xori', 'lui']);

export function format(insn: Insn): string {
  if (insn.operands.length === 0) return insn.mnemonic;
  const last = insn.operands[insn.operands.length - 1]!;
  if (HEX_IMMEDIATE.has(insn.mnemonic) && last.t === 'imm' && last.value >= 0) {
    const head = insn.operands.slice(0, -1).map(formatOperand).join(', ');
    return `${insn.mnemonic} ${head}, 0x${last.value.toString(16)}`;
  }
  return `${insn.mnemonic} ${insn.operands.map(formatOperand).join(', ')}`;
}

/** The no-operation instruction: sll $zero, $zero, 0, which is the all-zero word. */
export const NOP: Insn = { mnemonic: 'sll', operands: [ZERO, ZERO, I(0)] };

/**
 * Instructions that load a 32-bit constant. The value is read as a signed
 * 32-bit number: addiu when it fits in 16 signed bits (which includes
 * 4294934528 to 4294967295, read as -32768 to -1), ori when it fits in 16
 * unsigned bits, otherwise lui followed by ori when the low half is nonzero.
 */
export function expandLi(rd: string, value: number): Insn[] {
  const v = value | 0;
  if (v >= -32768 && v <= 32767) return [{ mnemonic: 'addiu', operands: [R(rd), ZERO, I(v)] }];
  if (v >= 0 && v <= 65535) return [{ mnemonic: 'ori', operands: [R(rd), ZERO, I(v)] }];
  const out: Insn[] = [{ mnemonic: 'lui', operands: [R(rd), I(v >>> 16)] }];
  if ((v & 0xffff) !== 0) out.push({ mnemonic: 'ori', operands: [R(rd), R(rd), I(v & 0xffff)] });
  return out;
}

/** Expansion of the pseudoinstruction b: beq with $zero as both registers. */
export function expandB(target: AsmOperand): Insn[] {
  return [{ mnemonic: 'beq', operands: [ZERO, ZERO, target] }];
}

/** Expansion of beqz and bnez: beq or bne that compares the register with $zero. */
export function expandBranchZero(pseudo: 'beqz' | 'bnez', rs: AsmOperand, target: AsmOperand): Insn[] {
  return [{ mnemonic: pseudo === 'beqz' ? 'beq' : 'bne', operands: [rs, ZERO, target] }];
}

type Arg = AsmOperand;

interface PseudoRule {
  operands: number;
  expand(a: Arg[]): Insn[] | string;
}

function needReg(a: Arg | undefined): a is { t: 'reg'; name: string } {
  return a !== undefined && a.t === 'reg';
}

function regs(a: Arg[], n: number): boolean {
  for (let i = 0; i < n; i++) if (!needReg(a[i])) return false;
  return true;
}

function isTarget(a: Arg | undefined): boolean {
  return a !== undefined && (a.t === 'label' || a.t === 'addr');
}

const branchZero = (pseudo: 'beqz' | 'bnez'): PseudoRule => ({
  operands: 2,
  expand: (a) => (regs(a, 1) && isTarget(a[1]) ? expandBranchZero(pseudo, a[0]!, a[1]!) : 'expected a register and a target'),
});

/** Pseudoinstructions accepted by the assembler, with their expansions. */
export const PSEUDO: Record<string, PseudoRule[]> = {
  nop: [{ operands: 0, expand: () => [NOP] }],
  li: [{
    operands: 2,
    expand: (a) => {
      if (!needReg(a[0]) || a[1]!.t !== 'imm') return 'expected a register and an integer';
      const v = a[1]!.value;
      if (v < -2147483648 || v > 4294967295) return `${v} does not fit in 32 bits`;
      return expandLi(a[0].name, v);
    },
  }],
  move: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'or', operands: [a[0]!, a[1]!, ZERO] }] : 'expected two registers') }],
  negu: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'subu', operands: [a[0]!, ZERO, a[1]!] }] : 'expected two registers') }],
  not: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'nor', operands: [a[0]!, a[1]!, ZERO] }] : 'expected two registers') }],
  b: [{ operands: 1, expand: (a) => (isTarget(a[0]) ? expandB(a[0]!) : 'expected a target') }],
  beqz: [branchZero('beqz')],
  bnez: [branchZero('bnez')],
};

/** Preferred pseudoinstruction spelling of a real instruction, or null when there is none. */
export function aliasOf(insn: Insn): string | null {
  const o = insn.operands;
  const name = (i: number): string => (o[i]?.t === 'reg' ? (o[i] as { name: string }).name : '');
  switch (insn.mnemonic) {
    case 'sll':
      return name(0) === '$zero' && name(1) === '$zero' && o[2]?.t === 'imm' && o[2].value === 0 ? 'nop' : null;
    case 'or':
    case 'addu':
      return name(2) === '$zero' ? `move ${name(0)}, ${name(1)}` : null;
    case 'subu':
      return name(1) === '$zero' ? `negu ${name(0)}, ${name(2)}` : null;
    case 'nor':
      return name(2) === '$zero' ? `not ${name(0)}, ${name(1)}` : null;
    case 'addiu':
      return name(1) === '$zero' && o[2]?.t === 'imm' ? `li ${name(0)}, ${o[2].value}` : null;
    case 'ori':
      return name(1) === '$zero' && o[2]?.t === 'imm' && o[2].value > 32767 ? `li ${name(0)}, ${o[2].value}` : null;
    case 'beq':
      if (name(0) === '$zero' && name(1) === '$zero') return `b ${formatOperand(o[2]!)}`;
      return name(1) === '$zero' ? `beqz ${name(0)}, ${formatOperand(o[2]!)}` : null;
    case 'bne':
      return name(1) === '$zero' ? `bnez ${name(0)}, ${formatOperand(o[2]!)}` : null;
    default:
      return null;
  }
}

function parseOperand(text: string): AsmOperand | string {
  const t = text.trim();
  if (t === '') return 'missing operand';
  const mm = /^(.*)\(\s*(\$?[A-Za-z0-9]+)\s*\)$/.exec(t);
  if (mm) {
    const base = regIndex(mm[2]!);
    if (base < 0) return `unknown register '${mm[2]}'; register names begin with $`;
    const dispText = mm[1]!.trim();
    const disp = dispText === '' ? 0 : parseNumber(dispText);
    if (disp === null) return `'${dispText}' is not an integer offset`;
    return { t: 'mem', base: REG_NAMES[base]!, disp };
  }
  if (t.startsWith('$')) {
    const r = regIndex(t);
    if (r < 0) return `unknown register '${t}'`;
    return R(REG_NAMES[r]!);
  }
  const n = parseNumber(t);
  if (n !== null) return I(n);
  if (regIndex('$' + t) >= 0) return `'${t}' is not a register name; register names begin with $, as in $${t.toLowerCase()}`;
  if (/^[A-Za-z_.][\w.$]*$/.test(t)) return { t: 'label', name: t };
  return `cannot read operand '${t}'`;
}

/** Parse one instruction or pseudoinstruction. Numeric branch and jump targets are absolute addresses. */
export function parseLine(text: string): ParsedLine {
  const m = /^([A-Za-z.][A-Za-z0-9.]*)\s*(.*)$/.exec(text.trim());
  if (!m) return { ok: false, message: `cannot read '${text.trim()}' as an instruction` };
  const mnemonic = m[1]!.toLowerCase();
  const args: AsmOperand[] = [];
  for (const part of splitOperands(m[2]!)) {
    const o = parseOperand(part);
    if (typeof o === 'string') return { ok: false, message: o };
    args.push(o);
  }
  const meta = { region: 'main' as const, irOps: [] as number[] };
  const asTarget = (o: AsmOperand): AsmOperand => (o.t === 'imm' ? { t: 'addr', value: o.value } : o);
  const withTarget = (): AsmOperand[] => args.map((a, i) => (i === args.length - 1 ? asTarget(a) : a));

  const enc = ENCODING_BY_MNEMONIC.get(mnemonic);
  if (enc) {
    let operands = args;
    if (enc.format === 'B1' || enc.format === 'B2' || enc.format === 'J') {
      if (args.length > 0) operands = withTarget();
    } else if (enc.format === 'JALR' && args.length === 1) {
      // jalr rs is shorthand for jalr $ra, rs.
      operands = [R('$ra'), args[0]!];
    }
    return { ok: true, items: [{ kind: 'insn', insn: { mnemonic, operands }, meta }] };
  }

  const rules = Object.hasOwn(PSEUDO, mnemonic) ? PSEUDO[mnemonic] : undefined;
  if (rules) {
    const rule = rules.find((r) => r.operands === args.length);
    if (!rule) return { ok: false, message: `'${mnemonic}' takes ${rules.map((r) => r.operands).join(' or ')} operand(s), found ${args.length}` };
    const targeted = mnemonic.startsWith('b') ? withTarget() : args;
    const expansion = rule.expand(targeted);
    if (typeof expansion === 'string') return { ok: false, message: `'${mnemonic}': ${expansion}` };
    const pseudoText = m[2]!.trim() === '' ? mnemonic : `${mnemonic} ${args.map(formatOperand).join(', ')}`;
    const items: AsmItem[] = expansion.map((insn, index) => ({
      kind: 'insn', insn, meta: { ...meta, irOps: [], pseudo: { text: pseudoText, index, count: expansion.length } },
    }));
    return { ok: true, items };
  }
  return { ok: false, message: `'${mnemonic}' is not a MIPS32 instruction implemented by this profile or a supported pseudoinstruction` };
}
