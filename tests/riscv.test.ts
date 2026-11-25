import { describe, expect, it } from 'vitest';
import { decodeBytes } from '../src/core/api.ts';
import { compile } from '../src/core/compile.ts';
import { assembleText } from '../src/core/target/assemble.ts';
import { getBackend } from '../src/core/target/index.ts';
import { Machine, loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { LAYOUT } from '../src/core/target/memory.ts';
import { riscv } from '../src/core/target/riscv/index.ts';
import { crossCheck } from '../src/core/trace/crosscheck.ts';
import { bytesToHex, bytesToWordLE, hex, wordToBytesLE } from '../src/core/util/int32.ts';

const assemble = (text: string) => {
  const r = assembleText(riscv, text);
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
  const r = assembleText(riscv, text);
  return r.ok ? [] : r.errors.map((e) => e.message);
};
const runAsm = (text: string, steps = 100) => {
  const p = assemble(text);
  const m = new Machine(riscv, { code: p.bytes, entry: p.base, listing: p });
  for (let i = 0; i < steps && m.step(); i++) {
    // step
  }
  return m;
};

describe('RV32I encoder', () => {
  it('encodes each format as the specification lays it out', () => {
    // Words checked by hand against the RV32I format tables.
    expect(words('add a0, a1, a2')).toEqual(['00c58533']);
    expect(words('sub a0, a1, a2')).toEqual(['40c58533']);
    expect(words('addi a0, a1, -1')).toEqual(['fff58513']);
    expect(words('slli t0, t1, 31')).toEqual(['01f31293']);
    expect(words('srai t0, t1, 1')).toEqual(['40135293']);
    expect(words('lw a0, 8(sp)')).toEqual(['00812503']);
    expect(words('sw a0, -4(sp)')).toEqual(['fea12e23']);
    expect(words('lui a0, 0x12345')).toEqual(['12345537']);
    expect(words('jalr zero, 0(ra)')).toEqual(['00008067']);
    expect(words('ecall')).toEqual(['00000073']);
  });

  it('stores words least significant byte first', () => {
    expect(bytesToHex(assemble('addi a7, zero, 2').bytes)).toBe('93 08 20 00');
  });

  it('computes branch and jump offsets from the instruction address', () => {
    expect(words('top:\n beq a0, a1, top')).toEqual(['00b50063']);
    expect(words('addi zero, zero, 0\n bne a0, zero, done\n addi zero, zero, 0\ndone:\n ecall')[1]).toBe('00051463');
    expect(words('jal ra, target\n addi zero, zero, 0\ntarget:\n ecall')[0]).toBe('008000ef');
  });

  it('rejects operands outside the instruction fields', () => {
    expect(errors('addi a0, a0, 2048')[0]).toMatch(/12-bit signed field/);
    expect(errors('addi a0, a0, -2049')[0]).toMatch(/12-bit signed field/);
    expect(errors('slli a0, a0, 32')[0]).toMatch(/outside 0 to 31/);
    expect(errors('lui a0, 1048576')[0]).toMatch(/20-bit field/);
    expect(errors('lw a0, 4096(sp)')[0]).toMatch(/12-bit signed field/);
    expect(errors('add a0, a1')[0]).toMatch(/takes 3 operands/);
    expect(errors('add a0, a1, q9')[0]).toMatch(/unknown|label|register/);
    expect(errors('mul a0, a1, a2')[0]).toMatch(/not an RV32I instruction/);
    expect(errors('beq a0, a1, nowhere')[0]).toMatch(/not defined/);
    expect(errors('x:\nx:\n ecall')[0]).toMatch(/more than once/);
  });

  it('reports a mnemonic that names a property of Object.prototype as unknown', () => {
    expect(errors('constructor')[0]).toMatch(/'constructor' is not an RV32I instruction/);
    expect(errors('nop\nCONSTRUCTOR a0, a1')[0]).toMatch(/'constructor' is not an RV32I instruction/);
  });

  it('names FENCE, FENCE.TSO, PAUSE, and EBREAK as RV32I instructions that the profile leaves out', () => {
    for (const text of ['ebreak', 'fence', 'fence rw, rw', 'fence.tso', 'pause']) {
      expect(errors(text)[0], text).toMatch(/is an RV32I base instruction that this profile does not implement/);
    }
    expect(riscv.profile.excluded.join('; ')).toMatch(/FENCE \(with FENCE\.TSO and PAUSE\) and EBREAK/);
  });

  it('relaxes a conditional branch that cannot reach its target', () => {
    const pad = Array.from({ length: 1100 }, () => 'addi zero, zero, 0').join('\n');
    const p = assemble(`beq a0, a1, far\n${pad}\nfar:\n ecall`);
    // The branch becomes the inverted branch over an unconditional jump.
    expect(p.insns[0]!.text).toMatch(/^bne a0, a1, /);
    expect(p.insns[1]!.text).toMatch(/^jal zero, far/);
    const m = new Machine(riscv, { code: p.bytes, entry: p.base });
    m.cpu.writeReg('a0', 5n);
    m.cpu.writeReg('a1', 5n);
    m.cpu.writeReg('a7', 2n);
    m.step();
    m.step();
    expect(m.cpu.pc).toBe(p.symbols['far']);
  });

  it('expands pseudoinstructions into base instructions', () => {
    expect(assemble('li a0, 5').insns.map((i) => i.text)).toEqual(['addi a0, zero, 5']);
    expect(assemble('li a0, 100000').insns.map((i) => i.text)).toEqual(['lui a0, 0x18', 'addi a0, a0, 1696']);
    expect(assemble('li a0, 2048').insns.map((i) => i.text)).toEqual(['lui a0, 0x1', 'addi a0, a0, -2048']);
    expect(assemble('li a0, 4096').insns.map((i) => i.text)).toEqual(['lui a0, 0x1']);
    expect(assemble('mv a0, a1').insns[0]!.text).toBe('addi a0, a1, 0');
    expect(assemble('ret').insns[0]!.text).toBe('jalr zero, 0(ra)');
    expect(assemble('nop').insns[0]!.meta.pseudo?.text).toBe('nop');
  });

  it('loads every 32-bit constant correctly with li', () => {
    for (const v of [0, 1, -1, 2047, 2048, -2048, -2049, 4095, 4096, 0x7ff, 0x800, 0x7fffffff, -2147483648, 0x12345678, 0x7ffff800, -4096, 305419896]) {
      const m = runAsm(`li a0, ${v}\n li a7, 2\n ecall`);
      expect(m.returnValue, String(v)).toBe(v | 0);
    }
  });
});

describe('RV32I decoder', () => {
  it('decodes what the encoder produces and formats it back to the same text', () => {
    let checked = 0;
    for (const sweep of riscv.validation.sweeps()) {
      if (sweep.passthrough) continue;
      const p = assemble(sweep.text);
      for (const i of p.insns) {
        if (i.insn === null) continue;
        const d = riscv.decode(p.bytes, i.address - p.base, i.address);
        expect(d.ok, i.text).toBe(true);
        if (!d.ok) continue;
        expect(riscv.format(d.insn)).toBe(riscv.format({ mnemonic: i.insn.mnemonic, operands: i.insn.operands.map((o) => (o.t === 'addr' ? { t: 'addr', value: o.value } : o)) }));
        // The decoded text assembles to the original word at the same address.
        const again = assembleText(riscv, riscv.format(d.insn), i.address);
        expect(again.ok && bytesToHex(again.program.bytes)).toBe(bytesToHex(p.bytes.subarray(i.address - p.base, i.address - p.base + 4)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1200);
  });

  it('describes the bit fields of an instruction', () => {
    const d = riscv.decode(wordToBytesLE(0x00c58533), 0, LAYOUT.codeBase);
    expect(d.ok && d.fields.map((f) => `${f.name}=${f.value}`)).toEqual(['funct7=0', 'rs2=12', 'rs1=11', 'funct3=0', 'rd=10', 'opcode=51']);
    const b = riscv.decode(wordToBytesLE(0x00b50463), 0, 0x00400010);
    expect(b.ok && riscv.format(b.insn)).toBe('beq a0, a1, 0x00400018');
  });

  it('separates truncated, unsupported, and invalid encodings', () => {
    expect(riscv.decode(Uint8Array.of(0x13, 0x05), 0, 0)).toMatchObject({ ok: false, kind: 'truncated' });
    // mul a0, a1, a2 belongs to the M extension.
    expect(riscv.decode(wordToBytesLE(0x02c58533), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported' });
    // A 16-bit compressed encoding.
    expect(riscv.decode(wordToBytesLE(0x00000001), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported' });
    // csrrw is defined by Zicsr.
    expect(riscv.decode(wordToBytesLE(0x30051073), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported' });
    // srai with shamt[5] set is reserved in RV32I.
    expect(riscv.decode(wordToBytesLE(0x4365df93), 0, 0)).toMatchObject({ ok: false, kind: 'invalid' });
    expect(riscv.decode(wordToBytesLE(0xffffffff), 0, 0)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('treats bits [15:0] all zero as the illegal instruction, not as a compressed encoding', () => {
    for (const word of [0x00000000, 0x12340000, 0xffff0000]) {
      const d = riscv.decode(wordToBytesLE(word), 0, 0);
      expect(d, hex(word)).toMatchObject({ ok: false, kind: 'invalid', length: 4 });
      expect(!d.ok && d.message, hex(word)).toMatch(/bits \[15:0\] are all zero/);
    }
  });

  it('classifies a complete 16-bit parcel from its two bytes', () => {
    // c.nop is complete in two bytes; the low bits 01 mark a compressed encoding, so no further byte is needed.
    expect(riscv.decode(Uint8Array.of(0x01, 0x00), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported', length: 2 });
    expect(riscv.decode(Uint8Array.of(0x01, 0x00, 0x13), 0, 0)).toMatchObject({ ok: false, kind: 'unsupported', length: 2 });
    // The low bits 11 announce a 32-bit instruction, which needs four bytes.
    expect(riscv.decode(Uint8Array.of(0x13, 0x05, 0x00), 0, 0)).toMatchObject({ ok: false, kind: 'truncated', length: 3 });
  });

  it('treats a short all-zero parcel as the start of the 32-bit illegal instruction', () => {
    // Without a 16-bit extension, the illegal instruction with bits [15:0] all zero is 32 bits long (manual Section
    // 1.5), so two or three of its bytes are truncated and no further instruction starts inside it.
    expect(riscv.decode(Uint8Array.of(0x00, 0x00), 0, 0)).toMatchObject({ ok: false, kind: 'truncated', length: 2 });
    expect(riscv.decode(Uint8Array.of(0x00, 0x00, 0x13), 0, 0)).toMatchObject({ ok: false, kind: 'truncated', length: 3 });
    expect(decodeBytes('riscv', Uint8Array.of(0x00, 0x00, 0x13))).toMatchObject([{ address: LAYOUT.codeBase, bytes: '000013', ok: false, kind: 'truncated' }]);
    expect(decodeBytes('riscv', Uint8Array.of(0x13, 0x05, 0x00, 0x00, 0x00, 0x00, 0x13)).map((d) => [d.bytes, d.ok ? d.text : d.kind])).toEqual([
      ['13050000', 'addi a0, zero, 0'], ['000013', 'truncated'],
    ]);
  });

  it('names the extension of instructions that ratified extensions define', () => {
    // Words assembled by Clang 20. LD, SD, and LWU are the RV64I encodings, which Zilsd reuses for LD and SD on RV32.
    const cases: [number, RegExp][] = [
      [0x20c5a533, /^SH1ADD, .* Zba extension/], [0x40c5f533, /^ANDN, .* Zbb and Zbkb extensions/],
      [0x0ac5e533, /^MAX, .* Zbb extension/], [0x60059513, /^CLZ, .* Zbb extension/], [0x60459513, /^SEXT\.B, /],
      [0x0805c533, /^ZEXT\.H /], [0x6035d513, /^RORI, /], [0x2875d513, /^ORC\.B, /], [0x6985d513, /^REV8, /],
      [0x0ac59533, /^CLMUL, .* Zbc and Zbkc extensions/], [0x0ac5a533, /^CLMULR, .* Zbc extension/],
      [0x48c59533, /^BCLR, .* Zbs extension/], [0x4855d513, /^BEXTI, /], [0x28359513, /^BSETI, /],
      [0x08c5c533, /^PACK, .* Zbkb extension/], [0x08f59513, /^ZIP, /], [0x08f5d513, /^UNZIP, /], [0x6875d513, /^BREV8, /],
      [0x28c5a533, /^XPERM4, .* Zbkx extension/], [0x28c5c533, /^XPERM8, /],
      [0x0ec5d533, /^CZERO\.EQZ, .* Zicond extension/], [0x0ec5f533, /^CZERO\.NEZ, /],
      [0x10059513, /^SHA256SUM0, .* Zknh extension/], [0x50c58533, /^SHA512SUM0R, /], [0x5ec58533, /^SHA512SIG1H, /],
      [0x22c58533, /^AES32ESI, .* Zkne extension/], [0xeec58533, /^AES32DSMI, .* Zknd extension/],
      [0xf0c58533, /^SM4ED, .* Zksed extension/], [0x10959513, /^SM3P1, .* Zksh extension/],
      [0x0085b503, /^LD, .* Zilsd extension/], [0x00c5b823, /^SD, .* Zilsd extension/], [0x0045e503, /^LWU, .* RV64I/],
      [0x3ac58533, /^AES64DS, RV64-only .* Zknd extension/], [0x7ec58533, /^AES64KS2, RV64-only .* Zknd and Zkne extensions/],
      [0x30059513, /^AES64IM, RV64-only /], [0x31a59513, /^AES64KS1I, RV64-only /], [0x10459513, /^SHA512SUM0, RV64-only .* Zknh/],
      [0x022180d7, /^VADD, vector instruction of the V extension/], [0x0d05f557, /^VSETVLI, vector instruction of the V extension/],
      [0x070c0457, /^VANDN, .* Zvbb and Zvkb extensions/], [0x5701b457, /^VROR, .* Zvbb and Zvkb extensions/],
      [0xd70c0457, /^VWSLL, .* Zvbb extension/], [0x4b052457, /^VBREV\.V, .* Zvbb extension/], [0x330c2457, /^VCLMUL, .* Zvbc extension/],
      [0xef0c1457, /^VFWMACCBF16, .* Zvfbfwma extension/], [0x4b0e9457, /^VFNCVTBF16\.F\.F\.W, .* Zvfbfmin extension/],
      [0x5e0c0457, /^VMV\.V\.V, /], [0x5d054457, /^VMERGE\.VXM, /], [0x9f03b457, /^VMV8R\.V, /], [0x5208a457, /^VID\.V, /],
      [0x43002557, /^VMV\.X\.S, /], [0x5f0c2457, /^VCOMPRESS\.VM, /], [0x410c0457, /^VADC, /],
      [0x02056087, /^vector unit-stride load of the V extension/], [0x02057087, /^vector unit-stride load of the V extension/],
      [0x020560a7, /^vector unit-stride store of the V extension/], [0x03050407, /^vector unit-stride fault-only-first load/],
      [0x0ac50407, /^vector strided load/], [0x0f050427, /^vector indexed-ordered store of the V extension/],
      [0x07057407, /^vector indexed-unordered load with 64-bit indices, which the V extension supports only in RV64/],
      [0x02855407, /^vector whole-register load/], [0xe2850427, /^vector whole-register store/],
      [0x02b50407, /^VLM\.V, vector mask load/], [0x02b50427, /^VSM\.V, vector mask store/],
      [0xa281a277, /^VAESEF\.VV, vector cryptography instruction of the Zvkned extension/], [0xa703a477, /^VAESZ\.VS, .* Zvkned/],
      [0xa308a477, /^VGMUL\.VV, .* Zvkg extension/], [0xa7082477, /^VSM4R\.VS, .* Zvksed extension/],
      [0xb2862277, /^VGHSH\.VV, vector cryptography/], [0xbb0c2477, /^VSHA2CH\.VV, .* Zvknha and Zvknhb extensions/],
      [0xaf01a477, /^VSM3C\.VI, .* Zvksh extension/],
      [0x00051507, /^FLH, .* Zfh extension/], [0x00052507, /^FLW, .* F extension/],
      [0x04c5f553, /floating-point computational instruction/], [0x28b6252f, /atomic memory instruction .* Zacas/],
    ];
    for (const [word, text] of cases) {
      const d = riscv.decode(wordToBytesLE(word), 0, 0);
      expect(d, hex(word)).toMatchObject({ ok: false, kind: 'unsupported' });
      expect(!d.ok && d.message.replace(/^0x[0-9a-f]+: /, ''), hex(word)).toMatch(text);
      expect(!d.ok && d.message, hex(word)).not.toMatch(/reserved/);
    }
    // Encodings that no ratified extension defines stay invalid: funct7 0100000 with funct3 001, funct7 0000101 with
    // funct3 000, rori with imm[5] = 1, the unassigned code 00011 of the clz group, LOAD funct3 111, STORE funct3 100,
    // a vector load with mew = 1, and AES64KS1I with the reserved round number 0xB.
    for (const word of [0x40c59533, 0x0ac58533, 0x6235d593, 0x60359513, 0x00007503, 0x00a04023, 0x12058507, 0x31b59513]) {
      expect(riscv.decode(wordToBytesLE(word), 0, 0), hex(word)).toMatchObject({ ok: false, kind: 'invalid' });
    }
  });

  it('rejects the reserved encodings of the vector major opcodes and of the vector loads and stores', () => {
    // An arithmetic word with vd = v8 from its funct6, vm, vs2, vs1, and funct3 fields (manual Section 31.10).
    const vec = (opcode: number, funct6: number, vm: number, vs2: number, vs1: number, funct3: number): number =>
      ((funct6 << 26) | (vm << 25) | (vs2 << 20) | (vs1 << 15) | (funct3 << 12) | (8 << 7) | opcode) >>> 0;
    const OP_V = 0x57, OP_VE = 0x77;
    const cases: [number, RegExp][] = [
      // Cells that the vector instruction listing leaves empty, and the unassigned part of OPCFG.
      [0xd1d1c5d7, /^reserved OP-V encoding: funct6 110100 with funct3 100 \(OPIVX\)/],
      [vec(OP_V, 0b001000, 1, 16, 24, 0b000), /^reserved OP-V encoding: funct6 001000 with funct3 000 \(OPIVV\)/],
      [vec(OP_V, 0b101000, 1, 16, 24, 0b010), /funct6 101000 with funct3 010 \(OPMVV\)/],
      [0x82007457, /^reserved OP-V encoding in the OPCFG category/],
      // Sub-opcode values that the unary tables leave unassigned (Tables 61 to 68 and 71).
      [vec(OP_V, 0b010000, 1, 16, 0b00101, 0b010), /^reserved OP-V encoding: vs1 = 00101 in the VWXUNARY0 group/],
      [vec(OP_V, 0b010000, 1, 0b00001, 10, 0b110), /vs2 = 00001 in the VRXUNARY0 group/],
      [vec(OP_V, 0b010010, 1, 16, 0b01011, 0b010), /vs1 = 01011 in the VXUNARY0 group/],
      [vec(OP_V, 0b010010, 1, 16, 0b00100, 0b001), /vs1 = 00100 in the VFUNARY0 group/],
      [vec(OP_V, 0b010011, 1, 16, 0b00001, 0b001), /vs1 = 00001 in the VFUNARY1 group/],
      [vec(OP_V, 0b010100, 1, 16, 0b00000, 0b010), /vs1 = 00000 in the VMUNARY0 group/],
      [vec(OP_V, 0b100111, 1, 16, 0b00010, 0b011), /vs1 = 00010 in the whole-register move group/],
      // Values of vm and vs2 that an instruction's encoding excludes.
      [0x430c0457, /^VADC is defined only with vm = 0/], [0x5d0c2457, /^VCOMPRESS\.VM is defined only with vm = 1/],
      [0x650c2457, /^VMAND\.MM is defined only with vm = 1/], [0x41002557, /^VMV\.X\.S is defined only with vm = 1/],
      [0x40055457, /^VFMV\.S\.F is defined only with vm = 1/], [0x9d003457, /^VMV1R\.V is defined only with vm = 1/],
      [0x5e1c0457, /^VMV\.V\.V is defined only with vs2 = 00000/], [0x5e155457, /^VFMV\.V\.F is defined only with vs2 = 00000/],
      [0x5218a457, /^VID\.V is defined only with vs2 = 00000/],
      // OP-VE: only OPMVV, only unmasked, and only the listed funct6 and vs1 values (Section 33.4 and Table 70).
      [0x00000077, /^reserved OP-VE encoding: funct6 000000 with funct3 000 \(OPIVV\)/], [0xfe00f077, /funct3 111$/],
      [vec(OP_VE, 0b100011, 1, 16, 24, 0b010), /funct6 100011 with funct3 010 \(OPMVV\)/],
      [vec(OP_VE, 0b101100, 1, 16, 24, 0b000), /funct6 101100 with funct3 000/],
      [0xa101a477, /^VAESEF\.VV is defined only with vm = 1/],
      [0xa303a477, /^reserved OP-VE encoding: vs1 = 00111 in the VAES\.vv group/],
      [0xa708a477, /^reserved OP-VE encoding: vs1 = 10001 in the VAES\.vs group/],
      // Vector loads and stores: reserved lumop and sumop values, and the fields fixed by whole-register and mask transfers.
      [0x02150407, /^reserved lumop 00001 in a vector unit-stride load/], [0x03050427, /^reserved sumop 10000 in a vector unit-stride store/],
      [0x42850407, /^whole-register load with vm = 1, nf = 010/], [0x00850407, /^whole-register load with vm = 0/],
      [0x02856427, /^whole-register store with vm = 1, nf = 000, and width 110/],
      [0x02b55407, /^mask load with vm = 1, nf = 000, and width 101/], [0x22b50427, /^mask store with vm = 1, nf = 001/],
    ];
    for (const [word, text] of cases) {
      const d = riscv.decode(wordToBytesLE(word), 0, 0);
      expect(d, hex(word)).toMatchObject({ ok: false, kind: 'invalid' });
      expect(!d.ok && d.message.replace(/^0x[0-9a-f]+: /, ''), hex(word)).toMatch(text);
    }
  });

  it('rejects the vector encodings that the manual reserves by their register numbers under every vtype setting', () => {
    // Each word is the encoding of the assembly text beside it. Clang 20 rejects the texts of the first five groups
    // except vzext.vf2 v8, v8; it assembles the texts of the last two groups (vluxei64.v for RV64), which the manual
    // reserves all the same.
    const reserved: [number, RegExp][] = [
      // Section 31.5.3: a masked instruction does not write a vector over the mask register v0. Sections 31.11.4,
      // 31.15.4, and 31.15.8 say the same of vadc, vmsbf.m, and viota.m.
      [0x00880057, /^reserved VADD encoding: with vm = 0 and vd = v0, the destination overlaps the mask register/], // vadd.vv v0, v8, v16, v0.t
      [0x40880057, /^reserved VADC encoding: with vm = 0 and vd = v0/], // vadc.vvm v0, v8, v16, v0
      [0x5c880057, /^reserved VMERGE\.VVM encoding: with vm = 0 and vd = v0/], // vmerge.vvm v0, v8, v16, v0
      [0x5d055057, /^reserved VFMERGE\.VFM encoding: with vm = 0 and vd = v0/], // vfmerge.vfm v0, v16, fa0, v0
      [0x5008a057, /^reserved VID\.V encoding: with vm = 0 and vd = v0/], // vid.v v0, v0.t
      [0x5100a057, /^reserved VMSBF\.M encoding: with vm = 0 and vd = v0/], // vmsbf.m v0, v16, v0.t
      [0x51082057, /^reserved VIOTA\.M encoding: with vm = 0 and vd = v0/], // viota.m v0, v16, v0.t
      [0x00050007, /^reserved masked vector load: with vm = 0 and vd = v0, the destination overlaps the mask register/], // vle8.v v0, (a0), v0.t
      [0x01056007, /^reserved masked vector load: /], // vle32ff.v v0, (a0), v0.t
      [0x08c55007, /^reserved masked vector load: /], // vlse16.v v0, (a0), a2, v0.t
      [0x05056007, /^reserved masked vector load: /], // vluxei32.v v0, (a0), v16, v0.t
      [0x40050007, /^reserved masked vector load: /], // vlseg3e8.v v0, (a0), v0.t
      // Sections 31.16.6 and 31.7.9: whole-register moves, loads, and stores name registers that are multiples of the count.
      [0x9e20b0d7, /^reserved VMV2R\.V encoding: the register numbers must be multiples of 2/], // vmv2r.v v1, v2
      [0x9e90b457, /^reserved VMV2R\.V encoding: /], // vmv2r.v v8, v9
      [0x9ea1b457, /^reserved VMV4R\.V encoding: the register numbers must be multiples of 4/], // vmv4r.v v8, v10
      [0x9ec3b457, /^reserved VMV8R\.V encoding: the register numbers must be multiples of 8/], // vmv8r.v v8, v12
      [0x22850087, /^reserved whole-register load: 2 registers from vd = v1, which is not a multiple of 2/], // vl2re8.v v1, (a0)
      [0x62856507, /^reserved whole-register load: 4 registers from vd = v10, /], // vl4re32.v v10, (a0)
      [0xe2850627, /^reserved whole-register store: 8 registers from vs3 = v12, /], // vs8r.v v12, (a0)
      [0x22850fa7, /^reserved whole-register store: 2 registers from vs3 = v31, /], // vs2r.v v31, (a0)
      // Sections 31.16.3 to 31.16.5 and 31.15.4 to 31.15.8: the destination may not overlap a source.
      [0x32880457, /^reserved VRGATHER encoding: with vd equal to vs2, the destination overlaps a source that it may not overlap/], // vrgather.vv v8, v8, v16
      [0x33040457, /^reserved VRGATHER encoding: with vd equal to vs1, /], // vrgather.vv v8, v16, v8
      [0x3281b457, /^reserved VRGATHER encoding: with vd equal to vs2, /], // vrgather.vi v8, v8, 3
      [0x3b040457, /^reserved VRGATHEREI16 encoding: with vd equal to vs1, /], // vrgatherei16.vv v8, v16, v8
      [0x3a854457, /^reserved VSLIDEUP encoding: with vd equal to vs2, /], // vslideup.vx v8, v8, a0
      [0x3a81b457, /^reserved VSLIDEUP encoding: with vd equal to vs2, /], // vslideup.vi v8, v8, 3
      [0x3a856457, /^reserved VSLIDE1UP encoding: with vd equal to vs2, /], // vslide1up.vx v8, v8, a0
      [0x3a855457, /^reserved VFSLIDE1UP encoding: with vd equal to vs2, /], // vfslide1up.vf v8, v8, fa0
      [0x5e80a457, /^reserved VCOMPRESS\.VM encoding: with vd equal to vs2, /], // vcompress.vm v8, v8, v1
      [0x5f042457, /^reserved VCOMPRESS\.VM encoding: with vd equal to vs1, /], // vcompress.vm v8, v16, v8
      [0x52882457, /^reserved VIOTA\.M encoding: with vd equal to vs2, /], // viota.m v8, v8
      [0x5280a457, /^reserved VMSBF\.M encoding: with vd equal to vs2, /], // vmsbf.m v8, v8
      // Section 31.5.2: a destination of wider elements may not start at the register of a source.
      [0xc6882457, /^reserved VWADD encoding: with vd equal to vs2, /], // vwadd.vv v8, v8, v16
      [0xc7042457, /^reserved VWADD encoding: with vd equal to vs1, /], // vwadd.vv v8, v16, v8
      [0xd7042457, /^reserved VWADD\.W encoding: with vd equal to vs1, /], // vwadd.wv v8, v16, v8
      [0xf3042457, /^reserved VWMACCU encoding: with vd equal to vs1, /], // vwmaccu.vv v8, v8, v16
      [0xf28c2457, /^reserved VWMACCU encoding: with vd equal to vs2, /], // vwmaccu.vv v8, v24, v8
      [0xe2855457, /^reserved VFWMUL encoding: with vd equal to vs2, /], // vfwmul.vf v8, v8, fa0
      [0xd681b457, /^reserved VWSLL encoding: with vd equal to vs2, /], // vwsll.vi v8, v8, 3
      [0x4a861457, /^reserved VFWCVT\.F\.F\.V encoding: with vd equal to vs2, /], // vfwcvt.f.f.v v8, v8
      [0x4a832457, /^reserved VZEXT\.VF2 encoding: with vd equal to vs2, /], // vzext.vf2 v8, v8
      // Section 33.1.5: destinations of the vector cryptography instructions that may not overlap a source.
      [0xa683a477, /^reserved VAESZ\.VS encoding: with vd equal to vs2, /], // vaesz.vs v8, v8
      [0xa6802477, /^reserved VAESDM\.VS encoding: with vd equal to vs2, /], // vaesdm.vs v8, v8
      [0xa681a477, /^reserved VAESEF\.VS encoding: with vd equal to vs2, /], // vaesef.vs v8, v8
      [0xa6882477, /^reserved VSM4R\.VS encoding: with vd equal to vs2, /], // vsm4r.vs v8, v8
      [0xae81a477, /^reserved VSM3C\.VI encoding: with vd equal to vs2, /], // vsm3c.vi v8, v8, 3
      [0x828c2477, /^reserved VSM3ME\.VV encoding: with vd equal to vs2, /], // vsm3me.vv v8, v8, v24
      [0xb68c2477, /^reserved VSHA2MS\.VV encoding: with vd equal to vs2, /], // vsha2ms.vv v8, v8, v24
      [0xbb042477, /^reserved VSHA2CH\.VV encoding: with vd equal to vs1, /], // vsha2ch.vv v8, v16, v8
      [0xbe8c2477, /^reserved VSHA2CL\.VV encoding: with vd equal to vs2, /], // vsha2cl.vv v8, v8, v24
      // Section 31.5.2: no register is read with two element widths; the mask register counts as a source of one-bit elements.
      [0x000c0457, /^reserved VADD encoding: with vm = 0 and vs2 = v0, the mask register is read with two element widths/], // vadd.vv v8, v0, v24, v0.t
      [0x01000457, /^reserved VADD encoding: with vm = 0 and vs1 = v0, /], // vadd.vv v8, v16, v0, v0.t
      [0x60054457, /^reserved VMSEQ encoding: with vm = 0 and vs2 = v0, /], // vmseq.vx v8, v0, a0, v0.t
      [0x400c0457, /^reserved VADC encoding: with vm = 0 and vs2 = v0, /], // vadc.vvm v8, v0, v24, v0
      [0xb3080457, /^reserved VNSRL encoding: with vs1 equal to vs2, the register is read with two element widths/], // vnsrl.wv v8, v16, v16
      [0xd7082457, /^reserved VWADD\.W encoding: with vs1 equal to vs2, /], // vwadd.wv v8, v16, v16
      [0xc7080457, /^reserved VWREDSUM encoding: with vs1 equal to vs2, /], // vwredsum.vs v8, v16, v16
      [0x5f082457, /^reserved VCOMPRESS\.VM encoding: with vs1 equal to vs2, /], // vcompress.vm v8, v16, v16
      [0x00050027, /^reserved masked vector store: with vm = 0 and vs3 = v0, the mask register is read with two element widths/], // vse8.v v0, (a0), v0.t
      [0x08c56027, /^reserved masked vector store: /], // vsse32.v v0, (a0), a2, v0.t
      [0x04050407, /^reserved masked vector indexed load: with vm = 0 and vs2 = v0, /], // vluxei8.v v8, (a0), v0, v0.t
      [0x0c055427, /^reserved masked vector indexed store: with vm = 0 and vs2 = v0, /], // vsoxei16.v v8, (a0), v0, v0.t
      [0x04057407, /^reserved masked vector indexed load: with vm = 0 and vs2 = v0, /], // vluxei64.v v8, (a0), v0, v0.t
      // Section 31.7.8: the fields of a segment may not pass v31, and those of an indexed segment load may not overlap the index register.
      [0x22050f87, /^reserved vector segment load: 2 fields from vd = v31 pass v31/], // vlseg2e8.v v31, (a0)
      [0xe2050c87, /^reserved vector segment load: 8 fields from vd = v25 pass v31/], // vlseg8e8.v v25, (a0)
      [0x42055f27, /^reserved vector segment store: 3 fields from vs3 = v30 pass v31/], // vsseg3e16.v v30, (a0)
      [0x6ac56ea7, /^reserved vector segment store: 4 fields from vs3 = v29 pass v31/], // vssseg4e32.v v29, (a0), a2
      [0x26850407, /^reserved vector indexed segment load: 2 fields from vd = v8 overlap the index register vs2 = v8/], // vluxseg2ei8.v v8, (a0), v8
      [0x26950407, /^reserved vector indexed segment load: 2 fields from vd = v8 overlap the index register vs2 = v9/], // vluxseg2ei8.v v8, (a0), v9
      [0xeef56407, /^reserved vector indexed segment load: 8 fields from vd = v8 overlap the index register vs2 = v15/], // vloxseg8ei32.v v8, (a0), v15
    ];
    for (const [word, text] of reserved) {
      const d = riscv.decode(wordToBytesLE(word), 0, 0);
      expect(d, hex(word)).toMatchObject({ ok: false, kind: 'invalid' });
      expect(!d.ok && d.message.replace(/^0x[0-9a-f]+: /, ''), hex(word)).toMatch(text);
    }
    // Neighbours that no rule reserves under every vtype setting, all assembled by Clang 20, stay defined instructions.
    const defined: number[] = [
      0x030c0057, // vadd.vv v0, v16, v24: unmasked
      0x610c0057, // vmseq.vv v0, v16, v24, v0.t: the result is a mask
      0x450c0057, // vmadc.vvm v0, v16, v24, v0: the result is a mask
      0x010c2057, // vredsum.vs v0, v16, v24, v0.t: the scalar result of a reduction
      0xc68c0457, // vwredsum.vs v8, v8, v24: a reduction may overlap its sources
      0x03082457, // vredsum.vs v8, v16, v16: both sources have elements of SEW
      0x5008a457, // vid.v v8, v0.t: the vs2 field is not a register
      0x42056057, // vmv.s.x v0, a0
      0x5e000457, // vmv.v.v v8, v0
      0x5000a457, // vmsbf.m v8, v0, v0.t: the source is a mask
      0x40082557, // vcpop.m a0, v0, v0.t
      0x41082057, 0x4108a057, // vcpop.m zero, v16, v0.t; vfirst.m zero, v16, v0.t: the destination is an integer register
      0x66842457, // vmand.mm v8, v8, v8
      0x020c0457, // vadd.vv v8, v0, v24: unmasked
      0x01003457, 0x01004457, 0x01005457, // vadd.vi v8, v16, 0, v0.t; vadd.vx v8, v16, zero, v0.t; vfadd.vf v8, v16, ft0, v0.t: field 19:15 is not a vector register
      0xc7046457, 0x33043457, 0xb3084457, // vwadd.vx v8, v16, s0; vrgather.vi v8, v16, 8; vnsrl.wx v8, v16, a6
      0x3b080457, // vrgatherei16.vv v8, v16, v16: both sources have 16-bit elements when SEW is 16
      0x3e81b457, // vslidedown.vi v8, v8, 3
      0xd68c2457, // vwadd.wv v8, v8, v24: vs2 has the element width of the destination
      0xb28c0457, // vnsrl.wv v8, v8, v24: a narrower destination may start at the register of its source
      0x4a8a1457, // vfncvt.f.f.w v8, v8
      0x9f01b457, 0x9ec1b457, 0x9f0034d7, // vmv4r.v v8, v16; vmv4r.v v8, v12; vmv1r.v v9, v16
      0x22850507, 0x62856607, 0xe2850427, 0x02850f87, // vl2re8.v v10, (a0); vl4re32.v v12, (a0); vs8r.v v8, (a0); vl1re8.v v31, (a0)
      0x02050007, 0x02050027, 0x06050407, // vle8.v v0, (a0); vse8.v v0, (a0); vluxei8.v v8, (a0), v0
      0x22050f07, 0xe2050607, 0x42055ea7, // vlseg2e8.v v30, (a0); vlseg8e8.v v12, (a0); vsseg3e16.v v29, (a0)
      0x26a50407, 0xef056407, 0x26850487, // vluxseg2ei8.v v8, (a0), v10; vloxseg8ei32.v v8, (a0), v16; vluxseg2ei8.v v9, (a0), v8
      0x26850427, 0x06850407, // vsuxseg2ei8.v v8, (a0), v8; vluxei8.v v8, (a0), v8
      0xa281a477, 0xa2882477, 0xa288a477, // vaesef.vv v8, v8; vsm4r.vv v8, v8; vgmul.vv v8, v8
      0x83042477, 0xb28c2477, 0xb3042477, // vsm3me.vv v8, v16, v8; vghsh.vv v8, v8, v24; vghsh.vv v8, v16, v8
      0x8a81a477, 0xaa81a477, 0x8681a477, // vaeskf1.vi v8, v8, 3; vaeskf2.vi v8, v8, 3; vsm4k.vi v8, v8, 3
    ];
    for (const word of defined) {
      expect(riscv.decode(wordToBytesLE(word), 0, 0), hex(word)).toMatchObject({ ok: false, kind: 'unsupported' });
    }
  });

  it('names the families of MISC-MEM and SYSTEM encodings by funct3', () => {
    const cases: [number, 'unsupported' | 'invalid', RegExp][] = [
      [0x0ff0000f, 'unsupported', /FENCE is defined by RV32I/],
      [0x8330000f, 'unsupported', /FENCE is defined by RV32I/],
      [0x0000100f, 'unsupported', /^FENCE\.I, .* Zifencei extension/],
      [0x0005200f, 'unsupported', /^CBO\.INVAL, .* Zicbom extension/],
      [0x0015200f, 'unsupported', /^CBO\.CLEAN, .* Zicbom extension/],
      [0x0045200f, 'unsupported', /^CBO\.ZERO, .* Zicboz extension/],
      [0x0035200f, 'invalid', /reserved/],
      [0x0000300f, 'invalid', /reserved funct3 011/],
      [0x0000700f, 'invalid', /reserved funct3 111/],
      [0x00100073, 'unsupported', /EBREAK is defined by RV32I/],
      [0x01d00073, 'unsupported', /^WRS\.STO, .* Zawrs extension/],
      [0x30059573, 'unsupported', /Zicsr/],
      [0x81c5c573, 'unsupported', /^MOP\.R\.n, .* Zimop extension/],
      [0xcdf5c573, 'unsupported', /^MOP\.R\.n, /],
      [0x82c5c573, 'unsupported', /^MOP\.RR\.n, .* Zimop extension/],
      [0x6005c573, 'unsupported', /^HLV or HLVX, .* H extension/],
      [0x6805c573, 'unsupported', /^HLV or HLVX, /],
      [0x6bf44073, 'unsupported', /^HSV, .* H extension/],
      [0x0000c073, 'invalid', /reserved encoding with funct3 100/],
    ];
    for (const [word, kind, text] of cases) {
      const d = riscv.decode(wordToBytesLE(word), 0, 0);
      expect(d, hex(word)).toMatchObject({ ok: false, kind });
      expect(!d.ok && d.message.replace(/^0x[0-9a-f]+: /, ''), hex(word)).toMatch(text);
    }
  });

  it('reassembles decoded branches and jumps whose targets wrap around the address space', () => {
    // Targets are computed modulo 2^32, so a branch near address 0 or near the top of the address space
    // names a target on the other side; its text assembles to the same word at the same address.
    const cases: [number, number][] = [
      [0xea381b63, 0x00000000], [0x8e00d66f, 0x00000000], [0xfeb51ce3, 0x00000000],
      [0x35f7346f, 0xfffff000], [0x0100006f, 0xfffffff8], [0x00b50463, 0xfffffffc],
    ];
    for (const [word, pc] of cases) {
      const d = riscv.decode(wordToBytesLE(word), 0, pc);
      expect(d.ok, hex(word)).toBe(true);
      if (!d.ok) continue;
      for (const text of [riscv.format(d.insn), d.alias ?? '']) {
        if (text === '') continue;
        const again = assembleText(riscv, text, pc);
        expect(again.ok && bytesToHex(again.program.bytes), `${text} at ${hex(pc)}`).toBe(bytesToHex(wordToBytesLE(word)));
      }
    }
    // A numeric target must be a 32-bit value; a larger number is rejected rather than reduced.
    expect(errors('j 0x100400010')[0]).toMatch(/does not fit in 32 bits/);
  });

  it('reports a branch or jump to an undefined label that names a property of Object.prototype', () => {
    // The offset is taken modulo 2^32, so a target that is not an integer address must not become offset 0.
    const texts = ['j toString', 'j valueOf', 'j constructor', 'j hasOwnProperty', 'j __proto__', 'jal ra, toLocaleString',
      'beq a0, a1, isPrototypeOf', 'bnez a0, valueOf', 'bgt a0, a1, constructor', 'li a0, 1\n beqz a0, propertyIsEnumerable\n ecall'];
    for (const text of texts) {
      const name = /(\w+)$/.exec(text.split('\n')[1] ?? text)![1]!;
      expect(errors(text), text).toEqual([`label '${name}' is not defined`]);
    }
  });

  it('reports the conventional shorthand of an instruction', () => {
    const alias = (text: string): string | undefined => {
      const p = assemble(text);
      const d = riscv.decode(p.bytes, 0, p.base);
      return d.ok ? d.alias : undefined;
    };
    expect(alias('addi zero, zero, 0')).toBe('nop');
    expect(alias('addi a0, zero, 7')).toBe('li a0, 7');
    expect(alias('addi a0, a1, 0')).toBe('mv a0, a1');
    expect(alias('jalr zero, 0(ra)')).toBe('ret');
    expect(alias('add a0, a1, a2')).toBeUndefined();
  });
});

describe('RV32I processor model', () => {
  it('keeps x0 at zero and uses five bits of a shift count', () => {
    const m = runAsm('addi zero, zero, 5\n addi t0, zero, 33\n addi t1, zero, 1\n sll a0, t1, t0\n li a7, 2\n ecall');
    expect(m.cpu.reg32('zero')).toBe(0);
    expect(m.returnValue).toBe(2);
  });

  it('distinguishes signed and unsigned comparisons and shifts', () => {
    const m = runAsm('li t0, -1\n li t1, 1\n slt a0, t0, t1\n sltu a1, t0, t1\n srai a2, t0, 4\n srli a3, t0, 28\n sltiu a4, t1, -1');
    expect([m.cpu.reg32('a0'), m.cpu.reg32('a1'), m.cpu.reg32('a2'), m.cpu.reg32('a3'), m.cpu.reg32('a4')]).toEqual([1, 0, -1, 15, 1]);
  });

  it('loads and stores bytes, halfwords, and words in little-endian order', () => {
    const m = runAsm('lui gp, 0x10000\n li t0, 0x80c0ffee\n sw t0, 0(gp)\n lb a0, 0(gp)\n lbu a1, 0(gp)\n lh a2, 2(gp)\n lhu a3, 2(gp)\n lw a4, 0(gp)\n sb t0, 5(gp)\n lw a5, 4(gp)');
    expect(m.mem.peek(LAYOUT.dataBase, 4)).toEqual(Uint8Array.of(0xee, 0xff, 0xc0, 0x80));
    expect(m.cpu.reg32('a0')).toBe(-18);
    expect(m.cpu.reg32('a1')).toBe(0xee);
    expect(m.cpu.reg32('a2')).toBe(-32576);
    expect(m.cpu.reg32('a3')).toBe(0x80c0);
    expect(m.cpu.reg32('a4')).toBe(0x80c0ffee | 0);
    expect(m.cpu.reg32('a5')).toBe(0xee00);
  });

  it('links with jal and returns with jalr', () => {
    const m = runAsm('jal ra, f\n li a7, 2\n ecall\nf:\n li a0, 9\n ret');
    expect(m.status).toBe('exited');
    expect(m.returnValue).toBe(9);
    expect(m.executed).toBe(5);
  });

  it('faults deterministically', () => {
    expect(runAsm('.word 0xffffffff').fault).toMatch(/illegal instruction 0xffffffff/);
    expect(runAsm('lw a0, 0(zero)').fault).toMatch(/unmapped address 0x00000000/);
    expect(runAsm('lui t0, 0x10000\n lw a0, 2(t0)').fault).toMatch(/misaligned 4-byte load/);
    expect(runAsm('lui t0, 0x400\n sw a0, 0(t0)').fault).toMatch(/read-only code region/);
    expect(runAsm('li t0, 0x00400006\n jr t0').fault).toMatch(/not a multiple of 4/);
    expect(runAsm('li t0, 0x10000000\n jr t0').fault).toMatch(/instruction fetch outside the code region/);
    expect(runAsm('li a7, 99\n ecall').fault).toMatch(/service number 99/);
    // A program without an exit runs into the zero-filled rest of the code region.
    expect(runAsm('li a0, 5\n addi a0, a0, 1').fault).toMatch(/illegal instruction 0x00000000 at 0x00400008: bits \[15:0\] are all zero/);
    // Instructions of extensions are recognized but never executed.
    expect(runAsm('.word 0x40c5f533').fault).toMatch(/illegal instruction 0x40c5f533 .*ANDN/);
    expect(runAsm('.word 0x0085b503').fault).toMatch(/illegal instruction 0x0085b503 .*Zilsd/);
  });

  it('reports the address of a faulting instruction as the next program counter', () => {
    // A faulting instruction does not complete, so the program counter stays at its address. Each program faults in
    // its second instruction: a misaligned load, an illegal instruction, a jump to an address that is not a multiple
    // of 4, and a load from an unmapped address.
    for (const text of ['lui t0, 0x10000\n lw a0, 2(t0)', 'addi zero, zero, 0\n .word 0xffffffff', 'addi t0, zero, 6\n jalr zero, 0(t0)', 'addi zero, zero, 0\n lw a0, 0(zero)']) {
      const p = assemble(text);
      const m = new Machine(riscv, { code: p.bytes, entry: p.base });
      m.step();
      const ev = newStepEvent(0);
      m.step(ev);
      expect(m.status, text).toBe('fault');
      expect(ev.nextPc, text).toBe(p.base + 4);
      expect(m.cpu.pc, text).toBe(p.base + 4);
    }
    // An instruction address that is not a multiple of 4 faults before the fetch.
    const p = assemble('addi zero, zero, 0');
    const m = new Machine(riscv, { code: p.bytes, entry: p.base + 2 });
    const ev = newStepEvent(0);
    m.step(ev);
    expect(m.status).toBe('fault');
    expect(ev.nextPc).toBe(p.base + 2);
  });

  it('records the pc as the first operand of the auipc addition', () => {
    const p = assemble('addi zero, zero, 0\n auipc a0, 1');
    const m = new Machine(riscv, { code: p.bytes, entry: p.base });
    m.step();
    const ev = newStepEvent(0);
    m.step(ev);
    expect(ev.alu).toEqual({ op: 'add', a: BigInt(p.base + 4), b: 4096n, result: BigInt(p.base + 4 + 4096) });
    expect(m.cpu.reg32('a0')).toBe(p.base + 4 + 4096);
  });

  it('records the details of a step when asked', () => {
    const p = assemble('lui gp, 0x10000\n li t0, 77\n sw t0, 8(gp)\n beq t0, zero, 0x00400000');
    const m = new Machine(riscv, { code: p.bytes, entry: p.base });
    m.step();
    m.step();
    const store = newStepEvent(0);
    m.step(store);
    expect(store.klass).toBe('store');
    expect(store.text).toBe('sw t0, 8(gp)');
    expect(store.memWrites).toEqual([{ address: LAYOUT.dataBase + 8, size: 4, before: 0n, value: 77n }]);
    expect(store.regReads.map((r) => r.reg)).toEqual(['gp', 't0']);
    const branch = newStepEvent(0);
    m.step(branch);
    expect(branch.branch).toEqual({ conditional: true, taken: false, target: 0x00400000 });
    expect(branch.nextPc).toBe(p.base + 16);
  });
});

describe('execution from encoded bytes', () => {
  const SOURCE = 'def main():\n    x = 5\n    return x + 1\n';

  it('changes behaviour when an operand field in the code bytes is edited', () => {
    const r = compile(SOURCE, riscv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.compiled;
    expect(loadCompiled(riscv, c).run().returnValue).toBe(6);
    // Find "addi s0, zero, 5" and change its immediate field from 5 to 9 in memory.
    const target = c.program.insns.find((i) => i.text === 'addi s0, zero, 5')!;
    expect(target).toBeDefined();
    const m = loadCompiled(riscv, c);
    const word = m.mem.peek32(target.address)!;
    const edited = ((word & 0x000fffff) | (9 << 20)) >>> 0;
    expect(m.pokeCode(target.address, wordToBytesLE(edited))).toBe(true);
    expect(m.run().returnValue).toBe(10);
    // The listing no longer describes the edited instruction, and only that one.
    expect(m.mappingStale(target.address)).toBe(true);
    expect(m.insnInfo(target.address)).toBeUndefined();
    expect(m.mappingStale(target.address + 4)).toBe(false);
    expect(m.codeEdited).toBe(true);
    // Resetting reloads the original bytes.
    m.reset();
    expect(m.run().returnValue).toBe(6);
    expect(m.codeEdited).toBe(false);
  });

  it('faults when the edited bytes are not an implemented instruction', () => {
    const r = compile(SOURCE, riscv);
    if (!r.ok) throw new Error('compile failed');
    const target = r.compiled.program.insns.find((i) => i.text === 'addi s0, zero, 5')!;
    const m = loadCompiled(riscv, r.compiled);
    // The same word with opcode bits of the M extension multiply group.
    m.pokeCode(target.address, wordToBytesLE(0x02c58533));
    const o = m.run();
    expect(o.status).toBe('fault');
    expect(o.fault).toMatch(/illegal instruction 0x02c58533.*M extension/);
  });

  it('never consults the listing: zeroed code bytes stop the program', () => {
    const r = compile(SOURCE, riscv);
    if (!r.ok) throw new Error('compile failed');
    const m = loadCompiled(riscv, r.compiled);
    m.mem.code.bytes.fill(0);
    expect(m.run().status).toBe('fault');
  });
});

describe('stack frames beyond the 12-bit offsets', () => {
  // Variables after the twelve in s0 to s11 live in stack slots. From about 509 slots on, the frame size, the
  // offset of the saved ra, and the slot offsets no longer fit the 12-bit immediate of addi, lw, and sw.
  const program = (n: number, multiply: boolean): string => {
    const lines = ['def main(a):'];
    for (let i = 0; i < n; i++) lines.push(`    v${i} = a + ${i % 10}`);
    lines.push('    s = 0', '    for k in range(3):', `        v${n - 1} = v${n - 1} + k`);
    lines.push(multiply ? `        s = s + v${n - 1} * 3` : `        s = s + v${n - 1}`);
    lines.push('    print(s)', `    return v0 + v${n - 1} + v${n >> 1} + s`);
    return lines.join('\n') + '\n';
  };

  it('agrees with the reference evaluator at every boundary for frames of 2048 bytes and more', () => {
    // 516 variables give a 2048-byte frame; with a multiplication main also saves ra; 1100 variables give 4384 bytes.
    for (const [n, multiply] of [[516, false], [515, true], [520, true], [1100, false]] as const) {
      const cc = crossCheck(program(n, multiply), [7], [riscv]);
      expect(cc.failures, `${n} variables`).toEqual([]);
      expect(cc.ok).toBe(true);
      expect(cc.compiled.riscv!.frame.size).toBeGreaterThanOrEqual(2048);
    }
  });
});

describe('catalog and profile', () => {
  it('describes jalr with the target computed before rd is written', () => {
    const jalr = riscv.instructions.find((s) => s.mnemonic === 'jalr')!;
    expect(jalr.semantics).toBe('target = (rs1 + sext(offset)) with bit 0 cleared; rd = pc + 4; pc = target');
    expect(jalr.restrictions).toMatch(/computed from rs1 before rd is written, so jalr ra, 0\(ra\) jumps to the old value of ra/);
    // The processor model follows the same order: li expands to lui and addi, so jalr is at 0x00400008.
    const m = runAsm('li ra, 0x00400010\n jalr ra, 4(ra)', 3);
    expect(m.cpu.pc).toBe(0x00400014);
    expect(m.cpu.reg32('ra')).toBe(0x0040000c);
  });

  it('names the documents that define the profile', () => {
    const refs = riscv.profile.references;
    expect(refs.map((r) => r.title)).toEqual([
      'The RISC-V Instruction Set Manual, Volume I: Unprivileged Architecture', 'RISC-V ABIs Specification', 'RISC-V Assembly Programmer\'s Manual',
    ]);
    expect(refs[0]!.version).toMatch(/^Version 20260120, ratified; Chapter 2 "RV32I Base Integer Instruction Set, Version 2\.1"$/);
    expect(refs[1]!.version).toMatch(/Version 1\.0, November 2022/);
    for (const r of refs) expect(r.url).toMatch(/^https:\/\//);
    expect(riscv.instructions.find((s) => s.mnemonic === 'add')!.reference).toMatch(/Version 20260120.*Section 2\.4/);
  });
});

describe('RV32I profile description', () => {
  it('names every RV32I base instruction that the catalog leaves out', () => {
    // The 40 instructions of the RV32I base (manual Chapter 2).
    const RV32I = [
      'lui', 'auipc', 'jal', 'jalr', 'beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'lb', 'lh', 'lw', 'lbu', 'lhu', 'sb', 'sh', 'sw',
      'addi', 'slti', 'sltiu', 'xori', 'ori', 'andi', 'slli', 'srli', 'srai', 'add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra',
      'or', 'and', 'fence', 'ecall', 'ebreak',
    ];
    const b = getBackend('riscv');
    expect(RV32I.length).toBe(40);
    const implemented = new Set(b.instructions.filter((i) => !i.pseudo).map((i) => i.mnemonic));
    const omitted = RV32I.filter((m) => !implemented.has(m));
    expect(omitted).toEqual(['fence', 'ebreak']);
    const excluded = b.profile.excluded.join('; ');
    for (const m of omitted) {
      expect(excluded, `${m} is named as not included`).toMatch(new RegExp(`\\b${m}\\b`, 'i'));
      expect(b.profile.isa, `${m} is named as an exception`).toMatch(new RegExp(`\\bexcept\\b.*\\b${m}\\b`, 'i'));
    }
    expect(b.profile.isa).toBe('RV32I base integer instruction set, version 2.1, except FENCE and EBREAK, without extensions');
  });
});

describe('validation sweeps', () => {
  const sweep = (name: string) => assemble(riscv.validation.sweeps().find((s) => s.name === name)!.text);

  it('puts every register in every register operand position', () => {
    for (const s of riscv.validation.sweeps()) {
      if (s.passthrough) continue;
      const seen: Set<string>[] = [];
      let swept = 0;
      // Only the swept instruction counts: the branch sweeps end with addi zero, zero, 0, whose operands would
      // otherwise supply x0 to the first two positions.
      for (const i of assemble(s.text).insns) {
        if (i.insn?.mnemonic !== s.name) continue;
        swept++;
        i.insn.operands.forEach((o, k) => {
          const name = o.t === 'reg' ? o.name : o.t === 'mem' ? o.base : null;
          if (name) (seen[k] ??= new Set()).add(name);
        });
      }
      expect(swept, s.name).toBeGreaterThan(0);
      seen.forEach((names, k) => expect(names.size, `${s.name} operand ${k + 1}`).toBe(32));
    }
  });

  it('uses every value of the two low offset bits and both extremes for loads, stores, and jalr', () => {
    // scripts/export-validation.ts sets the base register of a memory operand to this address before each case.
    const base = LAYOUT.dataBase + 0x800;
    for (const m of ['lb', 'lbu', 'lh', 'lhu', 'lw', 'sb', 'sh', 'sw', 'jalr']) {
      const offsets = new Set<number>();
      const executed: number[] = [];
      for (const i of sweep(m).insns) {
        const o = i.insn!.operands[1]!;
        if (o.t !== 'mem') throw new Error(i.text);
        offsets.add(o.disp);
        if (o.base !== 'zero') executed.push((base + o.disp) >>> 0);
      }
      expect(Math.min(...offsets), m).toBe(-2048);
      expect(Math.max(...offsets), m).toBe(2047);
      expect(new Set([...offsets].map((d) => d & 3)), m).toEqual(new Set([0, 1, 2, 3]));
      // The executed cases reach every byte lane and the upper halfword, and jalr clears bit 0 of an odd sum, while
      // every halfword or word access stays aligned and every jump target is a multiple of 4.
      const lanes = new Set(executed.map((a) => a & 3));
      if (m === 'jalr') {
        expect(executed.some((a) => (a & 1) === 1), m).toBe(true);
        expect(executed.every((a) => ((a & ~1) & 3) === 0), m).toBe(true);
      } else {
        const size = { b: 1, h: 2, w: 4 }[m[1]!]!;
        expect(lanes, m).toEqual(new Set([0, 1, 2, 3].filter((l) => l % size === 0)));
      }
    }
  });

  it('writes each register on at most one line of the pseudoinstruction sweep', () => {
    // The sweep differs from the reference assembler in the expansion of li 2048, so it is checked by comparing the
    // final registers; a line whose result a later line overwrites would not be checked at all.
    const s = riscv.validation.sweeps().find((x) => x.passthrough)!;
    const writer = new Map<string, number>();
    for (const i of assemble(s.text).insns) {
      const rd = i.insn!.operands[0];
      if (rd?.t !== 'reg' || rd.name === 'zero') continue;
      expect(writer.get(rd.name) ?? i.meta.line, `${rd.name} on line ${i.meta.line}`).toBe(i.meta.line);
      writer.set(rd.name, i.meta.line!);
    }
    expect(writer.size).toBe(30);
  });
});
