/**
 * Simplified datapath diagram driven by the events of the last executed
 * instruction. It is an educational execution model with one stage per
 * activity (fetch, decode, operand read, arithmetic, memory access,
 * write-back, next program counter). It does not describe the pipeline or
 * microarchitecture of any commercial processor.
 */
import type { StepEvent } from '../../core/api.ts';
import { bytesText, hex32, hexWide } from './format.ts';

function shortValue(v: bigint): string {
  const s = BigInt.asIntN(64, v);
  if (s >= -9999n && s <= 99999n) return s.toString();
  return '0x' + BigInt.asUintN(64, v).toString(16);
}

/** A code address in 16 hexadecimal digits when the event carries the full 64-bit value, otherwise in 8. */
function codeAddress(low: number, full: bigint | undefined): string {
  return full !== undefined ? hexWide(full, 64) : hex32(low);
}

/**
 * How the instruction left the program counter: `sequential` when the following instruction is
 * next, `redirected` when another address is next, and `unchanged` when the instruction faulted,
 * so that it did not complete and the program counter still holds its address.
 */
export function programCounterUpdate(ev: StepEvent): 'sequential' | 'redirected' | 'unchanged' {
  if (ev.stop?.kind === 'fault') return 'unchanged';
  return ev.nextPc64 === undefined && ev.nextPc === ((ev.pc + ev.length) >>> 0) ? 'sequential' : 'redirected';
}

/** Sentences that describe what the instruction did, in the order of the stages. */
export function describeStep(ev: StepEvent, flagNames: string[]): string[] {
  const out: string[] = [];
  out.push(`Fetch: ${ev.length} byte${ev.length === 1 ? '' : 's'} (${bytesText(ev.bytes)}) were read from address ${hex32(ev.pc)}.`);
  out.push(`Decode: the bytes encode "${ev.text}".${ev.delaySlot ? ' This instruction is in the delay slot of the preceding branch or jump.' : ''}`);
  if (ev.regReads.length > 0) out.push(`Read registers: ${ev.regReads.map((r) => `${r.reg} = ${shortValue(r.value)}`).join(', ')}.`);
  if (ev.alu) out.push(`Compute (${ev.alu.op}): ${shortValue(ev.alu.a)} and ${shortValue(ev.alu.b)} give ${shortValue(ev.alu.result)}.`);
  for (const r of ev.memReads) out.push(`Memory read: ${r.size} byte${r.size === 1 ? '' : 's'} at ${hex32(r.address)} hold ${shortValue(r.value)}.`);
  for (const w of ev.memWrites) out.push(`Memory write: ${shortValue(w.value)} stored in ${w.size} byte${w.size === 1 ? '' : 's'} at ${hex32(w.address)} (was ${shortValue(w.before)}).`);
  if (ev.regWrites.length > 0) out.push(`Write registers: ${ev.regWrites.map((w) => `${w.reg} = ${shortValue(w.value)}`).join(', ')}.`);
  if (ev.flags) {
    const changed = flagNames.filter((f) => ev.flags!.before[f] !== ev.flags!.after[f]);
    out.push(`Flags after the instruction: ${flagNames.map((f) => `${f}=${ev.flags!.after[f]}`).join(' ')}${changed.length > 0 ? ` (changed: ${changed.join(', ')})` : ' (none changed)'}.`);
  }
  if (ev.service) out.push(`Service request: number ${ev.service.number} (${ev.service.name}) with argument ${ev.service.argument}, handled by the execution environment.`);
  if (ev.branch) {
    const target = codeAddress(ev.branch.target, ev.branch.target64);
    out.push(ev.branch.conditional ? `Branch decision: ${ev.branch.taken ? 'taken' : 'not taken'}; target ${target}.` : `Jump to ${target}.`);
  }
  const update = programCounterUpdate(ev);
  out.push(
    update === 'unchanged'
      ? `Next program counter: unchanged at ${hex32(ev.pc)}, because the instruction did not complete.`
      : `Next program counter: ${codeAddress(ev.nextPc, ev.nextPc64)}${update === 'sequential' ? ' (the following instruction)' : ''}.`,
  );
  if (ev.stop?.kind === 'fault') out.push(`Fault: ${ev.stop.message}.`);
  return out;
}

interface BoxProps {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  active: boolean;
}

function Box({ x, y, w, h, title, lines, active }: BoxProps) {
  return (
    <g className={active ? 'dp-box is-active' : 'dp-box'}>
      <rect x={x} y={y} width={w} height={h} rx={4} />
      <text x={x + w / 2} y={y + 16} className="dp-title" textAnchor="middle">{title}</text>
      {lines.slice(0, 4).map((l, i) => (
        <text key={i} x={x + w / 2} y={y + 33 + 13 * i} className="dp-value" textAnchor="middle">{l.length > 22 ? l.slice(0, 21) + '…' : l}</text>
      ))}
    </g>
  );
}

