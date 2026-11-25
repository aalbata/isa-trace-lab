/**
 * AArch64 processor model for the A64 subset. Each step fetches four bytes
 * from the code region, decodes them, and applies the instruction semantics to
 * the general-purpose registers, the stack pointer, the flags N, Z, C, V,
 * memory, and the program counter.
 *
 * Registers are 64 bits wide and are held as two 32-bit halves, so the 32-bit
 * forms, which the compiler generates, run without BigInt arithmetic. The
 * 64-bit forms compute with BigInt.
 *
 * Modelling choices:
 *  - an instruction fetch from an address that is not a multiple of 4 raises a
 *    PC alignment fault; the branch to that address (br, blr, ret) has
 *    completed, as in the architecture;
 *  - data accesses need no alignment, and stack-pointer alignment is not checked;
 *  - svc changes no register; it advances the program counter and returns the
 *    service stop.
 */
import { bytesToWordLE, hex, hex64 } from '../../util/int32.ts';
import type { Memory } from '../memory.ts';
import { MemoryFault } from '../memory.ts';
import type { Cpu, CpuSnapshot, StepEvent, Stop } from '../types.ts';
import type { Raw } from './decode.ts';
import { decodeWord, toInsn } from './decode.ts';
import { condHolds, parseReg, regName } from './isa.ts';
import { format } from './text.ts';

const M64 = 0xffffffffffffffffn;
const TWO32 = 4294967296;

/** The 64-bit value whose upper and lower 32 bits are `high` and `low`. */
const join64 = (high: number, low: number): bigint => (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);

interface Snapshot {
  lo: Int32Array;
  hi: Int32Array;
  flags: number[];
  written: number;
  pcHigh: number;
}

export class Aarch64Cpu implements Cpu {
  /** Low and high halves of x0 to x30; index 31 is the stack pointer. */
  private lo = new Int32Array(32);
  private hi = new Int32Array(32);
  private n = 0;
  private z = 0;
  private c = 0;
  private v = 0;
  private written = 0;
  private pcLow = 0;
  /** Upper 32 bits of the program counter; nonzero only after a branch outside the 32-bit address space. */
  private pcHigh = 0;
  private mem: Memory;

  constructor(mem: Memory) {
    this.mem = mem;
  }

  /** Low 32 bits of the program counter. */
  get pc(): number {
    return this.pcLow;
  }

  set pc(value: number) {
    this.pcLow = value >>> 0;
    this.pcHigh = 0;
  }

  reset(entry: number, stackPointer: number): void {
    this.lo.fill(0);
    this.hi.fill(0);
    this.n = this.z = this.c = this.v = 0;
    this.written = 0;
    this.pc = entry;
    this.lo[31] = stackPointer | 0;
  }

  private get64(r: number): bigint {
    return (BigInt(this.hi[r]! >>> 0) << 32n) | BigInt(this.lo[r]! >>> 0);
  }

  private set64(r: number, value: bigint): void {
    this.lo[r] = Number(value & 0xffffffffn) | 0;
    this.hi[r] = Number((value >> 32n) & 0xffffffffn) | 0;
    this.written |= 1 << r;
  }

  readReg(name: string): bigint {
    if (name === 'pc') return join64(this.pcHigh, this.pcLow);
    const r = parseReg(name);
    if (!r) throw new Error(`unknown register '${name}'`);
    if (r.kind === 'zr') return 0n;
    return r.bits === 64 ? this.get64(r.n) : BigInt(this.lo[r.n]! >>> 0);
  }

  /** Write a register by name. A write to a W name clears the upper 32 bits; a write to the zero register is discarded. */
  writeReg(name: string, value: bigint): void {
    if (name === 'pc') {
      const v = BigInt.asUintN(64, value);
      this.pcLow = Number(v & 0xffffffffn);
      this.pcHigh = Number(v >> 32n);
      return;
    }
    const r = parseReg(name);
    if (!r) throw new Error(`unknown register '${name}'`);
    if (r.kind === 'zr') return;
    this.set64(r.n, BigInt.asUintN(r.bits, value));
  }

  reg32(name: string): number {
    const r = parseReg(name);
    if (!r) throw new Error(`unknown register '${name}'`);
    return r.kind === 'zr' ? 0 : this.lo[r.n]!;
  }

  readFlags(): Record<string, number> {
    return { N: this.n, Z: this.z, C: this.c, V: this.v };
  }

