/**
 * Start page: choose an instruction set. The instruction-set explorer is the
 * first step; readers who already know the instruction set can go straight to
 * the code workspace.
 */
import { availableBackends } from '../../core/api.ts';
import { href } from '../router.ts';
import { setState } from '../store.ts';

export function Start() {
  const backends = availableBackends();
  return (
    <div className="page start-page">
      <h1>Trace a program from source to machine code and execution</h1>
      <p className="lead">
        ISA Trace Lab follows a small program, written with Python syntax and 32-bit integers, through an intermediate representation, assembly,
        encoded bytes, and step-by-step execution on four instruction sets. Start by choosing an instruction set and exploring its instructions.
      </p>
      <h2>Choose an instruction set</h2>
      <ul className="target-cards">
        {backends.map((b) => {
          const p = b.profile;
          const real = b.instructions.filter((i) => !i.pseudo).length;
          return (
            <li key={p.id} className="target-card">
              <h3>{p.name}</h3>
              <p className="isa">{p.isa}</p>
              <dl>
                <dt>Registers</dt>
                <dd>{p.registers.filter((r) => r.generalPurpose !== false).length} general-purpose{p.registers.some((r) => r.generalPurpose === false) ? ' and a separate stack pointer' : ''}, {p.registerBits} bits</dd>
                <dt>Instruction length</dt>
                <dd>{p.instructionLength.min === p.instructionLength.max ? `${p.instructionLength.min} bytes, fixed` : `${p.instructionLength.min} to ${p.instructionLength.max} bytes`}</dd>
                <dt>Condition flags</dt>
                <dd>{p.flags.length === 0 ? 'none' : p.flags.map((f) => f.name).join(', ')}</dd>
                <dt>Implemented subset</dt>
                <dd>{real} instructions</dd>
              </dl>
              <div className="card-actions">
                <a className="button primary" href={href('explore', p.id)} onClick={() => setState({ target: p.id })}>Explore the instruction set</a>
                <a className="button" href={href('workspace')} onClick={() => setState({ target: p.id })}>Skip to the code workspace</a>
              </div>
            </li>
          );
        })}
      </ul>
      <h2>Two separate paths</h2>
      <div className="two-paths">
        <div className="path-box">
          <h3><span className="path-tag path-a">Path A</span> CPython bytecode, for inspection</h3>
          <p>
            Source text is compiled by the CPython interpreter itself, without being executed, and its bytecode is listed with the standard
            <span className="mono"> dis</span> module. This shows what ordinary Python runs on its virtual machine.
          </p>
        </div>
        <div className="path-box">
          <h3><span className="path-tag path-b">Path B</span> Native code for a simulated processor</h3>
          <p>
            A separate compiler translates a restricted language with Python syntax through a typed intermediate representation into real machine-code bytes.
            A simulator fetches and decodes those bytes and shows registers, memory, and output. Path B does not use the bytecode of Path A.
          </p>
        </div>
      </div>
      <h2>What the tool is and is not</h2>
      <ul className="plain-list">
        <li>The source language is a documented subset with 32-bit wraparound arithmetic. It is not full Python.</li>
        <li>Each target is a documented subset of its instruction set, not a complete implementation of the architecture.</li>
        <li>The simulators and the datapath view are educational models. Instruction counts are not measurements of speed or energy of real processors.</li>
        <li>Everything runs in the browser. Nothing is uploaded.</li>
      </ul>
    </div>
  );
}
