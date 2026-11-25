/**
 * RV32I decoder. `decodeWord` recognizes a 32-bit word and extracts its
 * register numbers and immediate; the processor model executes from this
 * result. `decode` adds the assembly-level instruction and the bit fields.
 */
import { bytesToWordLE, hex, signExtend } from '../../util/int32.ts';
import type { BitField, DecodeResult, Insn } from '../types.ts';
import type { Encoding } from './isa.ts';
import { ENCODINGS, REG_NAMES } from './isa.ts';
import { aliasOf } from './text.ts';

export interface Raw {
  enc: Encoding;
  rd: number;
  rs1: number;
  rs2: number;
  /** Sign-extended immediate; for U format the 20-bit field value; for B and J the byte offset. */
  imm: number;
}

export interface RawError {
  kind: 'invalid' | 'unsupported';
  message: string;
}

const BY_OPCODE = new Map<number, Encoding[]>();
for (const e of ENCODINGS) {
  const list = BY_OPCODE.get(e.opcode) ?? [];
  list.push(e);
  BY_OPCODE.set(e.opcode, list);
}

/** Major opcodes (bits 6:0) named as in the base opcode map of the manual (Table 72). */
const OPCODE = {
  LOAD: 0b0000011, LOAD_FP: 0b0000111, MISC_MEM: 0b0001111, OP_IMM: 0b0010011, OP_IMM_32: 0b0011011,
  STORE: 0b0100011, STORE_FP: 0b0100111, AMO: 0b0101111, OP: 0b0110011, OP_32: 0b0111011,
  MADD: 0b1000011, MSUB: 0b1000111, NMSUB: 0b1001011, NMADD: 0b1001111, OP_FP: 0b1010011, OP_V: 0b1010111,
  BRANCH: 0b1100011, JALR: 0b1100111, SYSTEM: 0b1110011, OP_VE: 0b1110111,
} as const;

const binary = (value: number, digits: number): string => value.toString(2).padStart(digits, '0');

/** An encoding that a ratified extension defines, recognized by the bits under `mask`. */
interface ExtensionEncoding {
  mask: number;
  match: number;
  /** The instruction and the extensions that define it. */
  text: string;
}

/** Text naming an instruction, its family, and the extensions that define it. */
const named = (mnemonic: string, family: string, extensions: string): string => `${mnemonic}, ${family} of the ${extensions}`;
const BITMANIP = 'bit-manipulation instruction';
const CRYPTO = 'scalar cryptography instruction';
const CRYPTO_RV64 = 'RV64-only scalar cryptography instruction';

/** OP encoding selected by funct7 and funct3. */
const op = (funct7: number, funct3: number, text: string): ExtensionEncoding =>
  ({ mask: 0xfe00707f, match: ((funct7 << 25) | (funct3 << 12) | OPCODE.OP) >>> 0, text });
/** OP encoding selected by funct7 bits 29:25 and funct3; bits 31:30 select a byte of rs2. */
const opByteSelect = (low5: number, funct3: number, text: string): ExtensionEncoding =>
  ({ mask: 0x3e00707f, match: ((low5 << 25) | (funct3 << 12) | OPCODE.OP) >>> 0, text });
/** OP encoding selected by funct7, a fixed rs2 field, and funct3. */
const opRs2 = (funct7: number, rs2: number, funct3: number, text: string): ExtensionEncoding =>
  ({ mask: 0xfff0707f, match: ((funct7 << 25) | (rs2 << 20) | (funct3 << 12) | OPCODE.OP) >>> 0, text });
/** OP-IMM encoding with imm[11:5] fixed and a shift amount of 0 to 31 in imm[4:0]. */
const opImmShift = (upper: number, funct3: number, text: string): ExtensionEncoding =>
  ({ mask: 0xfe00707f, match: ((upper << 25) | (funct3 << 12) | OPCODE.OP_IMM) >>> 0, text });
/** OP-IMM encoding with the whole imm[11:0] field fixed. */
const opImm = (imm12: number, funct3: number, text: string): ExtensionEncoding =>
  ({ mask: 0xfff0707f, match: ((imm12 << 20) | (funct3 << 12) | OPCODE.OP_IMM) >>> 0, text });

/**
 * Encodings that ratified extensions define in the OP and OP-IMM major opcodes: Zicond (manual Chapter 11), the
 * bit-manipulation extensions Zba, Zbb, Zbc, Zbs, Zbkb, Zbkc, and Zbkx (Chapter 30), and the scalar cryptography
 * extensions Zknd, Zkne, Zknh, Zksed, and Zksh (Chapter 32), including the scalar cryptography encodings that
 * only RV64 defines. The M extension is recognized separately. The RV64-only bit-manipulation encodings in OP-IMM
 * (shift amounts of 32 to 63 and the RV64 form of REV8) set imm[5], which RV32 reserves, and are reported as
 * invalid together with the base shifts.
 */