function Wire({ d, active, label, lx, ly }: { d: string; active: boolean; label?: string; lx?: number; ly?: number }) {
  return (
    <g className={active ? 'dp-wire is-active' : 'dp-wire'}>
      <path d={d} markerEnd={active ? 'url(#dp-arrow-active)' : 'url(#dp-arrow)'} />
      {label && lx !== undefined && ly !== undefined && <text x={lx} y={ly} className="dp-wire-label" textAnchor="middle">{label}</text>}
    </g>
  );
}

export function Datapath(props: { event: StepEvent | null; flagNames: string[] }) {
  const ev = props.event;
  const has = ev !== null;
  const reads = has && ev.regReads.length > 0;
  const alu = has && ev.alu !== undefined;
  const mem = has && (ev.memReads.length > 0 || ev.memWrites.length > 0);
  // Only a load brings a value from data memory to a register. A store that also updates a register, such
  // as x86-64 push and call, which lower the stack pointer, writes a computed value.
  const loads = has && ev.klass === 'load';
  const writes = has && ev.regWrites.length > 0;
  // A faulting instruction leaves the program counter unchanged, so neither program counter wire is highlighted for it.
  const update = has ? programCounterUpdate(ev) : null;
  const redirected = update === 'redirected';
  const sequential = update === 'sequential';
  const sentences = has ? describeStep(ev, props.flagNames) : [];
  return (
    <figure className="datapath">
      <svg viewBox="0 0 780 300" role="img" aria-labelledby="dp-title dp-desc">
        <title id="dp-title">Educational execution model of the last instruction</title>
        <desc id="dp-desc">
          {has ? sentences.join(' ') : 'No instruction has been executed yet. Stages: program counter, instruction memory, decode, registers, arithmetic unit, data memory, and write-back.'}
        </desc>
        <defs>
          <marker id="dp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" className="dp-arrow-head" /></marker>
          <marker id="dp-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z" className="dp-arrow-head is-active" /></marker>
        </defs>
        <Wire d="M88 143 H118" active={has} />
        <Wire d="M232 143 H258" active={has} />
        <Wire d="M362 143 H388" active={reads} />
        <Wire d="M502 143 H528" active={alu} />
        <Wire d="M612 143 H638" active={mem} label={mem ? 'address' : undefined} lx={625} ly={135} />
        <Wire d="M570 178 V250 H445 V198" active={writes && !loads} label={writes && !loads ? 'result' : undefined} lx={508} ly={264} />
        <Wire d="M690 188 V272 H425 V198" active={writes && loads} label={writes && loads ? 'loaded value' : undefined} lx={560} ly={286} />
        <Wire d="M570 108 V36 H54 V118" active={redirected} label={redirected ? 'new program counter' : undefined} lx={310} ly={28} />
        <Wire d="M176 98 V62 H70 V118" active={sequential} label={sequential ? `pc + ${ev!.length}` : undefined} lx={124} ly={54} />
        <Box x={20} y={120} w={68} h={46} title="PC" lines={has ? [hex32(ev.pc)] : []} active={has} />
        <Box x={120} y={100} w={112} h={86} title="Instruction memory" lines={has ? ['fetch', bytesText(ev.bytes)] : ['fetch']} active={has} />
        <Box x={260} y={100} w={102} h={86} title="Decode" lines={has ? [ev.text] : []} active={has} />
        <Box x={390} y={90} w={112} h={106} title="Registers" lines={has ? [...ev.regReads.map((r) => `read ${r.reg}`), ...ev.regWrites.map((w) => `write ${w.reg}`)] : []} active={reads || writes} />
        <Box x={530} y={110} w={82} h={66} title="Arithmetic" lines={alu ? [ev.alu!.op, shortValue(ev.alu!.result)] : []} active={alu} />
        <Box x={640} y={100} w={112} h={86} title="Data memory"
          lines={has ? [...ev.memReads.map((r) => `load ${hex32(r.address)}`), ...ev.memWrites.map((w) => `store ${hex32(w.address)}`)] : []} active={mem} />
        {props.flagNames.length > 0 && (
          <Box x={530} y={196} w={82} h={44} title="Flags" lines={has && ev.flags ? [props.flagNames.map((f) => ev.flags!.after[f]).join(' ')] : []} active={has && ev.flags !== undefined} />
        )}
      </svg>
      <figcaption>
        Educational execution model. Highlighted parts were used by the last instruction; the model does not reproduce the microarchitecture of any commercial processor.
      </figcaption>
      {has && (
        <ol className="step-description" aria-label="Description of the last instruction, stage by stage">
          {sentences.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </figure>
  );
}
