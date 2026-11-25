/**
 * Instruction selection for the A64 subset.
 *
 * Conventions: variables live in w19 to w28, temporaries in w9 to w13, and
 * w14 to w17 are scratch. Source arithmetic uses the 32-bit forms. The address
 * of an array is built in x17 with MOVZ and MOVK, and an element is addressed
 * as base plus zero-extended index times four. Every instruction is emitted in
 * its canonical form; where the architecture defines a preferred alias (mov,
 * cmp, mul, lsl, cset, and others) the alias text is recorded beside it.
 */
import type { BinFn, Pred, UnFn } from '../../ir/ir.ts';
import { SERVICE } from '../memory.ts';
import type { AsmOperand, Emitter, FrameInfo, Home, Insn, Src, TargetLowering } from '../types.ts';
import { encodeBitmask } from './isa.ts';
import { moveImmediate, moveImmediateText } from './text.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const L = (name: string): AsmOperand => ({ t: 'label', name });
const LSL12: AsmOperand = { t: 'shift', kind: 'lsl', amount: 12 };
const one = (mnemonic: string, operands: AsmOperand[]): Insn => ({ mnemonic, operands });

/** Scratch register for constants that do not fit an instruction. */
const S2 = 'w16';
/** Scratch register for addresses. */
const ADDR = 'x17';

/** Largest offset of the unsigned scaled form of a 4-byte load or store. */
const MAX_WORD_OFFSET = 4 * 4095;

/** Load a 32-bit constant into a W register: one instruction when one suffices, otherwise MOVZ and MOVK. */
function loadConstant(e: Emitter, rd: string, value: number, note?: string): void {
  const u = value >>> 0;
  const single = moveImmediate(rd, BigInt(u));
  if (single) {
    e.pseudo(moveImmediateText(rd, BigInt(u)), [single], note);
    return;
  }
  const low = u & 0xffff;
  e.pseudo(moveImmediateText(rd, BigInt(low)), [one('movz', [R(rd), I(low)])], note);
  e.insn('movk', [R(rd), I(u >>> 16), { t: 'shift', kind: 'lsl', amount: 16 }], 'upper 16 bits of the constant');
}

/** Load an address below 2^32 into an X register. */
function loadAddress(e: Emitter, rd: string, address: number, note: string): void {
  const low = address & 0xffff;
  const high = address >>> 16;
  if (high === 0 || low === 0) {
    e.pseudo(moveImmediateText(rd, BigInt(address)), [moveImmediate(rd, BigInt(address))!], note);
    return;
  }
  e.pseudo(moveImmediateText(rd, BigInt(high * 65536)), [one('movz', [R(rd), I(high), { t: 'shift', kind: 'lsl', amount: 16 }])], note);
  e.insn('movk', [R(rd), I(low)], 'lower 16 bits of the address');
}

function mov(e: Emitter, rd: string, rs: string, note?: string): void {
  if (rd === rs) return;
  e.pseudo(`mov ${rd}, ${rs}`, [one('orr', [R(rd), R('wzr'), R(rs)])], note);
}

function movSrc(e: Emitter, rd: string, s: Src, note?: string): void {
  if ('imm' in s) loadConstant(e, rd, s.imm, note);
  else mov(e, rd, s.reg, note);
}

/** Register holding the operand: the register itself, wzr for zero, or `scratch` loaded with the constant. */
function regFor(e: Emitter, s: Src, scratch: string): string {
  if ('reg' in s) return s.reg;
  if (s.imm === 0) return 'wzr';
  loadConstant(e, scratch, s.imm);
  return scratch;
}

/** Immediate operands of ADD or SUB for a magnitude: 0 to 4095, or a multiple of 4096 up to 0xfff000. */
function arithmeticImmediate(magnitude: number): AsmOperand[] | null {
  if (magnitude >= 0 && magnitude <= 4095) return [I(magnitude)];
  if (magnitude > 0 && magnitude % 4096 === 0 && magnitude <= 0xfff000) return [I(magnitude / 4096), LSL12];
  return null;
}

const formatImmediate = (ops: AsmOperand[]): string => `#${(ops[0] as { value: number }).value}${ops.length > 1 ? ', lsl #12' : ''}`;

/** dst = a + value or a - value with an immediate, using the opposite operation for a negative value. Returns false when no immediate form fits. */
function addImmediate(e: Emitter, subtract: boolean, dst: string, a: string, value: number, note?: string): boolean {
  let ops = arithmeticImmediate(value);
  let mnemonic = subtract ? 'sub' : 'add';
  if (!ops) {
    ops = arithmeticImmediate(-value);
    mnemonic = subtract ? 'add' : 'sub';
  }
  if (!ops) return false;
  e.insn(mnemonic, [R(dst), R(a), ...ops], note);
  return true;
}

