/**
 * x86-64 processor model for the implemented subset in 64-bit mode. Each step
 * fetches up to 15 bytes from the code region, decodes one instruction, and
 * applies its semantics to the sixteen 64-bit registers, the six status
 * flags, memory, and the instruction pointer.
 *
 * Register values are kept as two 32-bit halves so that 32-bit instructions,
 * which are most of the generated code, run without BigInt arithmetic.
 *
 * Choices of this model:
 *  - Flags that the manual leaves undefined receive a fixed value: AF is
 *    cleared by and, or, xor, test, imul, and shifts with a nonzero count;
 *    imul sets SF, ZF, and PF from the truncated product; a shift by more than
 *    one bit sets OF as a one-bit shift of the same kind would on its last step.
 *  - The environment maps only addresses below 2^32. A memory access above
 *    that range faults as an unmapped access, and a return to such an address
 *    faults at the RET instruction.
 *  - SYSCALL copies the address of the next instruction to rcx and the flags
 *    image to r11 (bit 1 set, the six status flags in their EFLAGS positions,
 *    all other bits zero, because the model has no other flags). The service
 *    is then performed by the execution environment, which resumes at the
 *    next instruction with the flags unchanged.
 */
import { hex, hex64 } from '../../util/int32.ts';
import type { Memory } from '../memory.ts';
import { MemoryFault } from '../memory.ts';
import type { Cpu, CpuSnapshot, StepEvent, Stop } from '../types.ts';
import type { Raw, RM } from './decode.ts';
import { decodeRaw, toInsn } from './decode.ts';
import { REG64, regRef } from './isa.ts';
import { format } from './text.ts';

const MASK64 = 0xffffffffffffffffn;
const SIGN64 = 0x8000000000000000n;
const TWO32 = 4294967296;

/** PARITY[b] is 1 when byte b has an even number of one bits. */
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let n = 0;
  for (let b = i; b !== 0; b >>= 1) n += b & 1;
  PARITY[i] = n % 2 === 0 ? 1 : 0;
}

const FLAG_BITS: Record<string, number> = { CF: 0, PF: 2, AF: 4, ZF: 6, SF: 7, OF: 11 };
const u = (x: number): bigint => BigInt(x >>> 0);

export class X86Cpu implements Cpu {
  pc = 0;
  private lo = new Int32Array(16);
  private hi = new Int32Array(16);
  private written = 0;
  private cf = 0;
  private pf = 0;
  private af = 0;
  private zf = 0;
  private sf = 0;
  private of = 0;
  private mem: Memory;

  constructor(mem: Memory) {
    this.mem = mem;
  }

  reset(entry: number, stackPointer: number): void {
    this.lo.fill(0);
    this.hi.fill(0);
    this.written = 0;
    this.cf = this.pf = this.af = this.zf = this.sf = this.of = 0;
    this.pc = entry;
    this.lo[4] = stackPointer | 0;
  }

  private get64(n: number): bigint {
    return (u(this.hi[n]!) << 32n) | u(this.lo[n]!);
  }

  private set64(n: number, v: bigint): void {
    this.lo[n] = Number(BigInt.asIntN(32, v));
    this.hi[n] = Number(BigInt.asIntN(32, v >> 32n));
    this.written |= 1 << n;
  }

  /** A 32-bit write clears the upper half of the register. */
  private set32(n: number, v: number): void {
    this.lo[n] = v;
    this.hi[n] = 0;
    this.written |= 1 << n;
  }

  readReg(name: string): bigint {
    // A pc below zero stands for the address 2^64 + pc.
    if (name === 'rip') return BigInt.asUintN(64, BigInt(this.pc));
    const r = regRef(name);
    if (!r) throw new Error(`unknown register '${name}'`);
    if (r.size === 64) return this.get64(r.num);
    if (r.size === 32) return u(this.lo[r.num]!);
    return BigInt(r.high ? (this.lo[r.num]! >>> 8) & 0xff : this.lo[r.num]! & 0xff);
  }

