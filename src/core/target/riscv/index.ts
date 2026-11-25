/** RISC-V RV32I backend. */
import type { Backend } from '../types.ts';
import { INSTRUCTIONS, OPERATIONS } from './catalog.ts';
import { RiscvCpu } from './cpu.ts';
import { decode } from './decode.ts';
import { riscvAsm } from './encode.ts';
import { PROFILE } from './isa.ts';
import { riscvLowering } from './lower.ts';
import { format, parseLine } from './text.ts';
import { VALIDATION } from './validation.ts';

export const riscv: Backend = {
  profile: PROFILE,
  validation: VALIDATION,
  instructions: INSTRUCTIONS,
  operations: OPERATIONS,
  lowering: riscvLowering,
  asm: riscvAsm,
  decode,
  format,
  parseLine,
  createCpu: (mem) => new RiscvCpu(mem),
};
