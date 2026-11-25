/**
 * Bounded little-endian memory made of three regions: code, data, and stack.
 * The same layout is used for every target. Program accesses outside the
 * regions, stores to the code region, and instruction fetches outside the code
 * region raise a MemoryFault, which the processor models report as a fault.
 * The data and stack regions, which a program can store to, record which of
 * their bytes have been written.
 */
import { hexAddress } from '../util/int32.ts';

export const LAYOUT = {
  codeBase: 0x00400000,
  codeSize: 0x10000,
  dataBase: 0x10000000,
  dataSize: 0x10000,
  /** Initial stack pointer; the stack region ends here and grows downward. */
  stackTop: 0x7ffff000,
  stackSize: 0x10000,
} as const;

/** Service numbers of the execution environment (not operating-system calls). */
export const SERVICE = {
  /** Append the signed 32-bit argument to the output. */
  print: 1,
  /** End the program; the argument is the return value of main. */
  exit: 2,
  /** End the program with a runtime error; the argument is the error code. */
  error: 3,
} as const;

export function serviceName(n: number): string {
  return n === SERVICE.print ? 'print' : n === SERVICE.exit ? 'exit' : n === SERVICE.error ? 'error' : 'unknown';
}

export type RegionName = 'code' | 'data' | 'stack';

interface Region {
  name: RegionName;
  base: number;
  size: number;
  bytes: Uint8Array;
  /**
   * One flag per byte of a load-and-store region, set when a store of an
   * executed instruction or a debugger edit writes the byte. The machine clears
   * the flags on reset and loads the program image without setting them, so a
   * flagged byte holds a value that was written since the reset. Null for the
   * code region, which a program cannot store to.
   */
  written: Uint8Array | null;
}

export class MemoryFault extends Error {
  address: number;
  constructor(message: string, address: number) {
    super(message);
    this.address = address;
  }
}

function hex(a: number): string {
  return '0x' + (a >>> 0).toString(16).padStart(8, '0');
}

export class Memory {
  readonly code: Region;
  readonly data: Region;
  readonly stack: Region;
  /** Counts of program loads and stores to the data and stack regions. */
  loads = 0;
  stores = 0;

  constructor() {
    this.code = { name: 'code', base: LAYOUT.codeBase, size: LAYOUT.codeSize, bytes: new Uint8Array(LAYOUT.codeSize), written: null };
    this.data = {
      name: 'data', base: LAYOUT.dataBase, size: LAYOUT.dataSize, bytes: new Uint8Array(LAYOUT.dataSize), written: new Uint8Array(LAYOUT.dataSize),
    };
    this.stack = {
      name: 'stack', base: LAYOUT.stackTop - LAYOUT.stackSize, size: LAYOUT.stackSize, bytes: new Uint8Array(LAYOUT.stackSize),
      written: new Uint8Array(LAYOUT.stackSize),
    };
  }

  regionOf(address: number, length: number): Region | null {
    for (const r of [this.code, this.data, this.stack]) {
      if (address >= r.base && address + length <= r.base + r.size) return r;
    }
    return null;
  }

  private locate(address: number, length: number, write: boolean): Region {
    if (!Number.isInteger(address) || address < 0) throw new MemoryFault(`memory access at an address outside the 32-bit space`, 0);
    const r = this.regionOf(address, length);
    if (!r) throw new MemoryFault(`${write ? 'store to' : 'load from'} unmapped address ${hex(address)}`, address);
    if (write && r.name === 'code') throw new MemoryFault(`store to the read-only code region at ${hex(address)}`, address);
    return r;
  }

  read(address: number, size: 1 | 2 | 4): number {
    const r = this.locate(address, size, false);
    const o = address - r.base;
    const b = r.bytes;
    this.loads++;
    if (size === 1) return b[o]!;
    if (size === 2) return b[o]! | (b[o + 1]! << 8);
    return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
  }

