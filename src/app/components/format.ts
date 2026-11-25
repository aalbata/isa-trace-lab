/** Number formatting helpers shared by the views. */

export function hex32(value: number): string {
  return '0x' + (value >>> 0).toString(16).padStart(8, '0');
}

export function hexWide(value: bigint, bits: number): string {
  return '0x' + BigInt.asUintN(bits, value).toString(16).padStart(bits / 4, '0');
}

export function signed32(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

export function binaryGroups(value: bigint, bits: number): string {
  const s = BigInt.asUintN(bits, value).toString(2).padStart(bits, '0');
  return s.replace(/(.{8})(?=.)/g, '$1 ');
}

export function bytesText(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Parse a number typed by the user: decimal, 0x hexadecimal, or 0b binary, optionally negative. */
export function parseUserNumber(text: string): bigint | null {
  const t = text.trim().replace(/_/g, '');
  if (!/^-?(0x[0-9a-fA-F]+|0b[01]+|[0-9]+)$/.test(t)) return null;
  try {
    return t.startsWith('-') ? -BigInt(t.slice(1)) : BigInt(t);
  } catch {
    return null;
  }
}

export const TARGET_LABEL: Record<string, string> = {
  riscv: 'RISC-V RV32I',
  mips: 'MIPS32 Release 2',
  aarch64: 'Arm AArch64 (A64)',
  x86: 'x86-64',
};

export const REGION_LABEL: Record<string, string> = {
  startup: 'Startup stub',
  main: 'Entry function main',
  trap: 'Runtime error stubs',
  helper: 'Runtime helper',
};