/** Set the flags for the comparison of a with b: SUBS (cmp), or ADDS (cmn) when the negated constant fits. */
function compare(e: Emitter, a: string, b: Src): void {
  if ('imm' in b) {
    const plus = arithmeticImmediate(b.imm);
    if (plus) {
      e.pseudo(`cmp ${a}, ${formatImmediate(plus)}`, [one('subs', [R('wzr'), R(a), ...plus])]);
      return;
    }
    // For a constant from -1 down, a + (-b) sets the same flags as a - b. Zero is excluded above, where the carries differ.
    const minus = arithmeticImmediate(-b.imm);
    if (minus) {
      e.pseudo(`cmn ${a}, ${formatImmediate(minus)}`, [one('adds', [R('wzr'), R(a), ...minus])], `compare with ${b.imm}`);
      return;
    }
  }
  const rb = regFor(e, b, S2);
  e.pseudo(`cmp ${a}, ${rb}`, [one('subs', [R('wzr'), R(a), R(rb)])]);
}

const CONDITION: Record<Pred, string> = { eq: 'eq', ne: 'ne', lt: 'lt', le: 'le', gt: 'gt', ge: 'ge', ltu: 'lo', leu: 'ls', gtu: 'hi', geu: 'hs' };
const INVERSE: Record<string, string> = { eq: 'ne', ne: 'eq', lt: 'ge', ge: 'lt', gt: 'le', le: 'gt', lo: 'hs', hs: 'lo', hi: 'ls', ls: 'hi' };

/** Memory operand for element `index` of an array; emits the instructions that load the array address into x17. */
function element(e: Emitter, arrayId: number, index: Src): AsmOperand {
  const address = e.arrayAddress(arrayId);
  if ('imm' in index) {
    const disp = 4 * index.imm;
    if (disp >= 0 && disp <= MAX_WORD_OFFSET) {
      loadAddress(e, ADDR, address, 'address of the array');
      return { t: 'mem', base: ADDR, disp };
    }
    loadAddress(e, ADDR, address + disp, 'address of the element');
    return { t: 'mem', base: ADDR, disp: 0 };
  }
  loadAddress(e, ADDR, address, 'address of the array');
  return { t: 'mem', base: ADDR, disp: 0, index: index.reg, ext: 'uxtw', shift: 2 };
}

/** Memory operand for a stack slot. A slot beyond the reach of the scaled offset is addressed through x17. */
function slot(e: Emitter, offset: number): AsmOperand {
  if (offset <= MAX_WORD_OFFSET) return { t: 'mem', base: 'sp', disp: offset };
  e.insn('add', [R(ADDR), R('sp'), I(offset >>> 12), LSL12], 'address of the stack slot');
  return { t: 'mem', base: ADDR, disp: offset & 0xfff };
}

/** Adjust sp by the frame size, in two steps when the size does not fit one immediate. */
function adjustStack(e: Emitter, mnemonic: 'add' | 'sub', size: number, note: string): void {
  if (size >= 4096) e.insn(mnemonic, [R('sp'), R('sp'), I(size >>> 12), LSL12], note);
  if ((size & 0xfff) !== 0) e.insn(mnemonic, [R('sp'), R('sp'), I(size & 0xfff)], note);
}

function service(e: Emitter, number: number, note: string): void {
  loadConstant(e, 'w8', number, note);
  e.insn('svc', [I(0)]);
}

