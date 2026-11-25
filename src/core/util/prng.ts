/**
 * Deterministic pseudo-random generator (xoshiro128**), used by the test-case
 * generators so that every generated corpus can be reproduced from its recorded
 * initialization value.
 */
export class Prng {
  private s: Uint32Array;

  constructor(init: number) {
    // SplitMix32 expands the single initialization value into the 128-bit state.
    let z = init >>> 0;
    const next = (): number => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
      t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
      return (t ^ (t >>> 16)) >>> 0;
    };
    this.s = Uint32Array.of(next(), next(), next(), next());
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    const s = this.s;
    const r = Math.imul(rotl(Math.imul(s[1]!, 5), 7), 9) >>> 0;
    const t = s[1]! << 9;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11);
    return r;
  }

  /** Uniform integer in [0, n). Rejection sampling removes modulo bias. */
  below(n: number): number {
    if (n <= 0) throw new RangeError('below() requires a positive bound');
    const limit = Math.floor(4294967296 / n) * n;
    let x = this.u32();
    while (x >= limit) x = this.u32();
    return x % n;
  }

  /** Uniform integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.below(hi - lo + 1);
  }

  /** Uniform signed 32-bit integer. */
  s32(): number {
    return this.u32() | 0;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)]!;
  }

  chance(p: number): boolean {
    return this.u32() / 4294967296 < p;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}
