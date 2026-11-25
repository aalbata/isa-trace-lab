/**
 * Execution controls and state views of one simulated machine.
 */
import { useState } from 'react';
import type { TargetProfile } from '../../core/api.ts';
import type { MachineControl } from '../engine/useMachine.ts';
import { Datapath } from './Datapath.tsx';
import { MemoryView, OutputView, Registers, TraceView, Variables } from './StateViews.tsx';

const SPEEDS = [1, 2, 5, 10, 25];

export function MachineControls(props: { machine: MachineControl; hasSource: boolean; label: string }) {
  const { machine: m } = props;
  const [speed, setSpeed] = useState(5);
  const v = m.view;
  if (!v) return null;
  const idle = !m.running && !m.playing;
  const live = v.status === 'running';
  return (
    <div className="controls" role="toolbar" aria-label={props.label}>
      <button type="button" disabled={!idle || v.executed === 0} onClick={() => m.back(1)} title="Undo the last instruction">Back</button>
      <button type="button" className="primary" disabled={!idle || !live} onClick={() => m.step(1)} title="Execute one machine instruction">Step instruction</button>
      {props.hasSource && (
        <>
          <button type="button" disabled={!idle || !live} onClick={() => m.stepSource()} title="Execute until the next source statement begins">Step statement</button>
          <button type="button" disabled={!idle || v.executed === 0} onClick={() => m.backSource()} title="Return to the previous statement boundary">Back statement</button>
        </>
      )}
      {m.playing || m.running ? (
        <button type="button" onClick={() => m.pause()}>Pause</button>
      ) : (
        <button type="button" disabled={!live} onClick={() => m.play(speed, false)} title="Step automatically at the selected speed">Play</button>
      )}
      <label className="inline-label">
        Speed
        <select aria-label="Speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={m.playing}>
          {SPEEDS.map((s) => <option key={s} value={s}>{s} per second</option>)}
        </select>
      </label>
      <button type="button" disabled={!idle || !live} onClick={() => m.run()} title="Run at full speed until the program stops or reaches a breakpoint">Run</button>
      <button type="button" disabled={m.running} onClick={() => m.reset()} title="Reload the program and discard edits">Reset</button>
    </div>
  );
}

export function MachinePanels(props: { machine: MachineControl; profile: TargetProfile; detailed: boolean }) {
  const { machine: m, profile } = props;
  const v = m.view;
  if (!v) return null;
  const editable = v.status === 'running' && !m.running && !m.playing;
  const roles: Record<string, string> = {};
  // Instructions report registers by the spelling they use, such as w0 for the low half of x0 on
  // AArch64; the register table has one row per register.
  const rowOf: Record<string, string> = {};
  for (const r of profile.registers) {
    roles[r.name] = r.role;
    for (const a of r.aliases) rowOf[a] = r.name;
  }
  for (const r of profile.registers) rowOf[r.name] = r.name;
  return (
    <div className="machine-panels">
      <OutputView view={v} />
      {m.error && <div className="error-box" role="alert">{m.error}</div>}
      {m.notice && <div className="info-box" role="status">{m.notice}</div>}
      {v.codeEdited && (
        <div className="warning-box" role="status">
          Code bytes were edited. The simulator executes the edited bytes; source mappings of the affected instructions are no longer shown. Reset reloads the compiled program.
        </div>
      )}
      <details open className="panel">
        <summary>Registers{editable ? ' (select a value to edit it)' : ''}</summary>
        <Registers
          view={v} bits={profile.registerBits} roles={roles} rowOf={rowOf} detailed={props.detailed} editable={editable}
          onSetRegister={(name, value) => m.setRegister(name, value)} onSetFlag={(name, value) => m.setFlag(name, value)}
        />
      </details>
      {v.variables.length + v.arrays.length > 0 && (
        <details open className="panel">
          <summary>Source variables</summary>
          <Variables view={v} detailed={props.detailed} />
        </details>
      )}
      <details open className="panel">
        <summary>Datapath for the last instruction</summary>
        <Datapath event={v.lastEvent} flagNames={profile.flags.map((f) => f.name)} />
        {!v.lastEvent && v.executed > 0 && <p className="muted">Details are recorded when stepping. Step once to see the stages of an instruction.</p>}
      </details>
      <details className="panel" open={!props.detailed ? undefined : true}>
        <summary>Memory</summary>
        <MemoryView view={v} region={m.region} onRegion={(r) => m.setRegion(r)} editable={editable} onPoke={(address, bytes) => m.poke(address, bytes)} />
      </details>
      <details className="panel">
        <summary>Recent instructions ({v.executed} executed)</summary>
        <TraceView view={v} />
      </details>
    </div>
  );
}
