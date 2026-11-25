/**
 * Instruction selection for x86-64.
 *
 * Conventions: variables live in ebx, ebp, and r12d to r15d, temporaries in
 * r8d to r10d, esi, and edi, and eax, edx, ecx, and r11d are scratch. All
 * source arithmetic uses 32-bit operands; a 32-bit write clears the upper half
 * of the register, so a register that holds an array index can be used with
 * its 64-bit name in an address. Instructions have two operands, so
 * `dst = a op b` is a move followed by the operation. Arrays are addressed
 * absolutely: the address of element 0 is the displacement of the operand.
 */
import type { BinFn, Pred, UnFn } from '../../ir/ir.ts';
import { SERVICE } from '../memory.ts';
import type { AsmOperand, Emitter, FrameInfo, Home, Src, TargetLowering } from '../types.ts';
import { REG64, REG8, regRef } from './isa.ts';

const R = (name: string): AsmOperand => ({ t: 'reg', name });
const I = (value: number): AsmOperand => ({ t: 'imm', value });
const L = (name: string): AsmOperand => ({ t: 'label', name });
const SLOT = (offset: number): AsmOperand => ({ t: 'mem', base: 'rsp', disp: offset, size: 32 });

/** Scratch register for the count of a shift (its low byte is cl). */
const S2 = 'ecx';
/** Scratch register that holds operand b when the destination overwrites it. */
const S3 = 'r11d';

/** Condition suffix of jcc and setcc for each predicate, evaluated after `cmp a, b`. */
const CC: Record<Pred, string> = { eq: 'e', ne: 'ne', lt: 'l', le: 'le', gt: 'g', ge: 'ge', ltu: 'b', leu: 'be', gtu: 'a', geu: 'ae' };

const low8 = (reg: string): string => REG8[regRef(reg)!.num]!;
const full64 = (reg: string): string => REG64[regRef(reg)!.num]!;
const operand = (s: Src): AsmOperand => ('imm' in s ? I(s.imm) : R(s.reg));

function mov(e: Emitter, dst: string, src: Src, note?: string): void {
  if ('reg' in src && src.reg === dst) return;
  e.insn('mov', [R(dst), operand(src)], note);
}

/** Memory operand for element `index` of an array. */
function element(e: Emitter, arrayId: number, index: Src): AsmOperand {
  const address = e.arrayAddress(arrayId);
  if ('imm' in index) return { t: 'mem', base: null, disp: address + 4 * index.imm, size: 32 };
  return { t: 'mem', base: null, index: full64(index.reg), scale: 4, disp: address, size: 32 };
}