const EXTENSION_ENCODINGS: ExtensionEncoding[] = [
  op(0b0010000, 0b010, named('SH1ADD', BITMANIP, 'Zba extension')),
  op(0b0010000, 0b100, named('SH2ADD', BITMANIP, 'Zba extension')),
  op(0b0010000, 0b110, named('SH3ADD', BITMANIP, 'Zba extension')),
  op(0b0100000, 0b111, named('ANDN', BITMANIP, 'Zbb and Zbkb extensions')),
  op(0b0100000, 0b110, named('ORN', BITMANIP, 'Zbb and Zbkb extensions')),
  op(0b0100000, 0b100, named('XNOR', BITMANIP, 'Zbb and Zbkb extensions')),
  op(0b0000101, 0b110, named('MAX', BITMANIP, 'Zbb extension')),
  op(0b0000101, 0b111, named('MAXU', BITMANIP, 'Zbb extension')),
  op(0b0000101, 0b100, named('MIN', BITMANIP, 'Zbb extension')),
  op(0b0000101, 0b101, named('MINU', BITMANIP, 'Zbb extension')),
  op(0b0110000, 0b001, named('ROL', BITMANIP, 'Zbb and Zbkb extensions')),
  op(0b0110000, 0b101, named('ROR', BITMANIP, 'Zbb and Zbkb extensions')),
  opRs2(0b0000100, 0, 0b100, named('ZEXT.H (PACK with rs2 = x0)', BITMANIP, 'Zbb and Zbkb extensions')),
  op(0b0000100, 0b100, named('PACK', BITMANIP, 'Zbkb extension')),
  op(0b0000100, 0b111, named('PACKH', BITMANIP, 'Zbkb extension')),
  op(0b0000101, 0b001, named('CLMUL', BITMANIP, 'Zbc and Zbkc extensions')),
  op(0b0000101, 0b011, named('CLMULH', BITMANIP, 'Zbc and Zbkc extensions')),
  op(0b0000101, 0b010, named('CLMULR', BITMANIP, 'Zbc extension')),
  op(0b0100100, 0b001, named('BCLR', BITMANIP, 'Zbs extension')),
  op(0b0100100, 0b101, named('BEXT', BITMANIP, 'Zbs extension')),
  op(0b0110100, 0b001, named('BINV', BITMANIP, 'Zbs extension')),
  op(0b0010100, 0b001, named('BSET', BITMANIP, 'Zbs extension')),
  op(0b0010100, 0b010, named('XPERM4', BITMANIP, 'Zbkx extension')),
  op(0b0010100, 0b100, named('XPERM8', BITMANIP, 'Zbkx extension')),
  op(0b0000111, 0b101, named('CZERO.EQZ', 'integer conditional operation', 'Zicond extension')),
  op(0b0000111, 0b111, named('CZERO.NEZ', 'integer conditional operation', 'Zicond extension')),
  op(0b0101000, 0b000, named('SHA512SUM0R', CRYPTO, 'Zknh extension')),
  op(0b0101001, 0b000, named('SHA512SUM1R', CRYPTO, 'Zknh extension')),
  op(0b0101010, 0b000, named('SHA512SIG0L', CRYPTO, 'Zknh extension')),
  op(0b0101011, 0b000, named('SHA512SIG1L', CRYPTO, 'Zknh extension')),
  op(0b0101110, 0b000, named('SHA512SIG0H', CRYPTO, 'Zknh extension')),
  op(0b0101111, 0b000, named('SHA512SIG1H', CRYPTO, 'Zknh extension')),
  opByteSelect(0b10001, 0b000, named('AES32ESI', CRYPTO, 'Zkne extension')),
  opByteSelect(0b10011, 0b000, named('AES32ESMI', CRYPTO, 'Zkne extension')),
  opByteSelect(0b10101, 0b000, named('AES32DSI', CRYPTO, 'Zknd extension')),
  opByteSelect(0b10111, 0b000, named('AES32DSMI', CRYPTO, 'Zknd extension')),
  opByteSelect(0b11000, 0b000, named('SM4ED', CRYPTO, 'Zksed extension')),
  opByteSelect(0b11010, 0b000, named('SM4KS', CRYPTO, 'Zksed extension')),
  opImm(0x600, 0b001, named('CLZ', BITMANIP, 'Zbb extension')),
  opImm(0x601, 0b001, named('CTZ', BITMANIP, 'Zbb extension')),
  opImm(0x602, 0b001, named('CPOP', BITMANIP, 'Zbb extension')),
  opImm(0x604, 0b001, named('SEXT.B', BITMANIP, 'Zbb extension')),
  opImm(0x605, 0b001, named('SEXT.H', BITMANIP, 'Zbb extension')),
  opImmShift(0b0100100, 0b001, named('BCLRI', BITMANIP, 'Zbs extension')),
  opImmShift(0b0110100, 0b001, named('BINVI', BITMANIP, 'Zbs extension')),
  opImmShift(0b0010100, 0b001, named('BSETI', BITMANIP, 'Zbs extension')),
  opImm(0x08f, 0b001, named('ZIP', BITMANIP, 'Zbkb extension')),
  opImm(0x100, 0b001, named('SHA256SUM0', CRYPTO, 'Zknh extension')),
  opImm(0x101, 0b001, named('SHA256SUM1', CRYPTO, 'Zknh extension')),
  opImm(0x102, 0b001, named('SHA256SIG0', CRYPTO, 'Zknh extension')),
  opImm(0x103, 0b001, named('SHA256SIG1', CRYPTO, 'Zknh extension')),
  opImm(0x108, 0b001, named('SM3P0', CRYPTO, 'Zksh extension')),
  opImm(0x109, 0b001, named('SM3P1', CRYPTO, 'Zksh extension')),
  opImmShift(0b0110000, 0b101, named('RORI', BITMANIP, 'Zbb and Zbkb extensions')),
  opImmShift(0b0100100, 0b101, named('BEXTI', BITMANIP, 'Zbs extension')),
  opImm(0x287, 0b101, named('ORC.B', BITMANIP, 'Zbb extension')),
  opImm(0x698, 0b101, named('REV8', BITMANIP, 'Zbb and Zbkb extensions')),
  opImm(0x687, 0b101, named('BREV8', BITMANIP, 'Zbkb extension')),
  opImm(0x08f, 0b101, named('UNZIP', BITMANIP, 'Zbkb extension')),
  op(0b0011101, 0b000, named('AES64DS', CRYPTO_RV64, 'Zknd extension')),
  op(0b0011111, 0b000, named('AES64DSM', CRYPTO_RV64, 'Zknd extension')),
  op(0b0011001, 0b000, named('AES64ES', CRYPTO_RV64, 'Zkne extension')),
  op(0b0011011, 0b000, named('AES64ESM', CRYPTO_RV64, 'Zkne extension')),
  op(0b0111111, 0b000, named('AES64KS2', CRYPTO_RV64, 'Zknd and Zkne extensions')),
  opImm(0x300, 0b001, named('AES64IM', CRYPTO_RV64, 'Zknd extension')),
  // AES64KS1I holds rnum in imm[3:0]; rnum 0xB to 0xF is reserved.
  ...Array.from({ length: 11 }, (_, rnum) => opImm(0x310 | rnum, 0b001, named('AES64KS1I', CRYPTO_RV64, 'Zknd and Zkne extensions'))),
  opImm(0x104, 0b001, named('SHA512SUM0', CRYPTO_RV64, 'Zknh extension')),
  opImm(0x105, 0b001, named('SHA512SUM1', CRYPTO_RV64, 'Zknh extension')),
  opImm(0x106, 0b001, named('SHA512SIG0', CRYPTO_RV64, 'Zknh extension')),
  opImm(0x107, 0b001, named('SHA512SIG1', CRYPTO_RV64, 'Zknh extension')),
];

/** Cache-block operations (MISC-MEM funct3 010, rd = 0) by imm[11:0] (manual Section 20.7). */
const CBO = new Map<number, string>([
  [0, named('CBO.INVAL', 'cache-block management instruction', 'Zicbom extension')],
  [1, named('CBO.CLEAN', 'cache-block management instruction', 'Zicbom extension')],
  [2, named('CBO.FLUSH', 'cache-block management instruction', 'Zicbom extension')],
  [4, named('CBO.ZERO', 'cache-block zero instruction', 'Zicboz extension')],
]);

/**
 * Hypervisor virtual-machine loads (HLV, HLVX) in SYSTEM funct3 100: the rs2 values defined for each funct7.
 * The stores (HSV) use the odd funct7 values 0110001 to 0110111 with rd = 0. These belong to the H extension
 * of the privileged architecture.
 */
const HYPERVISOR_LOAD_RS2 = new Map<number, number[]>([
  [0b0110000, [0, 1]], [0b0110010, [0, 1, 3]], [0b0110100, [0, 1, 3]], [0b0110110, [0]],
]);
const HYPERVISOR_STORE_FUNCT7 = [0b0110001, 0b0110011, 0b0110101, 0b0110111];

/** Scalar floating-point loads and stores (LOAD-FP and STORE-FP) by width (manual Table 54): load, store, precision, extension. */
const FP_TRANSFER = new Map<number, [string, string, string, string]>([
  [0b001, ['FLH', 'FSH', 'half-precision', 'Zfh extension (also in Zfhmin and Zfbfmin)']],
  [0b010, ['FLW', 'FSW', 'single-precision', 'F extension']],
  [0b011, ['FLD', 'FSD', 'double-precision', 'D extension']],
  [0b100, ['FLQ', 'FSQ', 'quad-precision', 'Q extension']],
]);

/** Operand categories of the vector arithmetic instructions, indexed by funct3 (manual Table 56). */
const VECTOR_CATEGORY = ['OPIVV', 'OPFVV', 'OPMVV', 'OPIVI', 'OPIVX', 'OPFVF', 'OPMVX'];
const OPIVV = 0b000, OPFVV = 0b001, OPMVV = 0b010, OPIVI = 0b011, OPIVX = 0b100, OPFVF = 0b101, OPMVX = 0b110;

/**
 * Element width of a vector operand: a mask with one bit per element, or a width with a fixed relation to SEW (a
 * fraction of it, SEW itself, or twice SEW). The 16-bit indices of vrgatherei16 have no fixed relation to SEW.
 */
type Width = 'mask' | 'fraction' | 'sew' | 'double' | 'ei16';
const WIDTH_RANK: Partial<Record<Width, number>> = { mask: 0, fraction: 1, sew: 2, double: 3 };

/**
 * An instruction of a vector major opcode, with the values of vm and vs2 that its encoding fixes and the properties
 * of its register operands from which the reserved register numbers follow.
 */
interface VectorEncoding {
  mnemonic: string;
  extension: string;
  vm?: number;
  vs2?: number;
  /**
   * What vd names: a vector of the given element width (SEW when absent), the scalar result of a reduction, or a
   * register that is not a vector register.
   */
  result?: Width | 'scalar' | 'other';
  /** Element width of the vector source in vs2 (SEW when absent). */
  source2?: Width;
  /** Element width of the vector source in vs1 (SEW when absent), or 'none' when an OPMVV encoding holds an immediate there. */
  source1?: Width | 'none';
  /** The sources that vd may not equal whatever their element widths: vs2 alone, or every vector source. */
  apart?: 'vs2' | 'sources';
  /** Number of registers in the groups that vd and vs2 name, when the encoding fixes it. */
  registers?: number;
}

