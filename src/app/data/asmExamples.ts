/** Short assembly programs for the assembler page: the sum 1 + 2 + ... + 10, printed, then exit. */
import type { TargetId } from '../../core/api.ts';

export const ASM_EXAMPLES: Record<TargetId, string> = {
  riscv: `# Sum the integers 1 to 10, print the sum, and exit.
    li   t0, 0          # sum
    li   t1, 1          # i
    li   t2, 11
loop:
    add  t0, t0, t1
    addi t1, t1, 1
    blt  t1, t2, loop
    mv   a0, t0
    li   a7, 1          # service 1: print a0
    ecall
    li   a0, 0
    li   a7, 2          # service 2: exit with a0
    ecall
`,
  mips: `# Sum the integers 1 to 10, print the sum, and exit.
# The instruction after a branch (the delay slot) always executes.
    li    $t0, 0        # sum
    li    $t1, 1        # i
    li    $t2, 11
loop:
    addu  $t0, $t0, $t1
    addiu $t1, $t1, 1
    bne   $t1, $t2, loop
    nop                 # delay slot
    move  $a0, $t0
    li    $v0, 1        # service 1: print $a0
    syscall
    li    $a0, 0
    li    $v0, 2        # service 2: exit with $a0
    syscall
`,
  aarch64: `// Sum the integers 1 to 10, print the sum, and exit.
    mov  w9, #0         // sum
    mov  w10, #1        // i
loop:
    add  w9, w9, w10
    add  w10, w10, #1
    cmp  w10, #11
    b.lt loop
    mov  w0, w9
    mov  w8, #1         // service 1: print w0
    svc  #0
    mov  w0, #0
    mov  w8, #2         // service 2: exit with w0
    svc  #0
`,
  x86: `# Sum the integers 1 to 10, print the sum, and exit.
    mov  ebx, 0         # sum
    mov  r8d, 1         # i
loop:
    add  ebx, r8d
    add  r8d, 1
    cmp  r8d, 11
    jl   loop
    mov  edi, ebx
    mov  eax, 1         # service 1: print edi
    syscall
    mov  edi, 0
    mov  eax, 2         # service 2: exit with edi
    syscall
`,
};

export const BYTE_EXAMPLES: Record<TargetId, string> = {
  riscv: '93 08 20 00 33 05 b5 00 63 46 b5 00 ff ff ff ff 33 05 c5 02',
  mips: '05 00 04 24 21 10 43 00 05 00 88 10 00 00 00 00 ff ff ff ff',
  aarch64: 'a0 00 80 52 02 00 01 0b eb 00 00 54 20 00 40 bd 00 00 00 00',
  x86: 'b8 05 00 00 00 01 c8 0f af d8 4f 69 84 f5 7f ff ff ff 78 56 34 12 06 0f',
};
