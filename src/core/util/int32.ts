/**
 * Fixed-width integer helpers.
 *
 * A 32-bit value is held in a JavaScript number in one of two forms:
 * the signed form in [-2^31, 2^31 - 1] and the unsigned form in [0, 2^32 - 1].
 * The conversions below are exact for every integer argument whose magnitude
 * is below 2^53, because ToInt32 and ToUint32 reduce modulo 2^32.
 */

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;
export const UINT32_MAX = 4294967295;
export const TWO32 = 4294967296;

/** Signed interpretation of the low 32 bits of an integer. */
export function s32(x: number): number {
  return x | 0;
}

/** Unsigned interpretation of the low 32 bits of an integer. */
export function u32(x: number): number {
  return x >>> 0;
}

/** Wrap an exact mathematical integer to its signed 32-bit interpretation. */
export function wrapBig(z: bigint): number {
  return Number(BigInt.asIntN(32, z));
}

/** Addition modulo 2^32; the operands are below 2^32 in magnitude so the sum is exact. */
export function add32(a: number, b: number): number {
  return (a + b) | 0;
}

export function sub32(a: number, b: number): number {
  return (a - b) | 0;
}

/** Low 32 bits of the product; Math.imul avoids the precision loss of a * b. */
export function mul32(a: number, b: number): number {
  return Math.imul(a, b);
}

export function neg32(a: number): number {
  return (0 - a) | 0;
}

/** Logical left shift; the count must already be in [0, 31]. */
export function shl32(a: number, n: number): number {
  return (a << n) | 0;
}

/** Arithmetic right shift; the count must already be in [0, 31]. */
export function sar32(a: number, n: number): number {
  return a >> n;
}

/** Logical right shift returning the signed form; the count must already be in [0, 31]. */
export function shr32(a: number, n: number): number {
  return (a >>> n) | 0;
}

export function ltu32(a: number, b: number): boolean {
  return a >>> 0 < b >>> 0;
}

/** Sign-extend the low `bits` bits of x. */
export function signExtend(x: number, bits: number): number {
  const shift = 32 - bits;
  return (x << shift) >> shift;
}

/** True when the signed value fits in a two's-complement field of the given width. */
export function fitsSigned(x: number, bits: number): boolean {
  const lim = 2 ** (bits - 1);
  return Number.isInteger(x) && x >= -lim && x < lim;
}

export function fitsUnsigned(x: number, bits: number): boolean {
  return Number.isInteger(x) && x >= 0 && x < 2 ** bits;
}

export function hex(x: number, digits = 8): string {
  return '0x' + (x >>> 0).toString(16).padStart(digits, '0');
}

/**
 * Hexadecimal text of a code address. A negative number denotes an address
 * below zero in a 64-bit address space (2^64 + x), as produced by an x86-64
 * relative jump with a large negative offset, and is printed with 16 digits.
 */
export function hexAddress(x: number): string {
  return x < 0 ? '0x' + BigInt.asUintN(64, BigInt(x)).toString(16) : '0x' + x.toString(16).padStart(8, '0');
}

export function hex64(x: bigint): string {
  return '0x' + BigInt.asUintN(64, x).toString(16).padStart(16, '0');
}

export function bin(x: number, bits = 32): string {
  return (x >>> 0).toString(2).padStart(bits, '0').slice(-bits);
}

export function bytesToHex(bytes: ArrayLike<number>, sep = ' '): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!.toString(16).padStart(2, '0'));
  return out.join(sep);
}

/** Parse a hexadecimal byte string such as "13 05 50 00" or "13055000". */
export function hexToBytes(text: string): Uint8Array | null {
  const cleaned = text.replace(/0x/gi, '').replace(/[\s,_]/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-fA-F]/.test(cleaned)) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Little-endian byte sequence of a 32-bit word. */
export function wordToBytesLE(word: number): Uint8Array {
  return Uint8Array.of(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff);
}

export function bytesToWordLE(bytes: ArrayLike<number>, offset = 0): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}