  writeFlag(name: string, value: number): void {
    const bit = value ? 1 : 0;
    if (name === 'N') this.n = bit;
    else if (name === 'Z') this.z = bit;
    else if (name === 'C') this.c = bit;
    else if (name === 'V') this.v = bit;
    else throw new Error(`unknown flag '${name}'`);
  }

  wasWritten(name: string): boolean {
    const r = parseReg(name);
    return r !== null && r.kind !== 'zr' && (this.written & (1 << r.n)) !== 0;
  }

  snapshot(): CpuSnapshot {
    const data: Snapshot = { lo: this.lo.slice(), hi: this.hi.slice(), flags: [this.n, this.z, this.c, this.v], written: this.written, pcHigh: this.pcHigh };
    return { pc: this.pcLow, data };
  }

  restore(s: CpuSnapshot): void {
    const d = s.data as Snapshot;
    this.lo.set(d.lo);
    this.hi.set(d.hi);
    [this.n, this.z, this.c, this.v] = d.flags as [number, number, number, number];
    this.written = d.written;
    this.pcLow = s.pc >>> 0;
    this.pcHigh = d.pcHigh;
  }

  step(ev?: StepEvent): Stop | null {
    const pc = this.pcLow;
    const { lo, hi, mem } = this;
    // A faulting instruction leaves the program counter where it is, so until the step completes the
    // event reports the address of the instruction itself as the next program counter.
    if (ev) {
      ev.nextPc = pc;
      if (this.pcHigh !== 0) ev.nextPc64 = this.readReg('pc');
    }
    try {
      if (pc & 3) return { kind: 'fault', message: `PC alignment fault: instruction address ${hex64(this.readReg('pc'))} is not a multiple of 4` };
      if (this.pcHigh !== 0) return { kind: 'fault', message: `instruction fetch outside the code region at ${hex64(this.readReg('pc'))}` };
      const fetched = mem.fetch(pc, 4);
      if (fetched.length < 4) return { kind: 'fault', message: `instruction fetch runs past the end of the code region at ${hex(pc)}` };
      const word = bytesToWordLE(fetched, 0);
      const d = decodeWord(word);
      if (ev) {
        ev.pc = pc;
        ev.length = 4;
        ev.bytes = Array.from(fetched);
      }
      if ('kind' in d) {
        if (ev) ev.text = `.word ${hex(word)}`;
        return { kind: 'fault', message: `${d.kind === 'invalid' ? 'undefined' : 'unimplemented'} instruction ${hex(word)} at ${hex(pc)}: ${d.message}` };
      }
      const r: Raw = d;
      const sf = r.sf;
      const bits: 32 | 64 = sf ? 64 : 32;
      const klass = r.spec.klass;
      const code = r.spec.code;
      if (ev) ev.text = format(toInsn(r, pc));

      // Register access. `sp` selects the stack pointer for register 31; otherwise 31 reads as zero and discards writes.
      const read32 = (n: number, sp: boolean): number => {
        const value = n === 31 && !sp ? 0 : lo[n]!;
        if (ev) ev.regReads.push({ reg: regName(n, 32, sp ? 'sp' : 'zr'), value: BigInt(value >>> 0) });
        return value;
      };
      const read64 = (n: number, sp: boolean): bigint => {
        const value = n === 31 && !sp ? 0n : this.get64(n);
        if (ev) ev.regReads.push({ reg: regName(n, 64, sp ? 'sp' : 'zr'), value });
        return value;
      };
      const write64 = (n: number, sp: boolean, value: bigint): void => {
        if (n === 31 && !sp) return;
        if (ev) ev.regWrites.push({ reg: regName(n, 64, 'sp'), before: this.get64(n), value });
        this.set64(n, value);
      };
      /** Write a W register: the upper 32 bits of the X register become zero. */
      const write32 = (n: number, sp: boolean, value: number): void => {
        if (n === 31 && !sp) return;
        if (ev) ev.regWrites.push({ reg: regName(n, 64, 'sp'), before: this.get64(n), value: BigInt(value >>> 0) });
        lo[n] = value;
        hi[n] = 0;
        this.written |= 1 << n;
      };
      const flagsBefore = ev ? this.readFlags() : undefined;
      const setFlags = (n: number, z: number, c: number, v: number): void => {
        this.n = n;
        this.z = z;
        this.c = c;
        this.v = v;
        if (ev) ev.flags = { before: flagsBefore!, after: this.readFlags() };
      };
      const alu = (op: string, a: bigint | number, b: bigint | number, result: bigint | number): void => {
        if (!ev) return;
        const wide = (x: bigint | number): bigint => (typeof x === 'bigint' ? x : BigInt(x >>> 0));
        ev.klass = 'alu';
        ev.alu = { op, a: wide(a), b: wide(b), result: wide(result) };
      };
      const shift32 = (x: number, type: number, amount: number): number => {
        if (amount === 0) return x;
        switch (type) {
          case 0: return x << amount;
          case 1: return (x >>> amount) | 0;
          case 2: return x >> amount;
          default: return (x >>> amount) | (x << (32 - amount));
        }
      };
      const shift64 = (x: bigint, type: number, amount: number): bigint => {
        const k = BigInt(amount);
        if (amount === 0) return x;
        switch (type) {
          case 0: return (x << k) & M64;
          case 1: return x >> k;
          case 2: return BigInt.asUintN(64, BigInt.asIntN(64, x) >> k);
          default: return ((x >> k) | (x << (64n - k))) & M64;
        }
      };
      /** a + b + carry in 32 bits, setting the flags when requested. */
      const add32 = (a: number, b: number, carry: number, flags: boolean): number => {
        const wide = (a >>> 0) + (b >>> 0) + carry;
        const result = wide | 0;
        if (flags) setFlags(result < 0 ? 1 : 0, result === 0 ? 1 : 0, wide >= TWO32 ? 1 : 0, ((a ^ result) & (b ^ result)) < 0 ? 1 : 0);
        return result;
      };
      const add64 = (a: bigint, b: bigint, carry: bigint, flags: boolean): bigint => {
        const wide = a + b + carry;
        const result = wide & M64;
        if (flags) setFlags(Number(result >> 63n), result === 0n ? 1 : 0, wide > M64 ? 1 : 0, Number(((a ^ result) & (b ^ result)) >> 63n));
        return result;
      };

      let next = (pc + 4) >>> 0;
      let nextHigh = 0;
      let stop: Stop | null = null;
      const jumpTo = (low: number, high: number, conditional: boolean, taken: boolean): void => {
        if (ev) {
          ev.klass = conditional ? 'branch' : 'jump';
          ev.branch = { conditional, taken, target: low };
          if (high !== 0) ev.branch.target64 = join64(high, low);
        }
        if (taken) {
          next = low;
          nextHigh = high;
        }
      };
      /** PC-relative branch. A target below zero wraps in the 64-bit address space. */
      const direct = (conditional: boolean, taken: boolean): void => {
        const target = pc + r.imm;
        jumpTo(target >>> 0, target < 0 ? 0xffffffff : target >= TWO32 ? 1 : 0, conditional, taken);
      };

      switch (klass) {
        case 'addsub': {
          const flags = (code & 1) === 1;
          const subtract = (code & 2) === 2;
          const name = subtract ? 'subtract' : 'add';
          const immediate = r.form === 'imm';
          if (sf) {
            const a = read64(r.rn, immediate);
            const b = immediate ? BigInt(r.imm) << BigInt(r.imm2) : shift64(read64(r.rm, false), r.shift, r.imm2);
            const result = subtract ? add64(a, ~b & M64, 1n, flags) : add64(a, b, 0n, flags);
            alu(name, a, b, result);
            write64(r.rd, immediate && !flags, result);
          } else {
            const a = read32(r.rn, immediate);
            const b = immediate ? r.imm << r.imm2 : shift32(read32(r.rm, false), r.shift, r.imm2);
            const result = subtract ? add32(a, ~b, 1, flags) : add32(a, b, 0, flags);
            alu(name, a, b, result);
            write32(r.rd, immediate && !flags, result);
          }
          break;
        }
        case 'logic':
        case 'logicn': {
          const immediate = r.form === 'imm';
          const m = r.spec.mnemonic;
          const op = m === 'and' || m === 'ands' || m === 'bic' ? 'and' : m === 'eor' ? 'xor' : 'or';
          if (sf) {
            const a = read64(r.rn, false);
            let b = immediate ? r.value : shift64(read64(r.rm, false), r.shift, r.imm2);
            if (klass === 'logicn') b = ~b & M64;
            const result = op === 'and' ? a & b : op === 'or' ? a | b : a ^ b;
            if (m === 'ands') setFlags(Number(result >> 63n), result === 0n ? 1 : 0, 0, 0);
            alu(op, a, b, result);
            write64(r.rd, immediate && m !== 'ands', result);
          } else {
            const a = read32(r.rn, false);
            let b = immediate ? Number(r.value) | 0 : shift32(read32(r.rm, false), r.shift, r.imm2);
            if (klass === 'logicn') b = ~b;
            const result = op === 'and' ? a & b : op === 'or' ? a | b : a ^ b;
            if (m === 'ands') setFlags(result < 0 ? 1 : 0, result === 0 ? 1 : 0, 0, 0);
            alu(op, a, b, result);
            write32(r.rd, immediate && m !== 'ands', result);
          }
          break;
        }
        case 'movw': {
          const m = r.spec.mnemonic;
          const chunk = BigInt(r.imm) << BigInt(r.imm2);
          let result: bigint;
          if (m === 'movz') result = chunk;
          else if (m === 'movn') result = ~chunk & (sf ? M64 : 0xffffffffn);
          else {
            const old = sf ? read64(r.rd, false) : BigInt(read32(r.rd, false) >>> 0);
            result = (old & ~(0xffffn << BigInt(r.imm2))) | chunk;
          }
          alu(m === 'movk' ? 'insert 16 bits' : 'load constant', 0n, chunk, result);
          if (sf) write64(r.rd, false, result);
          else write32(r.rd, false, Number(result) | 0);
          break;
        }
        case 'shiftv': {
          const name = ['shift left', 'shift right logical', 'shift right arithmetic'][code]!;
          if (sf) {
            const a = read64(r.rn, false);
            const count = Number(read64(r.rm, false) & 63n);
            const result = shift64(a, code, count);
            alu(name, a, BigInt(count), result);
            write64(r.rd, false, result);
          } else {
            const a = read32(r.rn, false);
            const count = read32(r.rm, false) & 31;
            const result = shift32(a, code, count);
            alu(name, a, count, result);
            write32(r.rd, false, result);
          }
          break;
        }
        case 'bitfield': {
          // UBFM and SBFM: when imms >= immr, extract imms - immr + 1 bits starting at bit immr; otherwise place
          // the low imms + 1 bits at bit (size - immr). The rest is filled with zeros or with the sign.
          const signed = r.spec.mnemonic === 'sbfm';
          const size = BigInt(bits);
          const immr = BigInt(r.imm);
          const imms = BigInt(r.imm2);
          const src = sf ? read64(r.rn, false) : BigInt(read32(r.rn, false) >>> 0);
          let width: bigint;
          let position: bigint;
          let field: bigint;
          if (imms >= immr) {
            width = imms - immr + 1n;
            position = 0n;
            field = (src >> immr) & ((1n << width) - 1n);
          } else {
            width = imms + 1n;
            position = size - immr;
            field = src & ((1n << width) - 1n);
          }
          let result = field << position;
          if (signed && (field >> (width - 1n)) & 1n) result |= (M64 << (position + width)) & M64;
          result &= sf ? M64 : 0xffffffffn;
          alu(signed ? 'bitfield move, signed' : 'bitfield move, unsigned', src, (immr << 8n) | imms, result);
          if (sf) write64(r.rd, false, result);
          else write32(r.rd, false, Number(result) | 0);
          break;
        }
        case 'mul': {
          const subtract = code === 1;
          if (sf) {
            const a = read64(r.rn, false);
            const b = read64(r.rm, false);
            const acc = read64(r.ra, false);
            const result = BigInt.asUintN(64, subtract ? acc - a * b : acc + a * b);
            alu('multiply', a, b, result);
            write64(r.rd, false, result);
          } else {
            const a = read32(r.rn, false);
            const b = read32(r.rm, false);
            const acc = read32(r.ra, false);
            const product = Math.imul(a, b);
            const result = subtract ? (acc - product) | 0 : (acc + product) | 0;
            alu('multiply', a, b, result);
            write32(r.rd, false, result);
          }
          break;
        }
        case 'csel': {
          const holds = condHolds(r.cond, this.n, this.z, this.c, this.v);
          if (sf) {
            const a = read64(r.rn, false);
            const b = read64(r.rm, false);
            const result = holds ? a : code === 1 ? (b + 1n) & M64 : b;
            alu('select', a, b, result);
            write64(r.rd, false, result);
          } else {
            const a = read32(r.rn, false);
            const b = read32(r.rm, false);
            const result = holds ? a : code === 1 ? (b + 1) | 0 : b;
            alu('select', a, b, result);
            write32(r.rd, false, result);
          }
          break;
        }
        case 'b':
          if (code === 1) write64(30, false, BigInt(next));
          direct(false, true);
          break;
        case 'bcond':
          direct(true, condHolds(r.cond, this.n, this.z, this.c, this.v));
          break;
        case 'cb': {
          const zero = sf ? read64(r.rd, false) === 0n : read32(r.rd, false) === 0;
          direct(true, code === 0 ? zero : !zero);
          break;
        }
        case 'breg': {
          const target = read64(r.rn, false);
          if (code === 1) write64(30, false, BigInt(next));
          jumpTo(Number(target & 0xffffffffn), Number(target >> 32n), false, true);
          break;
        }
        case 'mem': {
          const load = (code & 1) === 1;
          const size = r.size as 1 | 2 | 4 | 8;
          const what = load ? 'load from' : 'store to';
          let address: number;
          if (!ev && hi[r.rn] === 0 && (r.form === 'uimm' || r.option === 2)) {
            // Base below 2^32 with a constant offset or a zero-extended 32-bit index: the sum is exact in a number.
            const off = r.form === 'uimm' ? r.imm : ((r.rm === 31 ? 0 : lo[r.rm]!) >>> 0) * (r.s ? size : 1);
            address = (lo[r.rn]! >>> 0) + off;
            if (address >= TWO32) return { kind: 'fault', message: `${what} unmapped address ${hex64(BigInt(address))}` };
          } else {
            const base = read64(r.rn, true);
            let off: bigint;
            if (r.form === 'uimm') off = BigInt(r.imm);
            else {
              const index = r.option & 1 ? read64(r.rm, false) : BigInt(read32(r.rm, false) >>> 0);
              const extended = r.option === 6 ? BigInt.asUintN(64, BigInt.asIntN(32, index)) : index;
              off = (extended << BigInt(r.s ? Math.log2(size) : 0)) & M64;
            }
            const address64 = (base + off) & M64;
            if (address64 > 0xffffffffn) return { kind: 'fault', message: `${what} unmapped address ${hex64(address64)}` };
            address = Number(address64);
            if (ev) ev.alu = { op: 'address', a: base, b: off, result: address64 };
          }
          if (ev) ev.klass = load ? 'load' : 'store';
          // An 8-byte access is two 4-byte accesses in the memory model. When the 8 bytes are not inside one
          // region, the access to the half that is outside raises the fault before anything is transferred.
          if (size === 8 && !mem.regionOf(address, 8)) {
            const outside = mem.regionOf(address, 4) ? address + 4 : address;
            if (load) mem.read(outside, 4);
            else mem.write(outside, 4, 0);
          }
          if (load) {
            if (size === 8) {
              const value = mem.read64(address);
              if (ev) ev.memReads.push({ address, size, value });
              write64(r.rd, false, value);
            } else {
              const value = mem.read(address, size);
              if (ev) ev.memReads.push({ address, size, value: BigInt(value) });
              write32(r.rd, false, value | 0);
            }
          } else {
            let before = 0n;
            if (ev) {
              const old = mem.peek(address, size);
              if (old) for (let i = size - 1; i >= 0; i--) before = (before << 8n) | BigInt(old[i]!);
            }
            if (size === 8) {
              const value = read64(r.rd, false);
              mem.write64(address, value);
              if (ev) ev.memWrites.push({ address, size, before, value });
            } else {
              const value = read32(r.rd, false);
              mem.write(address, size, value);
              if (ev) ev.memWrites.push({ address, size, before, value: BigInt(value >>> 0) & (size === 4 ? 0xffffffffn : size === 2 ? 0xffffn : 0xffn) });
            }
          }
          break;
        }
        case 'svc':
          stop = { kind: 'service' };
          if (ev) ev.klass = 'service';
          break;
        case 'nop':
          break;
      }
      if (ev) {
        ev.nextPc = next;
        if (nextHigh !== 0) ev.nextPc64 = join64(nextHigh, next);
      }
      this.pcLow = next;
      this.pcHigh = nextHigh;
      return stop;
    } catch (e) {
      if (e instanceof MemoryFault) return { kind: 'fault', message: e.message };
      throw e;
    }
  }
}
