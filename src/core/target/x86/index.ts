/** x86-64 backend. */
import type { Backend } from '../types.ts';
import { INSTRUCTIONS, OPERATIONS } from './catalog.ts';
import { X86Cpu } from './cpu.ts';
import { decode } from './decode.ts';
import { x86Asm } from './encode.ts';
import { PROFILE } from './isa.ts';
import { x86Lowering } from './lower.ts';
import { format, parseLine } from './text.ts';
import { VALIDATION } from './validation.ts';

export const x86: Backend = {
  profile: PROFILE,
  validation: VALIDATION,
  instructions: INSTRUCTIONS,
  operations: OPERATIONS,
  lowering: x86Lowering,
  asm: x86Asm,
  decode,
  format,
  parseLine,
  createCpu: (mem) => new X86Cpu(mem),
};
