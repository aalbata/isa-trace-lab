/** MIPS32 Release 2 backend. */
import type { Backend } from '../types.ts';
import { INSTRUCTIONS, OPERATIONS } from './catalog.ts';
import { MipsCpu } from './cpu.ts';
import { decode } from './decode.ts';
import { mipsAsm } from './encode.ts';
import { PROFILE } from './isa.ts';
import { mipsLowering } from './lower.ts';
import { format, parseLine } from './text.ts';
import { VALIDATION } from './validation.ts';

export const mips: Backend = {
  profile: PROFILE,
  validation: VALIDATION,
  instructions: INSTRUCTIONS,
  operations: OPERATIONS,
  lowering: mipsLowering,
  asm: mipsAsm,
  decode,
  format,
  parseLine,
  createCpu: (mem) => new MipsCpu(mem),
};