/** A cell of a vector opcode table: one instruction, or instructions selected by the vs1, vs2, or vm field. */
type VectorCell = VectorEncoding | { group: string; field: 'vs1' | 'vs2' | 'vm'; entries: Map<number, VectorEncoding> };

const V_EXT = 'V extension';
const ZVKB = 'Zvbb and Zvkb extensions';
const ZVBB = 'Zvbb extension';
const ZVFBFMIN = 'Zvfbfmin extension';
const ZVKNED = 'Zvkned extension';
const ZVKSED = 'Zvksed extension';

const cellKey = (funct3: number, funct6: number): number => (funct3 << 6) | funct6;

/**
 * Operand properties shared by groups of vector instructions. Comparisons and carry outputs write a mask (manual
 * Sections 31.11.4, 31.11.8, and 31.13.13); the mask-register logical instructions read and write masks
 * (Section 31.15.1); a reduction writes a scalar that may overlap any operand, and a widening reduction reads a
 * scalar of twice SEW (Section 31.14); widening and narrowing instructions have operands of twice SEW (Section 31.10).
 */
const MASK_RESULT: Partial<VectorEncoding> = { result: 'mask' };
const MASK_LOGICAL: Partial<VectorEncoding> = { vm: 1, result: 'mask', source2: 'mask', source1: 'mask' };
const REDUCTION: Partial<VectorEncoding> = { result: 'scalar' };
const WIDENING_REDUCTION: Partial<VectorEncoding> = { result: 'scalar', source1: 'double' };
const WIDENING: Partial<VectorEncoding> = { result: 'double' };
const WIDENING_W: Partial<VectorEncoding> = { result: 'double', source2: 'double' };
const NARROWING: Partial<VectorEncoding> = { source2: 'double' };
/** The destination may not overlap a source (Sections 31.16.3 and 31.16.4). */
const APART: Partial<VectorEncoding> = { apart: 'sources' };

/** Instructions selected by a sub-opcode field; each belongs to the V extension unless it names another. */
const selectBy = (group: string, field: 'vs1' | 'vs2' | 'vm', entries: [number, string, Partial<VectorEncoding>?][]): VectorCell =>
  ({ group, field, entries: new Map(entries.map(([value, mnemonic, more]) => [value, { mnemonic, extension: V_EXT, ...more }])) });

/**
 * Rows of the vector instruction listing (manual Section 31.20) with the instructions that Zvbb, Zvkb, and Zvbc
 * (Section 33.5) and Zvfbfwma (Section 25.5.5) add: funct6, the operand forms that exist, the mnemonic, and the
 * fields that the encoding fixes. The forms are V, X, and I (OPIVV, OPIVX, OPIVI) in the integer table, V and X
 * (OPMVV, OPMVX) in the second table, and V and F (OPFVV, OPFVF) in the floating-point table.
 */
type VectorRow = [funct6: number, forms: string, mnemonic: string, more?: Partial<VectorEncoding>];

const OPI_ROWS: VectorRow[] = [
  [0b000000, 'VXI', 'VADD'], [0b000001, 'VX', 'VANDN', { extension: ZVKB }], [0b000010, 'VX', 'VSUB'], [0b000011, 'XI', 'VRSUB'],
  [0b000100, 'VX', 'VMINU'], [0b000101, 'VX', 'VMIN'], [0b000110, 'VX', 'VMAXU'], [0b000111, 'VX', 'VMAX'],
  [0b001001, 'VXI', 'VAND'], [0b001010, 'VXI', 'VOR'], [0b001011, 'VXI', 'VXOR'], [0b001100, 'VXI', 'VRGATHER', APART],
  [0b001110, 'V', 'VRGATHEREI16', { apart: 'sources', source1: 'ei16' }], [0b001110, 'XI', 'VSLIDEUP', APART], [0b001111, 'XI', 'VSLIDEDOWN'],
  // vadc and vsbc are encoded as masked instructions; the unmasked encodings are reserved (Section 31.11.4).
  [0b010000, 'VXI', 'VADC', { vm: 0 }], [0b010001, 'VXI', 'VMADC', MASK_RESULT], [0b010010, 'VX', 'VSBC', { vm: 0 }], [0b010011, 'VX', 'VMSBC', MASK_RESULT],
  [0b010100, 'VXI', 'VROR', { extension: ZVKB }], [0b010101, 'VX', 'VROL', { extension: ZVKB }],
  [0b011000, 'VXI', 'VMSEQ', MASK_RESULT], [0b011001, 'VXI', 'VMSNE', MASK_RESULT], [0b011010, 'VX', 'VMSLTU', MASK_RESULT], [0b011011, 'VX', 'VMSLT', MASK_RESULT],
  [0b011100, 'VXI', 'VMSLEU', MASK_RESULT], [0b011101, 'VXI', 'VMSLE', MASK_RESULT], [0b011110, 'XI', 'VMSGTU', MASK_RESULT], [0b011111, 'XI', 'VMSGT', MASK_RESULT],
  [0b100000, 'VXI', 'VSADDU'], [0b100001, 'VXI', 'VSADD'], [0b100010, 'VX', 'VSSUBU'], [0b100011, 'VX', 'VSSUB'],
  [0b100101, 'VXI', 'VSLL'], [0b100111, 'VX', 'VSMUL'], [0b101000, 'VXI', 'VSRL'], [0b101001, 'VXI', 'VSRA'],
  [0b101010, 'VXI', 'VSSRL'], [0b101011, 'VXI', 'VSSRA'], [0b101100, 'VXI', 'VNSRL', NARROWING], [0b101101, 'VXI', 'VNSRA', NARROWING],
  [0b101110, 'VXI', 'VNCLIPU', NARROWING], [0b101111, 'VXI', 'VNCLIP', NARROWING], [0b110000, 'V', 'VWREDSUMU', WIDENING_REDUCTION], [0b110001, 'V', 'VWREDSUM', WIDENING_REDUCTION],
  [0b110101, 'VXI', 'VWSLL', { extension: ZVBB, ...WIDENING }],
];

const OPM_ROWS: VectorRow[] = [
  [0b000000, 'V', 'VREDSUM', REDUCTION], [0b000001, 'V', 'VREDAND', REDUCTION], [0b000010, 'V', 'VREDOR', REDUCTION], [0b000011, 'V', 'VREDXOR', REDUCTION],
  [0b000100, 'V', 'VREDMINU', REDUCTION], [0b000101, 'V', 'VREDMIN', REDUCTION], [0b000110, 'V', 'VREDMAXU', REDUCTION], [0b000111, 'V', 'VREDMAX', REDUCTION],
  [0b001000, 'VX', 'VAADDU'], [0b001001, 'VX', 'VAADD'], [0b001010, 'VX', 'VASUBU'], [0b001011, 'VX', 'VASUB'],
  [0b001100, 'VX', 'VCLMUL', { extension: 'Zvbc extension' }], [0b001101, 'VX', 'VCLMULH', { extension: 'Zvbc extension' }],
  [0b001110, 'X', 'VSLIDE1UP', APART], [0b001111, 'X', 'VSLIDE1DOWN'],
  // vcompress and the mask-register logical instructions are unmasked; vm = 0 is reserved (Sections 31.16.5 and 31.15.1).
  [0b010111, 'V', 'VCOMPRESS.VM', { vm: 1, source1: 'mask', apart: 'sources' }],
  [0b011000, 'V', 'VMANDN.MM', MASK_LOGICAL], [0b011001, 'V', 'VMAND.MM', MASK_LOGICAL], [0b011010, 'V', 'VMOR.MM', MASK_LOGICAL],
  [0b011011, 'V', 'VMXOR.MM', MASK_LOGICAL], [0b011100, 'V', 'VMORN.MM', MASK_LOGICAL], [0b011101, 'V', 'VMNAND.MM', MASK_LOGICAL],
  [0b011110, 'V', 'VMNOR.MM', MASK_LOGICAL], [0b011111, 'V', 'VMXNOR.MM', MASK_LOGICAL],
  [0b100000, 'VX', 'VDIVU'], [0b100001, 'VX', 'VDIV'], [0b100010, 'VX', 'VREMU'], [0b100011, 'VX', 'VREM'],
  [0b100100, 'VX', 'VMULHU'], [0b100101, 'VX', 'VMUL'], [0b100110, 'VX', 'VMULHSU'], [0b100111, 'VX', 'VMULH'],
  [0b101001, 'VX', 'VMADD'], [0b101011, 'VX', 'VNMSUB'], [0b101101, 'VX', 'VMACC'], [0b101111, 'VX', 'VNMSAC'],
  [0b110000, 'VX', 'VWADDU', WIDENING], [0b110001, 'VX', 'VWADD', WIDENING], [0b110010, 'VX', 'VWSUBU', WIDENING], [0b110011, 'VX', 'VWSUB', WIDENING],
  [0b110100, 'VX', 'VWADDU.W', WIDENING_W], [0b110101, 'VX', 'VWADD.W', WIDENING_W], [0b110110, 'VX', 'VWSUBU.W', WIDENING_W], [0b110111, 'VX', 'VWSUB.W', WIDENING_W],
  [0b111000, 'VX', 'VWMULU', WIDENING], [0b111010, 'VX', 'VWMULSU', WIDENING], [0b111011, 'VX', 'VWMUL', WIDENING],
  [0b111100, 'VX', 'VWMACCU', WIDENING], [0b111101, 'VX', 'VWMACC', WIDENING], [0b111110, 'X', 'VWMACCUS', WIDENING], [0b111111, 'VX', 'VWMACCSU', WIDENING],
];

