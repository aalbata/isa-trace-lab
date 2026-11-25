import { describe, expect, it } from 'vitest';
import { decodeBytes, machineFromBytes } from '../src/core/api.ts';
import { compile } from '../src/core/compile.ts';
import { assembleText } from '../src/core/target/assemble.ts';
import { Machine, loadCompiled, newStepEvent } from '../src/core/target/machine.ts';
import { LAYOUT } from '../src/core/target/memory.ts';
import { OPERATIONS as RISCV_OPERATIONS } from '../src/core/target/riscv/catalog.ts';
import type { AsmOperand, Insn } from '../src/core/target/types.ts';
import { INSTRUCTIONS, OPERATIONS } from '../src/core/target/x86/catalog.ts';
import { x86 } from '../src/core/target/x86/index.ts';
import { BASE_MNEMONICS, CC_NAMES } from '../src/core/target/x86/isa.ts';
import { undefinedFlags } from '../src/core/target/x86/validation.ts';
import { bytesToHex } from '../src/core/util/int32.ts';

const assemble = (text: string) => {
  const r = assembleText(x86, text);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('; '));
  return r.program;
};
const bytes = (text: string): string => bytesToHex(assemble(text).bytes, '');
const errors = (text: string): string[] => {
  const r = assembleText(x86, text);
  return r.ok ? [] : r.errors.map((e) => e.message);
};
const fromHex = (h: string): Uint8Array => Uint8Array.from((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const decodeHex = (h: string, pc: number = LAYOUT.codeBase) => x86.decode(fromHex(h), 0, pc);
const text = (h: string, pc: number = LAYOUT.codeBase): string => {
  const d = decodeHex(h, pc);
  if (!d.ok) throw new Error(d.message);
  return x86.format(d.insn);
};
const machine = (source: string) => {
  const p = assemble(source);
  return new Machine(x86, { code: p.bytes, entry: p.base, listing: p });
};
const run = (source: string, steps = 100) => {
  const m = machine(source);
  for (let i = 0; i < steps && m.step(); i++) {
    // step
  }
  return m;
};

describe('x86-64 encoder', () => {
  it('chooses the encodings of the reference assembler', () => {
    // Bytes observed from Clang 20 for the same Intel-syntax text.
    expect(bytes('mov eax, ebx')).toBe('89d8');
    expect(bytes('mov rax, rbx')).toBe('4889d8');
    expect(bytes('mov r8d, eax')).toBe('4189c0');
    expect(bytes('mov eax, r8d')).toBe('4489c0');
    expect(bytes('mov eax, 5')).toBe('b805000000');
    expect(bytes('mov r9d, 100000')).toBe('41b9a0860100');
    expect(bytes('mov rax, -1')).toBe('48c7c0ffffffff');
    expect(bytes('mov dword ptr [rbx], 5')).toBe('c70305000000');
    expect(bytes('mov qword ptr [rbx], -5')).toBe('48c703fbffffff');
    expect(bytes('add eax, ebx')).toBe('01d8');
    expect(bytes('add eax, 127')).toBe('83c07f');
    expect(bytes('add eax, 128')).toBe('0580000000');
    expect(bytes('add ebx, 128')).toBe('81c380000000');
    expect(bytes('add rax, 128')).toBe('480580000000');
    expect(bytes('add eax, 0xffffffff')).toBe('83c0ff');
    expect(bytes('sub rsp, 24')).toBe('4883ec18');
    expect(bytes('cmp eax, 1000')).toBe('3de8030000');
    expect(bytes('cmp eax, dword ptr [rbx]')).toBe('3b03');
    expect(bytes('cmp dword ptr [rbx], eax')).toBe('3903');
    expect(bytes('test eax, ebx')).toBe('85d8');
    expect(bytes('test eax, dword ptr [rbx]')).toBe('8503');
    expect(bytes('imul eax, ebx')).toBe('0fafc3');
    expect(bytes('imul eax, ebx, 127')).toBe('6bc37f');
    expect(bytes('imul eax, ebx, 128')).toBe('69c380000000');
    expect(bytes('imul eax, 5')).toBe('6bc005');
    expect(bytes('neg eax')).toBe('f7d8');
    expect(bytes('not eax')).toBe('f7d0');
    expect(bytes('inc r8d')).toBe('41ffc0');
    expect(bytes('dec eax')).toBe('ffc8');
    expect(bytes('shl eax, 1')).toBe('d1e0');
    expect(bytes('shl eax, 2')).toBe('c1e002');
    expect(bytes('sar eax, cl')).toBe('d3f8');
    expect(bytes('shr rax, 63')).toBe('48c1e83f');
    expect(bytes('sete al')).toBe('0f94c0');
    expect(bytes('setl sil')).toBe('400f9cc6');
    expect(bytes('setg r8b')).toBe('410f9fc0');
    expect(bytes('sete ch')).toBe('0f94c5');
    expect(bytes('movzx eax, sil')).toBe('400fb6c6');
    expect(bytes('movzx eax, ah')).toBe('0fb6c4');
    expect(bytes('movzx r9d, dil')).toBe('440fb6cf');
    expect(bytes('movsxd r9, r10d')).toBe('4d63ca');
    expect(bytes('lea rax, [rbx + rcx*4 + 8]')).toBe('488d448b08');
    expect(bytes('push r8')).toBe('4150');
    expect(bytes('pop r15')).toBe('415f');
    expect(bytes('ret')).toBe('c3');
    expect(bytes('syscall')).toBe('0f05');
    expect(bytes('nop')).toBe('90');
  });

  it('encodes every ModR/M and SIB special case', () => {
    expect(bytes('mov eax, dword ptr [rbx]')).toBe('8b03');
    expect(bytes('mov eax, dword ptr [rsp]')).toBe('8b0424');
    expect(bytes('mov eax, dword ptr [rsp + 8]')).toBe('8b442408');
    expect(bytes('mov eax, dword ptr [rbp]')).toBe('8b4500');
    expect(bytes('mov eax, dword ptr [r12]')).toBe('418b0424');
    expect(bytes('mov eax, dword ptr [r13]')).toBe('418b4500');
    expect(bytes('mov eax, dword ptr [rbx + 127]')).toBe('8b437f');
    expect(bytes('mov eax, dword ptr [rbx + 128]')).toBe('8b8380000000');
    expect(bytes('mov eax, dword ptr [rbx - 128]')).toBe('8b4380');
    expect(bytes('mov eax, dword ptr [rbx - 129]')).toBe('8b837fffffff');
    expect(bytes('mov eax, dword ptr [rbx + rcx*4 + 8]')).toBe('8b448b08');
    expect(bytes('mov eax, dword ptr [rbx + rcx]')).toBe('8b040b');
    expect(bytes('mov eax, dword ptr [rcx*4 + 0x10000000]')).toBe('8b048d00000010');
    expect(bytes('mov eax, dword ptr [rcx*1 + 16]')).toBe('8b040d10000000');
    expect(bytes('mov eax, dword ptr [0x10000000]')).toBe('8b042500000010');
    expect(bytes('mov eax, dword ptr [rbp + rcx*2]')).toBe('8b444d00');
    expect(bytes('mov eax, dword ptr [r13 + r12*8]')).toBe('438b44e500');
    expect(bytes('mov eax, dword ptr [rsp + rbp*2 + 0x1000]')).toBe('8b846c00100000');
    expect(bytes('mov eax, dword ptr [rsp + r12*1]')).toBe('428b0424');
    expect(bytes('mov dword ptr [0x10000004], 7')).toBe('c704250400001007000000');
    expect(bytes('mov eax, [8 + rbx + 4*rcx]')).toBe('8b448b08');
    expect(bytes('mov eax, dword ptr [rbx + rsp]')).toBe('8b041c');
  });

  it('relaxes jumps to labels and uses the long form for numeric targets', () => {
    expect(bytes('a: jmp a')).toBe('ebfe');
    expect(bytes('a: je a')).toBe('74fe');
    expect(bytes('jmp b\n nop\n b: nop')).toBe('eb019090');
    expect(bytes(`a: nop\n${'.byte 0x90\n'.repeat(125)}jmp a`).slice(-4)).toBe('eb80');
    expect(bytes(`a: nop\n${'.byte 0x90\n'.repeat(126)}jmp a`).slice(-10)).toBe('e97cffffff');
    expect(bytes(`a: nop\n${'.byte 0x90\n'.repeat(126)}jne a`).slice(-12)).toBe('0f857bffffff');
    expect(bytes('jmp 0x00400010')).toBe('e90b000000');
    expect(bytes('jz 0x00400010')).toBe('0f840a000000');
    expect(bytes('call 0x00400010')).toBe('e80b000000');
  });

  it('reports operands that cannot be encoded', () => {
    expect(errors('mov rax, 0x80000000')[0]).toMatch(/64-bit immediate/);
    expect(errors('add eax, 0x100000000')[0]).toMatch(/does not fit in 32 bits/);
    expect(errors('mov eax, dword ptr [rax + rsp*2]')[0]).toMatch(/rsp cannot be an index/);
    expect(errors('mov eax, dword ptr [ebx]')[0]).toMatch(/64-bit register/);
    expect(errors('mov ax, bx')[0]).toMatch(/16-bit register/);
    expect(errors('mov eax, rbx')[0]).toMatch(/different sizes/);
    expect(errors('inc [rbx]')[0]).toMatch(/ambiguous/);
    expect(errors('movzx r8d, ah')[0]).toMatch(/REX prefix/);
    expect(errors('shl eax, 256')[0]).toMatch(/shift count/);
    expect(errors('shl eax, bl')[0]).toMatch(/cl/);
    expect(errors('push eax')[0]).toMatch(/64-bit register/);
    expect(errors('mov dword ptr [rax], dword ptr [rbx]')[0]).toMatch(/two memory operands/);
    expect(errors('jmp rax')[0]).toMatch(/outside the subset/);
    expect(errors('div ebx')[0]).toMatch(/not an instruction of the implemented/);
    expect(errors('mov eax, dword ptr [rip + 8]')[0]).toMatch(/RIP-relative/);
    expect(errors('jmp nowhere')[0]).toMatch(/not defined/);
  });
});

describe('x86-64 decoder', () => {
  it('decodes alternate encodings to the same instruction as the chosen encoding', () => {
    for (const alt of x86.validation.alternateEncodings ?? []) {
      const d = decodeHex(alt.bytes);
      expect(d.ok, `${alt.bytes} (${alt.note})`).toBe(true);
      if (!d.ok) continue;
      expect(d.length).toBe(alt.bytes.length / 2);
      const target = d.insn.operands.find((o) => o.t === 'addr');
      const again = assemble(x86.format(d.insn));
      const back = x86.decode(again.bytes, 0, LAYOUT.codeBase);
      expect(back.ok && x86.format(back.insn), alt.note).toBe(x86.format(d.insn));
      if (!target) expect(bytesToHex(again.bytes, ''), alt.note).not.toBe(alt.bytes);
    }
    expect(text('03c3')).toBe('add eax, ebx');
    expect(text('c7c005000000')).toBe('mov eax, 5');
    expect(text('c1e001')).toBe('shl eax, 1');
    expect(text('8b0423')).toBe('mov eax, dword ptr [rbx]');
    // A SIB byte without an index register: the scale bits are ignored.
    expect(text('8b04a3')).toBe('mov eax, dword ptr [rbx]');
    expect(text('8b442308')).toBe('mov eax, dword ptr [rbx + 8]');
    expect(text('8904a500000010')).toBe('mov dword ptr [0x10000000], eax');
    expect(text('fff0')).toBe('push rax');
    expect(text('8fc0')).toBe('pop rax');
  });

  it('distinguishes the byte registers by the presence of a REX prefix', () => {
    expect(text('0fb6c4')).toBe('movzx eax, ah');
    expect(text('400fb6c4')).toBe('movzx eax, spl');
    expect(text('0f94c7')).toBe('sete bh');
    expect(text('400f94c7')).toBe('sete dil');
    expect(text('410f94c7')).toBe('sete r15b');
  });

  it('computes jump targets from the end of the instruction', () => {
    expect(text('eb10', 0x00400100)).toBe('jmp 0x00400112');
    expect(text('7cfe', 0x00400100)).toBe('jl 0x00400100');
    expect(text('e9fbffffff', 0x00400100)).toBe('jmp 0x00400100');
    expect(text('0f8500010000', 0x00400100)).toBe('jne 0x00400206');
    expect(text('e800000000', 0x00400100)).toBe('call 0x00400105');
  });

  it('breaks an instruction into prefix, opcode, ModR/M, SIB, displacement, and immediate', () => {
    const d = decodeHex('4f6984f57fffffff78563412');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(x86.format(d.insn)).toBe('imul r8, qword ptr [r13 + r14*8 - 129], 305419896');
    expect(d.byteFields!.map((f) => [f.name, f.offset, f.length])).toEqual([
      ['REX', 0, 1], ['opcode', 1, 1], ['ModR/M', 2, 1], ['SIB', 3, 1], ['displacement', 4, 4], ['immediate', 8, 4],
    ]);
    expect(d.byteFields![0]!.bits!.map((b) => b.value)).toEqual([4, 1, 1, 1, 1]);
    expect(d.byteFields![2]!.bits!.map((b) => b.value)).toEqual([2, 0, 4]);
    expect(d.byteFields![3]!.bits!.map((b) => b.value)).toEqual([3, 6, 5]);
    const j = decodeHex('0f84fa000000');
    expect(j.ok && j.byteFields!.map((f) => [f.name, f.offset, f.length])).toEqual([['opcode', 0, 2], ['offset', 2, 4]]);
  });

  it('classifies bytes outside the subset', () => {
    const kind = (h: string): string => {
      const d = decodeHex(h);
      return d.ok ? 'ok' : d.kind;
    };
    for (const h of ['06', '07', '0e', '16', '17', '1e', '1f', '27', '2f', '37', '3f', '60', '61', '82c001', '9a', 'ce', 'd40a', 'd50a', 'ea']) {
      expect(kind(h), h).toBe('invalid');
    }
    expect(kind('8dc0')).toBe('invalid');
    for (const h of ['', '0f', '48', '8b', '8b04', '8b0425000000', 'b80000', 'e9000000', '0f84', 'c70305', '8b8300']) expect(kind(h), h).toBe('truncated');
    for (const h of ['8b0500000000', '6689d8', 'f390', '00d8', '11d8', '19d8', 'f7e3', 'f7fb', 'ffe0', 'ffd0', 'ff30', '8f00', '0fa2', '0f1f00', '48b80000000000000000',
      'c20800', '6a05', 'a900000000', '4190', '480fb6c3', '63c3', 'd1c0', 'c5f877', '62f17c4858c1', 'cc', 'f4', '0f44c3', '4048 89d8'.replace(' ', '')]) {
      expect(kind(h), h).toBe('unsupported');
    }
    const rip = decodeHex('8b0500000000');
    expect(!rip.ok && rip.message).toMatch(/RIP-relative/);
    const div = decodeHex('f7fb');
    expect(!div.ok && div.message).toMatch(/IDIV/);
  });

  it('reports encodings that 64-bit mode leaves undefined as invalid, not as instructions outside the subset', () => {
    const failure = (h: string): { kind: string; message: string; length: number } => {
      const d = decodeHex(h);
      if (d.ok) throw new Error(`${h} decodes as ${x86.format(d.insn)}`);
      return d;
    };
    // Group members without an instruction (Intel SDM Vol. 2A CALL, JMP, INC, DEC; Vol. 2B MOV, POP), blank cells of
    // the two-byte opcode map, VEX and EVEX prefixes after a LOCK, 66, F2, F3, or REX prefix or with a reserved
    // opcode map (Vol. 2A, Sections 2.3.2 to 2.3.4, Table 2-10, Section 2.7.1), EVEX with P[3] = 1 or P[10] = 0
    // (Vol. 2A, Table 2-40), and an invalid opcode after a prefix.
    for (const h of ['fff8', 'ff38', 'ffd8', 'ffe8', 'c70800000000', 'c73805000000', 'c7f900000000', 'c60801', 'c6c805', 'c68a0e2901',
      'fed0', 'fef8', '8fc8', '8f38', '0f04', '0f0a', '0f24c0', '0f36', '0f7ac0', '66c5f877', 'f0c5f877', '48c5f877', 'c4e07877',
      'c4e47818c0', '6248', '62f47c4858c1', '62f97c4858c1', '62f1784858c1', '6606', 'f2ff38']) {
      expect(failure(h).kind, h).toBe('invalid');
    }
    // Defined instructions outside the subset keep their names.
    expect(failure('c7f800000000')).toMatchObject({ kind: 'unsupported', length: 6, message: expect.stringMatching(/XBEGIN/) });
    expect(failure('c6f801')).toMatchObject({ kind: 'unsupported', length: 3, message: expect.stringMatching(/XABORT/) });
    expect(failure('c6c001')).toMatchObject({ kind: 'unsupported', length: 3, message: expect.stringMatching(/MOV r\/m8, imm8/) });
    expect(failure('fec0')).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/INC with an 8-bit operand/) });
    expect(failure('fec8')).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/DEC with an 8-bit operand/) });
    expect(failure('d6')).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/UDB/) });
    expect(failure('ff18')).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/far CALL/) });
    expect(failure('ff28')).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/far JMP/) });
    expect(failure('0f1ae2').kind).toBe('unsupported');
    expect(failure('0f38f007')).toMatchObject({ kind: 'unsupported', message: expect.stringMatching(/three-byte opcode/) });
  });

  it('gives an instruction outside the subset its full length, so that a byte listing continues at the next instruction', () => {
    const length = (h: string): number => decodeHex(h).length;
    // Prefixes, REX, opcode bytes, ModR/M, SIB, displacement, and immediate (Intel SDM Vol. 2A, Section 2.1).
    expect(length('c6c005')).toBe(3);
    expect(length('00c3')).toBe(2);
    expect(length('6689d8')).toBe(3);
    expect(length('f390')).toBe(2);
    expect(length('48b8' + '00'.repeat(8))).toBe(10);
    expect(length('6648b8' + '00'.repeat(8))).toBe(11);
    expect(length('66b80100')).toBe(4);
    expect(length('6605010000000000')).toBe(4);
    expect(length('f7c0' + '00'.repeat(4))).toBe(6);
    expect(length('66f7c00100')).toBe(5);
    expect(length('f6c805')).toBe(3);
    expect(length('8b0501000000')).toBe(6);
    expect(length('c70501000000' + '05000000')).toBe(10);
    expect(length('d86c1853')).toBe(4);
    expect(length('0fba6c240805')).toBe(6);
    expect(length('a1' + '00'.repeat(8))).toBe(9);
    expect(length('67a100000000')).toBe(6);
    expect(length('c8000102')).toBe(4);
    expect(length('c20800')).toBe(3);
    expect(length('66e800000000')).toBe(6);
    expect(length('660f8400000000')).toBe(7);
    // MOV to and from control registers ignores the mod field: no SIB byte or displacement follows (Vol. 2B, MOV).
    expect(length('0f224424')).toBe(3);
    expect(length('0fffc0')).toBe(3);
    expect(length('f30f1efa')).toBe(4);
    expect(length('0f38f007')).toBe(4);
    expect(length('0f3a0fc105')).toBe(5);
    expect(length('c5f877')).toBe(3);
    expect(length('c4e1787700')).toBe(4);
    expect(length('c4e3790fc105')).toBe(6);
    expect(length('62f17c4858c1')).toBe(6);
    expect(length('62f37d480fc105')).toBe(7);
    // When the bytes end inside the instruction, the bytes present belong to it.
    expect(decodeHex('c6c0')).toMatchObject({ ok: false, kind: 'unsupported', length: 2 });
    // An instruction longer than 15 bytes is not a valid encoding (Vol. 2A, Sections 2.2.1 and 2.3.11); more bytes
    // would not complete it, so it is not truncated.
    expect(decodeHex('66'.repeat(14) + '89d8')).toMatchObject({ ok: false, kind: 'invalid', length: 15, message: expect.stringMatching(/longer than 15 bytes/) });
    expect(decodeHex('66'.repeat(14) + '89d8' + '90'.repeat(4))).toMatchObject({ ok: false, kind: 'invalid', length: 15 });

    const listing = (h: string) => decodeBytes('x86', fromHex(h)).map((d) => [d.address, d.bytes, d.ok ? d.text : d.kind]);
    expect(listing('c6c00589d8c390')).toEqual([[0x400000, 'c6c005', 'unsupported'], [0x400003, '89d8', 'mov eax, ebx'], [0x400005, 'c3', 'ret'], [0x400006, '90', 'nop']]);
    expect(listing('00c3c3')).toEqual([[0x400000, '00c3', 'unsupported'], [0x400002, 'c3', 'ret']]);
    expect(listing('6689d8c3')).toEqual([[0x400000, '6689d8', 'unsupported'], [0x400003, 'c3', 'ret']]);
    expect(listing('48b889d8c30000000000c3')).toEqual([[0x400000, '48b889d8c30000000000', 'unsupported'], [0x40000a, 'c3', 'ret']]);
    expect(listing('f7c089d8c390c3')).toEqual([[0x400000, 'f7c089d8c390', 'unsupported'], [0x400006, 'c3', 'ret']]);
    expect(listing('8b0501000000c3')).toEqual([[0x400000, '8b0501000000', 'unsupported'], [0x400006, 'c3', 'ret']]);
    expect(listing('c6c006c3')).toEqual([[0x400000, 'c6c006', 'unsupported'], [0x400003, 'c3', 'ret']]);
    expect(listing('66'.repeat(15) + '89d8c3')).toEqual([[0x400000, '66'.repeat(15), 'invalid'], [0x40000f, '89d8', 'mov eax, ebx'], [0x400011, 'c3', 'ret']]);
  });

  it('decodes the VEX map 7 instructions with a 32-bit immediate as nine-byte instructions outside the subset', () => {
    const kind = (h: string): string => {
      const d = decodeHex(h);
      return d.ok ? 'ok' : d.kind;
    };
    // Intel SDM Vol. 2B: RDMSR r64, imm32 is VEX.128.F2.MAP7:W0.F6 11:000:bbb id, and URDMSR and UWRMSR are opcode F8
    // with F2 and F3; Vol. 2D gives WRMSRNS imm32, r64 as the F3 form of F6. Vol. 2A, Table 2-10, lists map 7 as reserved.
    for (const h of ['c4e77bf6c078563412', 'c4e77af6c078563412', 'c4e77bf8c078563412', 'c4e77af8c078563412', 'c4c77bf8c078563412']) {
      expect(decodeHex(h), h).toMatchObject({ ok: false, kind: 'unsupported', length: 9 });
    }
    expect(decodeBytes('x86', fromHex('c4e77bf6c07856341289d8c3')).map((d) => [d.address, d.bytes, d.ok ? d.text : d.kind])).toEqual([
      [0x400000, 'c4e77bf6c078563412', 'unsupported'], [0x400009, '89d8', 'mov eax, ebx'], [0x40000b, 'c3', 'ret'],
    ]);
    // Other opcodes of the map; VEX.L = 1, VEX.W = 1, VEX.vvvv other than 1111b, or no or a 66 implied prefix; a ModR/M byte
    // other than 11:000:bbb; and the other maps from 4 to 31.
    for (const h of ['c4e77b00c0', 'c4e77ff6c078563412', 'c4e7fbf6c078563412', 'c4e743f6c078563412', 'c4e778f6c078563412', 'c4e779f8c078563412',
      'c4e77bf6c878563412', 'c4e77bf60078563412', 'c4e57bf6c078563412', 'c4ff7bf6c078563412']) {
      expect(kind(h), h).toBe('invalid');
    }
  });

  it('checks the mandatory prefix, operand form, and group member of two- and three-byte opcodes', () => {
    const kind = (h: string): string => {
      const d = decodeHex(h);
      return d.ok ? 'ok' : d.kind;
    };
    // Combinations that no instruction page of Intel SDM Vol. 2A or 2B lists: a SIMD opcode without its mandatory prefix,
    // with a prefix that its NP or NFx opcode column excludes, or with a memory or register operand that it does not
    // take; group members without an instruction; blank cells of the 0F 38 and 0F 3A maps; and the AMD opcodes 0F 0D /0
    // and 0F 01 D8 to DF. The first five strings come from the random decoding input of the validation.
    for (const h of ['0f6cd28bbd54', '0f5012b2467d', '0fc3f67c350a', '0ff0c5f528d8', '0f382634a722', '0f6dc0', '0f7cc0', '0fd0c0', '0fe6c0', '0fb8c0',
      'f20f5bc0', 'f30f50c0', 'f3f20f5bc0', '66480f52c0', '0f13c0', '0f17c0', '0fb5c0', '0fc50005', '0ff700', '0f71c005', '0f713005', '0f73d805',
      '0fc7e8', '0fc700', 'f20fc7f0', '0f00f0', '0f00f8', '0f0128', '660f01ca', '0f01d2', '0f384fc0', '0f388dc0', '0f3a9cc005', '0f38f8c0',
      '660f38c8c0', 'f30f38f0c0', '0f38f0c0', 'f30f38d820', 'f30f3af0c805', '660f77', 'f30fc300', '660fae00', 'f30fae00', '0faec0', 'f20fae30',
      '0f0d00', '0f0dc8', 'f20f2b00', '0f01d8']) {
      expect(kind(h), h).toBe('invalid');
    }
    // Their defined counterparts and the hint and NOP space 0F 18 to 0F 1F, among them LKGS, the fences with any r/m
    // field, URDMSR with register operands, ENQCMDS, the Key Locker instructions, HRESET, and SENDUIPI.
    for (const h of ['660f6cd2', '0f50c0', '0fc300', 'f20ff000', '0f1300', '0fb500', '0fc5c005', '0ff7c0', '0f71d005', '660f73f805', '0fc728',
      '0fc7f0', 'f30fc7f8', 'f30fc7f0', 'f20f00f0', '0f00d8', 'f30f0128', '0f01d0', 'f30f01ee', 'f20f01c6', '0f38c8c0', '0f38f000', 'f20f38f0c0',
      'f20f38f8c0', 'f30f38f800', '660f38f800', 'f30f38d800', 'f30f3af0c005', '0f77', '0fae00', '660fae38', '0faee8', '0faeef', '0faeff',
      'f30faec0', 'f20faef0', '0f0d08', '0f0d10', '0f1ae2', '0f1cda', '0f18c0', 'f30fb8c0', 'f30fbcc0', 'f20fbcc0', '660f3a0fc105']) {
      expect(kind(h), h).toBe('unsupported');
    }
    expect(decodeHex('0f6cd2')).toMatchObject({ length: 2, message: expect.stringMatching(/0F 6C requires the 66 prefix/) });
    expect(decodeHex('0f5012')).toMatchObject({ length: 3, message: expect.stringMatching(/0F 50 with a memory operand is an undefined opcode/) });
    expect(decodeHex('0fc7e8')).toMatchObject({ length: 3, message: expect.stringMatching(/0F C7 \/5 with a register operand/) });
  });

  it('reports MOV to and from segment registers 6 and 7 as invalid and names C6 and FE with a RIP-relative operand', () => {
    const kind = (h: string): string => {
      const d = decodeHex(h);
      return d.ok ? 'ok' : d.kind;
    };
    // The segment registers are ES = 0 to GS = 5 (Intel SDM Vol. 2A, Section 3.1.1.3).
    for (const h of ['8cf0', '8cf8', '8c30', '8e38', '668ef0']) expect(kind(h), h).toBe('invalid');
    for (const h of ['8cc8', '8c18', '8ed8', '8e20']) expect(kind(h), h).toBe('unsupported');
    expect(decodeHex('c6050100000005')).toMatchObject({ ok: false, kind: 'unsupported', length: 7, message: expect.stringMatching(/C6 \/0 is MOV r\/m8, imm8/) });
    expect(decodeHex('fe0501000000')).toMatchObject({ ok: false, kind: 'unsupported', length: 6, message: expect.stringMatching(/FE \/0 is INC/) });
    expect(decodeHex('fe0d01000000')).toMatchObject({ ok: false, kind: 'unsupported', length: 6, message: expect.stringMatching(/FE \/1 is DEC/) });
  });

  it('describes mod 00 with SIB base 101 as a 32-bit displacement without a base register', () => {
    const field = (h: string, name: string) => {
      const d = decodeHex(h);
      if (!d.ok) throw new Error(d.message);
      return d.byteFields!.find((f) => f.name === name)!;
    };
    // Intel SDM Vol. 2A, Table 2-3 note 1 and Table 2-5 (SIB base 0101 with mod 00: no base, REX.B not decoded).
    for (const h of ['8b048d00000010', '448b049d00000010', '418b042500000010']) {
      const modrm = field(h, 'ModR/M');
      expect(modrm.text, h).toMatch(/without a base register; the SIB base field 101 selects a 32-bit displacement/);
      expect(modrm.bits![0]!.text, h).toBe(modrm.text.replace(/^ModR\/M [0-9A-F]{2}: /, ''));
      if (h.startsWith('4')) expect(field(h, 'REX').bits![4]!.text, h).toMatch(/^not decoded/);
    }
    expect(field('8b0423', 'ModR/M').text).toMatch(/memory operand without displacement/);
    expect(field('418b442508', 'REX').bits![4]!.text).toBe('extends the SIB base field');
  });

  it('does not call an operand of CMP or TEST a destination', () => {
    const opcodeText = (h: string): string => {
      const d = decodeHex(h);
      if (!d.ok) throw new Error(d.message);
      return d.byteFields!.find((f) => f.name === 'opcode')!.text;
    };
    for (const h of ['85c3', '39c3', '3bc3', '4885c3', '3903', '3b4308']) {
      expect(opcodeText(h), h).toMatch(/no operand is written, only the flags/);
      expect(opcodeText(h), h).not.toMatch(/destination/);
    }
    expect(opcodeText('01c3')).toMatch(/the r\/m operand is the destination/);
    expect(opcodeText('03c3')).toMatch(/the reg operand is the destination/);
  });

  it('explains REX.W and REX.R by what they do for the decoded instruction', () => {
    const rex = (h: string) => {
      const d = decodeHex(h);
      if (!d.ok) throw new Error(d.message);
      const f = d.byteFields!.find((x) => x.name === 'REX')!;
      return { text: f.text, w: f.bits![1]!.text, r: f.bits![2]!.text };
    };
    // Intel SDM Vol. 2A, Section 2.2.1.2 (REX.R ignored for an opcode extension; REX.W without effect on byte
    // operations) and Section 2.2.1.7 (64-bit default operand size of PUSH, POP, and near branches); Vol. 2B, SETcc.
    expect(rex('4150')).toMatchObject({ text: expect.stringMatching(/REX\.W has no effect/), w: expect.stringMatching(/^no effect: PUSH and POP/) });
    expect(rex('41c3').text).toMatch(/REX\.W has no effect \(near branches/);
    expect(rex('480f94c0')).toMatchObject({ w: expect.stringMatching(/^no effect: SETcc always writes one byte/), r: expect.stringMatching(/^ignored: SETcc/) });
    expect(rex('44ffc0').r).toMatch(/^ignored: the ModR\/M reg field holds an opcode extension/);
    expect(rex('4183fd07').r).toMatch(/^ignored/);
    expect(rex('4489c0')).toMatchObject({ text: expect.stringMatching(/64-bit operand size not selected/), r: 'extends the ModR/M reg field' });
    expect(rex('4889d8')).toMatchObject({ text: expect.stringMatching(/64-bit operand size selected/), w: '64-bit operand size' });
  });
});

