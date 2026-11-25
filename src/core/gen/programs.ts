/**
 * Deterministic generator of test programs in the source language.
 *
 * Every program is valid (it passes the semantic checker) and terminates
 * within a small number of steps: for loops have bounded ranges and while
 * loops are guarded by a dedicated countdown. Some programs reach a runtime
 * error on purpose through an unmasked array index or shift count. The same
 * initialization value always produces the same program text.
 */
import { Prng } from '../util/prng.ts';

export const GENERATOR_VERSION = '1.0';

export type Family = 'expr' | 'branch' | 'loop' | 'array' | 'mixed';

export interface GeneratedProgram {
  family: Family;
  /** Initialization value of the pseudo-random generator. */
  init: number;
  source: string;
  /** Argument tuples to run the program with. */
  args: number[][];
}

const BOUNDARY = [0, 1, -1, 2, 3, 7, 31, 32, 255, 256, 4095, 4096, 65535, 65536, 2147483647, -2147483648, 2147483646, -2147483647, 1431655765, -1431655766];

const BOUNDED_RANGES = [
  'range(2147483600, 2147483647, 7)',
  'range(-2147483648, -2147483600, 5)',
  'range(2147483647, 2147483600, -9)',
  'range(-2147483600, -2147483648, -11)',
  'range(-2147483648, 2147483647, 1000000000)',
  'range(2147483647, -2147483648, -900000000)',
  'range(2147483640, 2147483647)',
  'range(-3, 4)',
  'range(5, 5)',
  'range(6, 2)',
  'range(0, 10, 3)',
  'range(10, 0, -3)',
  'range(1, 2, 2147483647)',
  'range(-1, -2, -2147483648)',
];

class Gen {
  private r: Prng;
  private family: Family;
  private ints: string[] = [];
  private bools: string[] = [];
  private arrays: { name: string; length: number }[] = [];
  private lines: string[] = [];
  private counters = 0;
  private loopVars = 0;
  private budget: number;

  constructor(init: number, family: Family) {
    this.r = new Prng(init);
    this.family = family;
    this.budget = family === 'expr' ? 10 : 16;
  }

  private literal(): string {
    const r = this.r;
    const k = r.below(10);
    let v: number;
    if (k < 4) v = r.range(-9, 9);
    else if (k < 7) v = r.pick(BOUNDARY);
    else if (k < 9) v = r.range(-3000, 3000);
    else v = r.s32();
    if (v < 0) return `(${v === -2147483648 ? '-2147483648' : String(v)})`;
    if (k === 9 && r.chance(0.5)) return '0x' + (v >>> 0).toString(16);
    return String(v);
  }

  private intAtom(): string {
    const r = this.r;
    const k = r.below(10);
    if (k < 5 && this.ints.length > 0) return r.pick(this.ints);
    if (k === 5 && this.arrays.length > 0) {
      const a = r.pick(this.arrays);
      return r.chance(0.3) ? `len(${a.name})` : this.element(a);
    }
    return this.literal();
  }

  private index(a: { name: string; length: number }): string {
    const r = this.r;
    const k = r.below(20);
    if (k < 8) return String(r.below(a.length));
    const pow2 = (a.length & (a.length - 1)) === 0;
    if (k < 17) {
      // An index expression kept in range by masking or by a small loop variable.
      if (pow2) return `((${this.int(1)}) & ${a.length - 1})`;
      return String(r.below(a.length));
    }
    // An unchecked index: it may be out of range and then ends the program with a runtime error.
    if (this.ints.length === 0) return String(r.below(a.length));
    if (k < 19) return r.pick(this.ints);
    return `${r.pick(this.ints)} + ${r.range(0, 2)}`;
  }

  private element(a: { name: string; length: number }): string {
    return `${a.name}[${this.index(a)}]`;
  }

  private shiftCount(): string {
    const r = this.r;
    const k = r.below(10);
    if (k < 6) return String(r.below(32));
    if (k < 9) return `((${this.int(1)}) & 31)`;
    return this.ints.length > 0 ? r.pick(this.ints) : '33 - 2';
  }