const OPF_ROWS: VectorRow[] = [
  [0b000000, 'VF', 'VFADD'], [0b000001, 'V', 'VFREDUSUM', REDUCTION], [0b000010, 'VF', 'VFSUB'], [0b000011, 'V', 'VFREDOSUM', REDUCTION],
  [0b000100, 'VF', 'VFMIN'], [0b000101, 'V', 'VFREDMIN', REDUCTION], [0b000110, 'VF', 'VFMAX'], [0b000111, 'V', 'VFREDMAX', REDUCTION],
  [0b001000, 'VF', 'VFSGNJ'], [0b001001, 'VF', 'VFSGNJN'], [0b001010, 'VF', 'VFSGNJX'],
  [0b001110, 'F', 'VFSLIDE1UP', APART], [0b001111, 'F', 'VFSLIDE1DOWN'],
  [0b011000, 'VF', 'VMFEQ', MASK_RESULT], [0b011001, 'VF', 'VMFLE', MASK_RESULT], [0b011011, 'VF', 'VMFLT', MASK_RESULT], [0b011100, 'VF', 'VMFNE', MASK_RESULT],
  [0b011101, 'F', 'VMFGT', MASK_RESULT], [0b011111, 'F', 'VMFGE', MASK_RESULT],
  [0b100000, 'VF', 'VFDIV'], [0b100001, 'F', 'VFRDIV'], [0b100100, 'VF', 'VFMUL'], [0b100111, 'F', 'VFRSUB'],
  [0b101000, 'VF', 'VFMADD'], [0b101001, 'VF', 'VFNMADD'], [0b101010, 'VF', 'VFMSUB'], [0b101011, 'VF', 'VFNMSUB'],
  [0b101100, 'VF', 'VFMACC'], [0b101101, 'VF', 'VFNMACC'], [0b101110, 'VF', 'VFMSAC'], [0b101111, 'VF', 'VFNMSAC'],
  [0b110000, 'VF', 'VFWADD', WIDENING], [0b110001, 'V', 'VFWREDUSUM', WIDENING_REDUCTION], [0b110010, 'VF', 'VFWSUB', WIDENING], [0b110011, 'V', 'VFWREDOSUM', WIDENING_REDUCTION],
  [0b110100, 'VF', 'VFWADD.W', WIDENING_W], [0b110110, 'VF', 'VFWSUB.W', WIDENING_W], [0b111000, 'VF', 'VFWMUL', WIDENING],
  [0b111011, 'VF', 'VFWMACCBF16', { extension: 'Zvfbfwma extension', ...WIDENING }],
  [0b111100, 'VF', 'VFWMACC', WIDENING], [0b111101, 'VF', 'VFWNMACC', WIDENING], [0b111110, 'VF', 'VFWMSAC', WIDENING], [0b111111, 'VF', 'VFWNMSAC', WIDENING],
];