  writeReg(name: string, value: bigint): void {
    if (name === 'rip') {
      this.pc = Number(BigInt.asUintN(32, value));
      return;
    }
    const r = regRef(name);
    if (!r) throw new Error(`unknown register '${name}'`);
    if (r.size === 64) this.set64(r.num, value);
    else if (r.size === 32) this.set32(r.num, Number(BigInt.asIntN(32, value)));
    else this.set8(r.num, r.high, Number(BigInt.asUintN(8, value)));
  }

  reg32(name: string): number {
    const r = regRef(name);
    if (!r) throw new Error(`unknown register '${name}'`);
    return this.lo[r.num]!;
  }

  readFlags(): Record<string, number> {
    return { OF: this.of, SF: this.sf, ZF: this.zf, AF: this.af, PF: this.pf, CF: this.cf };
  }

  writeFlag(name: string, value: number): void {
    const v = value ? 1 : 0;
    switch (name) {
      case 'CF': this.cf = v; break;
      case 'PF': this.pf = v; break;
      case 'AF': this.af = v; break;
      case 'ZF': this.zf = v; break;
      case 'SF': this.sf = v; break;
      case 'OF': this.of = v; break;
      default: throw new Error(`unknown flag '${name}'`);
    }
  }

  wasWritten(name: string): boolean {
    const r = regRef(name);
    return r !== null && (this.written & (1 << r.num)) !== 0;
  }

  snapshot(): CpuSnapshot {
    return { pc: this.pc, data: { lo: this.lo.slice(), hi: this.hi.slice(), written: this.written, flags: this.flagsImage() } };
  }

  restore(s: CpuSnapshot): void {
    const d = s.data as { lo: Int32Array; hi: Int32Array; written: number; flags: number };
    this.pc = s.pc;
    this.lo.set(d.lo);
    this.hi.set(d.hi);
    this.written = d.written;
    this.cf = d.flags & 1;
    this.pf = (d.flags >> 2) & 1;
    this.af = (d.flags >> 4) & 1;
    this.zf = (d.flags >> 6) & 1;
    this.sf = (d.flags >> 7) & 1;
    this.of = (d.flags >> 11) & 1;
  }

  /** The modeled part of RFLAGS: bit 1 is always set, and the six status flags are in their positions. */
  private flagsImage(): number {
    return 2 | this.cf | (this.pf << 2) | (this.af << 4) | (this.zf << 6) | (this.sf << 7) | (this.of << 11);
  }

  private set8(n: number, high: boolean, v: number): void {
    this.lo[n] = high ? (this.lo[n]! & ~0xff00) | ((v & 0xff) << 8) : (this.lo[n]! & ~0xff) | (v & 0xff);
    this.written |= 1 << n;
  }

  /** Effective address of a memory operand, modulo 2^64. */
  private ea64(m: Extract<RM, { kind: 'mem' }>): bigint {
    let a = BigInt(m.disp);
    if (m.base >= 0) a += this.get64(m.base);
    if (m.index >= 0) a += this.get64(m.index) * BigInt(m.scale);
    return a & MASK64;
  }

  /**
   * Operands of the address computation for the step event: the base register value (0 without a base) and
   * the scaled index plus the displacement, modulo 2^64, so that the two add up to the effective address.
   */
  private addressOperands(m: Extract<RM, { kind: 'mem' }>): { a: bigint; b: bigint } {
    const index = m.index >= 0 ? this.get64(m.index) * BigInt(m.scale) : 0n;
    return { a: m.base >= 0 ? this.get64(m.base) : 0n, b: (index + BigInt(m.disp)) & MASK64 };
  }

  /** Effective address as a number; faults when it lies outside the 4 GiB range that the environment can map. */
  private ea(m: Extract<RM, { kind: 'mem' }>, ev: StepEvent | undefined): number {
    let a = m.disp;
    let wide = false;
    if (m.base >= 0) {
      a += this.lo[m.base]! >>> 0;
      wide = this.hi[m.base] !== 0;
      if (ev) ev.regReads.push({ reg: REG64[m.base]!, value: this.get64(m.base) });
    }
    if (m.index >= 0) {
      a += (this.lo[m.index]! >>> 0) * m.scale;
      wide = wide || this.hi[m.index] !== 0;
      if (ev) ev.regReads.push({ reg: REG64[m.index]!, value: this.get64(m.index) });
    }
    if (wide || a < 0 || a >= TWO32) {
      const full = this.ea64(m);
      if (full > 0xffffffffn) throw new MemoryFault(`memory access at unmapped address ${hex64(full)}`, 0);
      a = Number(full);
    }
    if (ev) ev.alu = { op: 'address', ...this.addressOperands(m), result: BigInt(a) };
    return a;
  }