  private int(depth: number): string {
    const r = this.r;
    if (depth <= 0 || r.chance(0.25)) return this.intAtom();
    const k = r.below(13);
    const a = this.int(depth - 1);
    switch (k) {
      case 0: case 1: return `(${a} + ${this.int(depth - 1)})`;
      case 2: case 3: return `(${a} - ${this.int(depth - 1)})`;
      case 4: case 5: return `(${a} * ${this.int(depth - 1)})`;
      case 6: return `(${a} & ${this.int(depth - 1)})`;
      case 7: return `(${a} | ${this.int(depth - 1)})`;
      case 8: return `(${a} ^ ${this.int(depth - 1)})`;
      case 9: return `(${a} << ${this.shiftCount()})`;
      case 10: return `(${a} >> ${this.shiftCount()})`;
      case 11: return `(-${a})`;
      default: return `(~${a})`;
    }
  }

  private bool(depth: number): string {
    const r = this.r;
    const k = r.below(12);
    if (depth > 0 && k < 2) return `(${this.bool(depth - 1)} and ${this.bool(depth - 1)})`;
    if (depth > 0 && k < 4) return `(${this.bool(depth - 1)} or ${this.bool(depth - 1)})`;
    if (depth > 0 && k === 4) return `(not ${this.bool(depth - 1)})`;
    if (k === 5 && this.bools.length > 0) return r.pick(this.bools);
    if (k === 6) return r.chance(0.5) ? 'True' : 'False';
    const op = r.pick(['==', '!=', '<', '<=', '>', '>=']);
    return `${this.int(1)} ${op} ${this.int(1)}`;
  }

  private emit(indent: number, text: string): void {
    this.lines.push('    '.repeat(indent) + text);
  }

  private simple(indent: number, inLoop: boolean): void {
    const r = this.r;
    const k = r.below(inLoop ? 14 : 12);
    const depth = this.family === 'expr' ? 3 : 2;
    if (k < 3) this.emit(indent, `${r.pick(this.ints)} = ${this.int(depth)}`);
    else if (k < 5) {
      const op = r.pick(['+=', '-=', '*=', '&=', '|=', '^=']);
      this.emit(indent, `${r.pick(this.ints)} ${op} ${this.int(depth - 1)}`);
    } else if (k === 5) {
      const op = r.pick(['<<=', '>>=']);
      this.emit(indent, `${r.pick(this.ints)} ${op} ${this.shiftCount()}`);
    } else if (k < 8) this.emit(indent, `print(${this.int(depth)})`);
    else if (k === 8 && this.bools.length > 0) this.emit(indent, `${r.pick(this.bools)} = ${this.bool(2)}`);
    else if (k < 11 && this.arrays.length > 0) {
      const a = r.pick(this.arrays);
      if (r.chance(0.6)) this.emit(indent, `${this.element(a)} = ${this.int(depth - 1)}`);
      else this.emit(indent, `${this.element(a)} ${r.pick(['+=', '-=', '^=', '*='])} ${this.int(1)}`);
    } else if (k === 11) this.emit(indent, 'pass');
    else if (k === 12) {
      this.emit(indent, `if ${this.bool(1)}:`);
      this.emit(indent + 1, r.chance(0.5) ? 'break' : 'continue');
    } else this.emit(indent, `print(${this.int(1)})`);
  }

  private block(indent: number, depth: number, inLoop: boolean): void {
    // Variables introduced inside the block are not definitely assigned after it, so they leave scope with it.
    const visible = this.ints.length;
    const n = this.r.range(1, 3);
    for (let i = 0; i < n; i++) this.statement(indent, depth, inLoop);
    this.ints.length = visible;
  }

