/**
 * MIPS32 Release 2 processor model. Each step fetches four bytes from the
 * code region, decodes them, and applies the instruction semantics to the
 * register file, memory, and program counter.
 *
 * Delayed control transfer is modelled as the architecture defines it. A
 * branch or jump computes its target and the instruction after it (the delay
 * slot) executes before control moves to the target; when a conditional
 * branch is not taken, execution continues after the delay slot. `pc` is
 * always the address of the next instruction to fetch, and the address that
 * follows the delay slot is kept in `delayTarget`.
 *
 * Conditions the model reports as faults:
 *  - a branch or jump in a delay slot, which is UNPREDICTABLE in the architecture;
 *  - jalr whose destination and target registers are the same, also UNPREDICTABLE;
 *  - the Integer Overflow exception of add, addi, and sub (the destination is not modified);
 *  - the Address Error exception of a misaligned word or halfword access or instruction fetch.
 * The registers HI and LO are not modelled.
 */
import { bytesToWordLE, hex } from '../../util/int32.ts';
import type { Memory } from '../memory.ts';
import { MemoryFault } from '../memory.ts';
import type { Cpu, CpuSnapshot, StepEvent, Stop } from '../types.ts';
import { branchTarget, decodeWord, jumpTarget, toInsn } from './decode.ts';
import { isControlTransfer, REG_NAMES, regIndex } from './isa.ts';
import { format } from './text.ts';

const u = (x: number): bigint => BigInt(x >>> 0);

/** Value of `delayTarget` when the next instruction is not in a delay slot. */
const NONE = -1;

export class MipsCpu implements Cpu {
  pc = 0;
  private x = new Int32Array(32);
  private written = 0;
  /** Address at which execution continues after the delay-slot instruction at `pc`, or NONE. */
  private delayTarget = NONE;
  private mem: Memory;

  constructor(mem: Memory) {
    this.mem = mem;
  }

  reset(entry: number, stackPointer: number): void {
    this.x.fill(0);
    this.written = 0;
    this.pc = entry;
    this.delayTarget = NONE;
    this.x[29] = stackPointer | 0;
  }

  readReg(name: string): bigint {
    if (name === 'pc') return u(this.pc);
    const r = regIndex(name);
    if (r < 0) throw new Error(`unknown register '${name}'`);
    return u(this.x[r]!);
  }

  /** Writing `pc` redirects execution and cancels a pending delayed transfer. */
  writeReg(name: string, value: bigint): void {
    const v = Number(BigInt.asIntN(32, value));
    if (name === 'pc') {
      this.pc = v >>> 0;
      this.delayTarget = NONE;
      return;
    }
    const r = regIndex(name);
    if (r < 0) throw new Error(`unknown register '${name}'`);
    if (r !== 0) {
      this.x[r] = v;
      this.written |= 1 << r;
    }
  }

  reg32(name: string): number {
    const r = regIndex(name);
    if (r < 0) throw new Error(`unknown register '${name}'`);
    return this.x[r]!;
  }

  readFlags(): Record<string, number> {
    return {};
  }

  writeFlag(): void {
    // MIPS32 has no condition flags.
  }

  wasWritten(name: string): boolean {
    const r = regIndex(name);
    return r >= 0 && (this.written & (1 << r)) !== 0;
  }

  snapshot(): CpuSnapshot {
    return { pc: this.pc, data: { x: this.x.slice(), written: this.written, delayTarget: this.delayTarget } };
  }

  restore(s: CpuSnapshot): void {
    const d = s.data as { x: Int32Array; written: number; delayTarget: number };
    this.pc = s.pc;
    this.x.set(d.x);
    this.written = d.written;
    this.delayTarget = d.delayTarget;
  }