  write(address: number, size: 1 | 2 | 4, value: number): void {
    const r = this.locate(address, size, true);
    const o = address - r.base;
    const b = r.bytes;
    this.stores++;
    b[o] = value & 0xff;
    if (size >= 2) b[o + 1] = (value >>> 8) & 0xff;
    if (size === 4) {
      b[o + 2] = (value >>> 16) & 0xff;
      b[o + 3] = (value >>> 24) & 0xff;
    }
    // A store reaches only the data and stack regions, which have flags.
    const w = r.written!;
    for (let i = o; i < o + size; i++) w[i] = 1;
  }

  read64(address: number): bigint {
    const lo = this.read(address, 4);
    const hi = this.read(address + 4, 4);
    this.loads--;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  write64(address: number, value: bigint): void {
    this.write(address, 4, Number(value & 0xffffffffn));
    this.write(address + 4, 4, Number((value >> 32n) & 0xffffffffn));
    this.stores--;
  }

  /**
   * Bytes available for an instruction fetch at `address`, at most `max`.
   * Throws when the address is outside the code region.
   */
  fetch(address: number, max: number): Uint8Array {
    const r = this.code;
    if (!Number.isInteger(address) || address < r.base || address >= r.base + r.size) {
      throw new MemoryFault(`instruction fetch outside the code region at ${hexAddress(address)}`, address >>> 0);
    }
    const o = address - r.base;
    return r.bytes.subarray(o, Math.min(o + max, r.size));
  }

  /** Debugger access without permission checks or access counting; returns null when unmapped. */
  peek(address: number, length: number): Uint8Array | null {
    const r = this.regionOf(address, length);
    if (!r) return null;
    const o = address - r.base;
    return r.bytes.subarray(o, o + length);
  }

  /** Debugger edit without permission checks or access counting; returns false when unmapped. The bytes count as written. */
  poke(address: number, bytes: ArrayLike<number>): boolean {
    const r = this.regionOf(address, bytes.length);
    if (!r) return false;
    r.bytes.set(bytes, address - r.base);
    r.written?.fill(1, address - r.base, address - r.base + bytes.length);
    return true;
  }

  /**
   * Place the bytes of a program image, as the loader does; returns false when
   * they do not fit one region. The bytes do not count as written.
   */
  loadImage(address: number, bytes: ArrayLike<number>): boolean {
    const r = this.regionOf(address, bytes.length);
    if (!r) return false;
    r.bytes.set(bytes, address - r.base);
    return true;
  }

  peek32(address: number): number | null {
    const b = this.peek(address, 4);
    return b ? (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0 : null;
  }

  /**
   * True when the range lies in the data region or in the stack region and
   * every byte of it has been written since the flags were cleared (see
   * `Region.written`). A range in the code region, outside the regions, or
   * across the end of a region has not been written.
   */
  wasWritten(address: number, length: number): boolean {
    const r = Number.isInteger(address) ? this.regionOf(address, length) : null;
    const w = r ? r.written : null;
    if (!r || !w) return false;
    for (let i = address - r.base; i < address - r.base + length; i++) if (w[i] === 0) return false;
    return true;
  }

  /** Forget every recorded write. */
  clearWritten(): void {
    this.data.written!.fill(0);
    this.stack.written!.fill(0);
  }

  snapshot(): { code: Uint8Array; data: Uint8Array; stack: Uint8Array; dataWritten: Uint8Array; stackWritten: Uint8Array; loads: number; stores: number } {
    return {
      code: this.code.bytes.slice(), data: this.data.bytes.slice(), stack: this.stack.bytes.slice(),
      dataWritten: this.data.written!.slice(), stackWritten: this.stack.written!.slice(), loads: this.loads, stores: this.stores,
    };
  }

  restore(s: { code: Uint8Array; data: Uint8Array; stack: Uint8Array; dataWritten: Uint8Array; stackWritten: Uint8Array; loads: number; stores: number }): void {
    this.code.bytes.set(s.code);
    this.data.bytes.set(s.data);
    this.stack.bytes.set(s.stack);
    this.data.written!.set(s.dataWritten);
    this.stack.written!.set(s.stackWritten);
    this.loads = s.loads;
    this.stores = s.stores;
  }
}
