/**
 * Views of the simulated machine state: registers and flags, source
 * variables, memory, output, and the recent instruction trace.
 */
import { useEffect, useRef, useState } from 'react';
import type { MachineView } from '../engine/protocol.ts';
import { binaryGroups, hex32, hexWide, parseUserNumber, signed32 } from './format.ts';

interface EditableProps {
  /** True when the machine is paused and values may be edited. */
  editable: boolean;
}

function EditCell(props: { label: string; display: string; onCommit: (value: bigint) => void; editable: boolean; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  /** Set when Enter or Escape closes the editor, so that focus returns to the edit button. */
  const refocus = useRef(false);
  useEffect(() => {
    if (text === null && refocus.current) button.current?.focus();
    refocus.current = false;
  }, [text]);
  if (text === null) {
    return props.editable ? (
      <button ref={button} type="button" className={`cell-button mono ${props.className ?? ''}`} aria-label={`${props.label}: ${props.display}; edit`} onClick={() => setText(props.display)}>
        {props.display}
      </button>
    ) : (
      <span className={`mono ${props.className ?? ''}`}>{props.display}</span>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const v = parseUserNumber(text);
        if (v === null) {
          setError(true);
          return;
        }
        props.onCommit(v);
        refocus.current = true;
        setText(null);
        setError(false);
      }}
    >
      <input
        className={error ? 'cell-input is-invalid' : 'cell-input'}
        aria-label={`New value for ${props.label}`}
        aria-invalid={error}
        value={text}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          refocus.current = true;
          setText(null);
        }}
      />
    </form>
  );
}