  private statement(indent: number, depth: number, inLoop: boolean): void {
    const r = this.r;
    this.budget--;
    const structured = depth > 0 && this.budget > 0 && this.family !== 'expr';
    const k = structured ? r.below(10) : 0;
    if (!structured || k < 4) {
      this.simple(indent, inLoop);
      return;
    }
    if (k < 7) {
      this.emit(indent, `if ${this.bool(2)}:`);
      this.block(indent + 1, depth - 1, inLoop);
      if (r.chance(0.4)) {
        this.emit(indent, `elif ${this.bool(1)}:`);
        this.block(indent + 1, depth - 1, inLoop);
      }
      if (r.chance(0.6)) {
        this.emit(indent, 'else:');
        this.block(indent + 1, depth - 1, inLoop);
      }
      return;
    }
    if (this.family === 'branch') {
      this.simple(indent, inLoop);
      return;
    }
    if (k < 9) {
      const v = `i${this.loopVars++}`;
      let range: string;
      const kind = r.below(6);
      if (kind === 0) range = r.pick(BOUNDED_RANGES);
      else if (kind === 1) range = `range(((${this.int(1)}) & 7))`;
      else if (kind === 2 && this.arrays.length > 0) range = `range(len(${r.pick(this.arrays).name}))`;
      else if (kind === 3) range = `range(${r.range(-4, 4)}, ${r.range(-4, 9)}, ${r.pick([1, 2, 3, -1, -2])})`;
      else range = `range(${r.range(0, 6)})`;
      // The loop variable is initialized before the loop so that it may be read afterward.
      this.emit(indent, `${v} = ${r.range(-2, 2)}`);
      this.emit(indent, `for ${v} in ${range}:`);
      this.ints.push(v);
      if (r.chance(0.2)) this.emit(indent + 1, `${v} = ${v} + ${r.range(1, 5)}`);
      this.block(indent + 1, depth - 1, true);
      return;
    }
    const c = `w${this.counters++}`;
    this.emit(indent, `${c} = ${r.range(0, 9)}`);
    this.emit(indent, `while ${c} > 0 and ${this.bool(1)}:`);
    this.emit(indent + 1, `${c} -= 1`);
    this.block(indent + 1, depth - 1, true);
  }

  build(): { source: string; params: number } {
    const r = this.r;
    const params = r.range(0, 4);
    const names = ['a', 'b', 'c', 'd'].slice(0, params);
    this.lines.push(`def main(${names.join(', ')}):`);
    this.ints.push(...names);
    const nInts = r.range(2, 4);
    for (let i = 0; i < nInts; i++) {
      this.emit(1, `v${i} = ${this.literal()}`);
      this.ints.push(`v${i}`);
    }
    if (this.family !== 'expr') {
      const nBools = r.range(0, 2);
      for (let i = 0; i < nBools; i++) {
        this.emit(1, `f${i} = ${this.bool(1)}`);
        this.bools.push(`f${i}`);
      }
    }
    if (this.family === 'array' || this.family === 'mixed') {
      const nArrays = r.range(1, 2);
      for (let i = 0; i < nArrays; i++) {
        const name = `r${i}`;
        if (r.chance(0.5)) {
          const length = r.pick([1, 2, 3, 4, 5, 8]);
          const elts = Array.from({ length }, () => (r.chance(0.7) ? this.literal() : this.int(1)));
          this.emit(1, `${name} = [${elts.join(', ')}]`);
          this.arrays.push({ name, length });
        } else {
          const length = r.pick([1, 4, 8, 16, 6]);
          this.emit(1, `${name} = [${r.chance(0.6) ? this.literal() : this.int(1)}] * ${length}`);
          this.arrays.push({ name, length });
        }
      }
    }
    const top = r.range(4, 8);
    for (let i = 0; i < top && this.budget > 0; i++) {
      this.statement(1, 2, false);
      if (this.family !== 'expr' && r.chance(0.06)) {
        this.emit(1, `if ${this.bool(1)}:`);
        this.emit(2, `return ${this.int(1)}`);
      }
    }
    for (const v of this.ints.slice(params, params + 2)) this.emit(1, `print(${v})`);
    if (r.chance(0.85)) this.emit(1, `return ${this.int(2)}`);
    return { source: this.lines.join('\n') + '\n', params };
  }

  argTuples(params: number, count: number): number[][] {
    if (params === 0) return [[]];
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
      out.push(Array.from({ length: params }, () => (this.r.chance(0.6) ? this.r.pick(BOUNDARY) : this.r.chance(0.5) ? this.r.range(-20, 20) : this.r.s32())));
    }
    return out;
  }
}

/** Generate one program of the given family from an initialization value. */
export function generateProgram(init: number, family: Family, argCount = 3): GeneratedProgram {
  const g = new Gen(init, family);
  const { source, params } = g.build();
  return { family, init, source, args: g.argTuples(params, argCount) };
}

export const FAMILIES: Family[] = ['expr', 'branch', 'loop', 'array', 'mixed'];