export const aarch64Lowering: TargetLowering = {
  needsLinkSave: () => false,

  frame(slotCount: number): FrameInfo {
    const size = Math.ceil((4 * slotCount) / 16) * 16;
    if (size > 0xffffff) throw new Error(`the stack frame of ${size} bytes exceeds the 16 MiB that two stack adjustments can express`);
    return { size, slotOffsets: Array.from({ length: slotCount }, (_, i) => 4 * i), linkOffset: null };
  },

  startup(e: Emitter): void {
    e.insn('bl', [L('main')], 'call main; the return address goes to x30');
    service(e, SERVICE.exit, 'exit service; w0 holds the return value');
  },

  prologue(e: Emitter, frame: FrameInfo, params: Home[]): void {
    if (frame.size > 0) adjustStack(e, 'sub', frame.size, 'allocate the stack frame');
    params.forEach((h, i) => {
      const arg = `w${i}`;
      if (h.kind === 'reg') mov(e, h.reg, arg, 'parameter to its home register');
      else e.insn('str', [R(arg), slot(e, frame.slotOffsets[h.index]!)], 'parameter to its stack slot');
    });
  },

  ret(e: Emitter, frame: FrameInfo, value: Src): void {
    movSrc(e, 'w0', value, 'return value');
    if (frame.size > 0) adjustStack(e, 'add', frame.size, 'release the stack frame');
    e.pseudo('ret', [one('ret', [R('x30')])], 'return to the caller');
  },

  loadSlot(e: Emitter, dst: string, offset: number): void {
    e.insn('ldr', [R(dst), slot(e, offset)], 'load from stack slot');
  },

  storeSlot(e: Emitter, src: string, offset: number): void {
    e.insn('str', [R(src), slot(e, offset)], 'store to stack slot');
  },

  mov(e: Emitter, dst: string, src: Src): void {
    movSrc(e, dst, src);
  },

  un(e: Emitter, fn: UnFn, dst: string, a: string): void {
    if (fn === 'neg') e.pseudo(`neg ${dst}, ${a}`, [one('sub', [R(dst), R('wzr'), R(a)])]);
    else if (fn === 'not') e.pseudo(`mvn ${dst}, ${a}`, [one('orn', [R(dst), R('wzr'), R(a)])]);
    else e.insn('eor', [R(dst), R(a), I(1)], 'Boolean negation');
  },

  bin(e: Emitter, fn: BinFn, dst: string, a: string, b: Src): void {
    if ('imm' in b) {
      const v = b.imm;
      switch (fn) {
        case 'add':
          if (addImmediate(e, false, dst, a, v, v < 0 ? `add ${v}` : undefined)) return;
          break;
        case 'sub':
          if (addImmediate(e, true, dst, a, v, v < 0 ? `subtract ${v}` : undefined)) return;
          break;
        case 'and': case 'or': case 'xor':
          if (encodeBitmask(BigInt(v >>> 0), 32)) return e.insn({ and: 'and', or: 'orr', xor: 'eor' }[fn], [R(dst), R(a), I(v >>> 0)]);
          break;
        case 'shl':
          if (v === 0) return mov(e, dst, a);
          return e.pseudo(`lsl ${dst}, ${a}, #${v}`, [one('ubfm', [R(dst), R(a), I(32 - v), I(31 - v)])]);
        case 'sar':
          return e.pseudo(`asr ${dst}, ${a}, #${v}`, [one('sbfm', [R(dst), R(a), I(v), I(31)])]);
        default:
          break;
      }
    }
    const rb = regFor(e, b, S2);
    switch (fn) {
      case 'mul': return e.pseudo(`mul ${dst}, ${a}, ${rb}`, [one('madd', [R(dst), R(a), R(rb), R('wzr')])]);
      case 'shl': return e.pseudo(`lsl ${dst}, ${a}, ${rb}`, [one('lslv', [R(dst), R(a), R(rb)])]);
      case 'sar': return e.pseudo(`asr ${dst}, ${a}, ${rb}`, [one('asrv', [R(dst), R(a), R(rb)])]);
      case 'add': return e.insn('add', [R(dst), R(a), R(rb)]);
      case 'sub': return e.insn('sub', [R(dst), R(a), R(rb)]);
      case 'and': return e.insn('and', [R(dst), R(a), R(rb)]);
      case 'or': return e.insn('orr', [R(dst), R(a), R(rb)]);
      case 'xor': return e.insn('eor', [R(dst), R(a), R(rb)]);
    }
  },

  cmpSet(e: Emitter, pred: Pred, dst: string, a: string, b: Src): void {
    compare(e, a, b);
    const cond = CONDITION[pred];
    e.pseudo(`cset ${dst}, ${cond}`, [one('csinc', [R(dst), R('wzr'), R('wzr'), { t: 'cond', name: INVERSE[cond]! }])], `1 when ${cond} holds, else 0`);
  },

  branch(e: Emitter, pred: Pred, a: string, b: Src, label: string): void {
    if ('imm' in b && b.imm === 0 && (pred === 'eq' || pred === 'ne')) {
      e.insn(pred === 'eq' ? 'cbz' : 'cbnz', [R(a), L(label)]);
      return;
    }
    compare(e, a, b);
    e.insn(`b.${CONDITION[pred]}`, [L(label)]);
  },

  jump(e: Emitter, label: string): void {
    e.insn('b', [L(label)]);
  },

  load(e: Emitter, dst: string, arrayId: number, index: Src): void {
    e.insn('ldr', [R(dst), element(e, arrayId, index)], 'load array element');
  },

  store(e: Emitter, value: Src, arrayId: number, index: Src): void {
    // A constant value is loaded into w16 before the address is formed in x17; zero is stored from wzr.
    const rv = regFor(e, value, S2);
    e.insn('str', [R(rv), element(e, arrayId, index)], 'store array element');
  },

  print(e: Emitter, a: Src): void {
    movSrc(e, 'w0', a, 'value to print');
    service(e, SERVICE.print, 'output service');
  },

  trap(e: Emitter, code: number): void {
    loadConstant(e, 'w0', code, 'error code');
    service(e, SERVICE.error, 'error service');
  },

  helpers(): void {
    // The subset needs no runtime helper: multiplication is one instruction.
  },
};