/** OP-V encodings other than the configuration-setting instructions, by funct3 and funct6. */
const OP_V = new Map<number, VectorCell>();
for (const [rows, forms] of [
  [OPI_ROWS, { V: OPIVV, X: OPIVX, I: OPIVI }],
  [OPM_ROWS, { V: OPMVV, X: OPMVX }],
  [OPF_ROWS, { V: OPFVV, F: OPFVF }],
] as [VectorRow[], Record<string, number>][]) {
  for (const [funct6, letters, mnemonic, more] of rows) {
    for (const letter of letters) OP_V.set(cellKey(forms[letter]!, funct6), { mnemonic, extension: V_EXT, ...more });
  }
}
// vror.vi takes bit 26 as bit 5 of its shift amount, so it occupies funct6 010100 and 010101 (Section 33.3.20).
OP_V.set(cellKey(OPIVI, 0b010101), { mnemonic: 'VROR', extension: ZVKB });
// vmerge and vfmerge are encoded masked; vmv.v and vfmv.v.f unmasked with vs2 = v0 (Sections 31.11.15, 31.11.16, 31.13.15, and 31.13.16).
for (const [funct3, form] of [[OPIVV, 'V'], [OPIVX, 'X'], [OPIVI, 'I']] as const) {
  OP_V.set(cellKey(funct3, 0b010111), selectBy('vmerge and vmv', 'vm', [[0, `VMERGE.V${form}M`], [1, `VMV.V.${form}`, { vs2: 0 }]]));
}
OP_V.set(cellKey(OPFVF, 0b010111), selectBy('vfmerge and vfmv', 'vm', [[0, 'VFMERGE.VFM'], [1, 'VFMV.V.F', { vs2: 0 }]]));
// The whole-register moves share funct6 with vsmul: simm[4:0] is the number of registers less one, vm = 1, and the
// numbers of both registers are multiples of the number of registers (Section 31.16.6).
OP_V.set(cellKey(OPIVI, 0b100111), selectBy('whole-register move', 'vs1', [
  [0, 'VMV1R.V', { vm: 1 }], [1, 'VMV2R.V', { vm: 1, registers: 2 }], [3, 'VMV4R.V', { vm: 1, registers: 4 }],
  [7, 'VMV8R.V', { vm: 1, registers: 8 }],
]));
// Unary groups (Tables 61 to 68 and 71, and Section 25.5); the scalar moves are unmasked (Sections 31.16.1 and 31.16.2).
// vmv.x.s, vcpop.m, vfirst.m, and vfmv.f.s write an integer or floating-point register.
OP_V.set(cellKey(OPMVV, 0b010000), selectBy('VWXUNARY0', 'vs1', [
  [0b00000, 'VMV.X.S', { vm: 1, result: 'other' }], [0b10000, 'VCPOP.M', { result: 'other', source2: 'mask' }],
  [0b10001, 'VFIRST.M', { result: 'other', source2: 'mask' }],
]));
OP_V.set(cellKey(OPMVX, 0b010000), selectBy('VRXUNARY0', 'vs2', [[0b00000, 'VMV.S.X', { vm: 1 }]]));
// The integer extensions read elements of a fraction of SEW (Section 31.11.3).
const EXTENSION_SOURCE: Partial<VectorEncoding> = { source2: 'fraction' };
OP_V.set(cellKey(OPMVV, 0b010010), selectBy('VXUNARY0', 'vs1', [
  [0b00010, 'VZEXT.VF8', EXTENSION_SOURCE], [0b00011, 'VSEXT.VF8', EXTENSION_SOURCE], [0b00100, 'VZEXT.VF4', EXTENSION_SOURCE],
  [0b00101, 'VSEXT.VF4', EXTENSION_SOURCE], [0b00110, 'VZEXT.VF2', EXTENSION_SOURCE], [0b00111, 'VSEXT.VF2', EXTENSION_SOURCE],
  [0b01000, 'VBREV8.V', { extension: ZVKB }], [0b01001, 'VREV8.V', { extension: ZVKB }],
  [0b01010, 'VBREV.V', { extension: ZVBB }], [0b01100, 'VCLZ.V', { extension: ZVBB }], [0b01101, 'VCTZ.V', { extension: ZVBB }],
  [0b01110, 'VCPOP.V', { extension: ZVBB }],
]));
// vmsbf.m, vmsif.m, and vmsof.m write a mask that may overlap neither the source mask nor, when masked, v0
// (Sections 31.15.4 to 31.15.6); viota.m reads a mask (Section 31.15.8); vid.v requires vs2 = v0 (Section 31.15.9).
const SET_FIRST: Partial<VectorEncoding> = { result: 'mask', source2: 'mask', apart: 'vs2' };
OP_V.set(cellKey(OPMVV, 0b010100), selectBy('VMUNARY0', 'vs1', [
  [0b00001, 'VMSBF.M', SET_FIRST], [0b00010, 'VMSOF.M', SET_FIRST], [0b00011, 'VMSIF.M', SET_FIRST],
  [0b10000, 'VIOTA.M', { source2: 'mask' }], [0b10001, 'VID.V', { vs2: 0 }],
]));
OP_V.set(cellKey(OPFVV, 0b010000), selectBy('VWFUNARY0', 'vs1', [[0b00000, 'VFMV.F.S', { vm: 1, result: 'other' }]]));
OP_V.set(cellKey(OPFVF, 0b010000), selectBy('VRFUNARY0', 'vs2', [[0b00000, 'VFMV.S.F', { vm: 1 }]]));
OP_V.set(cellKey(OPFVV, 0b010010), selectBy('VFUNARY0', 'vs1', [
  [0b00000, 'VFCVT.XU.F.V'], [0b00001, 'VFCVT.X.F.V'], [0b00010, 'VFCVT.F.XU.V'], [0b00011, 'VFCVT.F.X.V'],
  [0b00110, 'VFCVT.RTZ.XU.F.V'], [0b00111, 'VFCVT.RTZ.X.F.V'], [0b01000, 'VFWCVT.XU.F.V', WIDENING], [0b01001, 'VFWCVT.X.F.V', WIDENING],
  [0b01010, 'VFWCVT.F.XU.V', WIDENING], [0b01011, 'VFWCVT.F.X.V', WIDENING], [0b01100, 'VFWCVT.F.F.V', WIDENING],
  [0b01101, 'VFWCVTBF16.F.F.V', { extension: ZVFBFMIN, ...WIDENING }], [0b01110, 'VFWCVT.RTZ.XU.F.V', WIDENING], [0b01111, 'VFWCVT.RTZ.X.F.V', WIDENING],
  [0b10000, 'VFNCVT.XU.F.W', NARROWING], [0b10001, 'VFNCVT.X.F.W', NARROWING], [0b10010, 'VFNCVT.F.XU.W', NARROWING], [0b10011, 'VFNCVT.F.X.W', NARROWING],
  [0b10100, 'VFNCVT.F.F.W', NARROWING], [0b10101, 'VFNCVT.ROD.F.F.W', NARROWING], [0b10110, 'VFNCVT.RTZ.XU.F.W', NARROWING], [0b10111, 'VFNCVT.RTZ.X.F.W', NARROWING],
  [0b11101, 'VFNCVTBF16.F.F.W', { extension: ZVFBFMIN, ...NARROWING }],
]));
OP_V.set(cellKey(OPFVV, 0b010011), selectBy('VFUNARY1', 'vs1', [
  [0b00000, 'VFSQRT.V'], [0b00100, 'VFRSQRT7.V'], [0b00101, 'VFREC7.V'], [0b10000, 'VFCLASS.V'],
]));

/**
 * OP-VE encodings of the vector cryptography extensions (Section 33.4 and Table 70): all OPMVV and unmasked. The .vi
 * encodings hold an immediate in vs1. The destination may not overlap vs2 in the .vs encodings, vsm3c.vi, and
 * vsm3me.vv, and neither source in vsha2ms.vv, vsha2ch.vv, and vsha2cl.vv (Section 33.1.5).
 */
const unmasked = (mnemonic: string, extension: string, more?: Partial<VectorEncoding>): VectorEncoding => ({ mnemonic, extension, vm: 1, ...more });
const IMMEDIATE: Partial<VectorEncoding> = { source1: 'none' };
const APART_VS2: Partial<VectorEncoding> = { apart: 'vs2' };
const OP_VE = new Map<number, VectorCell>([
  [cellKey(OPMVV, 0b100000), unmasked('VSM3ME.VV', 'Zvksh extension', APART_VS2)],
  [cellKey(OPMVV, 0b100001), unmasked('VSM4K.VI', ZVKSED, IMMEDIATE)],
  [cellKey(OPMVV, 0b100010), unmasked('VAESKF1.VI', ZVKNED, IMMEDIATE)],
  [cellKey(OPMVV, 0b101000), { group: 'VAES.vv', field: 'vs1', entries: new Map([
    [0b00000, unmasked('VAESDM.VV', ZVKNED)], [0b00001, unmasked('VAESDF.VV', ZVKNED)], [0b00010, unmasked('VAESEM.VV', ZVKNED)],
    [0b00011, unmasked('VAESEF.VV', ZVKNED)], [0b10000, unmasked('VSM4R.VV', ZVKSED)], [0b10001, unmasked('VGMUL.VV', 'Zvkg extension')],
  ]) }],
  [cellKey(OPMVV, 0b101001), { group: 'VAES.vs', field: 'vs1', entries: new Map([
    [0b00000, unmasked('VAESDM.VS', ZVKNED, APART_VS2)], [0b00001, unmasked('VAESDF.VS', ZVKNED, APART_VS2)], [0b00010, unmasked('VAESEM.VS', ZVKNED, APART_VS2)],
    [0b00011, unmasked('VAESEF.VS', ZVKNED, APART_VS2)], [0b00111, unmasked('VAESZ.VS', ZVKNED, APART_VS2)], [0b10000, unmasked('VSM4R.VS', ZVKSED, APART_VS2)],
  ]) }],
  [cellKey(OPMVV, 0b101010), unmasked('VAESKF2.VI', ZVKNED, IMMEDIATE)],
  [cellKey(OPMVV, 0b101011), unmasked('VSM3C.VI', 'Zvksh extension', { ...IMMEDIATE, ...APART_VS2 })],
  [cellKey(OPMVV, 0b101100), unmasked('VGHSH.VV', 'Zvkg extension')],
  [cellKey(OPMVV, 0b101101), unmasked('VSHA2MS.VV', 'Zvknha and Zvknhb extensions', APART)],
  [cellKey(OPMVV, 0b101110), unmasked('VSHA2CH.VV', 'Zvknha and Zvknhb extensions', APART)],
  [cellKey(OPMVV, 0b101111), unmasked('VSHA2CL.VV', 'Zvknha and Zvknhb extensions', APART)],
]);

/** Addressing modes of vector loads and stores, indexed by mop (manual Tables 50 and 51). */
const VECTOR_MODE = ['unit-stride', 'indexed-unordered', 'strided', 'indexed-ordered'];

const unsupported = (text: string): RawError => ({ kind: 'unsupported', message: `${text}, outside the profile` });
const invalid = (message: string): RawError => ({ kind: 'invalid', message });

