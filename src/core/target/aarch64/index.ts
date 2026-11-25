/** Arm AArch64 (A64 integer subset) backend. */
import type { Backend } from '../types.ts';
import { INSTRUCTIONS, OPERATIONS } from './catalog.ts';
import { Aarch64Cpu } from './cpu.ts';
import { decode } from './decode.ts';
import { aarch64Asm } from './encode.ts';
import { PROFILE } from './isa.ts';
import { aarch64Lowering } from './lower.ts';
import { format, parseLine } from './text.ts';
import { VALIDATION } from './validation.ts';

export const aarch64: Backend = {
  profile: PROFILE,
  validation: VALIDATION,
  instructions: INSTRUCTIONS,
  operations: OPERATIONS,
  lowering: aarch64Lowering,
  asm: aarch64Asm,
  decode,
  format,
  parseLine,
  createCpu: (mem) => new Aarch64Cpu(mem),
};
