/**
 * RV32I processor model. Each step fetches four bytes from the code region,
 * decodes them, and applies the instruction semantics to the register file,
 * memory, and program counter.
 *
 * Execution-environment choices permitted by the specification:
 *  - a taken branch or jump to an address that is not a multiple of 4 raises
 *    an instruction-address-misaligned fault;
 *  - loads and stores of halfwords and words must be naturally aligned.
 */
import { bytesToWordLE, hex } from '../../util/int32.ts';
import type { Memory } from '../memory.ts';
import { MemoryFault } from '../memory.ts';
import type { Cpu, CpuSnapshot, StepEvent, Stop } from '../types.ts';
import { decodeWord, toInsn } from './decode.ts';
import { REG_NAMES, regIndex } from './isa.ts';
import { format } from './text.ts';

const u = (x: number): bigint => BigInt(x >>> 0);

export class RiscvCpu implements Cpu {
  pc = 0;
  private x = new Int32Array(32);
  private written = 0;
  private mem: Memory;

  constructor(mem: Memory) {
    this.mem = mem;
  }

  reset(entry: number, stackPointer: number): void {
    this.x.fill(0);
    this.written = 0;
    this.pc = entry;
    this.x[2] = stackPointer | 0;
  }

  readReg(name: string): bigint {
    if (name === 'pc') return u(this.pc);
    const r = regIndex(name);
    if (r < 0) throw new Error(`unknown register '${name}'`);
    return u(this.x[r]!);
  }