/** Classification of a 16-bit parcel whose two low bits are not 11, or null when the bits mark a longer encoding. */
function classifyParcel(parcel: number): RawError | null {
  // Manual Section 1.5: an encoding whose bits [15:0] are all zero is an illegal instruction in every configuration.
  if ((parcel & 0xffff) === 0) return invalid('bits [15:0] are all zero, which RISC-V defines as an illegal instruction');
  if ((parcel & 3) !== 3) {
    return { kind: 'unsupported', message: 'the two low bits are not 11, which marks a 16-bit compressed encoding (C extension); the profile has no compressed instructions' };
  }
  return null;
}

/** True when the first width exceeds the second under every vtype setting. */
const wider = (a: Width, b: Width): boolean => (WIDTH_RANK[a] ?? NaN) > (WIDTH_RANK[b] ?? NaN);
/** True when the two widths differ under every vtype setting. */
const differ = (a: Width, b: Width): boolean => wider(a, b) || wider(b, a);

/**
 * The reason why the register numbers of a vector arithmetic word make it a reserved encoding under every vtype
 * setting, or null. `sources` holds the name, number, and element width of each vector source register. The rules
 * are those of manual Sections 31.5.2 and 31.5.3 and of the sections on single instructions: a register group whose
 * size the encoding fixes starts at a multiple of that size; a masked instruction does not write a vector over the
 * mask register v0; the destination equals a source only when its elements are not wider and the instruction does
 * not forbid the overlap; and no register is read with two element widths, where the mask register of a masked
 * instruction counts as a source of one-bit elements.
 */
function reservedRegisters(enc: VectorEncoding, vd: number, vm: number, sources: [name: string, number: number, width: Width][]): string | null {
  const result = enc.result ?? 'sew';
  const size = enc.registers;
  if (size !== undefined && (vd % size !== 0 || sources.some(([, number]) => number % size !== 0))) {
    return `the register numbers must be multiples of ${size}`;
  }
  if (result !== 'scalar' && result !== 'other') {
    if (vm === 0 && vd === 0 && (result !== 'mask' || enc.apart !== undefined)) {
      return 'with vm = 0 and vd = v0, the destination overlaps the mask register';
    }
    for (const [name, number, width] of sources) {
      const apart = enc.apart === 'sources' || (enc.apart === 'vs2' && name === 'vs2');
      if (number === vd && (apart || wider(result, width))) return `with vd equal to ${name}, the destination overlaps a source that it may not overlap`;
    }
  }
  for (const [name, number, width] of sources) {
    if (vm === 0 && number === 0 && width !== 'mask') return `with vm = 0 and ${name} = v0, the mask register is read with two element widths`;
  }
  const [first, second] = sources;
  if (first && second && first[1] === second[1] && differ(first[2], second[2])) return 'with vs1 equal to vs2, the register is read with two element widths';
  return null;
}

/**
 * Classification of an OP-V or OP-VE word by its funct3 and funct6 cell, the sub-opcode field that selects an
 * instruction within the cell, the values of vm and vs2 that the instruction requires, and the register numbers
 * that the manual reserves for it under every vtype setting.
 */
function classifyVector(word: number, cells: Map<number, VectorCell>, opcode: string, family: string): RawError {
  const funct3 = (word >>> 12) & 7;
  const funct6 = word >>> 26;
  const fields = { vs1: (word >>> 15) & 31, vs2: (word >>> 20) & 31, vm: (word >>> 25) & 1 };
  const cell = cells.get(cellKey(funct3, funct6));
  if (!cell) {
    const category = funct3 < VECTOR_CATEGORY.length ? ` (${VECTOR_CATEGORY[funct3]})` : '';
    return invalid(`reserved ${opcode} encoding: funct6 ${binary(funct6, 6)} with funct3 ${binary(funct3, 3)}${category}`);
  }
  let enc: VectorEncoding | undefined;
  const selector = 'group' in cell ? cell.field : null;
  if ('group' in cell) {
    enc = cell.entries.get(fields[cell.field]);
    if (!enc) return invalid(`reserved ${opcode} encoding: ${cell.field} = ${binary(fields[cell.field], 5)} in the ${cell.group} group`);
  } else {
    enc = cell;
  }
  if (enc.vm !== undefined && fields.vm !== enc.vm) return invalid(`${enc.mnemonic} is defined only with vm = ${enc.vm}`);
  if (enc.vs2 !== undefined && fields.vs2 !== enc.vs2) return invalid(`${enc.mnemonic} is defined only with vs2 = ${binary(enc.vs2, 5)}`);
  // vs2 is a vector source unless the encoding fixes it or it selects the instruction; vs1 is one in the
  // vector-vector categories unless it selects the instruction or holds an immediate.
  const sources: [string, number, Width][] = [];
  if (enc.vs2 === undefined && selector !== 'vs2') sources.push(['vs2', fields.vs2, enc.source2 ?? 'sew']);
  const source1 = (funct3 === OPIVV || funct3 === OPFVV || funct3 === OPMVV) && selector !== 'vs1' ? enc.source1 ?? 'sew' : 'none';
  if (source1 !== 'none') sources.push(['vs1', fields.vs1, source1]);
  const reserved = reservedRegisters(enc, (word >>> 7) & 31, fields.vm, sources);
  if (reserved !== null) return invalid(`reserved ${enc.mnemonic} encoding: ${reserved}`);
  return unsupported(named(enc.mnemonic, family, enc.extension));
}

/**
 * Classification of a LOAD-FP or STORE-FP word with a vector width (manual Section 31.7). In the unit-stride mode the
 * lumop or sumop field selects the variant (Tables 52 and 53). Whole-register transfers are unmasked and move 1, 2,
 * 4, or 8 registers starting at a multiple of that number; whole-register stores and the mask transfers VLM.V and
 * VSM.V use width 000 (Sections 31.7.4 and 31.7.9), and the mask transfers have one field. Indexed transfers with
 * 64-bit indices exist only in RV64 (Section 31.18.3). The register numbers that are reserved under every vtype
 * setting are rejected: v0 as the destination of a masked load (Section 31.5.3); v0 as the data register of a masked
 * store or as the index register of a masked indexed transfer, which would be read with two element widths
 * (Section 31.5.2); the fields of a segment passing v31; and the index register of an indexed segment load among
 * the destination registers (Section 31.7.8).
 */
function classifyVectorMemory(word: number, load: boolean): RawError {
  const access = load ? 'load' : 'store';
  if ((word >>> 28) & 1) return invalid(`reserved vector ${access} width (mew = 1)`);
  const mop = (word >>> 26) & 3;
  const width = (word >>> 12) & 7;
  const nf = word >>> 29;
  const vm = (word >>> 25) & 1;
  // Bits 11:7 hold vd of a load or vs3 of a store; bits 24:20 hold lumop or sumop, the stride register, or vs2.
  const data = (word >>> 7) & 31;
  const dataName = load ? 'vd' : 'vs3';
  const umop = (word >>> 20) & 31;
  const indexed = (mop & 1) === 1;
  let name = `vector ${VECTOR_MODE[mop]} ${access} of the V extension`;
  if (indexed && width === 0b111) name = `vector ${VECTOR_MODE[mop]} ${access} with 64-bit indices, which the V extension supports only in RV64`;
  if (mop === 0) {
    const fields = `vm = ${vm}, nf = ${binary(nf, 3)}, and width ${binary(width, 3)}`;
    if (umop === 0b01000) {
      if (vm !== 1 || ![0b000, 0b001, 0b011, 0b111].includes(nf) || !(load || width === 0)) {
        return invalid(`whole-register ${access} with ${fields}; it is defined only with vm = 1, nf = 000, 001, 011, or 111${load ? '' : ', and width 000'}`);
      }
      if (data % (nf + 1) !== 0) {
        return invalid(`reserved whole-register ${access}: ${nf + 1} registers from ${dataName} = v${data}, which is not a multiple of ${nf + 1}`);
      }
      return unsupported(`vector whole-register ${access} of the V extension`);
    }
    if (umop === 0b01011) {
      if (vm === 1 && nf === 0 && width === 0) return unsupported(named(load ? 'VLM.V' : 'VSM.V', `vector mask ${access}`, V_EXT));
      return invalid(`mask ${access} with ${fields}; it is defined only with vm = 1, nf = 000, and width 000`);
    }
    if (umop === 0b10000 && load) name = 'vector unit-stride fault-only-first load of the V extension';
    else if (umop !== 0b00000) return invalid(`reserved ${load ? 'lumop' : 'sumop'} ${binary(umop, 5)} in a vector unit-stride ${access}`);
  }
  if (vm === 0 && data === 0) {
    return invalid(load ? 'reserved masked vector load: with vm = 0 and vd = v0, the destination overlaps the mask register'
      : 'reserved masked vector store: with vm = 0 and vs3 = v0, the mask register is read with two element widths');
  }
  if (vm === 0 && indexed && umop === 0) {
    return invalid(`reserved masked vector indexed ${access}: with vm = 0 and vs2 = v0, the mask register is read with two element widths`);
  }
  if (data + nf > 31) return invalid(`reserved vector segment ${access}: ${nf + 1} fields from ${dataName} = v${data} pass v31`);
  if (load && indexed && nf > 0 && umop >= data && umop <= data + nf) {
    return invalid(`reserved vector indexed segment load: ${nf + 1} fields from vd = v${data} overlap the index register vs2 = v${umop}`);
  }
  return unsupported(name);
}