  step(ev?: StepEvent): Stop | null {
    const pc = this.pc;
    const x = this.x;
    const mem = this.mem;
    const slotTarget = this.delayTarget;
    const inSlot = slotTarget !== NONE;
    // A faulting instruction leaves the program counter where it is, so until the step completes the
    // event reports the address of the instruction itself as the next program counter.
    if (ev) ev.nextPc = pc;
    try {
      if (pc & 3) return { kind: 'fault', message: `Address Error: instruction address ${hex(pc)} is not a multiple of 4` };
      const fetched = mem.fetch(pc, 4);
      if (fetched.length < 4) return { kind: 'fault', message: `instruction fetch runs past the end of the code region at ${hex(pc)}` };
      const word = bytesToWordLE(fetched, 0);
      const d = decodeWord(word);
      if (ev) {
        ev.pc = pc;
        ev.length = 4;
        ev.bytes = Array.from(fetched);
        if (inSlot) ev.delaySlot = true;
      }
      if ('kind' in d) {
        if (ev) ev.text = `.word ${hex(word)}`;
        return { kind: 'fault', message: `Reserved Instruction: ${hex(word)} at ${hex(pc)}: ${d.message}` };
      }
      const { rs, rt, rd, sa, imm } = d;
      const fmt = d.enc.format;
      const mnemonic = d.enc.mnemonic;
      const a = x[rs]!;
      const b = x[rt]!;
      if (ev) {
        ev.text = format(toInsn(d, pc));
        if (fmt !== 'SHI' && fmt !== 'SYS' && fmt !== 'LUI' && fmt !== 'J') ev.regReads.push({ reg: REG_NAMES[rs]!, value: u(a) });
        if (fmt === 'R3' || fmt === 'SHI' || fmt === 'SHV' || fmt === 'B2' || (fmt === 'M' && mnemonic.startsWith('s'))) {
          ev.regReads.push({ reg: REG_NAMES[rt]!, value: u(b) });
        }
      }
      if (inSlot && isControlTransfer(fmt)) {
        return {
          kind: 'fault',
          message: `'${mnemonic}' at ${hex(pc)} is in the delay slot of the preceding branch or jump; a control-transfer instruction in a delay slot is UNPREDICTABLE in the MIPS32 architecture`,
        };
      }

      /** Register written by the instruction, or 0 when it writes none. */
      let dest = 0;
      let result = 0;
      /** Target of a control transfer that takes effect after the delay slot, or NONE. */
      let transfer = NONE;
      let stop: Stop | null = null;

      const alu = (to: number, op: string, operandA: number, operandB: number, r: number): void => {
        dest = to;
        result = r;
        if (ev) {
          ev.klass = 'alu';
          ev.alu = { op, a: u(operandA), b: u(operandB), result: u(r) };
        }
      };
      /** add, addi, and sub: the result is written only when it is representable in 32 signed bits. */
      const trapping = (to: number, op: string, operandB: number, exact: number): void => {
        if (exact < -2147483648 || exact > 2147483647) {
          stop = {
            kind: 'fault',
            message: `Integer Overflow exception: '${mnemonic}' at ${hex(pc)} computes ${exact}, which is outside the signed 32-bit range; the destination is not modified`,
          };
          if (ev) ev.klass = 'alu';
          return;
        }
        alu(to, op, a, operandB, exact);
      };
      const branch = (taken: boolean, compareB: number): void => {
        const target = branchTarget(d, pc);
        transfer = taken ? target : (pc + 8) >>> 0;
        if (ev) {
          ev.klass = 'branch';
          ev.alu = { op: 'compare', a: u(a), b: u(compareB), result: taken ? 1n : 0n };
          ev.branch = { conditional: true, taken, target };
        }
      };
      const jump = (target: number, link: number): void => {
        transfer = target;
        if (link !== 0) {
          dest = link;
          result = (pc + 8) | 0;
        }
        if (ev) {
          ev.klass = 'jump';
          ev.branch = { conditional: false, taken: true, target };
        }
      };
      const load = (size: 1 | 2 | 4, signed: boolean): void => {
        const address = (a + imm) >>> 0;
        if (ev) {
          ev.klass = 'load';
          ev.alu = { op: 'address', a: u(a), b: u(imm), result: u(address) };
        }
        if (address % size !== 0) {
          stop = { kind: 'fault', message: `Address Error: ${size}-byte load at ${hex(address)}, which is not a multiple of ${size}` };
          return;
        }
        let v = mem.read(address, size);
        if (signed && size === 1) v = (v << 24) >> 24;
        else if (signed && size === 2) v = (v << 16) >> 16;
        dest = rt;
        result = v | 0;
        if (ev) ev.memReads.push({ address, size, value: u(v) & (size === 4 ? 0xffffffffn : size === 2 ? 0xffffn : 0xffn) });
      };
      const store = (size: 1 | 2 | 4): void => {
        const address = (a + imm) >>> 0;
        if (ev) {
          ev.klass = 'store';
          ev.alu = { op: 'address', a: u(a), b: u(imm), result: u(address) };
        }
        if (address % size !== 0) {
          stop = { kind: 'fault', message: `Address Error: ${size}-byte store at ${hex(address)}, which is not a multiple of ${size}` };
          return;
        }
        const mask = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
        let before = 0n;
        if (ev) {
          const old = mem.peek(address, size);
          if (old) for (let i = size - 1; i >= 0; i--) before = (before << 8n) | BigInt(old[i]!);
        }
        mem.write(address, size, b);
        if (ev) ev.memWrites.push({ address, size, before, value: BigInt((b & mask) >>> 0) });
      };

      switch (mnemonic) {
        case 'sll': alu(rd, 'shift left', b, sa, b << sa); break;
        case 'srl': alu(rd, 'shift right logical', b, sa, (b >>> sa) | 0); break;
        case 'sra': alu(rd, 'shift right arithmetic', b, sa, b >> sa); break;
        // Variable shifts use the low five bits of rs.
        case 'sllv': alu(rd, 'shift left', b, a & 31, b << (a & 31)); break;
        case 'srlv': alu(rd, 'shift right logical', b, a & 31, (b >>> (a & 31)) | 0); break;
        case 'srav': alu(rd, 'shift right arithmetic', b, a & 31, b >> (a & 31)); break;
        case 'jr': jump(a >>> 0, 0); break;
        case 'jalr':
          if (rd === rs) {
            return {
              kind: 'fault',
              message: `'jalr' at ${hex(pc)} uses ${REG_NAMES[rs]} as destination and as target; the result is UNPREDICTABLE in the MIPS32 architecture`,
            };
          }
          jump(a >>> 0, rd);
          if (ev) ev.alu = { op: 'link', a: u(pc), b: 8n, result: u(pc + 8) };
          break;
        case 'syscall':
          stop = { kind: 'service' };
          if (ev) ev.klass = 'service';
          break;
        case 'add': trapping(rd, 'add', b, a + b); break;
        case 'addu': alu(rd, 'add', a, b, (a + b) | 0); break;
        case 'sub': trapping(rd, 'subtract', b, a - b); break;
        case 'subu': alu(rd, 'subtract', a, b, (a - b) | 0); break;
        case 'and': alu(rd, 'and', a, b, a & b); break;
        case 'or': alu(rd, 'or', a, b, a | b); break;
        case 'xor': alu(rd, 'xor', a, b, a ^ b); break;
        case 'nor': alu(rd, 'nor', a, b, ~(a | b)); break;
        case 'slt': alu(rd, 'set less than', a, b, a < b ? 1 : 0); break;
        case 'sltu': alu(rd, 'set less than (unsigned)', a, b, a >>> 0 < b >>> 0 ? 1 : 0); break;
        case 'mul': alu(rd, 'multiply', a, b, Math.imul(a, b)); break;
        case 'bltz': branch(a < 0, 0); break;
        case 'bgez': branch(a >= 0, 0); break;
        case 'blez': branch(a <= 0, 0); break;
        case 'bgtz': branch(a > 0, 0); break;
        case 'beq': branch(a === b, b); break;
        case 'bne': branch(a !== b, b); break;
        case 'j': jump(jumpTarget(d, pc), 0); break;
        case 'jal':
          jump(jumpTarget(d, pc), 31);
          if (ev) ev.alu = { op: 'link', a: u(pc), b: 8n, result: u(pc + 8) };
          break;
        case 'addi': trapping(rt, 'add', imm, a + imm); break;
        case 'addiu': alu(rt, 'add', a, imm, (a + imm) | 0); break;
        case 'slti': alu(rt, 'set less than', a, imm, a < imm ? 1 : 0); break;
        // The immediate is sign-extended and then compared as an unsigned value.
        case 'sltiu': alu(rt, 'set less than (unsigned)', a, imm, a >>> 0 < imm >>> 0 ? 1 : 0); break;
        case 'andi': alu(rt, 'and', a, imm, a & imm); break;
        case 'ori': alu(rt, 'or', a, imm, a | imm); break;
        case 'xori': alu(rt, 'xor', a, imm, a ^ imm); break;
        case 'lui': alu(rt, 'load upper', imm, 16, imm << 16); break;
        case 'lb': load(1, true); break;
        case 'lh': load(2, true); break;
        case 'lw': load(4, true); break;
        case 'lbu': load(1, false); break;
        case 'lhu': load(2, false); break;
        case 'sb': store(1); break;
        case 'sh': store(2); break;
        case 'sw': store(4); break;
        default:
          return { kind: 'fault', message: `no semantics for '${mnemonic}'` };
      }
      if (stop !== null && (stop as Stop).kind === 'fault') return stop;
      if (dest !== 0) {
        if (ev) ev.regWrites.push({ reg: REG_NAMES[dest]!, before: u(x[dest]!), value: u(result) });
        x[dest] = result;
        this.written |= 1 << dest;
      }
      // After a branch or jump the delay slot is fetched next; after a delay-slot instruction the saved target is.
      const next = inSlot ? slotTarget : (pc + 4) >>> 0;
      this.delayTarget = transfer;
      this.pc = next;
      if (ev) ev.nextPc = next;
      return stop;
    } catch (e) {
      if (e instanceof MemoryFault) return { kind: 'fault', message: e.message };
      throw e;
    }
  }
}
