/**
 * RISC-V assembly text: formatting of instructions, parsing of one line, and
 * expansion of the supported pseudoinstructions into RV32I instructions.
 */
import { hex, signExtend } from '../../util/int32.ts';
import { parseNumber, splitOperands } from '../assemble.ts';
import type { AsmItem, AsmOperand, Insn, ParsedLine } from '../types.ts';
import { ENCODING_BY_MNEMONIC, REG_NAMES, regIndex } from './isa.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const ZERO = R('zero');

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

export function format(insn: Insn): string {
  if (insn.operands.length === 0) return insn.mnemonic;
  if ((insn.mnemonic === 'lui' || insn.mnemonic === 'auipc') && insn.operands[1]?.t === 'imm') {
    return `${insn.mnemonic} ${formatOperand(insn.operands[0]!)}, 0x${insn.operands[1].value.toString(16)}`;
  }
  return `${insn.mnemonic} ${insn.operands.map(formatOperand).join(', ')}`;
}

/** Instructions that load a 32-bit constant: addi alone, or lui followed by addi when needed. */
export function expandLi(rd: string, value: number): Insn[] {
  const v = value | 0;
  if (v >= -2048 && v <= 2047) return [{ mnemonic: 'addi', operands: [R(rd), ZERO, I(v)] }];
  const lo = signExtend(v & 0xfff, 12);
  const hi = ((v - lo) >>> 12) & 0xfffff;
  const out: Insn[] = [{ mnemonic: 'lui', operands: [R(rd), I(hi)] }];
  if (lo !== 0) out.push({ mnemonic: 'addi', operands: [R(rd), R(rd), I(lo)] });
  return out;
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

const branchZero = (mnemonic: string, zeroFirst: boolean): PseudoRule => ({
  operands: 2,
  expand: (a) => (regs(a, 1) && isTarget(a[1]) ? [{ mnemonic, operands: zeroFirst ? [ZERO, a[0]!, a[1]!] : [a[0]!, ZERO, a[1]!] }] : 'expected a register and a target'),
});
const branchSwap = (mnemonic: string): PseudoRule => ({
  operands: 3,
  expand: (a) => (regs(a, 2) && isTarget(a[2]) ? [{ mnemonic, operands: [a[1]!, a[0]!, a[2]!] }] : 'expected two registers and a target'),
});

/** Pseudoinstructions accepted by the assembler, with their expansions. */
export const PSEUDO: Record<string, PseudoRule[]> = {
  nop: [{ operands: 0, expand: () => [{ mnemonic: 'addi', operands: [ZERO, ZERO, I(0)] }] }],
  li: [{
    operands: 2,
    expand: (a) => {
      if (!needReg(a[0]) || a[1]!.t !== 'imm') return 'expected a register and an integer';
      const v = a[1]!.value;
      if (v < -2147483648 || v > 4294967295) return `${v} does not fit in 32 bits`;
      return expandLi(a[0].name, v);
    },
  }],
  mv: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'addi', operands: [a[0]!, a[1]!, I(0)] }] : 'expected two registers') }],
  not: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'xori', operands: [a[0]!, a[1]!, I(-1)] }] : 'expected two registers') }],
  neg: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'sub', operands: [a[0]!, ZERO, a[1]!] }] : 'expected two registers') }],
  seqz: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'sltiu', operands: [a[0]!, a[1]!, I(1)] }] : 'expected two registers') }],
  snez: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'sltu', operands: [a[0]!, ZERO, a[1]!] }] : 'expected two registers') }],
  sltz: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'slt', operands: [a[0]!, a[1]!, ZERO] }] : 'expected two registers') }],
  sgtz: [{ operands: 2, expand: (a) => (regs(a, 2) ? [{ mnemonic: 'slt', operands: [a[0]!, ZERO, a[1]!] }] : 'expected two registers') }],
  beqz: [branchZero('beq', false)],
  bnez: [branchZero('bne', false)],
  bgez: [branchZero('bge', false)],
  bltz: [branchZero('blt', false)],
  blez: [branchZero('bge', true)],
  bgtz: [branchZero('blt', true)],
  bgt: [branchSwap('blt')],
  ble: [branchSwap('bge')],
  bgtu: [branchSwap('bltu')],
  bleu: [branchSwap('bgeu')],
  j: [{ operands: 1, expand: (a) => (isTarget(a[0]) ? [{ mnemonic: 'jal', operands: [ZERO, a[0]!] }] : 'expected a target') }],
  jr: [{ operands: 1, expand: (a) => (needReg(a[0]) ? [{ mnemonic: 'jalr', operands: [ZERO, { t: 'mem', base: a[0].name, disp: 0 }] }] : 'expected a register') }],
  ret: [{ operands: 0, expand: () => [{ mnemonic: 'jalr', operands: [ZERO, { t: 'mem', base: 'ra', disp: 0 }] }] }],
};

