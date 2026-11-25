/**
 * Helper of the validation harness. For byte sequences that this tool's
 * decoder rejects but the reference disassembler decodes, it assembles the
 * reference disassembler's text with this tool's assembler. When the result is
 * the same bytes, the encoder produces an encoding that the decoder rejects,
 * which is a defect.
 *
 * A numeric branch or jump target is an absolute address and is encoded in the
 * form that reaches any target. When the target is a label instead, the
 * assembler driver chooses the short form of a relaxable instruction whenever
 * it reaches, so that short form is tried as well.
 *
 *   node scripts/reencode.ts <input.json> <output.json>
 *
 * Input:  { "target": "<id>", "cases": [ { "pc": <address>, "text": "<assembly>", "bytes": "<hex>" } ] }
 * Output: { "results": [ { "reproduced": <boolean>, "error": "<message or empty>" } ] }
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { assembleText } from '../src/core/target/assemble.ts';
import { getBackend } from '../src/core/target/index.ts';
import type { Backend } from '../src/core/target/types.ts';
import { bytesToHex } from '../src/core/util/int32.ts';

/** Short form of a single relaxable instruction with a numeric target at `pc`, as for a label at that target, or null. */
function shortForm(backend: Backend, text: string, pc: number): Uint8Array | null {
  const parsed = backend.parseLine(text.trim());
  if (!parsed.ok || parsed.items.length !== 1) return null;
  const item = parsed.items[0]!;
  if (item.kind !== 'insn' || !backend.asm.relaxable(item.insn)) return null;
  const k = item.insn.operands.findIndex((o) => o.t === 'addr' && o.label === undefined);
  if (k < 0) return null;
  const target = (item.insn.operands[k] as { value: number }).value;
  if (!backend.asm.shortFits(item.insn, pc, target)) return null;
  const insn = { ...item.insn, operands: item.insn.operands.map((o, i) => (i === k ? { t: 'addr' as const, value: target, label: 'target' } : o)) };
  try {
    return backend.asm.encode(insn, pc, false);
  } catch {
    return null;
  }
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  process.stderr.write('usage: node scripts/reencode.ts <input.json> <output.json>\n');
  process.exit(2);
}
const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { target: string; cases: { pc: number; text: string; bytes: string }[] };
const backend = getBackend(input.target);
const results = input.cases.map((c) => {
  const want = c.bytes.toLowerCase();
  const short = shortForm(backend, c.text, c.pc);
  if (short && bytesToHex(short, '') === want) return { reproduced: true, error: '' };
  const r = assembleText(backend, c.text, c.pc);
  if (!r.ok) return { reproduced: false, error: r.errors[0]?.message ?? 'not assembled' };
  return { reproduced: bytesToHex(r.program.bytes, '') === want, error: '' };
});
writeFileSync(outputPath, JSON.stringify({ results }));