export function Registers(props: EditableProps & {
  view: MachineView;
  bits: 32 | 64;
  roles: Record<string, string>;
  /** Row name for each spelling of a register, such as x0 for w0 on AArch64. */
  rowOf: Record<string, string>;
  detailed: boolean;
  onSetRegister: (name: string, value: bigint) => void;
  onSetFlag: (name: string, value: number) => void;
}) {
  const { view, bits } = props;
  const row = (name: string): string => props.rowOf[name] ?? name;
  const written = new Set(view.lastEvent?.regWrites.map((w) => row(w.reg)) ?? []);
  const read = new Set(view.lastEvent?.regReads.map((r) => row(r.reg)) ?? []);
  const flagsChanged = view.lastEvent?.flags;
  const flagNames = Object.keys(view.flags);
  return (
    <div className="registers">
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Registers">
        <table className="register-table">
          <caption className="visually-hidden">Registers. Values written by the last instruction are marked, as are values it read.</caption>
          <thead>
            <tr>
              <th scope="col">Register</th>
              <th scope="col">Hexadecimal</th>
              <th scope="col">Signed (low 32 bits)</th>
              {props.detailed && <th scope="col">Binary (low 32 bits)</th>}
              {props.detailed && <th scope="col">Role</th>}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="mono">pc</th>
              <td className="mono">{view.pc64 === undefined ? hex32(view.pc) : hexWide(view.pc64, 64)}</td>
              <td />
              {props.detailed && <td />}
              {props.detailed && <td className="role">address of the next instruction</td>}
            </tr>
            {view.registers.map((r) => {
              const cls = written.has(r.name) ? 'is-written' : read.has(r.name) ? 'is-read' : '';
              return (
                <tr key={r.name} className={cls}>
                  <th scope="row" className="mono">
                    {r.name}
                    {written.has(r.name) && <span className="tag tag-write">written</span>}
                    {!written.has(r.name) && read.has(r.name) && <span className="tag tag-read">read</span>}
                  </th>
                  <td>
                    <EditCell label={r.name} display={hexWide(r.value, bits)} editable={props.editable} onCommit={(v) => props.onSetRegister(r.name, v)} />
                  </td>
                  <td className="mono num">{signed32(r.value)}</td>
                  {props.detailed && <td className="mono bin">{binaryGroups(r.value, 32)}</td>}
                  {props.detailed && <td className="role">{props.roles[r.name] ?? ''}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {flagNames.length > 0 && (
        <div className="flags" role="group" aria-label="Condition flags">
          <span className="flags-title">Flags</span>
          {flagNames.map((f) => {
            const changed = flagsChanged !== undefined && flagsChanged.before[f] !== flagsChanged.after[f];
            return (
              <button
                key={f}
                type="button"
                className={changed ? 'flag is-written' : 'flag'}
                disabled={!props.editable}
                aria-label={`Flag ${f} is ${view.flags[f]}${props.editable ? '; toggle' : ''}`}
                onClick={() => props.onSetFlag(f, view.flags[f] ? 0 : 1)}
              >
                <span className="mono">{f}</span> {view.flags[f]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Variables(props: { view: MachineView; detailed: boolean }) {
  const { view } = props;
  const shown = view.variables.filter((v) => props.detailed || !v.type.includes('compiler'));
  if (shown.length === 0 && view.arrays.length === 0) return <p className="muted">This program has no source variables.</p>;
  return (
    <div>
      {shown.length > 0 && (
        <table className="plain-table">
          <caption className="visually-hidden">Source variables with their homes in the machine and their current values</caption>
          <thead>
            <tr>
              <th scope="col">Variable</th>
              <th scope="col">Home</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.name}>
                <th scope="row" className="mono">{v.name}</th>
                <td className="mono">{v.home}</td>
                <td className="mono num">{v.value === null ? <span className="muted">not assigned yet</span> : v.type.startsWith('bool') ? (v.value ? 'True (1)' : 'False (0)') : v.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.arrays.map((a) => (
        <div key={a.name} className="array-view">
          <div className="array-title"><span className="mono">{a.name}</span> at {hex32(a.address)}, {a.defined ? <>{a.values.length}{a.truncated ? '+' : ''} elements</> : <span className="muted">not defined yet</span>}</div>
          <div className="array-cells mono" role="list" aria-label={`Elements of ${a.name}`}>
            {a.values.map((v, i) => (
              <span key={i} role="listitem" className="array-cell"><span className="array-index">{i}</span>{v}</span>
            ))}
            {a.truncated && <span className="muted">(more elements not shown)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export type MemoryRegionChoice = 'data' | 'stack' | 'code';

export function MemoryView(props: EditableProps & {
  view: MachineView;
  region: MemoryRegionChoice;
  onRegion: (r: MemoryRegionChoice) => void;
  onPoke: (address: number, bytes: number[]) => void;
}) {
  const { view } = props;
  const reads = new Map<number, number>();
  const writes = new Map<number, number>();
  for (const r of view.lastEvent?.memReads ?? []) for (let k = 0; k < r.size; k++) reads.set(r.address + k, 1);
  for (const w of view.lastEvent?.memWrites ?? []) for (let k = 0; k < w.size; k++) writes.set(w.address + k, 1);
  const window = view.memory[0];
  return (
    <div className="memory-view">
      <div className="segmented" role="group" aria-label="Memory region">
        {(['data', 'stack', 'code'] as const).map((r) => (
          <button key={r} type="button" className={props.region === r ? 'is-active' : ''} aria-pressed={props.region === r} onClick={() => props.onRegion(r)}>
            {r === 'data' ? 'Data' : r === 'stack' ? 'Stack' : 'Code'}
          </button>
        ))}
      </div>
      <p className="hint">
        Each row shows four bytes in address order (lowest address first) and the 32-bit word they form when read little-endian.
        Loads {view.loads}, stores {view.stores}.
      </p>
      {!window || window.bytes === null ? (
        <p className="muted">This range is not mapped.</p>
      ) : (
        <div className="table-scroll memory-scroll" tabIndex={0} role="region" aria-label="Memory contents">
          <table className="memory-table">
            <caption className="visually-hidden">Memory contents by address</caption>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Bytes</th>
                <th scope="col">Word</th>
                <th scope="col">Signed</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.floor(window.bytes.length / 4) }, (_, row) => {
                const address = window.address + 4 * row;
                const b = window.bytes!.slice(4 * row, 4 * row + 4);
                const word = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
                const isWrite = [0, 1, 2, 3].some((k) => writes.has(address + k));
                const isRead = [0, 1, 2, 3].some((k) => reads.has(address + k));
                return (
                  <tr key={address} className={isWrite ? 'is-written' : isRead ? 'is-read' : ''}>
                    <th scope="row" className="mono">{hex32(address)}</th>
                    <td className="mono">{b.map((x) => x.toString(16).padStart(2, '0')).join(' ')}</td>
                    <td>
                      <EditCell
                        label={`word at ${hex32(address)}`}
                        display={hex32(word)}
                        editable={props.editable}
                        onCommit={(v) => {
                          const u = Number(BigInt.asUintN(32, v));
                          props.onPoke(address, [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff]);
                        }}
                      />
                      {isWrite && <span className="tag tag-write">written</span>}
                      {!isWrite && isRead && <span className="tag tag-read">read</span>}
                    </td>
                    <td className="mono num">{word | 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function OutputView(props: { view: MachineView }) {
  const { view } = props;
  return (
    <div className="output-view">
      <div className={`status status-${view.status}`} role="status" aria-live="polite" aria-busy={view.busy}>
        {view.busy ? `running (${view.executed} instructions executed so far)` : view.statusText}
        {!view.busy && view.stopReason && view.status === 'running' ? ` (${view.stopReason})` : ''}
      </div>
      <div className="output-title">Output of print ({view.outputLength} value{view.outputLength === 1 ? '' : 's'})</div>
      {view.outputLength === 0 ? (
        <p className="muted">Nothing printed yet.</p>
      ) : (
        <ol className="output-list mono" tabIndex={0} aria-label="Printed values" start={view.outputLength - view.output.length + 1}>
          {view.output.map((v, i) => <li key={i}>{v}</li>)}
        </ol>
      )}
    </div>
  );
}

export function TraceView(props: { view: MachineView }) {
  const rows = props.view.recent;
  if (rows.length === 0) return <p className="muted">No instruction has been executed yet.</p>;
  return (
    <div className="table-scroll trace-scroll" tabIndex={0} role="region" aria-label="Recently executed instructions">
      <table className="plain-table trace-table">
        <caption className="visually-hidden">The most recently executed instructions, oldest first</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Address</th>
            <th scope="col">Instruction</th>
            <th scope="col">Shorthand</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <td className="num">{r.index + 1}</td>
              <td className="mono">{r.pc64 === undefined ? hex32(r.pc) : hexWide(r.pc64, 64)}</td>
              <td className="mono">{r.text}</td>
              <td className="mono muted">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