/** Preferred pseudoinstruction spelling of a real instruction, or null when there is none. */
export function aliasOf(insn: Insn): string | null {
  const o = insn.operands;
  const name = (i: number): string => (o[i]?.t === 'reg' ? (o[i] as { name: string }).name : '');
  switch (insn.mnemonic) {
    case 'addi':
      if (name(0) === 'zero' && name(1) === 'zero' && o[2]?.t === 'imm' && o[2].value === 0) return 'nop';
      if (name(1) === 'zero' && o[2]?.t === 'imm') return `li ${name(0)}, ${o[2].value}`;
      if (o[2]?.t === 'imm' && o[2].value === 0) return `mv ${name(0)}, ${name(1)}`;
      return null;
    case 'xori':
      return o[2]?.t === 'imm' && o[2].value === -1 ? `not ${name(0)}, ${name(1)}` : null;
    case 'sub':
      return name(1) === 'zero' ? `neg ${name(0)}, ${name(2)}` : null;
    case 'sltiu':
      return o[2]?.t === 'imm' && o[2].value === 1 ? `seqz ${name(0)}, ${name(1)}` : null;
    case 'sltu':
      return name(1) === 'zero' ? `snez ${name(0)}, ${name(2)}` : null;
    case 'beq':
      return name(1) === 'zero' ? `beqz ${name(0)}, ${formatOperand(o[2]!)}` : null;
    case 'bne':
      return name(1) === 'zero' ? `bnez ${name(0)}, ${formatOperand(o[2]!)}` : null;
    case 'blt':
      if (name(1) === 'zero') return `bltz ${name(0)}, ${formatOperand(o[2]!)}`;
      return name(0) === 'zero' ? `bgtz ${name(1)}, ${formatOperand(o[2]!)}` : null;
    case 'bge':
      if (name(1) === 'zero') return `bgez ${name(0)}, ${formatOperand(o[2]!)}`;
      return name(0) === 'zero' ? `blez ${name(1)}, ${formatOperand(o[2]!)}` : null;
    case 'slt':
      if (name(2) === 'zero') return `sltz ${name(0)}, ${name(1)}`;
      return name(1) === 'zero' ? `sgtz ${name(0)}, ${name(2)}` : null;
    case 'jal':
      return name(0) === 'zero' ? `j ${formatOperand(o[1]!)}` : null;
    case 'jalr': {
      const m = o[1];
      if (m?.t === 'mem' && m.disp === 0 && name(0) === 'zero') return m.base === 'ra' ? 'ret' : `jr ${m.base}`;
      return null;
    }
    default:
      return null;
  }
}

function parseOperand(text: string): AsmOperand | string {
  const t = text.trim();
  if (t === '') return 'missing operand';
  const mm = /^(.*)\(\s*([A-Za-z0-9]+)\s*\)$/.exec(t);
  if (mm) {
    const base = regIndex(mm[2]!);
    if (base < 0) return `unknown register '${mm[2]}'`;
    const dispText = mm[1]!.trim();
    const disp = dispText === '' ? 0 : parseNumber(dispText);
    if (disp === null) return `'${dispText}' is not an integer offset`;
    return { t: 'mem', base: REG_NAMES[base]!, disp };
  }
  const r = regIndex(t);
  if (r >= 0) return R(REG_NAMES[r]!);
  const n = parseNumber(t);
  if (n !== null) return I(n);
  if (/^[A-Za-z_.$][\w.$]*$/.test(t)) return { t: 'label', name: t };
  return `cannot read operand '${t}'`;
}

/** Instructions of the RV32I base listing (FENCE, FENCE.TSO, PAUSE, and EBREAK) that the profile leaves out. */
const UNIMPLEMENTED_BASE = new Set(['fence', 'fence.tso', 'pause', 'ebreak']);

/** Parse one instruction or pseudoinstruction. Numeric branch and jump targets are absolute addresses. */
export function parseLine(text: string): ParsedLine {
  const m = /^([A-Za-z.]+)\s*(.*)$/.exec(text.trim());
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

  const enc = ENCODING_BY_MNEMONIC.get(mnemonic);
  if (enc) {
    let operands = args;
    if (enc.format === 'B' && args.length === 3) operands = [args[0]!, args[1]!, asTarget(args[2]!)];
    else if (enc.format === 'J') {
      // jal label is shorthand for jal ra, label.
      if (args.length === 1) operands = [R('ra'), asTarget(args[0]!)];
      else if (args.length === 2) operands = [args[0]!, asTarget(args[1]!)];
    } else if (enc.format === 'JR') {
      // Accepted forms: jalr rd, offset(rs1); jalr rd, rs1, offset; jalr rs1.
      if (args.length === 1 && args[0]!.t === 'reg') operands = [R('ra'), { t: 'mem', base: args[0]!.name, disp: 0 }];
      else if (args.length === 3 && args[1]!.t === 'reg' && args[2]!.t === 'imm') {
        operands = [args[0]!, { t: 'mem', base: args[1]!.name, disp: args[2]!.value }];
      }
    }
    return { ok: true, items: [{ kind: 'insn', insn: { mnemonic, operands }, meta }] };
  }

  // Only the table's own entries are pseudoinstructions, not names inherited from Object.prototype.
  const rules = Object.hasOwn(PSEUDO, mnemonic) ? PSEUDO[mnemonic] : undefined;
  if (rules) {
    const rule = rules.find((r) => r.operands === args.length);
    if (!rule) return { ok: false, message: `'${mnemonic}' takes ${rules.map((r) => r.operands).join(' or ')} operand(s), found ${args.length}` };
    const targeted = args.map((a, i) => (i === args.length - 1 && /^(b|j$)/.test(mnemonic) ? asTarget(a) : a));
    const expansion = rule.expand(targeted);
    if (typeof expansion === 'string') return { ok: false, message: `'${mnemonic}': ${expansion}` };
    const pseudoText = m[2]!.trim() === '' ? mnemonic : `${mnemonic} ${args.map(formatOperand).join(', ')}`;
    const items: AsmItem[] = expansion.map((insn, index) => ({
      kind: 'insn', insn, meta: { ...meta, irOps: [], pseudo: { text: pseudoText, index, count: expansion.length } },
    }));
    return { ok: true, items };
  }
  if (UNIMPLEMENTED_BASE.has(mnemonic)) {
    return { ok: false, message: `'${mnemonic}' is an RV32I base instruction that this profile does not implement` };
  }
  return { ok: false, message: `'${mnemonic}' is not an RV32I instruction or a supported pseudoinstruction` };
}
