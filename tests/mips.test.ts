import { describe, expect, it } from 'vitest';
import { compile } from '../src/core/compile.ts';
import { assembleText } from '../src/core/target/assemble.ts';
import { Machine, loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { LAYOUT } from '../src/core/target/memory.ts';
import { INSTRUCTIONS, OPERATIONS } from '../src/core/target/mips/catalog.ts';
import { mips } from '../src/core/target/mips/index.ts';
import { ENCODINGS } from '../src/core/target/mips/isa.ts';
import { PSEUDO } from '../src/core/target/mips/text.ts';
import { riscv } from '../src/core/target/riscv/index.ts';
import { bytesToHex, bytesToWordLE, wordToBytesLE } from '../src/core/util/int32.ts';

const assemble = (text: string) => {
  const r = assembleText(mips, text);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; '));
  return r.program;
};
const words = (text: string): string[] => {
  const p = assemble(text);
  const out: string[] = [];
  for (let i = 0; i < p.bytes.length; i += 4) out.push(bytesToWordLE(p.bytes, i).toString(16).padStart(8, '0'));
  return out;
};
const errors = (text: string): string[] => {
  const r = assembleText(mips, text);
  return r.ok ? [] : r.errors.map((e) => e.message);
};
const runAsm = (text: string, steps = 100) => {
  const p = assemble(text);
  const m = new Machine(mips, { code: p.bytes, entry: p.base, listing: p });
  for (let i = 0; i < steps && m.step(); i++) {
    // step
  }
  return m;
};
const EXIT = 'li $v0, 2\n syscall';

describe('MIPS32 encoder', () => {
  it('encodes each format as the manual lays it out', () => {
    // Words checked by hand against the instruction pages and against Clang's assembler output.
    expect(words('addu $t0, $t1, $t2')).toEqual(['012a4021']);
    expect(words('add $t0, $t1, $t2')).toEqual(['012a4020']);
    expect(words('subu $t0, $t1, $t2')).toEqual(['012a4023']);
    expect(words('mul $t0, $t1, $t2')).toEqual(['712a4002']);
    expect(words('sll $t0, $t1, 31')).toEqual(['000947c0']);
    expect(words('sllv $t0, $t1, $t2')).toEqual(['01494004']);
    expect(words('addiu $t0, $zero, -5')).toEqual(['2408fffb']);
    expect(words('andi $t0, $t1, 65535')).toEqual(['3128ffff']);
    expect(words('lui $gp, 0x1000')).toEqual(['3c1c1000']);
    expect(words('lw $t0, -32768($sp)')).toEqual(['8fa88000']);
    expect(words('sw $t0, 32767($sp)')).toEqual(['afa87fff']);
    expect(words('jr $ra')).toEqual(['03e00008']);
    expect(words('jalr $t0')).toEqual(['0100f809']);
    expect(words('jalr $t1, $t0')).toEqual(['01004809']);
    expect(words('syscall')).toEqual(['0000000c']);
    expect(words('syscall 5')).toEqual(['0000014c']);
  });

  it('stores words least significant byte first', () => {
    expect(bytesToHex(assemble('addiu $v0, $zero, 2').bytes)).toBe('02 00 02 24');
  });

  it('accepts numeric register names and $s8', () => {
    expect(words('addiu $8, $9, 1')).toEqual(words('addiu $t0, $t1, 1'));
    expect(words('addiu $t0, $s8, 1')).toEqual(words('addiu $t0, $fp, 1'));
  });

  it('computes branch offsets from the delay slot and jump targets within the region', () => {
    expect(words('top:\n beq $t0, $t1, top\n nop')[0]).toBe('1109ffff');
    expect(words('bne $t0, $zero, done\n nop\ndone:\n syscall')[0]).toBe('15000001');
    expect(words('bltz $t0, 0x00400000\n nop\n bgez $t0, 0x00400000')).toEqual(['0500ffff', '00000000', '0501fffd']);
    expect(words('j 0x00400070')).toEqual(['0810001c']);
    expect(words('jal 0x0ffffffc')).toEqual(['0fffffff']);
    expect(words(`beq $zero, $zero, ${0x00400004 - 131072}`)).toEqual(['10008000']);
    expect(words(`bne $zero, $zero, ${0x00400004 + 131068}`)).toEqual(['14007fff']);
  });

  it('rejects operands outside the instruction fields', () => {
    expect(errors('addiu $t0, $t0, 32768')[0]).toMatch(/16-bit signed field/);
    expect(errors('addiu $t0, $t0, -32769')[0]).toMatch(/16-bit signed field/);
    expect(errors('ori $t0, $t0, -1')[0]).toMatch(/16-bit unsigned field/);
    expect(errors('lui $t0, 65536')[0]).toMatch(/16-bit unsigned field/);
    expect(errors('sll $t0, $t0, 32')[0]).toMatch(/outside 0 to 31/);
    expect(errors('lw $t0, 32768($sp)')[0]).toMatch(/16-bit signed field/);
    expect(errors('syscall 1048576')[0]).toMatch(/20-bit field/);
    expect(errors('addu $t0, $t1')[0]).toMatch(/takes 3 operands/);
    expect(errors('addu $t0, $t1, $q9')[0]).toMatch(/unknown register/);
    expect(errors('addu t0, t1, t2')[0]).toMatch(/register names begin with \$/);
    expect(errors('div $t0, $t1')[0]).toMatch(/not a MIPS32 instruction implemented/);
    expect(errors('beq $t0, $t1, nowhere')[0]).toMatch(/not defined/);
    expect(errors('j 0x10000000')[0]).toMatch(/outside the 256 MB region/);
    expect(errors('j 0x00400002')[0]).toMatch(/not a multiple of 4/);
    expect(errors(`beq $zero, $zero, ${0x00400004 + 131072}`)[0]).toMatch(/18-bit offset/);
    expect(errors(`beq $zero, $zero, ${0x00400000 - 131072}`)[0]).toMatch(/18-bit offset/);
  });

  it('reports a mnemonic that is the name of a property of every object as unknown', () => {
    for (const text of ['constructor', 'constructor $t0', 'Constructor $t0, $t1', 'x:\n constructor x']) {
      expect(errors(text), text).toHaveLength(1);
      expect(errors(text)[0], text).toMatch(/'constructor' is not a MIPS32 instruction implemented by this profile or a supported pseudoinstruction/);
    }
    expect(mips.parseLine('constructor').ok).toBe(false);
  });

  it('expands pseudoinstructions as Clang does', () => {
    const texts = (source: string): string[] => assemble(source).insns.map((i) => i.text);
    expect(texts('li $t0, 5')).toEqual(['addiu $t0, $zero, 5']);
    expect(texts('li $t0, 40000')).toEqual(['ori $t0, $zero, 0x9c40']);
    expect(texts('li $t0, 65536')).toEqual(['lui $t0, 0x1']);
    expect(texts('li $t0, 0x12345678')).toEqual(['lui $t0, 0x1234', 'ori $t0, $t0, 0x5678']);
    expect(texts('li $t0, -32769')).toEqual(['lui $t0, 0xffff', 'ori $t0, $t0, 0x7fff']);
    expect(texts('move $t0, $t1')).toEqual(['or $t0, $t1, $zero']);
    expect(texts('negu $t0, $t1')).toEqual(['subu $t0, $zero, $t1']);
    expect(texts('not $t0, $t1')).toEqual(['nor $t0, $t1, $zero']);
    expect(words('nop')).toEqual(['00000000']);
    expect(texts('x:\n b x\n beqz $t0, x\n bnez $t0, x')).toEqual(['beq $zero, $zero, x', 'beq $t0, $zero, x', 'bne $t0, $zero, x']);
    expect(assemble('nop').insns[0]!.meta.pseudo?.text).toBe('nop');
  });

  it('loads every 32-bit constant correctly with li', () => {
    for (const v of [0, 1, -1, 32767, 32768, -32768, -32769, 65535, 65536, 0x7fffffff, -2147483648, 0x12345678, 0x7fff8000, -65536, 305419896]) {
      const m = runAsm(`li $a0, ${v}\n ${EXIT}`);
      expect(m.returnValue, String(v)).toBe(v | 0);
    }
  });

  it('describes in the catalog the li expansion that the assembler chooses for every operand', () => {
    const spec = INSTRUCTIONS.find((s) => s.mnemonic === 'li')!;
    // Each clause of the expansion text names the first instruction and the operand range that selects it;
    // an operand outside every range is expanded to lui followed by ori.
    const ranges = [...spec.expansion!.matchAll(/(\w+) rt, [^;]*? when imm is in (-?\d+) to (-?\d+)/g)]
      .map((r) => ({ first: r[1]!, lo: Number(r[2]), hi: Number(r[3]) }));
    expect(ranges.length).toBeGreaterThan(1);
    const operands = [-2147483648, -32769, -32768, -1, 0, 32767, 32768, 65535, 65536, 2147483647, 2147483648, 4294901760,
      4294934527, 4294934528, 4294950000, 4294967295];
    for (const v of operands) {
      const covering = ranges.filter((r) => v >= r.lo && v <= r.hi);
      expect(covering.length, String(v)).toBeLessThanOrEqual(1);
      const first = assemble(`li $t0, ${v}`).insns[0]!.insn!.mnemonic;
      expect(first, String(v)).toBe(covering[0]?.first ?? 'lui');
    }
  });
});

describe('MIPS32 decoder', () => {
  it('decodes what the encoder produces, and the decoded text assembles to the same bytes', () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const sweep of mips.validation.sweeps()) {
      if (sweep.passthrough) continue;
      const p = assemble(sweep.text);
      for (const i of p.insns) {
        if (i.insn === null) continue;
        const d = mips.decode(p.bytes, i.address - p.base, i.address);
        expect(d.ok, i.text).toBe(true);
        if (!d.ok) continue;
        seen.add(d.insn.mnemonic);
        expect(mips.format(d.insn)).toBe(mips.format({ mnemonic: i.insn.mnemonic, operands: i.insn.operands.map((o) => (o.t === 'addr' ? { t: 'addr', value: o.value } : o)) }));
        // parseLine(format(decoded)) encodes to the original word at the same address.
        const parsed = mips.parseLine(mips.format(d.insn));
        expect(parsed.ok, i.text).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.items.length).toBe(1);
        const again = assembleText(mips, mips.format(d.insn), i.address);
        expect(again.ok && bytesToHex(again.program.bytes), i.text).toBe(bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + 4)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1800);
    // The sweeps cover every implemented instruction.
    expect([...seen].sort()).toEqual(ENCODINGS.map((e) => e.mnemonic).sort());
  });

  it('uses every register in every register operand position of every instruction in the sweeps', () => {
    // For each mnemonic, the registers seen at each operand position (the base register of a memory operand included).
    const seen = new Map<string, Set<string>[]>();
    for (const sweep of mips.validation.sweeps()) {
      if (sweep.passthrough) continue;
      for (const i of assemble(sweep.text).insns) {
        if (i.insn === null) continue;
        const slots = seen.get(i.insn.mnemonic) ?? [];
        i.insn.operands.forEach((o, k) => {
          const name = o.t === 'reg' ? o.name : o.t === 'mem' ? o.base : null;
          if (name) (slots[k] ??= new Set()).add(name);
        });
        seen.set(i.insn.mnemonic, slots);
      }
    }
    let positions = 0;
    for (const e of ENCODINGS) {
      for (const [k, names] of (seen.get(e.mnemonic) ?? []).entries()) {
        if (!names) continue;
        positions++;
        expect(names.size, `${e.mnemonic}, operand ${k + 1}`).toBe(32);
      }
    }
    expect(positions).toBeGreaterThan(80);
  });

  it('describes the bit fields of an instruction', () => {
    const d = mips.decode(wordToBytesLE(0x012a4021), 0, LAYOUT.codeBase);
    expect(d.ok && d.fields.map((f) => `${f.name}=${f.value}`)).toEqual(['opcode=0', 'rs=9', 'rt=10', 'rd=8', 'sa=0', 'function=33']);
    const b = mips.decode(wordToBytesLE(0x11090001), 0, 0x00400010);
    expect(b.ok && mips.format(b.insn)).toBe('beq $t0, $t1, 0x00400018');
    const j = mips.decode(wordToBytesLE(0x0810001c), 0, 0x00400084);
    expect(j.ok && mips.format(j.insn)).toBe('j 0x00400070');
    for (const w of [0x012a4021, 0x11090001, 0x0810001c, 0x8fa88000, 0x0000014c, 0x03e00008, 0x3c1c1000]) {
      const r = mips.decode(wordToBytesLE(w), 0, LAYOUT.codeBase);
      // The fields cover the 32 bits of the word exactly once.
      expect(r.ok && r.fields.reduce((n, f) => n + f.hi - f.lo + 1, 0)).toBe(32);
    }
  });

  it('separates truncated, unsupported, and invalid encodings', () => {
    const kind = (w: number) => mips.decode(wordToBytesLE(w), 0, 0);
    expect(mips.decode(Uint8Array.of(0x13, 0x05), 0, 0)).toMatchObject({ ok: false, kind: 'truncated' });
    // mult $t1, $t2 uses HI and LO.
    expect(kind(0x012a0018)).toMatchObject({ ok: false, kind: 'unsupported' });
    // beql, bgezal, movn, teq, break, mfc0, add.s, rotr.
    for (const w of [0x51090001, 0x05110001, 0x012a400b, 0x012a0034, 0x0000000d, 0x40086000, 0x46020000, 0x00294082]) {
      expect(kind(w), w.toString(16)).toMatchObject({ ok: false, kind: 'unsupported' });
    }
    // blez with a nonzero rt field and lui with a nonzero rs field are Release 6 encodings.
    expect(kind(0x19090001)).toMatchObject({ ok: false, kind: 'unsupported' });
    expect(kind(0x3d281234)).toMatchObject({ ok: false, kind: 'unsupported' });
    // addu with a nonzero shift-amount field, and sll with a nonzero rs field.
    expect(kind(0x012a4061)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(kind(0x00494080)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(kind(0xffffffff)).toMatchObject({ ok: false, kind: 'unsupported' });
    // SPECIAL function codes 101000 and 111001 are reserved.
    for (const w of [0x00000028, 0x00000039]) expect(kind(w), w.toString(16)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  // The next three tests cover the codes marked beta (a valid encoding for a higher-order ISA level, here MIPS64)
  // in Tables A.2, A.3, and A.5 of the MIPS32 Instruction Set Manual.
  const verdictOf = (w: number): string => {
    const d = mips.decode(wordToBytesLE(w >>> 0), 0, 0);
    return d.ok ? `ok ${mips.format(d.insn)}` : `${d.kind}: ${d.message.replace(/^0x[0-9a-f]{8}: /, '')}`;
  };
  const MIPS64 = 'unsupported: MIPS64 instruction; the profile is MIPS32';
  const mips64Code = (table: string, f: number): string =>
    `unsupported: ${table} function code ${f.toString(2).padStart(6, '0')} belongs to MIPS64; the profile is MIPS32`;
  // The function codes that Table A.3 (SPECIAL) and Table A.5 (SPECIAL2) mark beta.
  const SPECIAL_MIPS64 = [0b010100, 0b010101, 0b010110, 0b010111, 0b011100, 0b011101, 0b011110, 0b011111, 0b101100, 0b101101,
    0b101110, 0b101111, 0b111000, 0b111010, 0b111011, 0b111100, 0b111110, 0b111111];
  const SPECIAL2_MIPS64 = [0b100100, 0b100101];
  const OP_SPECIAL2 = 0b011100 << 26;

  it('reports the MIPS64 opcodes as MIPS64 instructions', () => {
    for (const op of [0b011000, 0b011001, 0b011010, 0b011011, 0b100111, 0b101100, 0b101101, 0b110100, 0b110111, 0b111100, 0b111111]) {
      expect(verdictOf(((op << 26) | (8 << 21) | (9 << 16) | 4) >>> 0), op.toString(2)).toBe(MIPS64);
    }
  });

  it('reports every MIPS64 function code of SPECIAL and SPECIAL2 as outside the profile, whatever the other fields hold', () => {
    // daddu, dsll, dsllv, dmult, and dclz with all other fields zero; daddu $t2, $t0, $t1; dclz and dclo $t0, $t1;
    // dmult with rd = $t2 and bits 10 to 6 equal to 00100; function code 111111 with every other field all ones.
    expect(verdictOf(0x0000002d)).toBe(mips64Code('SPECIAL', 0b101101));
    expect(verdictOf(0x00000038)).toBe(mips64Code('SPECIAL', 0b111000));
    expect(verdictOf(0x00000014)).toBe(mips64Code('SPECIAL', 0b010100));
    expect(verdictOf(0x0000001c)).toBe(mips64Code('SPECIAL', 0b011100));
    expect(verdictOf(0x70000024)).toBe(mips64Code('SPECIAL2', 0b100100));
    expect(verdictOf(0x0109502d)).toBe(mips64Code('SPECIAL', 0b101101));
    expect(verdictOf(0x71284024)).toBe(mips64Code('SPECIAL2', 0b100100));
    expect(verdictOf(0x71284025)).toBe(mips64Code('SPECIAL2', 0b100101));
    expect(verdictOf(0x0109511c)).toBe(mips64Code('SPECIAL', 0b011100));
    expect(verdictOf(0x03ffffff)).toBe(mips64Code('SPECIAL', 0b111111));
    // Every value of rd and bits 10 to 6, with three values of rs and rt, for each of the twenty codes.
    const wrong: string[] = [];
    for (const [opcode, table, codes] of [[0, 'SPECIAL', SPECIAL_MIPS64], [OP_SPECIAL2, 'SPECIAL2', SPECIAL2_MIPS64]] as const) {
      for (const f of codes) {
        const expected = mips64Code(table, f);
        for (const [rs, rt] of [[0, 0], [8, 9], [31, 31]] as const) {
          for (let low = 0; low < 1024; low++) {
            const w = (opcode | (rs << 21) | (rt << 16) | (low << 6) | f) >>> 0;
            const got = verdictOf(w);
            if (got !== expected) wrong.push(`${w.toString(16).padStart(8, '0')}: ${got}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives the MIPS64 classification to exactly the function codes that the tables mark, and keeps the other rules', () => {
    // With the other fields zero and with rs, rt, and rd set, a function code is reported as a MIPS64 code exactly
    // when Table A.3 or Table A.5 marks it.
    for (const [opcode, codes] of [[0, SPECIAL_MIPS64], [OP_SPECIAL2, SPECIAL2_MIPS64]] as const) {
      const marked: number[] = [];
      for (let f = 0; f < 64; f++) {
        const zero = /belongs to MIPS64/.test(verdictOf((opcode | f) >>> 0));
        const fields = /belongs to MIPS64/.test(verdictOf((opcode | (8 << 21) | (9 << 16) | (10 << 11) | f) >>> 0));
        expect(fields, f.toString(2)).toBe(zero);
        if (zero) marked.push(f);
      }
      expect(marked).toEqual(codes);
    }
    // Function codes that Table A.3 marks reserved keep the reserved wording: 101000 and 111001.
    expect(verdictOf(0x00000028)).toBe('invalid: reserved SPECIAL function code 101000 in MIPS32 Release 2');
    expect(verdictOf(0x00000039)).toBe('invalid: reserved SPECIAL function code 111001 in MIPS32 Release 2');
    // MULT, MULTU, DIV, and DIVU (function codes 011000 to 011011) are MIPS32 instructions, so their fields are
    // examined as Table A.23 lists them: rd and bits 10 to 6 zero, or bits 10 to 6 equal to 00010 or 00011 (Release 6).
    const wrong: string[] = [];
    for (const f of [0b011000, 0b011001, 0b011010, 0b011011]) {
      for (const [rs, rt] of [[0, 0], [8, 9], [31, 17]] as const) {
        for (let rd = 0; rd < 32; rd++) {
          for (let sa = 0; sa < 32; sa++) {
            const w = ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | f) >>> 0;
            const listed = (rd === 0 && sa === 0) || sa === 0b00010 || sa === 0b00011;
            const got = verdictOf(w).split(':')[0]!;
            if (got !== (listed ? 'unsupported' : 'invalid')) wrong.push(`${w.toString(16).padStart(8, '0')}: ${got}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('names an excluded instruction only when the fields that it requires to be zero are zero', () => {
    const verdict = (w: number) => mips.decode(wordToBytesLE(w >>> 0), 0, 0);
    // Well-formed encodings of excluded instructions: mfhi $t2, mthi $t0, mult $t0, $t1, sync, movf $t2, $t0, $fcc0,
    // movz $t2, $t0, $t1, madd $t0, $t1, clz $t2, $t0, blezl $t0, bgtzl $t0.
    for (const w of [0x00005010, 0x01000011, 0x01090018, 0x0000000f, 0x01005001, 0x0109500a, 0x71090000, 0x710a5020, 0x59000004, 0x5d000004]) {
      expect(verdict(w), w.toString(16)).toMatchObject({ ok: false, kind: 'unsupported' });
    }
    // The same function codes with a nonzero field that the instruction requires to be zero: MFHI with rs and rt,
    // MTHI with rt and rd, MULT with rd, SYNC with bits 25 to 11, MOVF with bits 10 to 6, MOVF with bit 17,
    // MOVZ with bits 10 to 6, MADD with rd, MADD with bits 10 to 6, CLZ with bits 10 to 6, MFLO with bits 10 to 6.
    for (const w of [0x01095010, 0x01095011, 0x01095018, 0x0109500f, 0x01005041, 0x01025001, 0x0109504a, 0x71095000, 0x71090040, 0x710a5060, 0x00005052]) {
      expect(verdict(w), w.toString(16)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    // Release 6 defines these function codes and opcodes with other values of those fields: CLZ and CLO in the
    // places of MFHI and MTHI, MUL and DIVU with the result in rd, and compact branches in the places of BLEZL and BGTZL.
    const release6: [number, RegExp][] = [
      [0x01005050, /Release 6 instruction CLZ/], [0x01005051, /Release 6 instruction CLO/], [0x01095098, /Release 6 instruction MUL\b/],
      [0x0109509b, /Release 6 instruction DIVU\b/], [0x59090004, /Release 6 compact-branch encoding \(BLEZC/], [0x5d090004, /Release 6 compact-branch encoding \(BGTZC/],
    ];
    for (const [w, message] of release6) {
      const d = verdict(w);
      expect(d, w.toString(16)).toMatchObject({ ok: false, kind: 'unsupported' });
      expect(!d.ok && d.message, w.toString(16)).toMatch(message);
    }
  });

  it('reports the conventional shorthand of an instruction', () => {
    const alias = (text: string): string | undefined => {
      const p = assemble(text);
      const d = mips.decode(p.bytes, 0, p.base);
      return d.ok ? d.alias : undefined;
    };
    expect(alias('sll $zero, $zero, 0')).toBe('nop');
    expect(alias('addiu $t0, $zero, 7')).toBe('li $t0, 7');
    expect(alias('or $t0, $t1, $zero')).toBe('move $t0, $t1');
    expect(alias('subu $t0, $zero, $t1')).toBe('negu $t0, $t1');
    expect(alias('nor $t0, $t1, $zero')).toBe('not $t0, $t1');
    expect(alias('beq $zero, $zero, 0x00400000')).toBe('b 0x00400000');
    expect(alias('bne $t0, $zero, 0x00400000')).toBe('bnez $t0, 0x00400000');
    expect(alias('addu $t0, $t1, $t2')).toBeUndefined();
  });
});

describe('MIPS32 processor model', () => {
  it('keeps $zero at zero and uses five bits of a shift count', () => {
    const m = runAsm(`addiu $zero, $zero, 5\n li $t0, 33\n li $t1, 1\n sllv $a0, $t1, $t0\n ${EXIT}`);
    expect(m.cpu.reg32('$zero')).toBe(0);
    expect(m.returnValue).toBe(2);
  });

  it('distinguishes signed and unsigned comparisons, shifts, and immediate extension', () => {
    const m = runAsm('li $t0, -1\n li $t1, 1\n slt $a0, $t0, $t1\n sltu $a1, $t0, $t1\n sra $a2, $t0, 4\n srl $a3, $t0, 28\n sltiu $v0, $t1, -1\n andi $v1, $t0, 0xffff\n xori $s0, $t0, 0xffff\n nor $s1, $t1, $zero');
    expect(['$a0', '$a1', '$a2', '$a3', '$v0', '$v1', '$s0', '$s1'].map((r) => m.cpu.reg32(r))).toEqual([1, 0, -1, 15, 1, 0xffff, -65536, -2]);
  });

  it('multiplies to the low 32 bits', () => {
    const m = runAsm(`li $t0, 0x12345678\n li $t1, 0x9abcdef0\n mul $a0, $t0, $t1\n ${EXIT}`);
    expect(m.returnValue).toBe(0x242d2080);
  });

  it('loads and stores bytes, halfwords, and words in little-endian order', () => {
    const m = runAsm('lui $gp, 0x1000\n li $t0, 0x80c0ffee\n sw $t0, 0($gp)\n lb $a0, 0($gp)\n lbu $a1, 0($gp)\n lh $a2, 2($gp)\n lhu $a3, 2($gp)\n lw $v0, 0($gp)\n sb $t0, 5($gp)\n sh $t0, 10($gp)\n lw $v1, 4($gp)\n lw $s0, 8($gp)');
    expect(m.mem.peek(LAYOUT.dataBase, 4)).toEqual(Uint8Array.of(0xee, 0xff, 0xc0, 0x80));
    expect(['$a0', '$a1', '$a2', '$a3', '$v0', '$v1', '$s0'].map((r) => m.cpu.reg32(r))).toEqual([-18, 0xee, -32576, 0x80c0, 0x80c0ffee | 0, 0xee00, 0xffee0000 | 0]);
  });

  it('executes the delay slot before a taken branch, a not-taken branch, and a jump take effect', () => {
    // Taken: the slot runs, the skipped instruction does not.
    let m = runAsm(`li $a0, 0\n beq $zero, $zero, over\n addiu $a0, $a0, 1\n addiu $a0, $a0, 16\nover:\n ${EXIT}`);
    expect(m.returnValue).toBe(1);
    // Not taken: the slot runs once and execution continues after it.
    m = runAsm(`li $a0, 0\n bne $zero, $zero, over\n addiu $a0, $a0, 1\n addiu $a0, $a0, 16\nover:\n ${EXIT}`);
    expect(m.returnValue).toBe(17);
    m = runAsm(`li $a0, 0\n j over\n addiu $a0, $a0, 1\n addiu $a0, $a0, 16\nover:\n ${EXIT}`);
    expect(m.returnValue).toBe(1);
  });

  it('links to the address after the delay slot', () => {
    const m = runAsm(`jal f\n nop\n ${EXIT}\nf:\n li $a0, 9\n jr $ra\n nop`);
    expect(m.status).toBe('exited');
    expect(m.returnValue).toBe(9);
    expect(m.cpu.reg32('$ra')).toBe(LAYOUT.codeBase + 8);
    expect(m.executed).toBe(7);
    const n = runAsm(`li $t9, 0x00400018\n jalr $t0, $t9\n nop\n ${EXIT}\n li $a0, 4\n move $ra, $t0\n jr $ra\n nop`);
    expect(n.returnValue).toBe(4);
    expect(n.cpu.reg32('$t0')).toBe(LAYOUT.codeBase + 16);
  });

  it('marks the delay-slot instruction and keeps pc at the next instruction to fetch', () => {
    const p = assemble('beq $zero, $zero, 0x00400010\n addiu $t0, $zero, 7\n nop\n nop\n nop');
    const m = new Machine(mips, { code: p.bytes, entry: p.base });
    const branch = newStepEvent(0);
    m.step(branch);
    expect(branch.klass).toBe('branch');
    expect(branch.branch).toEqual({ conditional: true, taken: true, target: 0x00400010 });
    expect(branch.delaySlot).toBeUndefined();
    expect(branch.nextPc).toBe(p.base + 4);
    expect(m.cpu.pc).toBe(p.base + 4);
    // A snapshot taken between the branch and its delay slot keeps the pending target.
    const snap = m.cpu.snapshot();
    const slot = newStepEvent(1);
    m.step(slot);
    expect(slot.delaySlot).toBe(true);
    expect(slot.text).toBe('addiu $t0, $zero, 7');
    expect(slot.nextPc).toBe(0x00400010);
    expect(m.cpu.pc).toBe(0x00400010);
    const after = newStepEvent(2);
    m.step(after);
    expect(after.delaySlot).toBeUndefined();
    m.cpu.restore(snap);
    expect(m.cpu.pc).toBe(p.base + 4);
    m.cpu.step();
    expect(m.cpu.pc).toBe(0x00400010);
  });

  it('faults deterministically', () => {
    expect(runAsm('.word 0xffffffff').fault).toMatch(/Reserved Instruction: 0xffffffff/);
    expect(runAsm('lw $a0, 0($zero)').fault).toMatch(/unmapped address 0x00000000/);
    expect(runAsm('lui $t0, 0x1000\n lw $a0, 2($t0)').fault).toMatch(/Address Error: 4-byte load/);
    expect(runAsm('lui $t0, 0x1000\n sh $a0, 1($t0)').fault).toMatch(/Address Error: 2-byte store/);
    expect(runAsm('lui $t0, 0x40\n sw $a0, 0($t0)').fault).toMatch(/read-only code region/);
    expect(runAsm('li $t0, 0x00400006\n jr $t0\n nop').fault).toMatch(/Address Error: instruction address 0x00400006/);
    expect(runAsm('lui $t0, 0x1000\n jr $t0\n nop').fault).toMatch(/instruction fetch outside the code region/);
    expect(runAsm('li $v0, 99\n syscall').fault).toMatch(/service number 99/);
  });

  it('completes jr and jalr to an address with bit 0 set or in the kernel segments, and faults on the fetch of the target', () => {
    // The jump and its delay slot execute as for any target: the link register receives the address after the delay
    // slot, the delay-slot instruction writes its register, and the program counter holds the target unchanged,
    // bit 0 included. The fault belongs to the next step, the fetch at the target.
    const targets: [number, RegExp][] = [
      [0x00400011, /Address Error: instruction address 0x00400011/], [0x10000001, /Address Error: instruction address 0x10000001/],
      [0xc0000000, /instruction fetch outside the code region at 0xc0000000/], [0xfffffffc, /instruction fetch outside the code region at 0xfffffffc/],
      [0xc0000001, /Address Error: instruction address 0xc0000001/], [0xffffffff, /Address Error: instruction address 0xffffffff/],
    ];
    for (const [target, message] of targets) {
      for (const jump of ['jalr $t0, $t9', 'jr $t9']) {
        const p = assemble(`lui $t9, ${target >>> 16}\n ori $t9, $t9, ${target & 0xffff}\n ${jump}\n addiu $v1, $v1, 1\n nop`);
        const m = new Machine(mips, { code: p.bytes, entry: p.base, listing: p });
        const name = `${jump} to 0x${target.toString(16)}`;
        for (let k = 0; k < 4; k++) m.step();
        expect(m.status, name).toBe('running');
        expect(m.cpu.pc >>> 0, name).toBe(target);
        expect(m.cpu.reg32('$v1'), name).toBe(1);
        // The jump is the third instruction; its delay slot is the fourth.
        expect(m.cpu.reg32('$t0') >>> 0, name).toBe(jump.startsWith('jalr') ? p.base + 16 : 0);
        const ev = newStepEvent(4);
        m.step(ev);
        expect(m.status, name).toBe('fault');
        expect(m.fault, name).toMatch(message);
        expect([ev.pc >>> 0, m.cpu.pc >>> 0], name).toEqual([target, target]);
        expect(m.cpu.reg32('$v1'), name).toBe(1);
      }
    }
  });

  it('reports the address of a faulting instruction as the next program counter of its step', () => {
    const cases: [string, number][] = [
      ['li $t0, 0x7fffffff\n addi $t1, $t0, 1', 0x00400008],
      ['b 0x00400010\n jr $ra', 0x00400004],
      ['lui $t0, 0x1000\n lw $t1, 2($t0)', 0x00400004],
      ['.word 0xffffffff', 0x00400000],
      ['li $t0, 0x00400000\n jalr $t0, $t0', 0x00400004],
      ['li $t0, 0x00400006\n jr $t0\n nop', 0x00400006],
    ];
    for (const [text, at] of cases) {
      const p = assemble(text);
      const m = new Machine(mips, { code: p.bytes, entry: p.base, listing: p });
      let ev = newStepEvent(0);
      while (m.status === 'running') {
        ev = newStepEvent(m.executed);
        m.step(ev);
      }
      expect(m.status, text).toBe('fault');
      expect(ev.stop?.kind, text).toBe('fault');
      expect([ev.pc, ev.nextPc, m.cpu.pc], text).toEqual([at, at, at]);
      // The processor model alone, without the machine, reports the same address.
      const direct = new Machine(mips, { code: p.bytes, entry: p.base, listing: p });
      let last = newStepEvent(0);
      for (let k = 0; k < 8; k++) {
        last = newStepEvent(k);
        if (direct.cpu.step(last) !== null) break;
      }
      expect([last.nextPc, direct.cpu.pc], text).toEqual([at, at]);
    }
  });

  it('raises Integer Overflow for add, addi, and sub and leaves the destination unchanged', () => {
    for (const body of ['add $t2, $t0, $t1', 'addi $t2, $t0, 1', 'sub $t2, $t0, $t3']) {
      const m = runAsm(`li $t0, 0x7fffffff\n li $t1, 1\n li $t3, -1\n li $t2, 55\n ${body}`);
      expect(m.fault, body).toMatch(/Integer Overflow exception/);
      expect(m.cpu.reg32('$t2')).toBe(55);
    }
    const ok = runAsm(`li $t0, 0x7fffffff\n li $t1, 1\n addu $a0, $t0, $t1\n addiu $a1, $t0, 1\n subu $a2, $zero, $t0\n add $a3, $t1, $t1`);
    expect(ok.fault).toBeUndefined();
    expect(['$a0', '$a1', '$a2', '$a3'].map((r) => ok.cpu.reg32(r))).toEqual([-2147483648, -2147483648, -2147483647, 2]);
  });

  it('faults on the UNPREDICTABLE cases instead of choosing a behaviour', () => {
    expect(runAsm('x:\n b x\n b x\n nop').fault).toMatch(/delay slot.*UNPREDICTABLE/);
    expect(runAsm('x:\n bne $zero, $zero, x\n jr $ra\n nop').fault).toMatch(/delay slot.*UNPREDICTABLE/);
    expect(runAsm('li $t0, 0x00400000\n jalr $t0, $t0\n nop').fault).toMatch(/destination and as target.*UNPREDICTABLE/);
  });

  it('performs a service requested in a delay slot and continues at the branch target', () => {
    const m = runAsm(`li $v0, 1\n li $a0, 42\n b over\n syscall\n li $a0, 0\nover:\n ${EXIT}`);
    expect(m.output).toEqual([42]);
    expect(m.returnValue).toBe(42);
  });
});

describe('MIPS32 compiler and catalog', () => {
  const SOURCE = 'def main(n):\n    a = [0] * 4\n    s = 0\n    for i in range(n):\n        a[i & 3] += i * 3\n        if a[i & 3] > 5:\n            s -= 1\n    print(s)\n    return s + a[1]\n';

  it('fills every delay slot with nop and uses only non-trapping arithmetic', () => {
    const r = compile(SOURCE, mips);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const insns = r.compiled.program.insns;
    const control = new Set(['beq', 'bne', 'blez', 'bgtz', 'bltz', 'bgez', 'j', 'jal', 'jr', 'jalr']);
    let slots = 0;
    insns.forEach((i, k) => {
      const name = i.insn!.mnemonic;
      expect(['add', 'addi', 'sub']).not.toContain(name);
      expect(i.text).not.toMatch(/\$at/);
      if (control.has(name)) {
        expect(insns[k + 1]!.text).toBe('sll $zero, $zero, 0');
        expect(insns[k + 1]!.meta.pseudo?.text).toBe('nop');
        slots++;
      }
    });
    expect(slots).toBeGreaterThan(4);
    const m = loadCompiled(mips, r.compiled, { args: [10] });
    const o = m.run();
    const other = compile(SOURCE, riscv);
    if (!other.ok) throw new Error('compile failed');
    const ref = loadCompiled(riscv, other.compiled, { args: [10] }).run();
    expect(o.status).toBe('exited');
    expect([o.returnValue, o.output]).toEqual([ref.returnValue, ref.output]);
  });

  it('emits for b, beqz, and bnez the expansion that the assembler gives the recorded pseudoinstruction text', () => {
    const sources = [
      SOURCE,
      'def main(a, b):\n    s = 0\n    while a < b or s > 3:\n        a += 1\n        if a >= b and s <= a:\n            s += 2\n    return s\n',
    ];
    const seen = new Map<string, number>();
    for (const source of sources) {
      const r = compile(source, mips);
      if (!r.ok) throw new Error('compile failed');
      const p = r.compiled.program;
      for (const i of p.insns) {
        const pseudo = i.meta.pseudo;
        if (!pseudo || !/^(b|beqz|bnez) /.test(pseudo.text)) continue;
        // The text is the pseudoinstruction as written: the mnemonic, the register of beqz and bnez, and the label
        // of the target, which is the address that the emitted instruction branches to.
        const m = /^(?:(b)|(beqz|bnez) (\$\w+),) (\S+)$/.exec(pseudo.text);
        expect(m, pseudo.text).not.toBeNull();
        const mnemonic = (m![1] ?? m![2])!;
        const label = m![4]!;
        seen.set(mnemonic, (seen.get(mnemonic) ?? 0) + 1);
        expect(pseudo.count, pseudo.text).toBe(1);
        expect(i.insn!.operands.at(-1), pseudo.text).toEqual({ t: 'addr', value: p.symbols[label], label });
        // The assembler expands the text to the instruction that the code generator emitted.
        const parsed = mips.parseLine(pseudo.text);
        expect(parsed.ok, pseudo.text).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.items.map((item) => (item.kind === 'insn' ? mips.format(item.insn) : '')), pseudo.text).toEqual([i.text]);
        // Assembled at the address of the instruction, with the target written as an address, the text gives the
        // bytes of the program.
        const again = assembleText(mips, pseudo.text.replace(label, String(p.symbols[label])), i.address);
        expect(again.ok && bytesToHex(again.program.bytes), pseudo.text).toBe(bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + 4)));
      }
    }
    for (const mnemonic of ['b', 'beqz', 'bnez']) expect(seen.get(mnemonic) ?? 0, mnemonic).toBeGreaterThan(0);
  });

  it('changes behaviour when an operand field in the code bytes is edited', () => {
    const r = compile('def main():\n    x = 5\n    return x + 1\n', mips);
    if (!r.ok) throw new Error('compile failed');
    const target = r.compiled.program.insns.find((i) => i.text === 'addiu $s0, $zero, 5')!;
    expect(target).toBeDefined();
    const m = loadCompiled(mips, r.compiled);
    expect(m.run().returnValue).toBe(6);
    m.reset();
    const word = m.mem.peek32(target.address)!;
    m.pokeCode(target.address, wordToBytesLE(((word & 0xffff0000) | 9) >>> 0));
    expect(m.run().returnValue).toBe(10);
    m.reset();
    // mult $t1, $t2 is outside the profile.
    m.pokeCode(target.address, wordToBytesLE(0x012a0018));
    expect(m.run().fault).toMatch(/Reserved Instruction: 0x012a0018.*HI\/LO/);
  });

  it('has a catalog entry for every instruction and pseudoinstruction, with examples that assemble', () => {
    const names = new Set(INSTRUCTIONS.map((s) => s.mnemonic));
    for (const e of ENCODINGS) expect(names.has(e.mnemonic), e.mnemonic).toBe(true);
    for (const p of Object.keys(PSEUDO)) expect(names.has(p), p).toBe(true);
    expect(names.size).toBe(ENCODINGS.length + Object.keys(PSEUDO).length);
    for (const s of INSTRUCTIONS) expect(errors(s.example), s.example).toEqual([]);
    expect(OPERATIONS.map((o) => o.key).sort()).toEqual(riscv.operations.map((o) => o.key).sort());
    for (const o of OPERATIONS) expect(errors(`target:\n${o.assembly.join('\n')}`), o.key).toEqual([]);
  });

  it('names in the profile the instruction families that the decoder reports as outside the subset', () => {
    const listed = mips.profile.excluded.join('; ');
    // Words of instructions outside the subset, with the mnemonic that the list of excluded families must contain.
    const cases: [number, string][] = [
      [0x0000000f, 'sync'], [0x041f0000, 'synci'], [0xcc000000, 'pref'], [0xbc000000, 'cache'], [0x03e00408, 'jr.hb'],
      [0x0320fc09, 'jalr.hb'], [0x7c03e83b, 'rdhwr'], [0x7000003f, 'sdbbp'], [0x710a5020, 'clz'], [0x710a5021, 'clo'],
      [0x71090001, 'maddu'], [0x71090005, 'msubu'], [0x05120001, 'bltzall'], [0x05130001, 'bgezall'], [0x002950c2, 'rotr'],
      [0x01005001, 'movf'], [0x0000000d, 'break'], [0x00005010, 'mfhi'], [0x01090018, 'mult'], [0x55090001, 'bnel'],
      [0x74100000, 'jalx'],
    ];
    for (const [w, name] of cases) {
      expect(mips.decode(wordToBytesLE(w >>> 0), 0, 0), name).toMatchObject({ ok: false, kind: 'unsupported' });
      expect(listed, name).toMatch(new RegExp(`(^|[ (,])${name.replace('.', '\\.')}([,);]|$)`));
    }
    // clz and clo are MIPS32 instructions; the Release 2 entry does not hold them.
    for (const entry of mips.profile.excluded) if (/Release 2/.test(entry)) expect(entry).not.toMatch(/\bcl[oz]\b/);
  });

  it('keeps the register roles of the profile disjoint', () => {
    const c = mips.profile.conventions;
    const reserved = [...c.args, c.result, c.stackPointer, c.link, c.serviceNumber, c.serviceArg, '$zero', '$at', '$gp'];
    for (const r of [...c.varRegs, ...c.tempRegs, ...c.scratch]) expect(reserved).not.toContain(r);
    expect(new Set([...c.varRegs, ...c.tempRegs, ...c.scratch]).size).toBe(c.varRegs.length + c.tempRegs.length + c.scratch.length);
  });
});