/**
 * Classification of a word that is not an implemented RV32I instruction. A word that encodes an instruction of a
 * ratified extension, of RV64, or of the part of RV32I that the profile leaves out is unsupported, with the
 * instruction or its family and its extension named; any other word is invalid. Shift-immediate encodings with
 * imm[5] = 1 are invalid because RV32 reserves them, although RV64 uses them for shift amounts of 32 to 63 and for
 * its form of REV8.
 *
 * The OP, OP-IMM, LOAD, STORE, BRANCH, JALR, MISC-MEM, OP-V, and OP-VE major opcodes, the LOAD-FP and STORE-FP
 * widths, and the SYSTEM encodings with funct3 100 are examined field by field. In the AMO, OP-32, OP-IMM-32, and
 * floating-point computational major opcodes and among the SYSTEM encodings with funct3 000, every word is reported
 * as unsupported without examining whether that particular word is assigned. Vector encodings that the manual
 * reserves by their register numbers under every vtype setting are invalid. Reservations that depend on the vtype
 * setting (the alignment and overlap of register groups for the selected LMUL, element widths that an instruction
 * or the implementation does not support, and vill) are not examined.
 */
function classifyOther(word: number): RawError {
  const parcel = classifyParcel(word);
  if (parcel !== null) return parcel;
  const opcode = word & 0x7f;
  const rd = (word >>> 7) & 31;
  const funct3 = (word >>> 12) & 7;
  const rs2 = (word >>> 20) & 31;
  const funct7 = word >>> 25;
  const imm12 = word >>> 20;
  const reservedFunct3 = (): RawError => invalid(`reserved funct3 ${binary(funct3, 3)} for this opcode`);
  switch (opcode) {
    case OPCODE.OP:
    case OPCODE.OP_IMM: {
      if (opcode === OPCODE.OP && funct7 === 0b0000001) {
        return { kind: 'unsupported', message: 'multiply and divide encoding of the M extension; RV32I has no multiply or divide instruction' };
      }
      const known = EXTENSION_ENCODINGS.find((x) => ((word & x.mask) >>> 0) === x.match);
      if (known) return unsupported(known.text);
      if (opcode === OPCODE.OP) return invalid(`reserved register-register encoding: funct7 ${binary(funct7, 7)} with funct3 ${binary(funct3, 3)}`);
      // Of OP-IMM, only the shift-immediate group (funct3 001 and 101) has encodings outside RV32I.
      if (funct7 & 1) return invalid('shift-immediate encoding with imm[5] = 1, which is reserved in RV32');
      return invalid(`reserved shift-immediate encoding: imm[11:5] = ${binary(funct7, 7)}, imm[4:0] = ${binary(rs2, 5)}`);
    }
    case OPCODE.LOAD:
      if (funct3 === 0b011) return unsupported('LD, doubleword load of RV64I and, with an even destination register, of the Zilsd extension for RV32');
      if (funct3 === 0b110) return unsupported('LWU, a load that exists only in RV64I');
      return reservedFunct3();
    case OPCODE.STORE:
      if (funct3 === 0b011) return unsupported('SD, doubleword store of RV64I and, with an even source register, of the Zilsd extension for RV32');
      return reservedFunct3();
    case OPCODE.JALR:
    case OPCODE.BRANCH:
      return reservedFunct3();
    case OPCODE.MISC_MEM: {
      if (funct3 === 0b000) return { kind: 'unsupported', message: 'FENCE is defined by RV32I but is not implemented by this simulator' };
      if (funct3 === 0b001) return unsupported(named('FENCE.I', 'instruction-fetch fence', 'Zifencei extension'));
      if (funct3 !== 0b010) return reservedFunct3();
      const cbo = rd === 0 ? CBO.get(imm12) : undefined;
      return cbo ? unsupported(cbo) : invalid('reserved encoding in the cache-block operation group (MISC-MEM funct3 010)');
    }
    case OPCODE.SYSTEM: {
      if (funct3 === 0b000) {
        if (word === 0x00100073) return { kind: 'unsupported', message: 'EBREAK is defined by RV32I but is not implemented by this simulator' };
        if (word === 0x00d00073) return unsupported(named('WRS.NTO', 'wait-on-reservation-set instruction', 'Zawrs extension'));
        if (word === 0x01d00073) return unsupported(named('WRS.STO', 'wait-on-reservation-set instruction', 'Zawrs extension'));
        return { kind: 'unsupported', message: 'privileged or system instruction, outside the profile' };
      }
      if (funct3 !== 0b100) return unsupported('control and status register instruction (Zicsr extension)');
      // Manual Chapter 10: bit 31 is 1 and bits 29:28 are 00; MOP.RR.n has bit 25 = 1, MOP.R.n has bits 25:22 = 0111.
      const bit25 = (word >>> 25) & 1;
      if ((word >>> 31) === 1 && ((word >>> 28) & 3) === 0 && (bit25 === 1 || ((word >>> 22) & 0xf) === 0b0111)) {
        return unsupported(named(bit25 === 1 ? 'MOP.RR.n' : 'MOP.R.n', 'may-be-operation', 'Zimop extension'));
      }
      if (HYPERVISOR_LOAD_RS2.get(funct7)?.includes(rs2)) {
        return unsupported(named('HLV or HLVX', 'hypervisor virtual-machine load', 'H extension of the privileged architecture'));
      }
      if (HYPERVISOR_STORE_FUNCT7.includes(funct7) && rd === 0) {
        return unsupported(named('HSV', 'hypervisor virtual-machine store', 'H extension of the privileged architecture'));
      }
      return invalid('reserved encoding with funct3 100 in the SYSTEM opcode');
    }
    case OPCODE.AMO:
      return unsupported('atomic memory instruction (AMO major opcode of the A, Zacas, Zabha, Zalasr, and Zicfiss extensions)');
    case OPCODE.LOAD_FP:
    case OPCODE.STORE_FP: {
      // funct3 is the width: 001 to 100 are the scalar floating-point widths, the other values vector element widths.
      const load = opcode === OPCODE.LOAD_FP;
      const scalar = FP_TRANSFER.get(funct3);
      if (scalar) return unsupported(named(load ? scalar[0] : scalar[1], `${scalar[2]} floating-point ${load ? 'load' : 'store'}`, scalar[3]));
      return classifyVectorMemory(word, load);
    }
    case OPCODE.OP_FP:
    case OPCODE.MADD:
    case OPCODE.MSUB:
    case OPCODE.NMSUB:
    case OPCODE.NMADD:
      return unsupported('floating-point computational instruction of the F, D, Q, or Zfh extension or a related extension');
    case OPCODE.OP_32:
    case OPCODE.OP_IMM_32:
      return { kind: 'unsupported', message: 'word-sized instruction that exists only in RV64, outside the RV32I profile' };
    case OPCODE.OP_V: {
      if (funct3 !== 0b111) return classifyVector(word, OP_V, 'OP-V', 'vector instruction');
      // Configuration-setting instructions (Section 31.6): vsetvli has bit 31 = 0, vsetivli bits 31:30 = 11, and vsetvl bits 31:25 = 1000000.
      const config = (word >>> 31) === 0 ? 'VSETVLI' : (word >>> 30) === 0b11 ? 'VSETIVLI' : funct7 === 0b1000000 ? 'VSETVL' : null;
      if (config) return unsupported(named(config, 'vector instruction', V_EXT));
      return invalid(`reserved OP-V encoding in the OPCFG category (funct3 111): bits 31:25 are ${binary(funct7, 7)}`);
    }
    case OPCODE.OP_VE:
      return classifyVector(word, OP_VE, 'OP-VE', 'vector cryptography instruction');
  }
  return invalid('not an RV32I base instruction encoding');
}

