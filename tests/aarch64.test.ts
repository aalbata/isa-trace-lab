import { describe, expect, it } from 'vitest';
import { compile } from '../src/core/compile.ts';
import { aarch64 } from '../src/core/target/aarch64/index.ts';
import { decodeBitmask, encodeBitmask, SPECS } from '../src/core/target/aarch64/isa.ts';
import { bitmaskImmediates } from '../src/core/target/aarch64/validation.ts';
import { assembleText } from '../src/core/target/assemble.ts';
import { Machine, loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { LAYOUT } from '../src/core/target/memory.ts';
import { riscv } from '../src/core/target/riscv/index.ts';
import { bytesToHex, bytesToWordLE, wordToBytesLE } from '../src/core/util/int32.ts';

const assemble = (text: string, base: number = LAYOUT.codeBase) => {
  const r = assembleText(aarch64, text, base);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; '));
  return r.program;
};
const words = (text: string, base: number = LAYOUT.codeBase): string[] => {
  const p = assemble(text, base);
  const out: string[] = [];
  for (let i = 0; i < p.bytes.length; i += 4) out.push(bytesToWordLE(p.bytes, i).toString(16).padStart(8, '0'));
  return out;
};
const errors = (text: string): string[] => {
  const r = assembleText(aarch64, text);
  return r.ok ? [] : r.errors.map((e) => e.message);
};
const runAsm = (text: string, setup?: (m: Machine) => void, steps = 100) => {
  const p = assemble(text);
  const m = new Machine(aarch64, { code: p.bytes, entry: p.base, listing: p });
  setup?.(m);
  for (let i = 0; i < steps && m.step(); i++) {
    // step
  }
  return m;
};
const EXIT = 'movz w8, #2\n svc #0';

describe('A64 encoder', () => {
  it('produces the words that the reference assembler produces for the same text', () => {
    // Words recorded from Clang 20 (aarch64-freestanding) for the same instructions at 0x00400000.
    expect(words('movz w0, #5')).toEqual(['528000a0']);
    expect(words('movz w1, #0x1234, lsl #16')).toEqual(['52a24681']);
    expect(words('add w2, w0, w1')).toEqual(['0b010002']);
    expect(words('subs wzr, w2, w1')).toEqual(['6b01005f']);
    expect(words('and w3, w2, #0xff')).toEqual(['12001c43']);
    expect(words('ldr w4, [x9, w3, uxtw #2]')).toEqual(['b8635924']);
    expect(words('str w4, [sp, #8]')).toEqual(['b9000be4']);
    expect(words('madd w5, w4, w3, wzr')).toEqual(['1b037c85']);
    expect(words('csinc w6, wzr, wzr, lt')).toEqual(['1a9fb7e6']);
    expect(words('svc #0')).toEqual(['d4000001']);
  });

  it('computes branch offsets relative to the branch itself', () => {
    expect(words('b.lt 0x0040002c', 0x00400010)).toEqual(['540000eb']);
    expect(words('cbz w6, 0x0040002c', 0x00400028)).toEqual(['34000026']);
    expect(words('top:\n b top')).toEqual(['14000000']);
  });

  it('accepts the preferred aliases and records them as shorthand', () => {
    const p = assemble('mov w0, #5\n cmp w2, w1\n mul w5, w4, w3\n cset w6, ge\n lsl w0, w1, #3\n mov w7, w8');
    expect(p.insns.map((i) => i.meta.pseudo?.text.split(' ')[0])).toEqual(['mov', 'cmp', 'mul', 'cset', 'lsl', 'mov']);
    expect(p.insns.map((i) => i.insn!.mnemonic)).toEqual(['movz', 'subs', 'madd', 'csinc', 'ubfm', 'orr']);
  });

  it('rejects operands outside the instruction fields', () => {
    // 4096 is encodable as #1, lsl #12; 4097 is neither a 12-bit value nor a shifted one.
    expect(assembleText(aarch64, 'add w0, w1, #4096').ok).toBe(true);
    expect(errors('add w0, w1, #4097').length).toBeGreaterThan(0);
    expect(errors('and w0, w1, #0').length).toBeGreaterThan(0);
    expect(errors('and w0, w1, #0x12345').length).toBeGreaterThan(0);
    expect(errors('str w0, [sp, #2]').length).toBeGreaterThan(0);
    expect(errors('movz w0, #65536').length).toBeGreaterThan(0);
    expect(errors('ldr q0, [x1]').length).toBeGreaterThan(0);
  });

  it('rejects operands after the shift of cmp and cmn with an immediate', () => {
    // CMP and CMN (immediate) take a register, an immediate, and an optional shift.
    expect(errors('cmp x0, #1, lsl #12, x5').length).toBeGreaterThan(0);
    expect(errors('cmn w0, #1, lsl #0, w9').length).toBeGreaterThan(0);
    expect(errors('cmp x0, #1, lsl #0, #99').length).toBeGreaterThan(0);
    expect(words('cmp x0, #1, lsl #12')).toEqual(['f140041f']);
    expect(words('cmn w0, #1')).toEqual(['3100041f']);
  });

  it('rejects a second immediate in the text of a logical instruction', () => {
    // AND, ORR, EOR, and ANDS (immediate) take one immediate; a second one is not the upper half of the value.
    expect(errors('and x0, x1, #0xff, #0xff').length).toBeGreaterThan(0);
    expect(errors('orr x0, xzr, #1, #1').length).toBeGreaterThan(0);
    expect(errors('eor x2, x3, #1, #1').length).toBeGreaterThan(0);
    expect(errors('ands x4, x5, #0xff, #0xff').length).toBeGreaterThan(0);
    expect(words('and x0, x1, #0xff000000ff')).toEqual(['92001c20']);
    expect(words('orr x0, xzr, #0x100000001')).toEqual(['b20003e0']);
  });
});

describe('A64 logical immediates', () => {
  it('round-trips every encodable 32-bit and 64-bit bitmask immediate', () => {
    for (const bits of [32, 64] as const) {
      const all = bitmaskImmediates(bits);
      // 5,334 distinct 64-bit and 1,302 distinct 32-bit logical immediates exist.
      expect(all.length).toBe(bits === 64 ? 5334 : 1302);
      for (const v of all) {
        const f = encodeBitmask(v, bits);
        expect(f, `${bits}-bit ${v.toString(16)}`).not.toBeNull();
        expect(decodeBitmask(f!.n, f!.immr, f!.imms, bits)).toBe(v);
      }
    }
  });

  it('refuses values that have no bitmask encoding', () => {
    for (const v of [0n, 0xffffffffn, 0x12345n, 0x5n]) expect(encodeBitmask(v, 32), v.toString(16)).toBeNull();
    expect(encodeBitmask(0n, 64)).toBeNull();
    expect(encodeBitmask(0xffffffffffffffffn, 64)).toBeNull();
  });
});

describe('A64 decoder', () => {
  it('decodes what the encoder produces, and the decoded text assembles to the same bytes', () => {
    let checked = 0;
    for (const sweep of aarch64.validation.sweeps()) {
      if (sweep.passthrough) continue;
      const p = assemble(sweep.text);
      for (const i of p.insns) {
        if (i.insn === null) continue;
        const d = aarch64.decode(p.bytes, i.address - p.base, i.address);
        expect(d.ok, i.text).toBe(true);
        if (!d.ok) continue;
        const again = assembleText(aarch64, aarch64.format(d.insn), i.address);
        expect(again.ok, aarch64.format(d.insn)).toBe(true);
        if (again.ok) expect(bytesToHex(again.program.bytes), i.text).toBe(bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + 4)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2500);
  });

  it('separates truncated, unsupported, and invalid encodings', () => {
    expect(aarch64.decode(Uint8Array.of(0x00, 0x00), 0, 0)).toMatchObject({ ok: false, kind: 'truncated' });
    // ldr s0, [x1] loads a SIMD and floating-point register.
    expect(aarch64.decode(wordToBytesLE(0xbd400020), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported' });
    // ldp x0, x1, [sp] is a load pair.
    expect(aarch64.decode(wordToBytesLE(0xa94007e0), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported' });
    // The all-zero word is permanently undefined (UDF #0).
    expect(aarch64.decode(wordToBytesLE(0x00000000), 0, 0)).toMatchObject({ ok: false, kind: 'invalid' });
    // Move wide (immediate) with opc = 01 is unallocated.
    expect(aarch64.decode(wordToBytesLE(0x32800000), 0, 0)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('reports unallocated rows of the implemented encoding classes as invalid', () => {
    const kind = (w: number): string => {
      const d = aarch64.decode(wordToBytesLE(w), 0, LAYOUT.codeBase);
      return d.ok ? 'accepted' : d.kind;
    };
    const unallocated = [
      0xb9c00000, 0xf9c00000, // load/store register (unsigned immediate), size = 1x, opc = 11
      0xb8e06800, 0xf8e06800, // load/store register (register offset), size = 1x, opc = 11
      0xb8a00800, 0x38e00800, 0xf8a00800, // register offset with option<1> = 0 in the LDRSW, LDRSB, and PRFM rows
      0x7dc00020, 0xbd800020, // SIMD and floating-point register, size other than 00, opc = 1x
      0xd4000000, 0xd4200001, 0xd4000004, // exception generation: opc = 000 with LL = 00; opc = 001 with LL = 01; op2 = 001
      0xd4600000, // exception generation: opc = 011, which the 2026 encoding tables leave unallocated (formerly TCANCEL)
      0x55000000, 0x56000000, // bits 31 to 24 are 01010101 without RETAASPPC's op2 = 11111; bit 25 set
      0xd61f0400, 0xd67f0000, 0xd61f0001, 0xd69f0000, // branch (register): op3 = 000001; opc = 0011; BR with op4 = 1; ERET with Rn = 0
      0x1b200000, 0x3b000000, 0x9b408000, // 3 source: 32-bit SMADDL row; op54 = 01; SMULH row with o0 = 1
      0x1ac00400, 0x1ac01000, 0x1ac04c00, 0x3ac00800, // 2 source: opcode 000001; 32-bit IRG row; 32-bit CRC32X row; S = 1
    ];
    for (const w of unallocated) expect(kind(w), w.toString(16)).toBe('invalid');
    // Defined instructions outside the subset (words recorded from Clang 20) stay unsupported and are named.
    const defined: [number, RegExp][] = [
      [0x39c00020, /LDRSB/], [0x79800020, /LDRSH/], [0xb9800020, /LDRSW/], [0xf9800020, /PRFM/], [0xb8a26820, /LDRSW/],
      [0x3dc00020, /SIMD and floating-point/], [0xd4000002, /HVC/], [0xd4200000, /BRK/], [0xd4400000, /HLT/], [0xd4a00001, /DCPS1/],
      [0x54000010, /BC\.cond/], [0x5500001f, /RETAASPPC/], [0xd61f083f, /BRAAZ/], [0xd65f0bff, /RETAA/], [0xd65f0be2, /RETAASPPCR/],
      [0xd69f03e0, /ERET/], [0xd6bf03e0, /DRPS/], [0xd73f0822, /BLRAA/], [0x9b220c20, /SMADDL/], [0x9bc27c20, /UMULH/],
      [0x9b620c20, /MADDPT/], [0x1ac20820, /UDIV/], [0x9ac22c20, /RORV/], [0x9ac25c20, /CRC32CX/], [0x9ac23020, /PACGA/],
      [0xbac20020, /SUBPS/], [0x1ac26020, /SMAX/], [0xf8a24838, /RPRFM/], [0xf380001f, /AUTIASPPC/],
    ];
    for (const [w, name] of defined) {
      const d = aarch64.decode(wordToBytesLE(w), 0, LAYOUT.codeBase);
      expect(d.ok ? 'accepted' : d.kind, w.toString(16)).toBe('unsupported');
      if (!d.ok) expect(d.message, w.toString(16)).toMatch(name);
    }
  });

  it('reports unallocated rows of the group tables as invalid and names the defined rows', () => {
    const result = (w: number): string => {
      const d = aarch64.decode(wordToBytesLE(w), 0, LAYOUT.codeBase);
      return d.ok ? 'accepted' : `${d.kind}: ${d.message}`;
    };
    const unallocated = [
      0x1a200000, 0x1a600000, 0x1aa00000, 0x9ae00000, // data processing (register) with bit 28 = 1: op2 = 0001, 0011, 0101, 0111
      0x1a000c00, 0x1a001000, 0x1a00d800, // op2 = 0000 with op3 = 000011, 000100, 110110
      0xd5800000, 0xd5c00000, 0xd5400000, // System: bits 23 and 22 = 10 and 11, and 01 with op0 = 00
      0xd5200000, 0xd5233060, // System: L = 1 with op0 = 00 (the second word is the former TSTART encoding)
      0xd500501f, 0xd500001f, 0xd503001f, // op0 = 00: CRn = 0101; op1 = 000 with CRn = 0000; op1 = 011 with CRn = 0000
      0xd5032000, // the hint row with Rt other than 11111
      0xd5031100, 0xd5033f1f, 0xd503307f, 0xd5033f9e, 0xd5004000, 0xd56838c7, // WFET and WFIT with CRm = 0001; barriers with op2 = 000, op2 = 011, or Rt = 11110; PSTATE with Rt = 0; System pair with L = 1
      0x76000000, 0xf4008000, 0x74004000, 0x75004000, 0x74800000, // compare and branch: bit 25 = 1; sf = 1 with bit 15 = 1; bits 15 and 14 = 01; immediate form with bit 14 = 1; cc = 100
      0x09200000, 0x09000000, 0x8c000000, 0x0c010000, // load and store with bits 29 and 28 = 00
      0x1d200000, 0x99200000, 0x19000c00, 0x19201c00, 0x1d000000, 0xd9000c00, // load and store with bits 29 and 28 = 01
    ];
    for (const w of unallocated) expect(result(w), w.toString(16)).toMatch(/^invalid: /);
    // Words recorded from Clang 20, except STSHH (HINT #48), which is built from the hints table of the Arm encoding index.
    const defined: [number, RegExp][] = [
      [0x1a020020, /ADC/], [0xba018402, /RMIF/], [0x3a00080d, /SETF8/], [0x9a022020, /ADDPT/], [0x7a410002, /CCMP/], [0xfa5fb800, /CCMP/],
      [0xd51bd040, /MSR \(move to a system register/], [0xd53bd040, /MRS/], [0xd5087500, /SYS \(/], [0xd5287500, /SYSL/], [0xd5488000, /SYSP/],
      [0xd5582000, /MSRR/], [0xd5782000, /MRRS/], [0xd5031003, /WFET/], [0xd5033f9f, /DSB/], [0xd5033bbf, /DMB/], [0xd5033fdf, /ISB/],
      [0xd50330ff, /SB \(speculation barrier/], [0xd5033f5f, /CLREX/], [0xd5033e3f, /DSB .*nXS/], [0xd50041bf, /MSR \(immediate\)/], [0xd500401f, /CFINV/],
      [0xd503203f, /YIELD/], [0xd503207f, /WFI/], [0xd503233f, /PACIASP/], [0xd503245f, /BTI/], [0xd50324ff, /PACM/], [0xd503251f, /CHKFEAT/],
      [0xd503261f, /STSHH/], [0xd5032fff, /HINT #127/],
      [0xf4020001, /CB<cc> \(compare registers/], [0x74028001, /CBB<cc>/], [0x74c2c001, /CBH<cc>/], [0xf5028001, /CB<cc> \(compare a register with an immediate/],
      [0x885f7c20, /LDXR/], [0xc87f8440, /LDXP/], [0x88dffc20, /LDAR/], [0x88a07c41, /compare and swap \(CAS/], [0x4860fc82, /CASP/],
      [0x4c407000, /multiple structures/], [0x0d400c00, /single structure/], [0x895f7c20, /LDTXR/], [0xc9807c41, /CAST/], [0x49807c82, /CASPT/],
    ];
    for (const [w, name] of defined) expect(result(w), w.toString(16)).toMatch(new RegExp(`^unsupported: .*${name.source}`));
  });

  it('names the class of load and store encodings whose bits 29 and 28 are 01', () => {
    const message = (w: number): string => {
      const d = aarch64.decode(wordToBytesLE(w), 0, LAYOUT.codeBase);
      return d.ok ? 'accepted' : `${d.kind}: ${d.message}`;
    };
    // Words recorded from Clang 20: ldapur w0, [x1]; stlurb w0, [x1]; stg x0, [x0]; ldg x0, [x0]; ldr w0, <label>; cpyfp; setp.
    expect(message(0x99400020)).toMatch(/^unsupported: .*LDAPUR/);
    expect(message(0x19000020)).toMatch(/^unsupported: .*LDAPUR/);
    expect(message(0xd9200800)).toMatch(/^unsupported: .*STG/);
    expect(message(0xd9600000)).toMatch(/^unsupported: .*STG/);
    expect(message(0x18000000)).toMatch(/^unsupported: .*load register \(literal\)/);
    expect(message(0x19010440)).toMatch(/^unsupported: .*memory copy or memory set/);
    expect(message(0x19c20420)).toMatch(/^unsupported: .*memory copy or memory set/);
    for (const w of [0x99400020, 0xd9200800]) expect(message(w)).not.toMatch(/literal|memory copy/);
    // ldtadd w0, w1, [x2] and swptal x0, x1, [x2] (FEAT_LSUI); rcwcas; rcwcasp; swpp; ldiapp; ldapr with writeback; stlur q0; gcsstr.
    expect(message(0x19200441)).toMatch(/^unsupported: .*LDTADD.*FEAT_LSUI/);
    expect(message(0x59e08441)).toMatch(/^unsupported: .*LDTADD.*FEAT_LSUI/);
    expect(message(0x19200841)).toMatch(/^unsupported: .*RCWCAS/);
    expect(message(0x19200c82)).toMatch(/^unsupported: .*RCWCASP/);
    expect(message(0x19218040)).toMatch(/^unsupported: .*SWPP/);
    expect(message(0x99411840)).toMatch(/^unsupported: .*LDIAPP/);
    expect(message(0x99c00820)).toMatch(/^unsupported: .*with writeback/);
    expect(message(0x1d900820)).toMatch(/^unsupported: .*SIMD and floating-point register.*LDAPUR/);
    expect(message(0xd91f0c20)).toMatch(/^unsupported: .*GCSSTR/);
  });

  it('reports the mov alias of ORR (immediate) only for values that MOVZ and MOVN cannot load', () => {
    // MOV (bitmask immediate) excludes values that MOVZ or MOVN can load, so the alias text must assemble to the ORR word.
    let aliases = 0;
    for (const bits of [32, 64] as const) {
      const rd = bits === 64 ? 'x0' : 'w0';
      const zr = bits === 64 ? 'xzr' : 'wzr';
      for (const v of bitmaskImmediates(bits)) {
        const [word] = words(`orr ${rd}, ${zr}, #0x${v.toString(16)}`);
        const d = aarch64.decode(wordToBytesLE(Number.parseInt(word!, 16)), 0, LAYOUT.codeBase);
        expect(d.ok).toBe(true);
        if (!d.ok || d.alias === undefined) continue;
        aliases++;
        expect(words(d.alias), `${d.alias} for ${word}`).toEqual([word]);
      }
    }
    expect(aliases).toBe(760 + 4246);
    // orr w0, wzr, #0xfffffffe is movn w0, #1 as a value; orr x0, xzr, #0xffffffffffff0000 is movn x0, #0xffff.
    for (const w of [0x321f7be0, 0xb270bfe0]) expect(aarch64.decode(wordToBytesLE(w), 0, LAYOUT.codeBase)).not.toHaveProperty('alias');
    expect(aarch64.decode(wordToBytesLE(0xb200f3e0), 0, LAYOUT.codeBase)).toMatchObject({ ok: true, alias: 'mov x0, #0x5555555555555555' });
  });

  it('distinguishes register 31 as the stack pointer and as the zero register', () => {
    const text = (w: number): string => {
      const d = aarch64.decode(wordToBytesLE(w), 0, LAYOUT.codeBase);
      return d.ok ? aarch64.format(d.insn) : `(${d.kind})`;
    };
    // ADD (immediate) with Rd = Rn = 31 addresses SP; ADD (shifted register) with 31 addresses ZR.
    expect(text(0x910043ff)).toBe('add sp, sp, #16');
    expect(text(0x8b1f03ff)).toMatch(/^add xzr, xzr, xzr/);
    // The base register of a load is SP when it is 31.
    expect(text(0xb94003e0)).toBe('ldr w0, [sp]');
  });
});

describe('A64 processor model', () => {
  it('zeroes the upper half of an X register on a W write', () => {
    const m = runAsm('movn x0, #0\n add w0, w0, #1', undefined, 2);
    expect(m.cpu.readReg('x0')).toBe(0n);
    const n = runAsm('movn x1, #0\n orr w1, wzr, #0xff', undefined, 2);
    expect(n.cpu.readReg('x1')).toBe(0xffn);
  });

  it('sets NZCV for subtraction with carry meaning no borrow', () => {
    const flags = (a: number, b: number) => runAsm(`subs w2, w0, w1`, (m) => {
      m.cpu.writeReg('x0', BigInt(a >>> 0));
      m.cpu.writeReg('x1', BigInt(b >>> 0));
    }, 1).cpu.readFlags();
    expect(flags(5, 3)).toEqual({ N: 0, Z: 0, C: 1, V: 0 });
    expect(flags(3, 5)).toEqual({ N: 1, Z: 0, C: 0, V: 0 });
    expect(flags(7, 7)).toEqual({ N: 0, Z: 1, C: 1, V: 0 });
    expect(flags(-2147483648, 1)).toEqual({ N: 0, Z: 0, C: 1, V: 1 });
    expect(flags(2147483647, -1)).toEqual({ N: 1, Z: 0, C: 0, V: 1 });
  });

  it('branches on conditions and links through x30', () => {
    const m = runAsm(`bl f\n ${EXIT}\nf:\n movz w0, #9\n ret`);
    expect(m.status).toBe('exited');
    expect(m.returnValue).toBe(9);
    const ev = newStepEvent(0);
    const p = assemble('subs wzr, w0, w1\n b.lt 0x00400000');
    const k = new Machine(aarch64, { code: p.bytes, entry: p.base });
    k.cpu.writeReg('x0', 1n);
    k.cpu.writeReg('x1', 2n);
    k.step();
    k.step(ev);
    expect(ev.branch).toEqual({ conditional: true, taken: true, target: 0x00400000 });
  });

  it('faults deterministically', () => {
    expect(runAsm('.word 0x00000000').fault).toBeDefined();
    // An unallocated word is an undefined instruction; a defined instruction outside the subset is unimplemented.
    expect(runAsm('.word 0xb9c00000').fault).toMatch(/^undefined instruction/);
    expect(runAsm('.word 0xd4000000').fault).toMatch(/^undefined instruction/);
    expect(runAsm('.word 0xb9800000').fault).toMatch(/^unimplemented instruction .*LDRSW/);
    expect(runAsm('.word 0x1a200000').fault).toMatch(/^undefined instruction/);
    expect(runAsm('.word 0xd5800000').fault).toMatch(/^undefined instruction/);
    expect(runAsm('.word 0xd503203f').fault).toMatch(/^unimplemented instruction .*YIELD/);
    expect(runAsm('movz x0, #0\n ldr w1, [x0]').fault).toMatch(/unmapped/);
    expect(runAsm('movz x0, #0x40, lsl #16\n movk x0, #2\n br x0').fault).toMatch(/alignment|multiple of 4|aligned/);
  });

  it('reports the full address of a branch that leaves the 32-bit address space', () => {
    const cases: [string, bigint, bigint][] = [
      ['br x1', 0x100400008n, 0x100400008n],
      ['blr x1', 0xffffffff00400008n, 0xffffffff00400008n],
      ['ret x1', 0x8000000000400010n, 0x8000000000400010n],
      ['b 0xfffffffffffffff8', 0n, 0xfffffffffffffff8n],
      ['bl 0xfffffffffffffff8', 0n, 0xfffffffffffffff8n],
    ];
    for (const [text, x1, full] of cases) {
      const p = assemble(text);
      const m = new Machine(aarch64, { code: p.bytes, entry: p.base, listing: p });
      m.cpu.writeReg('x1', x1);
      const ev = newStepEvent(0);
      m.step(ev);
      const low = Number(full & 0xffffffffn);
      expect(ev.branch, text).toStrictEqual({ conditional: false, taken: true, target: low, target64: full });
      expect([ev.nextPc, ev.nextPc64], text).toEqual([low, full]);
      expect(m.cpu.readReg('pc'), text).toBe(full);
      // The fetch at that address faults, and the step reports the unchanged program counter in full.
      const after = newStepEvent(1);
      m.step(after);
      expect(m.status, text).toBe('fault');
      expect([after.nextPc, after.nextPc64], text).toEqual([low, full]);
      expect(after.branch, text).toBeUndefined();
      expect(m.cpu.readReg('pc'), text).toBe(full);
    }
    // A target inside the 32-bit address space has no 64-bit fields.
    const p = assemble('movz x1, #0x40, lsl #16\n br x1');
    const m = new Machine(aarch64, { code: p.bytes, entry: p.base, listing: p });
    m.step();
    const ev = newStepEvent(1);
    m.step(ev);
    expect(ev.branch).toStrictEqual({ conditional: false, taken: true, target: 0x00400000 });
    expect(ev.nextPc).toBe(0x00400000);
    expect('nextPc64' in ev).toBe(false);
  });

  it('reports the address of a faulting instruction as the next program counter of its step', () => {
    const cases: [string, number][] = [
      ['.word 0x00000000', 0x00400000],
      ['nop\n .word 0xb9800000', 0x00400004],
      ['movz x0, #0\n ldr w1, [x0]', 0x00400004],
      ['movz x0, #0\n str w1, [x0]', 0x00400004],
      ['movz x0, #0x40, lsl #16\n movk x0, #2\n br x0', 0x00400002],
      ['movz x0, #0x1000, lsl #16\n br x0', 0x10000000],
    ];
    for (const [text, at] of cases) {
      const p = assemble(text);
      const m = new Machine(aarch64, { code: p.bytes, entry: p.base, listing: p });
      let ev = newStepEvent(0);
      while (m.status === 'running') {
        ev = newStepEvent(m.executed);
        m.step(ev);
      }
      expect(m.status, text).toBe('fault');
      expect(ev.stop?.kind, text).toBe('fault');
      expect([ev.pc, ev.nextPc, m.cpu.pc], text).toEqual([at, at, at]);
      expect('nextPc64' in ev, text).toBe(false);
      // The processor model alone, without the machine, reports the same address.
      const direct = new Machine(aarch64, { code: p.bytes, entry: p.base, listing: p });
      let last = newStepEvent(0);
      for (let k = 0; k < 8; k++) {
        last = newStepEvent(k);
        if (direct.cpu.step(last) !== null) break;
      }
      expect([last.nextPc, direct.cpu.pc], text).toEqual([at, at]);
    }
  });
});

describe('A64 compiler and catalog', () => {
  it('runs a compiled program and changes behaviour when an operand field is edited', () => {
    const r = compile('def main():\n    x = 5\n    return x + 1\n', aarch64);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.compiled;
    expect(loadCompiled(aarch64, c).run().returnValue).toBe(6);
    const target = c.program.insns.find((i) => /^movz w19, #(0x)?5$/.test(i.text))!;
    expect(target).toBeDefined();
    const m = loadCompiled(aarch64, c);
    const word = m.mem.peek32(target.address)!;
    // The 16-bit immediate of MOVZ occupies bits 20 to 5.
    const edited = ((word & ~(0xffff << 5)) | (9 << 5)) >>> 0;
    m.pokeCode(target.address, wordToBytesLE(edited));
    expect(m.run().returnValue).toBe(10);
    expect(m.mappingStale(target.address)).toBe(true);
  });

  it('has a catalog entry for every implemented instruction, with an example that assembles', () => {
    const catalog = new Set(aarch64.instructions.map((i) => i.mnemonic));
    // The sixteen conditional branches share one catalog entry.
    for (const s of SPECS) expect(catalog.has(s.mnemonic.startsWith('b.') ? 'b.cond' : s.mnemonic), s.mnemonic).toBe(true);
    for (const i of aarch64.instructions) expect(assembleText(aarch64, i.example).ok, `${i.mnemonic}: ${i.example}`).toBe(true);
    const keys = new Set(aarch64.operations.map((o) => o.key));
    for (const o of riscv.operations) expect(keys.has(o.key), o.key).toBe(true);
  });

  it('lists the stack pointer apart from the 31 general-purpose registers', () => {
    const registers = aarch64.profile.registers;
    expect(registers.filter((r) => r.generalPurpose !== false).map((r) => r.name)).toEqual(Array.from({ length: 31 }, (_, i) => `x${i}`));
    expect(registers.filter((r) => r.generalPurpose === false).map((r) => r.name)).toEqual(['sp']);
  });

  it('keeps the register roles of the profile disjoint', () => {
    const c = aarch64.profile.conventions;
    const all = [...c.varRegs, ...c.tempRegs, ...c.scratch];
    expect(new Set(all).size).toBe(all.length);
    for (const r of [c.stackPointer, c.serviceNumber, 'w30', 'x30']) expect(all).not.toContain(r);
  });
});