describe('x86-64 round trip', () => {
  it('reassembles the decoded text of every sweep instruction to the same bytes', () => {
    let checked = 0;
    for (const sweep of x86.validation.sweeps()) {
      const program = assemble(sweep.text);
      const starts = new Set(program.insns.map((i) => i.address));
      const label = (a: number): string => `L_${a.toString(16)}`;
      const lines: string[] = [];
      for (const i of program.insns) {
        const at = i.address - program.base;
        const raw = program.bytes.subarray(at, at + i.length);
        if (starts.has(i.address)) lines.push(`${label(i.address)}:`);
        if (i.insn === null) {
          lines.push(`.byte ${Array.from(raw, (b) => `0x${b.toString(16)}`).join(', ')}`);
          continue;
        }
        const d = x86.decode(program.bytes, at, i.address);
        expect(d.ok, `${sweep.name}: ${i.text}`).toBe(true);
        if (!d.ok) continue;
        expect(d.length, i.text).toBe(i.length);
        const formatted = x86.format(d.insn);
        const parsed = x86.parseLine(formatted);
        expect(parsed.ok, formatted).toBe(true);
        if (!parsed.ok) continue;
        const item = parsed.items[0]!;
        if (item.kind !== 'insn') throw new Error('expected an instruction');
        const target = d.insn.operands.find((o) => o.t === 'addr') as Extract<AsmOperand, { t: 'addr' }> | undefined;
        if (!target) {
          // Instructions without a code address are re-encoded one at a time.
          expect(bytesToHex(x86.asm.encode(item.insn, i.address, false), ''), formatted).toBe(bytesToHex(raw, ''));
          lines.push(formatted);
        } else if (starts.has(target.value)) {
          // A target inside the program is written as a label, as the listing shows it, so that the
          // assembler chooses between the short and the long form again.
          const labelled: Insn = { mnemonic: d.insn.mnemonic, operands: [{ t: 'addr', value: target.value, label: label(target.value) }] };
          lines.push(x86.format(labelled));
        } else {
          // A numeric target is encoded in the long form at any distance.
          expect(i.length, formatted).toBeGreaterThan(2);
          expect(bytesToHex(x86.asm.encode(item.insn, i.address, false), ''), formatted).toBe(bytesToHex(raw, ''));
          lines.push(formatted);
        }
        checked++;
      }
      expect(bytesToHex(assemble(lines.join('\n')).bytes, ''), sweep.name).toBe(bytesToHex(program.bytes, ''));
    }
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('x86-64 processor model', () => {
  it('zero-extends 32-bit results and keeps the other bits on 8-bit writes', () => {
    const m = machine('mov eax, ebx\n sete al\n sete ah\n movsxd rcx, eax\n mov rdx, rcx');
    m.cpu.writeReg('rax', 0x1122334455667788n);
    m.cpu.writeReg('rbx', 0xaabbccdd80000001n);
    m.step();
    expect(m.cpu.readReg('rax')).toBe(0x80000001n);
    m.cpu.writeReg('rax', 0x1122334455667788n);
    m.cpu.writeFlag('ZF', 1);
    m.step();
    expect(m.cpu.readReg('rax')).toBe(0x1122334455667701n);
    m.cpu.writeFlag('ZF', 0);
    m.step();
    expect(m.cpu.readReg('rax')).toBe(0x1122334455660001n);
    m.cpu.writeReg('eax', 0xfffffff0n);
    m.step();
    expect(m.cpu.readReg('rcx')).toBe(0xfffffffffffffff0n);
    expect(m.cpu.reg32('ecx')).toBe(-16);
  });

  it('sets the status flags of arithmetic exactly', () => {
    const flagsAfter = (source: string, regs: Record<string, bigint>, flags: Record<string, number> = {}) => {
      const m = machine(source);
      for (const [k, v] of Object.entries(regs)) m.cpu.writeReg(k, v);
      for (const [k, v] of Object.entries(flags)) m.cpu.writeFlag(k, v);
      m.step();
      return m.cpu.readFlags();
    };
    expect(flagsAfter('add eax, ebx', { eax: 0x7fffffffn, ebx: 1n })).toEqual({ OF: 1, SF: 1, ZF: 0, AF: 1, PF: 1, CF: 0 });
    expect(flagsAfter('add eax, ebx', { eax: 0xffffffffn, ebx: 1n })).toEqual({ OF: 0, SF: 0, ZF: 1, AF: 1, PF: 1, CF: 1 });
    expect(flagsAfter('add rax, rbx', { rax: 0xffffffffn, rbx: 1n })).toEqual({ OF: 0, SF: 0, ZF: 0, AF: 1, PF: 1, CF: 0 });
    expect(flagsAfter('cmp eax, ebx', { eax: 3n, ebx: 7n })).toEqual({ OF: 0, SF: 1, ZF: 0, AF: 1, PF: 1, CF: 1 });
    expect(flagsAfter('sub eax, ebx', { eax: 0x80000000n, ebx: 1n })).toEqual({ OF: 1, SF: 0, ZF: 0, AF: 1, PF: 1, CF: 0 });
    expect(flagsAfter('and eax, ebx', { eax: 0xf0n, ebx: 0x0fn }, { CF: 1, OF: 1 })).toMatchObject({ OF: 0, SF: 0, ZF: 1, PF: 1, CF: 0 });
    expect(flagsAfter('inc eax', { eax: 0x7fffffffn }, { CF: 1 })).toEqual({ OF: 1, SF: 1, ZF: 0, AF: 1, PF: 1, CF: 1 });
    expect(flagsAfter('dec eax', { eax: 0n }, { CF: 0 })).toEqual({ OF: 0, SF: 1, ZF: 0, AF: 1, PF: 1, CF: 0 });
    expect(flagsAfter('neg eax', { eax: 0n }, { CF: 1 })).toMatchObject({ CF: 0, ZF: 1 });
    expect(flagsAfter('neg eax', { eax: 0x80000000n })).toMatchObject({ CF: 1, OF: 1, SF: 1 });
    expect(flagsAfter('imul eax, ebx', { eax: 0x10000n, ebx: 0x10000n })).toMatchObject({ CF: 1, OF: 1 });
    expect(flagsAfter('imul eax, ebx, -3', { ebx: 5n })).toMatchObject({ CF: 0, OF: 0 });
    expect(flagsAfter('shl eax, 1', { eax: 0xc0000000n })).toMatchObject({ CF: 1, OF: 0, SF: 1 });
    expect(flagsAfter('shl eax, 1', { eax: 0x40000000n })).toMatchObject({ CF: 0, OF: 1, SF: 1 });
    expect(flagsAfter('shr eax, 1', { eax: 0x80000001n })).toMatchObject({ CF: 1, OF: 1, SF: 0 });
    expect(flagsAfter('sar eax, 1', { eax: 0x80000001n })).toMatchObject({ CF: 1, OF: 0, SF: 1 });
    // A masked count of zero leaves every flag as it was.
    const all = { OF: 1, SF: 1, ZF: 1, AF: 1, PF: 1, CF: 1 };
    expect(flagsAfter('shl eax, cl', { eax: 5n, ecx: 32n }, all)).toEqual(all);
    expect(flagsAfter('not eax', { eax: 5n }, all)).toEqual(all);
    expect(flagsAfter('mov eax, 0', {}, all)).toEqual(all);
  });

  it('masks shift counts to five or six bits', () => {
    const m = machine('shl eax, cl\n shl rbx, cl\n sar edx, 33');
    m.cpu.writeReg('rax', 1n);
    m.cpu.writeReg('rbx', 1n);
    m.cpu.writeReg('rcx', 33n);
    m.cpu.writeReg('edx', 0x80000000n);
    m.step();
    m.step();
    m.step();
    expect(m.cpu.readReg('rax')).toBe(2n);
    expect(m.cpu.readReg('rbx')).toBe(0x200000000n);
    expect(m.cpu.readReg('rdx')).toBe(0xc0000000n);
  });

  it('pushes and pops quadwords and keeps the return address on the stack', () => {
    const m = machine('call f\n nop\n f: pop rax\n push rsp\n pop rbx\n push rax\n ret');
    const ev = newStepEvent(0);
    m.step(ev);
    expect(m.cpu.readReg('rsp')).toBe(BigInt(LAYOUT.stackTop - 8));
    expect(m.mem.peek32(LAYOUT.stackTop - 8)).toBe(LAYOUT.codeBase + 5);
    expect(ev.memWrites).toEqual([{ address: LAYOUT.stackTop - 8, size: 8, before: 0n, value: BigInt(LAYOUT.codeBase + 5) }]);
    m.step();
    expect(m.cpu.readReg('rax')).toBe(BigInt(LAYOUT.codeBase + 5));
    m.step();
    m.step();
    expect(m.cpu.readReg('rbx')).toBe(BigInt(LAYOUT.stackTop));
    m.step();
    m.step();
    expect(m.cpu.pc).toBe(LAYOUT.codeBase + 5);
  });

  it('copies the next address to rcx and the flags to r11 on syscall', () => {
    const m = machine('mov eax, 1\n mov edi, 42\n cmp eax, eax\n syscall\n mov eax, 2\n syscall');
    m.run();
    expect(m.output).toEqual([42]);
    expect(m.status).toBe('exited');
    expect(m.cpu.readReg('rcx')).toBe(BigInt(LAYOUT.codeBase + 21));
    // Bit 1 is always set; ZF (bit 6) and PF (bit 2) come from the comparison.
    expect(m.cpu.readReg('r11')).toBe(0x46n);
    expect(m.cpu.readFlags()).toMatchObject({ ZF: 1, PF: 1, CF: 0 });
  });

  it('evaluates all sixteen conditions', () => {
    const taken = (cc: string, flags: Record<string, number>): boolean => {
      const m = machine(`j${cc} t\n nop\n t: nop`);
      for (const f of ['OF', 'SF', 'ZF', 'AF', 'PF', 'CF']) m.cpu.writeFlag(f, flags[f] ?? 0);
      m.step();
      return m.cpu.pc === LAYOUT.codeBase + 3;
    };
    expect(CC_NAMES.filter((cc) => taken(cc, {}))).toEqual(['no', 'ae', 'ne', 'a', 'ns', 'np', 'ge', 'g']);
    expect(CC_NAMES.filter((cc) => taken(cc, { ZF: 1 }))).toEqual(['no', 'ae', 'e', 'be', 'ns', 'np', 'ge', 'le']);
    expect(CC_NAMES.filter((cc) => taken(cc, { SF: 1 }))).toEqual(['no', 'ae', 'ne', 'a', 's', 'np', 'l', 'le']);
    expect(CC_NAMES.filter((cc) => taken(cc, { SF: 1, OF: 1 }))).toEqual(['o', 'ae', 'ne', 'a', 's', 'np', 'ge', 'g']);
    expect(CC_NAMES.filter((cc) => taken(cc, { CF: 1, PF: 1 }))).toEqual(['no', 'b', 'ne', 'be', 'ns', 'p', 'ge', 'g']);
  });

  it('faults deterministically', () => {
    expect(run('mov eax, dword ptr [0x20000000]').fault).toMatch(/unmapped address 0x20000000/);
    expect(run('mov dword ptr [0x00400000], eax').fault).toMatch(/read-only code region/);
    // The address is computed modulo 2^64: -1 + 0x10000001 is the first byte of the data region.
    const wrap = machine('mov rax, -1\n mov eax, dword ptr [rax + 0x10000001]\n mov eax, dword ptr [rax*8 + 0x10000000]');
    wrap.step();
    expect(wrap.step()).toBe(true);
    wrap.cpu.writeReg('rax', 0xffffffffffffffffn);
    wrap.step();
    expect(wrap.fault).toMatch(/unmapped address 0x0ffffff8/);
    expect(run('mov rax, 0x10000000\n shl rax, 4\n mov eax, dword ptr [rax]').fault).toMatch(/unmapped address 0x0000000100000000/);
    expect(run('.byte 0x06').fault).toMatch(/illegal instruction.*not valid in 64-bit mode/);
    expect(run('.byte 0xf7, 0xfb').fault).toMatch(/illegal instruction.*IDIV/);
    expect(run('mov rax, -1\n push rax\n ret').fault).toMatch(/return to 0xffffffffffffffff/);
    expect(run('nop').fault).toMatch(/illegal instruction at 0x00400001/);
  });

  it('records reads, writes, flags, and the branch decision in a step event', () => {
    const m = machine('add dword ptr [rbx + rcx*4 + 8], eax\n jne 0x00400000');
    m.cpu.writeReg('rbx', BigInt(LAYOUT.dataBase));
    m.cpu.writeReg('rcx', 2n);
    m.cpu.writeReg('eax', 5n);
    m.mem.poke(LAYOUT.dataBase + 16, [0xff, 0xff, 0xff, 0xff]);
    const ev = newStepEvent(0);
    m.step(ev);
    expect(ev.text).toBe('add dword ptr [rbx + rcx*4 + 8], eax');
    expect(ev.klass).toBe('store');
    expect(ev.memReads).toEqual([{ address: LAYOUT.dataBase + 16, size: 4, value: 0xffffffffn }]);
    expect(ev.memWrites).toEqual([{ address: LAYOUT.dataBase + 16, size: 4, before: 0xffffffffn, value: 4n }]);
    expect(ev.alu).toEqual({ op: 'add', a: 0xffffffffn, b: 5n, result: 4n });
    expect(ev.flags!.after).toEqual({ OF: 0, SF: 0, ZF: 0, AF: 1, PF: 0, CF: 1 });
    const ev2 = newStepEvent(1);
    m.step(ev2);
    expect(ev2.branch).toEqual({ conditional: true, taken: true, target: 0x00400000 });
    expect(ev2.nextPc).toBe(0x00400000);
  });

  it('records an address computation whose two operands add up to the address, the scaled index included', () => {
    const address = (source: string, regs: Record<string, bigint>) => {
      const m = machine(source);
      for (const [k, v] of Object.entries(regs)) m.cpu.writeReg(k, v);
      const ev = newStepEvent(0);
      m.step(ev);
      return ev.alu;
    };
    // Intel SDM Vol. 1, Section 3.7.5: offset = base + (index * scale) + displacement.
    expect(address('lea eax, [rbx + rcx*4 + 8]', { rbx: 100n, rcx: 3n })).toEqual({ op: 'address', a: 100n, b: 20n, result: 120n });
    expect(address('lea rax, [rcx*8]', { rcx: 5n })).toEqual({ op: 'address', a: 0n, b: 40n, result: 40n });
    expect(address('mov r8d, dword ptr [rbx*4 + 0x10000000]', { rbx: 2n })).toEqual({ op: 'address', a: 0n, b: 0x10000008n, result: 0x10000008n });
    expect(address('mov eax, dword ptr [rbx + rcx*4 - 8]', { rbx: 0x10000010n, rcx: 3n })).toEqual({ op: 'address', a: 0x10000010n, b: 4n, result: 0x10000014n });
    expect(address('mov dword ptr [rbx - 16], eax', { rbx: 0x10000010n })).toEqual({ op: 'address', a: 0x10000010n, b: 0xfffffffffffffff0n, result: 0x10000000n });
  });

  it('keeps a jump or call target below address zero as a negative pc and faults at its 64-bit address', () => {
    for (const [source, target, text] of [
      ['jmp 0xfffffffffffffff0', -16, '0xfffffffffffffff0'],
      ['call 0xfffffffffffff000', -4096, '0xfffffffffffff000'],
      ['je 0xffffffffffffff01', -255, '0xffffffffffffff01'],
      // Encoded as e9 f6 ff af ff.
      ['jmp 0xffffffffffeffffb', -1048581, '0xffffffffffeffffb'],
    ] as const) {
      const m = machine(source);
      m.cpu.writeFlag('ZF', 1);
      const ev = newStepEvent(0);
      expect(m.step(ev), source).toBe(true);
      expect(ev.branch!.target, source).toBe(target);
      expect(ev.nextPc, source).toBe(target);
      expect(m.cpu.pc, source).toBe(target);
      expect(m.cpu.readReg('rip'), source).toBe(BigInt.asUintN(64, BigInt(target)));
      expect(m.step(), source).toBe(false);
      // The fault names the 64-bit address 2^64 + target.
      expect(m.fault, source).toContain(text);
    }
  });

  it('reports the address of a faulting instruction as the next program counter', () => {
    const base = LAYOUT.codeBase;
    const cases: [string, number][] = [
      ['nop\n .byte 0x0f, 0x0b', base + 1],
      ['.byte 0x06', base],
      ['nop', base + 1],
      ['mov eax, dword ptr [0x20000000]', base],
      ['nop\n mov dword ptr [0x00400000], eax', base + 1],
      ['mov eax, 0x1000fffc\n mov qword ptr [rax], rbx', base + 5],
      ['sete byte ptr [0x00400000]', base],
      ['mov rax, -1\n push rax\n ret', base + 8],
      ['mov rsp, -1\n push rax', base + 7],
      ['mov rsp, -1\n pop rax', base + 7],
      ['mov rsp, -1\n call 0x00400100', base + 7],
      ['mov rsp, -1\n ret', base + 7],
      // The fetch at an address below zero faults, and the program counter stays at that address.
      ['jmp 0xfffffffffffffff0', -16],
    ];
    for (const [source, at] of cases) {
      const m = machine(source);
      let ev = newStepEvent(0);
      while (m.status === 'running') {
        ev = newStepEvent(m.executed);
        m.step(ev);
      }
      expect(m.status, source).toBe('fault');
      expect(ev.stop?.kind, source).toBe('fault');
      expect([ev.pc, ev.nextPc, m.cpu.pc], source).toEqual([at, at, at]);
      // The processor model alone, without the machine, reports the same address.
      const direct = machine(source);
      let last = newStepEvent(0);
      for (let k = 0; k < 8; k++) {
        last = newStepEvent(k);
        if (direct.cpu.step(last) !== null) break;
      }
      expect([last.nextPc, direct.cpu.pc], source).toEqual([at, at]);
    }
    // An instruction that the end of the code region cuts off.
    const code = new Uint8Array(LAYOUT.codeSize);
    code.set([0x89, 0xd8, 0x89], LAYOUT.codeSize - 3);
    const cut = machineFromBytes('x86', code, { entry: base + LAYOUT.codeSize - 3 });
    const first = newStepEvent(0);
    expect(cut.step(first)).toBe(true);
    const second = newStepEvent(1);
    expect(cut.step(second)).toBe(false);
    expect([second.nextPc, cut.cpu.pc]).toEqual([base + LAYOUT.codeSize - 1, base + LAYOUT.codeSize - 1]);
    // A completed instruction and a service request report the address of the following instruction.
    expect(first.nextPc).toBe(base + LAYOUT.codeSize - 1);
    const service = machine('mov eax, 99\n syscall');
    service.step();
    const request = newStepEvent(1);
    service.step(request);
    expect(request.stop?.kind).toBe('service');
    expect([request.pc, request.nextPc, service.cpu.pc]).toEqual([base + 5, base + 7, base + 7]);
  });

  it('faults on an instruction longer than 15 bytes as an illegal instruction', () => {
    const m = run(`.byte ${Array.from({ length: 14 }, () => '0x66').join(', ')}, 0x89, 0xd8`);
    expect(m.fault).toBe('illegal instruction at 0x00400000: the instruction would be longer than 15 bytes');
  });

  it('faults on an instruction of the subset that the end of the code region cuts off as a fetch past the end', () => {
    const code = new Uint8Array(LAYOUT.codeSize);
    code.set([0x89, 0xd8, 0x89], LAYOUT.codeSize - 3);
    const m = machineFromBytes('x86', code, { entry: LAYOUT.codeBase + LAYOUT.codeSize - 3 });
    expect(m.step()).toBe(true);
    expect(m.step()).toBe(false);
    expect(m.fault).toBe('instruction fetch runs past the end of the code region at 0x0040ffff');
  });
});

describe('x86-64 lowering', () => {
  const compileOk = (source: string) => {
    const r = compile(source, x86);
    if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
    return r.compiled;
  };

  it('compiles and runs a program with arrays, shifts, comparisons, and a loop', () => {
    const source = [
      'def main(n, k):',
      '    a = [3, 1, 4, 1, 5, 9, 2, 6]',
      '    s = 0',
      '    for i in range(len(a)):',
      '        if a[i] > k and i != n:',
      '            s = s + (a[i] << (i & 3)) - (a[i] >> 1) * 3',
      '        a[i] = s - i',
      '    print(s)',
      '    return a[7] - s * n',
    ].join('\n');
    const compiled = compileOk(source);
    const m = loadCompiled(x86, compiled, { args: [2, 1] });
    const o = m.run();
    let s = 0;
    const a = [3, 1, 4, 1, 5, 9, 2, 6];
    for (let i = 0; i < 8; i++) {
      if (a[i]! > 1 && i !== 2) s = s + (a[i]! << (i & 3)) - (a[i]! >> 1) * 3;
      a[i] = s - i;
    }
    expect(o.status).toBe('exited');
    expect(o.output).toEqual([s]);
    expect(o.returnValue).toBe(a[7]! - s * 2);
    const texts = compiled.program.insns.map((i) => i.text);
    expect(texts.slice(0, 4)).toEqual(['call main', 'mov edi, eax', 'mov eax, 2', 'syscall']);
    expect(texts.some((t) => /^mov \w+, dword ptr \[\w+\*4 \+ 0x10000000\]$/.test(t))).toBe(true);
    expect(texts.some((t) => /^shl \w+, cl$/.test(t))).toBe(true);
    expect(texts[texts.indexOf('ret') - 1]).toMatch(/^(mov eax|add rsp)/);
  });

  it('keeps rsp a multiple of 16 inside main when stack slots are needed', () => {
    const vars = Array.from({ length: 9 }, (_, i) => `v${i}`);
    const source = ['def main(a):', ...vars.map((v, i) => `    ${v} = a + ${i}`), `    return ${vars.join(' + ')}`].join('\n');
    const compiled = compileOk(source);
    expect(compiled.frame.size % 16).toBe(8);
    expect(compiled.frame.size).toBeGreaterThanOrEqual(4 * compiled.frame.slotOffsets.length);
    const m = loadCompiled(x86, compiled, { args: [10] });
    const main = compiled.program.symbols['main']!;
    while (m.cpu.pc !== main) m.step();
    m.step();
    expect(Number(m.cpu.readReg('rsp')) % 16).toBe(0);
    const o = m.run();
    expect(o.returnValue).toBe(9 * 10 + 36);
    for (const size of [1, 2, 3, 6, 7, 10, 11]) {
      const f = x86.lowering.frame(size, false);
      expect(f.size % 16).toBe(8);
      expect(f.size).toBeGreaterThanOrEqual(4 * size);
      expect(f.size - 16).toBeLessThan(4 * size);
    }
    expect(x86.lowering.frame(0, false).size).toBe(0);
  });
});

describe('x86-64 catalog', () => {
  it('has an entry for every implemented mnemonic and every example assembles', () => {
    const names = new Set(INSTRUCTIONS.map((i) => i.mnemonic));
    for (const m of BASE_MNEMONICS) expect(names.has(m), m).toBe(true);
    for (const cc of CC_NAMES) {
      expect(names.has(`j${cc}`)).toBe(true);
      expect(names.has(`set${cc}`)).toBe(true);
    }
    expect(names.size).toBe(INSTRUCTIONS.length);
    for (const spec of INSTRUCTIONS) {
      const r = assembleText(x86, spec.example);
      expect(r.ok, `${spec.mnemonic}: ${spec.example}`).toBe(true);
      expect(spec.reference).toMatch(/^Intel SDM Volume 2/);
    }
  });

  it('gives an operation example for every key of the reference backend, and each assembles', () => {
    expect(OPERATIONS.map((o) => o.key)).toEqual(RISCV_OPERATIONS.map((o) => o.key));
    for (const op of OPERATIONS) {
      const r = assembleText(x86, `${op.assembly.join('\n')}\ntarget: nop`);
      expect(r.ok, op.key).toBe(true);
    }
  });

  it('describes the opcode of an x86-64 instruction as one, two, or three bytes', () => {
    // Intel SDM Vol. 2A, Section 2.1.2: a primary opcode can be 1, 2, or 3 bytes in length.
    expect(x86.profile.instructionLength.description).toMatch(/one, two, or three opcode bytes/);
  });

  it('keeps the register sets of the conventions disjoint', () => {
    const c = x86.profile.conventions;
    const all = [...c.varRegs, ...c.tempRegs, ...c.scratch];
    expect(new Set(all).size).toBe(all.length);
    expect(c.scratch).toEqual(['eax', 'edx', 'ecx', 'r11d']);
    for (const name of [...all, ...c.args, c.result, c.stackPointer, c.serviceNumber, c.serviceArg, ...c.serviceClobbers]) {
      expect(() => x86.createCpu(new Machine(x86, { code: new Uint8Array(1), entry: LAYOUT.codeBase }).mem).readReg(name)).not.toThrow();
    }
  });
});

describe('x86-64 validation inputs', () => {
  it('leaves OF and AF of a shift by cl undefined only for the masked counts where the manual does', () => {
    const insn = (source: string): Insn => assemble(source).insns[0]!.insn!;
    const flags = (source: string, cl: bigint): string[] => undefinedFlags(insn(source), (name) => (name === 'rcx' ? 0xabcd00n | cl : 0n));
    // Intel SDM Vol. 2B, SAL/SAR/SHL/SHR: with a masked count of 0 no flag changes; OF is defined for a masked count of 1;
    // AF is undefined for a nonzero count. The count is masked to 5 bits, or 6 bits for a 64-bit operand.
    expect(flags('shl eax, cl', 0n)).toEqual([]);
    expect(flags('shl eax, cl', 0x20n)).toEqual([]);
    expect(flags('shl eax, cl', 0xe0n)).toEqual([]);
    expect(flags('shr ecx, cl', 1n)).toEqual(['AF']);
    expect(flags('sar dword ptr [rbx], cl', 0x21n)).toEqual(['AF']);
    expect(flags('shl eax, cl', 5n)).toEqual(['OF', 'AF']);
    expect(flags('shl rax, cl', 0x20n)).toEqual(['OF', 'AF']);
    expect(flags('shl rax, cl', 0x40n)).toEqual([]);
    expect(flags('sar qword ptr [rbx + 8], cl', 0x41n)).toEqual(['AF']);
    // The immediate forms give the same sets, and without the state before the instruction the count in cl is unknown.
    expect(undefinedFlags(insn('shl eax, 32'))).toEqual([]);
    expect(undefinedFlags(insn('shl eax, 1'))).toEqual(['AF']);
    expect(undefinedFlags(insn('shl eax, cl'))).toEqual(['OF', 'AF']);
    expect(x86.validation.undefinedFlags).toBe(undefinedFlags);
  });

  it('gives every shift by cl of the sweeps its flags from the registers recorded before the instruction', () => {
    const registers = x86.profile.registers.map((r) => r.name);
    const counts = [0, 1, 2, 31, 32, 33, 63, 64, 65, 128, 129, 255];
    const ones = { OF: 1, SF: 1, ZF: 1, AF: 1, PF: 1, CF: 1 };
    const seen = new Set<string>();
    let shifts = 0;
    for (const sweep of x86.validation.sweeps().filter((s) => ['shl', 'shr', 'sar'].includes(s.name))) {
      const p = assemble(sweep.text);
      const m = new Machine(x86, { code: p.bytes, entry: p.base });
      for (const ai of p.insns) {
        const insn = ai.insn;
        const count = insn?.operands[1];
        if (!insn || !count || count.t !== 'reg' || count.name !== 'cl') continue;
        shifts++;
        // REX.W selects the 64-bit operand size, which masks the count to six bits.
        const bits = (p.bytes[ai.address - p.base]! & 0xf8) === 0x48 ? 64 : 32;
        counts.forEach((cl, k) => {
          const label = `${ai.text} with cl = ${cl}`;
          registers.forEach((name, i) => m.cpu.writeReg(name, 0x0123456789abcd00n * BigInt(i + k + 1) + 0x80000001n));
          m.cpu.writeReg('rcx', 0xfedcba9876543200n | BigInt(cl));
          // A memory operand is placed in the data region, which fixes the count when its address uses rcx.
          for (const o of insn.operands) {
            if (o.t !== 'mem') continue;
            if (o.index) m.cpu.writeReg(o.index, 3n);
            if (o.base) m.cpu.writeReg(o.base, BigInt(LAYOUT.dataBase + 0x800));
          }
          const flagsBefore = k % 2 === 0 ? ones : { OF: 0, SF: 0, ZF: 0, AF: 0, PF: 0, CF: 0 };
          for (const [f, v] of Object.entries(flagsBefore)) m.cpu.writeFlag(f, v);
          const before: Record<string, string> = {};
          for (const name of registers) before[name] = m.cpu.readReg(name).toString(16);
          m.cpu.pc = ai.address;
          const ev = newStepEvent(0);
          expect(m.cpu.step(ev), label).toBeNull();
          // The destination can be rcx itself, so the count is read from the recorded registers, not from the processor.
          const flags = x86.validation.undefinedFlags!(insn, (name) => {
            expect(registers, label).toContain(name);
            return BigInt('0x' + before[name]!);
          });
          const masked = Number(BigInt('0x' + before.rcx!) & 0xffn) & (bits - 1);
          expect(flags, label).toEqual(masked === 0 ? [] : masked === 1 ? ['AF'] : ['OF', 'AF']);
          seen.add(`${insn.mnemonic} ${bits} ${insn.operands[0]!.t} ${Math.min(masked, 2)}`);
          // Every flag outside the set has the value that the manual defines.
          const after = m.cpu.readFlags();
          if (masked === 0) expect(after, label).toEqual(flagsBefore);
          if (masked === 1) {
            const top = (v: bigint): number => Number((v >> BigInt(bits - 1)) & 1n);
            const a = ev.alu!.a;
            const r = ev.alu!.result;
            const cf = insn.mnemonic === 'shl' ? top(a) : Number(a & 1n);
            const of = insn.mnemonic === 'shl' ? top(r) ^ cf : insn.mnemonic === 'shr' ? top(a) : 0;
            expect([after.CF, after.OF, after.SF, after.ZF], label).toEqual([cf, of, top(r), r === 0n ? 1 : 0]);
          }
        });
      }
    }
    expect(shifts).toBeGreaterThan(150);
    // Each shift, operand size, and destination kind occurs with a masked count of 0, of 1, and above 1.
    expect(seen.size).toBe(3 * 2 * 2 * 3);
  });
});