export const x86Lowering: TargetLowering = {
  /** CALL keeps the return address on the stack, so there is nothing for the prologue to save. */
  needsLinkSave(): boolean {
    return false;
  },

  frame(slotCount: number): FrameInfo {
    // At entry to main rsp is 8 below a multiple of 16, because CALL pushed the return address.
    const size = slotCount === 0 ? 0 : 16 * Math.max(0, Math.ceil((4 * slotCount - 8) / 16)) + 8;
    return { size, slotOffsets: Array.from({ length: slotCount }, (_, i) => 4 * i), linkOffset: null };
  },

  startup(e: Emitter): void {
    e.insn('call', [L('main')], 'call main; the return address is pushed on the stack');
    e.insn('mov', [R('edi'), R('eax')], 'return value of main is the argument of the exit service');
    e.insn('mov', [R('eax'), I(SERVICE.exit)], 'exit service');
    e.insn('syscall', []);
  },

  prologue(e: Emitter, frame: FrameInfo, params: Home[]): void {
    if (frame.size > 0) e.insn('sub', [R('rsp'), I(frame.size)], 'allocate the stack frame');
    const args = ['edi', 'esi', 'edx', 'ecx'];
    params.forEach((h, i) => {
      if (h.kind === 'reg') mov(e, h.reg, { reg: args[i]! }, 'parameter to its home register');
      else e.insn('mov', [SLOT(frame.slotOffsets[h.index]!), R(args[i]!)], 'parameter to its stack slot');
    });
  },

  ret(e: Emitter, frame: FrameInfo, value: Src): void {
    mov(e, 'eax', value, 'return value');
    if (frame.size > 0) e.insn('add', [R('rsp'), I(frame.size)], 'release the stack frame');
    e.insn('ret', [], 'pop the return address and jump to it');
  },

  loadSlot(e: Emitter, dst: string, offset: number): void {
    e.insn('mov', [R(dst), SLOT(offset)], 'load from stack slot');
  },

  storeSlot(e: Emitter, src: string, offset: number): void {
    e.insn('mov', [SLOT(offset), R(src)], 'store to stack slot');
  },

  mov(e: Emitter, dst: string, src: Src): void {
    mov(e, dst, src);
  },

  un(e: Emitter, fn: UnFn, dst: string, a: string): void {
    mov(e, dst, { reg: a });
    if (fn === 'neg') e.insn('neg', [R(dst)]);
    else if (fn === 'not') e.insn('not', [R(dst)]);
    else e.insn('xor', [R(dst), I(1)], 'Boolean negation');
  },

  bin(e: Emitter, fn: BinFn, dst: string, a: string, b: Src): void {
    if (fn === 'shl' || fn === 'sar') {
      if ('imm' in b) {
        mov(e, dst, { reg: a });
        e.insn(fn, [R(dst), I(b.imm)]);
        return;
      }
      // A variable count must be in cl. It is copied first, because the destination may be the count register.
      mov(e, S2, b, 'shift count to cl');
      mov(e, dst, { reg: a });
      e.insn(fn, [R(dst), R('cl')]);
      return;
    }
    if (fn === 'mul') {
      if ('imm' in b) e.insn('imul', [R(dst), R(a), I(b.imm)]);
      else if (dst === b.reg) e.insn('imul', [R(dst), R(a)], 'multiplication is commutative');
      else {
        mov(e, dst, { reg: a });
        e.insn('imul', [R(dst), R(b.reg)]);
      }
      return;
    }
    if ('reg' in b && dst === b.reg && dst !== a) {
      if (fn === 'sub') {
        // The destination holds operand b, so b is saved before the destination receives a.
        mov(e, S3, b, 'keep operand b');
        mov(e, dst, { reg: a });
        e.insn('sub', [R(dst), R(S3)]);
      } else e.insn(fn, [R(dst), R(a)], 'the operation is commutative');
      return;
    }
    mov(e, dst, { reg: a });
    e.insn(fn, [R(dst), operand(b)]);
  },

  cmpSet(e: Emitter, pred: Pred, dst: string, a: string, b: Src): void {
    e.insn('cmp', [R(a), operand(b)]);
    e.insn(`set${CC[pred]}`, [R(low8(dst))], 'low byte = 1 when the condition holds, else 0');
    e.insn('movzx', [R(dst), R(low8(dst))], 'zero-extend the byte');
  },

  branch(e: Emitter, pred: Pred, a: string, b: Src, label: string): void {
    e.insn('cmp', [R(a), operand(b)]);
    e.insn(`j${CC[pred]}`, [L(label)]);
  },

  jump(e: Emitter, label: string): void {
    e.insn('jmp', [L(label)]);
  },

  load(e: Emitter, dst: string, arrayId: number, index: Src): void {
    e.insn('mov', [R(dst), element(e, arrayId, index)], 'load array element');
  },

  store(e: Emitter, value: Src, arrayId: number, index: Src): void {
    e.insn('mov', [element(e, arrayId, index), operand(value)], 'store array element');
  },

  print(e: Emitter, a: Src): void {
    mov(e, 'edi', a, 'value to print');
    e.insn('mov', [R('eax'), I(SERVICE.print)], 'output service');
    e.insn('syscall', []);
  },

  trap(e: Emitter, code: number): void {
    e.insn('mov', [R('edi'), I(code)], 'error code');
    e.insn('mov', [R('eax'), I(SERVICE.error)], 'error service');
    e.insn('syscall', []);
  },

  helpers(): void {
    // The subset has a multiply instruction, so no runtime helper is needed.
  },
};