  writeReg(name: string, value: bigint): void {
    const v = Number(BigInt.asIntN(32, value));
    if (name === 'pc') {
      this.pc = v >>> 0;
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
    // RV32I has no condition flags.
  }

  wasWritten(name: string): boolean {
    const r = regIndex(name);
    return r >= 0 && (this.written & (1 << r)) !== 0;
  }

  snapshot(): CpuSnapshot {
    return { pc: this.pc, data: { x: this.x.slice(), written: this.written } };
  }

  restore(s: CpuSnapshot): void {
    const d = s.data as { x: Int32Array; written: number };
    this.pc = s.pc;
    this.x.set(d.x);
    this.written = d.written;
  }

  step(ev?: StepEvent): Stop | null {
    const pc = this.pc;
    const x = this.x;
    const mem = this.mem;
    // A faulting instruction leaves the program counter where it is, so until the step completes the
    // event reports the address of the instruction itself as the next program counter.
    if (ev) ev.nextPc = pc;
    try {
      if (pc & 3) return { kind: 'fault', message: `instruction address ${hex(pc)} is not a multiple of 4` };
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
        return { kind: 'fault', message: `illegal instruction ${hex(word)} at ${hex(pc)}: ${d.message}` };
      }
      const { rd, rs1, rs2, imm } = d;
      const fmt = d.enc.format;
      const a = x[rs1]!;
      const b = x[rs2]!;
      const rdBefore = x[rd]!;
      if (ev) {
        ev.text = format(toInsn(d, pc));
        if (fmt !== 'U' && fmt !== 'J' && fmt !== 'SYS') ev.regReads.push({ reg: REG_NAMES[rs1]!, value: u(a) });
        if (fmt === 'R' || fmt === 'S' || fmt === 'B') ev.regReads.push({ reg: REG_NAMES[rs2]!, value: u(b) });
      }
      let next = (pc + 4) >>> 0;
      let result = 0;
      let writes = true;
      let stop: Stop | null = null;
      const misaligned = (target: number): Stop | null =>
        target & 3 ? { kind: 'fault', message: `control transfer to ${hex(target)}, which is not a multiple of 4` } : null;
      const branch = (taken: boolean): void => {
        writes = false;
        const target = (pc + imm) >>> 0;
        if (ev) {
          ev.klass = 'branch';
          ev.alu = { op: 'compare', a: u(a), b: u(b), result: taken ? 1n : 0n };
          ev.branch = { conditional: true, taken, target };
        }
        if (taken) {
          stop = misaligned(target);
          next = target;
        }
      };
      // The first operand is the value of rs1 unless the instruction names another one (auipc adds to the pc).
      const alu = (op: string, operandB: number, r: number, operandA: number = a): void => {
        result = r;
        if (ev) {
          ev.klass = 'alu';
          ev.alu = { op, a: u(operandA), b: u(operandB), result: u(r) };
        }
      };
      const load = (size: 1 | 2 | 4, signed: boolean): void => {
        const address = (a + imm) >>> 0;
        if (size > 1 && address % size !== 0) {
          stop = { kind: 'fault', message: `misaligned ${size}-byte load at ${hex(address)}` };
          writes = false;
          return;
        }
        let v = mem.read(address, size);
        if (signed && size === 1) v = (v << 24) >> 24;
        else if (signed && size === 2) v = (v << 16) >> 16;
        result = v | 0;
        if (ev) {
          ev.klass = 'load';
          ev.alu = { op: 'address', a: u(a), b: u(imm), result: u(address) };
          ev.memReads.push({ address, size, value: u(v) & (size === 4 ? 0xffffffffn : size === 2 ? 0xffffn : 0xffn) });
        }
      };
      const store = (size: 1 | 2 | 4): void => {
        writes = false;
        const address = (a + imm) >>> 0;
        if (size > 1 && address % size !== 0) {
          stop = { kind: 'fault', message: `misaligned ${size}-byte store at ${hex(address)}` };
          return;
        }
        const mask = size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
        let before = 0n;
        if (ev) {
          const old = mem.peek(address, size);
          if (old) for (let i = size - 1; i >= 0; i--) before = (before << 8n) | BigInt(old[i]!);
        }
        mem.write(address, size, b);
        if (ev) {
          ev.klass = 'store';
          ev.alu = { op: 'address', a: u(a), b: u(imm), result: u(address) };
          ev.memWrites.push({ address, size, before, value: BigInt((b & mask) >>> 0) });
        }
      };

      switch (d.enc.mnemonic) {
        case 'lui': alu('load upper', imm << 12, imm << 12); break;
        case 'auipc': alu('add', imm << 12, (pc + (imm << 12)) | 0, pc); break;
        case 'jal': {
          const target = (pc + imm) >>> 0;
          result = next | 0;
          stop = misaligned(target);
          if (ev) {
            ev.klass = 'jump';
            ev.branch = { conditional: false, taken: true, target };
          }
          next = target;
          break;
        }
        case 'jalr': {
          const target = ((a + imm) & ~1) >>> 0;
          result = next | 0;
          stop = misaligned(target);
          if (ev) {
            ev.klass = 'jump';
            ev.alu = { op: 'address', a: u(a), b: u(imm), result: u(target) };
            ev.branch = { conditional: false, taken: true, target };
          }
          next = target;
          break;
        }
        case 'beq': branch(a === b); break;
        case 'bne': branch(a !== b); break;
        case 'blt': branch(a < b); break;
        case 'bge': branch(a >= b); break;
        case 'bltu': branch(a >>> 0 < b >>> 0); break;
        case 'bgeu': branch(a >>> 0 >= b >>> 0); break;
        case 'lb': load(1, true); break;
        case 'lh': load(2, true); break;
        case 'lw': load(4, true); break;
        case 'lbu': load(1, false); break;
        case 'lhu': load(2, false); break;
        case 'sb': store(1); break;
        case 'sh': store(2); break;
        case 'sw': store(4); break;
        case 'addi': alu('add', imm, (a + imm) | 0); break;
        case 'slti': alu('set less than', imm, a < imm ? 1 : 0); break;
        case 'sltiu': alu('set less than (unsigned)', imm, a >>> 0 < imm >>> 0 ? 1 : 0); break;
        case 'xori': alu('xor', imm, a ^ imm); break;
        case 'ori': alu('or', imm, a | imm); break;
        case 'andi': alu('and', imm, a & imm); break;
        case 'slli': alu('shift left', imm, a << imm); break;
        case 'srli': alu('shift right logical', imm, (a >>> imm) | 0); break;
        case 'srai': alu('shift right arithmetic', imm, a >> imm); break;
        case 'add': alu('add', b, (a + b) | 0); break;
        case 'sub': alu('subtract', b, (a - b) | 0); break;
        // Register shifts use the low five bits of rs2.
        case 'sll': alu('shift left', b & 31, a << (b & 31)); break;
        case 'slt': alu('set less than', b, a < b ? 1 : 0); break;
        case 'sltu': alu('set less than (unsigned)', b, a >>> 0 < b >>> 0 ? 1 : 0); break;
        case 'xor': alu('xor', b, a ^ b); break;
        case 'srl': alu('shift right logical', b & 31, (a >>> (b & 31)) | 0); break;
        case 'sra': alu('shift right arithmetic', b & 31, a >> (b & 31)); break;
        case 'or': alu('or', b, a | b); break;
        case 'and': alu('and', b, a & b); break;
        case 'ecall':
          writes = false;
          stop = { kind: 'service' };
          if (ev) ev.klass = 'service';
          break;
        default:
          return { kind: 'fault', message: `no semantics for '${d.enc.mnemonic}'` };
      }
      if (stop !== null && (stop as Stop).kind === 'fault') return stop;
      if (writes && rd !== 0) {
        x[rd] = result;
        this.written |= 1 << rd;
      }
      if (ev) {
        if (writes && rd !== 0) ev.regWrites.push({ reg: REG_NAMES[rd]!, before: u(rdBefore), value: u(result) });
        ev.nextPc = next;
      }
      this.pc = next;
      return stop;
    } catch (e) {
      if (e instanceof MemoryFault) return { kind: 'fault', message: e.message };
      throw e;
    }
  }
}