  private cond(cc: number): boolean {
    let r: boolean;
    switch (cc >> 1) {
      case 0: r = this.of === 1; break;
      case 1: r = this.cf === 1; break;
      case 2: r = this.zf === 1; break;
      case 3: r = this.cf === 1 || this.zf === 1; break;
      case 4: r = this.sf === 1; break;
      case 5: r = this.pf === 1; break;
      case 6: r = this.sf !== this.of; break;
      default: r = this.zf === 1 || this.sf !== this.of; break;
    }
    return (cc & 1) === 1 ? !r : r;
  }

  private zsp32(r: number): void {
    this.zf = r === 0 ? 1 : 0;
    this.sf = r >>> 31;
    this.pf = PARITY[r & 0xff]!;
  }

  private zsp64(r: bigint): void {
    this.zf = r === 0n ? 1 : 0;
    this.sf = (r & SIGN64) !== 0n ? 1 : 0;
    this.pf = PARITY[Number(r & 0xffn)]!;
  }

  /** Result and flags of a 32-bit two-operand operation. */
  private alu32(op: string, a: number, b: number): number {
    let r: number;
    switch (op) {
      case 'add':
        r = (a + b) | 0;
        this.cf = r >>> 0 < a >>> 0 ? 1 : 0;
        this.of = ((a ^ r) & (b ^ r)) < 0 ? 1 : 0;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      case 'sub':
      case 'cmp':
        r = (a - b) | 0;
        this.cf = a >>> 0 < b >>> 0 ? 1 : 0;
        this.of = ((a ^ b) & (a ^ r)) < 0 ? 1 : 0;
        this.af = ((a ^ b ^ r) >> 4) & 1;
        break;
      default:
        r = op === 'or' ? a | b : op === 'xor' ? a ^ b : a & b;
        this.cf = 0;
        this.of = 0;
        this.af = 0;
        break;
    }
    this.zsp32(r);
    return r;
  }

  /** Result and flags of a 64-bit two-operand operation; values are unsigned 64-bit integers. */
  private alu64(op: string, a: bigint, b: bigint): bigint {
    let r: bigint;
    switch (op) {
      case 'add':
        r = (a + b) & MASK64;
        this.cf = r < a ? 1 : 0;
        this.of = ((a ^ r) & (b ^ r) & SIGN64) !== 0n ? 1 : 0;
        this.af = Number(((a ^ b ^ r) >> 4n) & 1n);
        break;
      case 'sub':
      case 'cmp':
        r = (a - b) & MASK64;
        this.cf = a < b ? 1 : 0;
        this.of = ((a ^ b) & (a ^ r) & SIGN64) !== 0n ? 1 : 0;
        this.af = Number(((a ^ b ^ r) >> 4n) & 1n);
        break;
      default:
        r = op === 'or' ? a | b : op === 'xor' ? a ^ b : a & b;
        this.cf = 0;
        this.of = 0;
        this.af = 0;
        break;
    }
    this.zsp64(r);
    return r;
  }

  /** 32-bit shift. The count has been masked to five bits and is not zero. */
  private shift32(op: string, a: number, n: number): number {
    let r: number;
    if (op === 'shl') {
      r = a << n;
      this.cf = (a >>> (32 - n)) & 1;
      this.of = (r >>> 31) ^ this.cf;
    } else if (op === 'shr') {
      r = (a >>> n) | 0;
      this.cf = (a >>> (n - 1)) & 1;
      this.of = n === 1 ? a >>> 31 : 0;
    } else {
      r = a >> n;
      this.cf = (a >> (n - 1)) & 1;
      this.of = 0;
    }
    this.af = 0;
    this.zsp32(r);
    return r;
  }