export function decodeWord(word: number): Raw | RawError {
  const opcode = word & 0x7f;
  const rd = (word >>> 7) & 31;
  const funct3 = (word >>> 12) & 7;
  const rs1 = (word >>> 15) & 31;
  const rs2 = (word >>> 20) & 31;
  const funct7 = word >>> 25;
  const candidates = BY_OPCODE.get(opcode);
  if (!candidates) return classifyOther(word);
  for (const enc of candidates) {
    switch (enc.format) {
      case 'U':
        return { enc, rd, rs1: 0, rs2: 0, imm: word >>> 12 };
      case 'J': {
        const v = (((word >>> 31) & 1) << 20) | (((word >>> 12) & 0xff) << 12) | (((word >>> 20) & 1) << 11) | (((word >>> 21) & 0x3ff) << 1);
        return { enc, rd, rs1: 0, rs2: 0, imm: signExtend(v, 21) };
      }
      case 'B': {
        if (enc.funct3 !== funct3) continue;
        const v = (((word >>> 31) & 1) << 12) | (((word >>> 7) & 1) << 11) | (((word >>> 25) & 0x3f) << 5) | (((word >>> 8) & 0xf) << 1);
        return { enc, rd: 0, rs1, rs2, imm: signExtend(v, 13) };
      }
      case 'S':
        if (enc.funct3 !== funct3) continue;
        return { enc, rd: 0, rs1, rs2, imm: signExtend((funct7 << 5) | rd, 12) };
      case 'I':
      case 'L':
      case 'JR':
        if (enc.funct3 !== funct3) continue;
        return { enc, rd, rs1, rs2: 0, imm: signExtend(word >>> 20, 12) };
      case 'SH':
        if (enc.funct3 !== funct3) continue;
        if (enc.funct7 !== funct7) continue;
        return { enc, rd, rs1, rs2: 0, imm: rs2 };
      case 'R':
        if (enc.funct3 !== funct3 || enc.funct7 !== funct7) continue;
        return { enc, rd, rs1, rs2, imm: 0 };
      case 'SYS':
        if (word !== enc.opcode) continue;
        return { enc, rd: 0, rs1: 0, rs2: 0, imm: 0 };
    }
  }
  return classifyOther(word);
}

/** Assembly-level instruction for a decoded word at address `pc`. */
export function toInsn(raw: Raw, pc: number): Insn {
  const r = (n: number) => ({ t: 'reg' as const, name: REG_NAMES[n]! });
  const m = raw.enc.mnemonic;
  switch (raw.enc.format) {
    case 'R':
      return { mnemonic: m, operands: [r(raw.rd), r(raw.rs1), r(raw.rs2)] };
    case 'I':
    case 'SH':
      return { mnemonic: m, operands: [r(raw.rd), r(raw.rs1), { t: 'imm', value: raw.imm }] };
    case 'L':
    case 'JR':
      return { mnemonic: m, operands: [r(raw.rd), { t: 'mem', base: REG_NAMES[raw.rs1]!, disp: raw.imm }] };
    case 'S':
      return { mnemonic: m, operands: [r(raw.rs2), { t: 'mem', base: REG_NAMES[raw.rs1]!, disp: raw.imm }] };
    case 'B':
      return { mnemonic: m, operands: [r(raw.rs1), r(raw.rs2), { t: 'addr', value: (pc + raw.imm) >>> 0 }] };
    case 'U':
      return { mnemonic: m, operands: [r(raw.rd), { t: 'imm', value: raw.imm }] };
    case 'J':
      return { mnemonic: m, operands: [r(raw.rd), { t: 'addr', value: (pc + raw.imm) >>> 0 }] };
    case 'SYS':
      return { mnemonic: m, operands: [] };
  }
}

function bitFields(word: number, raw: Raw, pc: number): BitField[] {
  const f = (name: string, hi: number, lo: number, text: string): BitField => ({
    name, hi, lo, value: (word >>> lo) & (2 ** (hi - lo + 1) - 1), text,
  });
  const regText = (n: number) => `${REG_NAMES[n]} (x${n})`;
  const opcode = f('opcode', 6, 0, raw.enc.mnemonic);
  const rd = f('rd', 11, 7, regText(raw.rd));
  const funct3 = f('funct3', 14, 12, 'selects the operation');
  const rs1 = f('rs1', 19, 15, regText(raw.rs1));
  const rs2 = f('rs2', 24, 20, regText(raw.rs2));
  switch (raw.enc.format) {
    case 'R':
      return [f('funct7', 31, 25, 'selects the operation'), rs2, rs1, funct3, rd, opcode];
    case 'I':
    case 'L':
    case 'JR':
      return [f('imm[11:0]', 31, 20, `${raw.imm} (sign-extended)`), rs1, funct3, rd, opcode];
    case 'SH':
      return [f('funct7', 31, 25, 'selects logical or arithmetic'), f('shamt', 24, 20, `shift by ${raw.imm}`), rs1, funct3, rd, opcode];
    case 'S':
      return [f('imm[11:5]', 31, 25, `offset ${raw.imm}, upper part`), rs2, rs1, funct3, f('imm[4:0]', 11, 7, 'offset, lower part'), opcode];
    case 'B':
      return [
        f('imm[12|10:5]', 31, 25, `offset ${raw.imm}, upper part`), rs2, rs1, funct3,
        f('imm[4:1|11]', 11, 7, `target ${hex((pc + raw.imm) >>> 0)}`), opcode,
      ];
    case 'U':
      return [f('imm[31:12]', 31, 12, `${hex(raw.imm << 12)} after the shift by 12`), rd, opcode];
    case 'J':
      return [f('imm[20|10:1|11|19:12]', 31, 12, `offset ${raw.imm}, target ${hex((pc + raw.imm) >>> 0)}`), rd, opcode];
    case 'SYS':
      return [f('funct12', 31, 20, 'environment call'), rs1, funct3, rd, opcode];
  }
}

export function decode(bytes: Uint8Array, offset: number, pc: number): DecodeResult {
  const available = bytes.length - offset;
  if (available < 4) {
    // A first parcel whose two low bits are not 11 is a complete 16-bit encoding. The all-zero parcel is the
    // illegal instruction, which is 32 bits long when no 16-bit extension is present (manual Section 1.5), so
    // fewer than four of its bytes are truncated like any other 32-bit instruction.
    if (available >= 2) {
      const parcel = bytes[offset]! | (bytes[offset + 1]! << 8);
      const short = parcel === 0 ? null : classifyParcel(parcel);
      if (short !== null) return { ok: false, kind: short.kind, message: `${hex(parcel, 4)}: ${short.message}`, length: 2 };
    }
    return { ok: false, kind: 'truncated', message: `an RV32I instruction is 4 bytes; only ${Math.max(available, 0)} available`, length: Math.max(available, 0) };
  }
  const word = bytesToWordLE(bytes, offset);
  const raw = decodeWord(word);
  if ('kind' in raw) return { ok: false, kind: raw.kind, message: `${hex(word)}: ${raw.message}`, length: 4 };
  const insn = toInsn(raw, pc);
  const result: DecodeResult = { ok: true, insn, length: 4, fields: bitFields(word, raw, pc) };
  const alias = aliasOf(insn);
  if (alias !== null) result.alias = alias;
  return result;
}