  /** 64-bit shift. The count has been masked to six bits and is not zero. */
  private shift64(op: string, a: bigint, n: number): bigint {
    const c = BigInt(n);
    let r: bigint;
    if (op === 'shl') {
      r = (a << c) & MASK64;
      this.cf = Number((a >> (64n - c)) & 1n);
      this.of = Number(r >> 63n) ^ this.cf;
    } else if (op === 'shr') {
      r = a >> c;
      this.cf = Number((a >> (c - 1n)) & 1n);
      this.of = n === 1 ? Number(a >> 63n) : 0;
    } else {
      const s = BigInt.asIntN(64, a);
      r = (s >> c) & MASK64;
      this.cf = Number((s >> (c - 1n)) & 1n);
      this.of = 0;
    }
    this.af = 0;
    this.zsp64(r);
    return r;
  }

  step(ev?: StepEvent): Stop | null {
    const pc = this.pc;
    const mem = this.mem;
    const lo = this.lo;
    // A faulting instruction leaves the instruction pointer where it is, so until the step completes the
    // event reports the address of the instruction itself as the next program counter.
    if (ev) ev.nextPc = pc;
    try {
      const fetched = mem.fetch(pc, 15);
      const d = decodeRaw(fetched, 0);
      if ('kind' in d) {
        if (ev) {
          ev.pc = pc;
          ev.length = Math.max(d.length, 1);
          ev.bytes = Array.from(fetched.subarray(0, ev.length));
          ev.text = `.byte ${ev.bytes.map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ')}`;
        }
        if (d.kind === 'truncated') return { kind: 'fault', message: `instruction fetch runs past the end of the code region at ${hex(pc)}` };
        return { kind: 'fault', message: `illegal instruction at ${hex(pc)}: ${d.message}` };
      }
      const flagsBefore = ev ? this.readFlags() : undefined;
      if (ev) {
        ev.pc = pc;
        ev.length = d.length;
        ev.bytes = Array.from(fetched.subarray(0, d.length));
        ev.text = format(toInsn(d, pc));
      }
      const next = pc + d.length;
      let nextPc = next;
      let stop: Stop | null = null;
      let flagsWritten = false;
      const rm = d.rm;
      const isMem = rm !== null && rm.kind === 'mem';
      const rmReg = rm !== null && rm.kind === 'reg' ? rm.reg : 0;
      const wide = d.size === 64;
      // The address is formed once; LEA uses it as a value and does not access memory.
      const addr = isMem && d.op !== 'lea' ? this.ea(rm, ev) : 0;

      const readReg32 = (n: number): number => {
        if (ev) ev.regReads.push({ reg: REG64[n]!, value: this.get64(n) });
        return lo[n]!;
      };
      const readReg64 = (n: number): bigint => {
        const v = this.get64(n);
        if (ev) ev.regReads.push({ reg: REG64[n]!, value: v });
        return v;
      };
      const writeReg32 = (n: number, v: number): void => {
        const before = ev ? this.get64(n) : 0n;
        this.set32(n, v);
        if (ev) ev.regWrites.push({ reg: REG64[n]!, before, value: u(v) });
      };
      const writeReg64 = (n: number, v: bigint): void => {
        const before = ev ? this.get64(n) : 0n;
        this.set64(n, v);
        if (ev) ev.regWrites.push({ reg: REG64[n]!, before, value: v });
      };
      const load32 = (): number => {
        const v = mem.read(addr, 4) | 0;
        if (ev) ev.memReads.push({ address: addr, size: 4, value: u(v) });
        return v;
      };
      const load64 = (): bigint => {
        const v = mem.read64(addr);
        if (ev) ev.memReads.push({ address: addr, size: 8, value: v });
        return v;
      };
      const peek = (size: number): bigint => {
        const old = mem.peek(addr, size);
        let before = 0n;
        if (old) for (let i = size - 1; i >= 0; i--) before = (before << 8n) | BigInt(old[i]!);
        return before;
      };
      const store32 = (v: number): void => {
        const before = ev ? peek(4) : 0n;
        mem.write(addr, 4, v);
        if (ev) ev.memWrites.push({ address: addr, size: 4, before, value: u(v) });
      };
      const store64 = (v: bigint): void => {
        const before = ev ? peek(8) : 0n;
        // The whole quadword must lie in one region, so a fault leaves memory unchanged.
        if (mem.regionOf(addr, 8) === null) throw new MemoryFault(`8-byte store at ${hex(addr)} is not inside a mapped region`, addr);
        mem.write64(addr, v);
        if (ev) ev.memWrites.push({ address: addr, size: 8, before, value: v });
      };
      const rm32 = (): number => (isMem ? load32() : readReg32(rmReg));
      const rm64 = (): bigint => (isMem ? load64() : readReg64(rmReg));
      const setRm32 = (v: number): void => (isMem ? store32(v) : writeReg32(rmReg, v));
      const setRm64 = (v: bigint): void => (isMem ? store64(v) : writeReg64(rmReg, v));
      /** The stack pointer as an address; faults when it lies outside the mapped range. */
      const stackAddress = (delta: number): number => {
        const sp = (this.get64(4) + BigInt(delta)) & MASK64;
        if (sp > 0xffffffffn) throw new MemoryFault(`stack access at unmapped address ${hex64(sp)}`, 0);
        return Number(sp);
      };
      const push64 = (v: bigint): void => {
        const a = stackAddress(-8);
        if (mem.regionOf(a, 8) === null) throw new MemoryFault(`8-byte store at ${hex(a)} is not inside a mapped region`, a);
        const before = ev ? ((): bigint => {
          const old = mem.peek(a, 8)!;
          let x = 0n;
          for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(old[i]!);
          return x;
        })() : 0n;
        mem.write64(a, v);
        if (ev) ev.memWrites.push({ address: a, size: 8, before, value: v });
        writeReg64(4, BigInt(a));
      };
      const pop64 = (): bigint => {
        const a = stackAddress(0);
        const v = mem.read64(a);
        if (ev) ev.memReads.push({ address: a, size: 8, value: v });
        writeReg64(4, (BigInt(a) + 8n) & MASK64);
        return v;
      };
      const klass = (k: StepEvent['klass']): void => {
        if (ev) ev.klass = k;
      };
      const alu = (op: string, a: bigint, b: bigint, result: bigint): void => {
        if (ev) ev.alu = { op, a, b, result };
      };
      const memKlass = (writes: boolean): void => klass(isMem ? (writes ? 'store' : 'load') : 'alu');

      switch (d.op) {
        case 'mov': {
          if (d.form === 'rm_r') {
            if (wide) setRm64(readReg64(d.reg));
            else setRm32(readReg32(d.reg));
            klass(isMem ? 'store' : 'other');
          } else if (d.form === 'r_rm') {
            if (wide) writeReg64(d.reg, rm64());
            else writeReg32(d.reg, rm32());
            klass(isMem ? 'load' : 'other');
          } else if (d.form === 'rm_imm') {
            if (wide) setRm64(BigInt.asUintN(64, BigInt(d.imm)));
            else setRm32(d.imm);
            klass(isMem ? 'store' : 'other');
          } else {
            writeReg32(d.reg, d.imm);
            klass('other');
          }
          break;
        }
        case 'movzx': {
          let v: number;
          if (isMem) {
            v = mem.read(addr, 1);
            if (ev) ev.memReads.push({ address: addr, size: 1, value: BigInt(v) });
          } else {
            const n = d.rmHigh ? rmReg - 4 : rmReg;
            const full = readReg32(n);
            v = d.rmHigh ? (full >>> 8) & 0xff : full & 0xff;
          }
          writeReg32(d.reg, v);
          klass(isMem ? 'load' : 'other');
          break;
        }
        case 'movsxd': {
          const v = rm32();
          writeReg64(d.reg, BigInt.asUintN(64, BigInt(v)));
          klass(isMem ? 'load' : 'other');
          break;
        }
        case 'lea': {
          const m = rm as Extract<RM, { kind: 'mem' }>;
          const full = this.ea64(m);
          if (ev) {
            if (m.base >= 0) ev.regReads.push({ reg: REG64[m.base]!, value: this.get64(m.base) });
            if (m.index >= 0) ev.regReads.push({ reg: REG64[m.index]!, value: this.get64(m.index) });
          }
          const operands = this.addressOperands(m);
          alu('address', operands.a, operands.b, wide ? full : full & 0xffffffffn);
          if (wide) writeReg64(d.reg, full);
          else writeReg32(d.reg, Number(BigInt.asIntN(32, full)));
          klass('alu');
          break;
        }
        case 'add':
        case 'sub':
        case 'and':
        case 'or':
        case 'xor':
        case 'cmp':
        case 'test': {
          const op = d.op === 'test' ? 'and' : d.op;
          const keep = d.op !== 'cmp' && d.op !== 'test';
          const toRm = d.form === 'rm_r' || d.form === 'rm_imm';
          flagsWritten = true;
          if (wide) {
            const a = d.form === 'acc_imm' ? readReg64(0) : toRm ? rm64() : readReg64(d.reg);
            const b = d.form === 'rm_imm' || d.form === 'acc_imm' ? BigInt.asUintN(64, BigInt(d.imm)) : d.form === 'rm_r' ? readReg64(d.reg) : rm64();
            const r = this.alu64(op, a, b);
            alu(d.op, a, b, r);
            if (keep) {
              if (toRm) setRm64(r);
              else writeReg64(d.form === 'acc_imm' ? 0 : d.reg, r);
            }
          } else {
            const a = d.form === 'acc_imm' ? readReg32(0) : toRm ? rm32() : readReg32(d.reg);
            const b = d.form === 'rm_imm' || d.form === 'acc_imm' ? d.imm : d.form === 'rm_r' ? readReg32(d.reg) : rm32();
            const r = this.alu32(op, a, b);
            alu(d.op, u(a), u(b), u(r));
            if (keep) {
              if (toRm) setRm32(r);
              else writeReg32(d.form === 'acc_imm' ? 0 : d.reg, r);
            }
          }
          klass(isMem ? (keep && toRm ? 'store' : 'load') : 'alu');
          break;
        }
        case 'imul': {
          flagsWritten = true;
          if (wide) {
            const a = BigInt.asIntN(64, d.form === 'r_rm' ? readReg64(d.reg) : rm64());
            const b = d.form === 'r_rm' ? BigInt.asIntN(64, rm64()) : BigInt(d.imm);
            const exact = a * b;
            const r = BigInt.asIntN(64, exact);
            this.cf = this.of = exact !== r ? 1 : 0;
            const ur = r & MASK64;
            this.zsp64(ur);
            this.af = 0;
            alu('multiply', a & MASK64, b & MASK64, ur);
            writeReg64(d.reg, ur);
          } else {
            const a = d.form === 'r_rm' ? readReg32(d.reg) : rm32();
            const b = d.form === 'r_rm' ? rm32() : d.imm;
            const r = Math.imul(a, b);
            // The exact product differs from the truncated one exactly when it does not fit in 32 signed bits.
            this.cf = this.of = a * b !== r ? 1 : 0;
            this.zsp32(r);
            this.af = 0;
            alu('multiply', u(a), u(b), u(r));
            writeReg32(d.reg, r);
          }
          klass(isMem ? 'load' : 'alu');
          break;
        }
        case 'neg': {
          flagsWritten = true;
          if (wide) {
            const a = rm64();
            const r = this.alu64('sub', 0n, a);
            alu('negate', 0n, a, r);
            setRm64(r);
          } else {
            const a = rm32();
            const r = this.alu32('sub', 0, a);
            alu('negate', 0n, u(a), u(r));
            setRm32(r);
          }
          memKlass(true);
          break;
        }
        case 'not': {
          if (wide) {
            const a = rm64();
            alu('not', a, 0n, a ^ MASK64);
            setRm64(a ^ MASK64);
          } else {
            const a = rm32();
            alu('not', u(a), 0n, u(~a));
            setRm32(~a);
          }
          memKlass(true);
          break;
        }
        case 'inc':
        case 'dec': {
          // CF is not changed by inc and dec.
          flagsWritten = true;
          const carry = this.cf;
          const op = d.op === 'inc' ? 'add' : 'sub';
          if (wide) {
            const a = rm64();
            const r = this.alu64(op, a, 1n);
            alu(op, a, 1n, r);
            setRm64(r);
          } else {
            const a = rm32();
            const r = this.alu32(op, a, 1);
            alu(op, u(a), 1n, u(r));
            setRm32(r);
          }
          this.cf = carry;
          memKlass(true);
          break;
        }
        case 'shl':
        case 'shr':
        case 'sar': {
          const raw = d.form === 'rm_cl' ? readReg32(1) & 0xff : d.imm;
          const n = raw & (wide ? 63 : 31);
          // A count of zero leaves the flags unchanged; the destination is still written.
          if (n !== 0) flagsWritten = true;
          if (wide) {
            const a = rm64();
            const r = n === 0 ? a : this.shift64(d.op, a, n);
            alu(d.op, a, BigInt(n), r);
            setRm64(r);
          } else {
            const a = rm32();
            const r = n === 0 ? a : this.shift32(d.op, a, n);
            alu(d.op, u(a), BigInt(n), u(r));
            setRm32(r);
          }
          memKlass(true);
          break;
        }
        case 'setcc': {
          const v = this.cond(d.cc) ? 1 : 0;
          if (isMem) {
            const before = ev ? peek(1) : 0n;
            mem.write(addr, 1, v);
            if (ev) ev.memWrites.push({ address: addr, size: 1, before, value: BigInt(v) });
          } else {
            const n = d.rmHigh ? rmReg - 4 : rmReg;
            const before = ev ? this.get64(n) : 0n;
            this.set8(n, d.rmHigh, v);
            if (ev) ev.regWrites.push({ reg: REG64[n]!, before, value: this.get64(n) });
          }
          klass(isMem ? 'store' : 'alu');
          break;
        }
        case 'jcc': {
          const taken = this.cond(d.cc);
          const target = next + d.imm;
          if (ev) {
            ev.klass = 'branch';
            ev.branch = { conditional: true, taken, target };
          }
          if (taken) nextPc = target;
          break;
        }
        case 'jmp': {
          const target = next + d.imm;
          if (ev) {
            ev.klass = 'jump';
            ev.branch = { conditional: false, taken: true, target };
          }
          nextPc = target;
          break;
        }
        case 'call': {
          const target = next + d.imm;
          push64(BigInt(next));
          if (ev) {
            ev.klass = 'jump';
            ev.branch = { conditional: false, taken: true, target };
          }
          nextPc = target;
          break;
        }
        case 'ret': {
          const a = stackAddress(0);
          const target = mem.read64(a);
          mem.loads--;
          if (target > 0xffffffffn) {
            const canonical = BigInt.asIntN(48, target) === BigInt.asIntN(64, target);
            return {
              kind: 'fault',
              message: canonical
                ? `return to ${hex64(target)}, which is outside the address range of this environment`
                : `return to ${hex64(target)}, which is not a canonical address (general-protection exception)`,
            };
          }
          pop64();
          nextPc = Number(target);
          if (ev) {
            ev.klass = 'jump';
            ev.branch = { conditional: false, taken: true, target: nextPc };
          }
          break;
        }
        case 'push': {
          push64(readReg64(d.form === 'rm' ? rmReg : d.reg));
          klass('store');
          break;
        }
        case 'pop': {
          const v = pop64();
          writeReg64(d.form === 'rm' ? rmReg : d.reg, v);
          klass('load');
          break;
        }
        case 'syscall': {
          writeReg64(1, BigInt(next));
          writeReg64(11, BigInt(this.flagsImage()));
          stop = { kind: 'service' };
          klass('service');
          break;
        }
        case 'nop':
          break;
        default:
          return { kind: 'fault', message: `no semantics for '${d.op}'` };
      }
      // A target below zero stays negative and stands for the address 2^64 + target; a target outside the code
      // region faults at the next fetch.
      if (ev) {
        if (flagsWritten) ev.flags = { before: flagsBefore!, after: this.readFlags() };
        ev.nextPc = nextPc;
      }
      this.pc = nextPc;
      return stop;
    } catch (e) {
      if (e instanceof MemoryFault) return { kind: 'fault', message: e.message };
      throw e;
    }
  }
}
