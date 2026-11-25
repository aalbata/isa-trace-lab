/**
 * Instruction-set explorer: architecture overview, instruction catalog with
 * live encoding and a worked state change, and operation-by-operation
 * comparison across the targets.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BACKENDS, availableBackends } from '../../core/api.ts';
import type { Backend, DecodedInstruction, InsnGroup, InsnSpec, TargetId } from '../../core/api.ts';
import { describeStep } from '../components/Datapath.tsx';
import { ByteDiagram, WordDiagram } from '../components/FieldDiagram.tsx';
import { TARGET_LABEL, bytesText, hex32, hexWide, signed32 } from '../components/format.ts';
import matrix from '../data/support-matrix.json';
import { Cancelled, engine } from '../engine/client.ts';
import type { AssembleResponse, DemoResponse } from '../engine/protocol.ts';
import { href, navigate } from '../router.ts';
import { setState, useAppState } from '../store.ts';

const GROUPS: { id: InsnGroup; label: string }[] = [
  { id: 'arithmetic', label: 'Arithmetic' },
  { id: 'logic', label: 'Logic' },
  { id: 'move', label: 'Movement' },
  { id: 'memory', label: 'Memory' },
  { id: 'compare', label: 'Comparison' },
  { id: 'shift', label: 'Shifts' },
  { id: 'control', label: 'Control flow' },
  { id: 'system', label: 'System' },
];

interface MatrixEntry {
  compilerGenerates: boolean;
  assemblerChecked: number;
  emulatorChecked: number;
}
const MATRIX = matrix as { generated: string; targets: Record<string, Record<string, MatrixEntry>> };

const OPERATION_TITLES: Record<string, string> = {
  'add-registers': 'Add two registers',
  'add-constant': 'Add a small constant',
  'load-constant-32': 'Load a 32-bit constant',
  'subtract-registers': 'Subtract two registers',
  multiply: 'Multiply',
  'shift-left-constant': 'Shift left by a constant',
  'shift-right-arithmetic': 'Arithmetic shift right by a register',
  'bitwise-and-constant': 'Bitwise AND with a constant mask',
  'compare-set': 'Produce 0 or 1 from a signed comparison',
  'branch-less-than': 'Branch if less than (signed)',
  'branch-equal-zero': 'Branch if zero',
  'load-array-element': 'Load an array element',
  'store-array-element': 'Store an array element',
  'call-return': 'Call and return',
  'service-call': 'Request a service from the environment',
};

function Overview({ backend }: { backend: Backend }) {
  const p = backend.profile;
  const c = p.conventions;
  const real = backend.instructions.filter((i) => !i.pseudo);
  const pseudo = backend.instructions.filter((i) => i.pseudo);
  const entries = MATRIX.targets[p.id] ?? {};
  const hasMatrix = Object.keys(entries).length > 0;
  return (
    <div className="overview">
      <h2>{p.name}</h2>
      <p className="isa">{p.isa}</p>
      <ul className="plain-list">{p.overview.map((o) => <li key={o}>{o}</li>)}</ul>
      <dl className="facts">
        <dt>Instruction size</dt>
        <dd>{p.instructionLength.description}</dd>
        <dt>Byte order in memory</dt>
        <dd>Little-endian: the least significant byte of a multi-byte value is stored at the lowest address.</dd>
        <dt>Program counter</dt>
        <dd className="mono">{p.pcName}</dd>
        <dt>Condition flags</dt>
        <dd>{p.flags.length === 0 ? 'None.' : p.flags.map((f) => `${f.name}: ${f.description}`).join('; ')}</dd>
        <dt>Not part of this profile</dt>
        <dd>{p.excluded.join('; ')}.</dd>
      </dl>

      <h3>Registers</h3>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Registers of the profile">
        <table className="plain-table">
          <caption className="visually-hidden">Registers of {p.name} and their roles in this environment</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Other names</th><th scope="col">Bits</th><th scope="col">Role in this environment</th></tr></thead>
          <tbody>
            {p.registers.map((r) => (
              <tr key={r.name}><th scope="row" className="mono">{r.name}</th><td className="mono">{r.aliases.join(', ')}</td><td className="num">{r.bits}</td><td>{r.role}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Conventions of the generated code</h3>
      <dl className="facts">
        <dt>Arguments of main</dt><dd className="mono">{c.args.join(', ')}</dd>
        <dt>Return value</dt><dd className="mono">{c.result}</dd>
        <dt>Stack pointer</dt><dd className="mono">{c.stackPointer}</dd>
        <dt>Return address</dt><dd className="mono">{c.link}</dd>
        <dt>Homes of source variables</dt><dd className="mono">{c.varRegs.join(', ')}; then stack slots</dd>
        <dt>Expression temporaries</dt><dd className="mono">{c.tempRegs.join(', ')}</dd>
        <dt>Code-generator scratch</dt><dd className="mono">{c.scratch.join(', ')}</dd>
        <dt>Service request</dt>
        <dd><span className="mono">{c.serviceInsn}</span> with the service number in <span className="mono">{c.serviceNumber}</span> (1 print, 2 exit, 3 runtime error) and the argument in <span className="mono">{c.serviceArg}</span></dd>
      </dl>
      <ul className="plain-list">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>

      {p.references.length > 0 && (
        <>
          <h3>Reference documents</h3>
          <ul className="plain-list">
            {p.references.map((r) => (
              <li key={r.title}><a href={r.url} rel="noreferrer" target="_blank">{r.title}</a>, {r.version}. {r.sections}</li>
            ))}
          </ul>
        </>
      )}

      <h3>Implemented coverage</h3>
      <p className="hint">
        {real.length} instructions and {pseudo.length} pseudoinstructions or aliases are implemented. The table is generated from the instruction catalog
        {hasMatrix ? ' and from the results of the independent validation run' : ''}. A subset is implemented; this is not a statement of conformance to the architecture.
      </p>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Implemented coverage">
        <table className="plain-table coverage-table">
          <caption className="visually-hidden">Support matrix of {p.name}</caption>
          <thead>
            <tr>
              <th scope="col">Instruction</th><th scope="col">Group</th><th scope="col">Encode</th><th scope="col">Decode</th><th scope="col">Simulate</th>
              {hasMatrix && <th scope="col">Compiler emits</th>}
              {hasMatrix && <th scope="col" title="Instances whose bytes equal the reference assembler's output">Assembler check</th>}
              {hasMatrix && <th scope="col" title="Single-instruction cases that match the reference emulator">Emulator check</th>}
              <th scope="col">Defined in</th>
            </tr>
          </thead>
          <tbody>
            {real.map((i) => {
              const e = entries[i.mnemonic];
              return (
                <tr key={i.mnemonic}>
                  <th scope="row" className="mono"><a href={href('explore', p.id, i.mnemonic)}>{i.mnemonic}</a></th>
                  <td>{i.group}</td>
                  <td>{i.encode ? 'yes' : 'no'}</td><td>{i.decode ? 'yes' : 'no'}</td><td>{i.simulate ? 'yes' : 'no'}</td>
                  {hasMatrix && <td>{e?.compilerGenerates ? 'yes' : 'no'}</td>}
                  {hasMatrix && <td className="num">{e ? e.assemblerChecked : 0}</td>}
                  {hasMatrix && <td className="num">{e ? e.emulatorChecked : 0}</td>}
                  <td className="note">{i.reference}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InstructionDetail({ backend, spec }: { backend: Backend; spec: InsnSpec }) {
  const target = backend.profile.id;
  const bits = backend.profile.registerBits;
  const [text, setText] = useState(spec.example);
  const [regs, setRegs] = useState<Record<string, number>>(spec.demo?.regs ?? {});
  // Text of a register input while it is being edited, so that a partial entry such as '-' stays visible.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [demo, setDemo] = useState<DemoResponse | null>(null);
  const [editError, setEditError] = useState('');
  const token = useRef(0);

  useEffect(() => {
    setText(spec.example);
    setRegs(spec.demo?.regs ?? {});
    setDrafts({});
    setEditError('');
  }, [spec]);

  useEffect(() => {
    const mine = ++token.current;
    const handle = window.setTimeout(() => {
      engine()
        .request<DemoResponse>({ op: 'demo', target, text, registers: regs, memory: spec.demo?.mem ?? [], flags: spec.demo?.flags ?? {} })
        .then((d) => mine === token.current && setDemo(d))
        .catch((e: unknown) => {
          if (mine !== token.current || e instanceof Cancelled) return;
          setDemo({ ok: false, message: e instanceof Error ? e.message : String(e), listing: [], decoded: [], before: { registers: {}, flags: {} }, after: { registers: {}, flags: {} }, events: [], fault: null });
        });
    }, 150);
    return () => window.clearTimeout(handle);
  }, [target, text, regs, spec]);

  const onEditBytes = (index: number, bytes: number[]): void => {
    if (!demo) return;
    const all = demo.listing.map((l, k) => (k === index ? bytes : l.bytes));
    engine()
      .request<DecodedInstruction[]>({ op: 'decode', target, bytes: all.flat(), address: demo.listing[0]!.address })
      .then((decoded) => {
        const bad = decoded.find((d) => !d.ok);
        if (bad) {
          setEditError(`The edited bytes ${bad.bytes} are not an implemented instruction (${bad.kind}): ${bad.message}`);
          return;
        }
        setEditError('');
        setText(decoded.map((d) => d.text).join('\n'));
      })
      .catch(() => undefined);
  };

  // The step events and the example's inputs can name a register by an alias, such as w1 or eax; the table
  // shows the register of the profile that the name refers to, because the snapshots are keyed by those names.
  const profileName = new Map<string, string>();
  for (const r of backend.profile.registers) {
    profileName.set(r.name, r.name);
    for (const a of r.aliases) profileName.set(a, r.name);
  }
  const rowName = (name: string): string => profileName.get(name) ?? name;
  const touched = new Set<string>();
  for (const ev of demo?.events ?? []) {
    ev.regReads.forEach((r) => touched.add(rowName(r.reg)));
    ev.regWrites.forEach((w) => touched.add(rowName(w.reg)));
  }
  Object.keys(regs).forEach((r) => touched.add(rowName(r)));
  const flagNames = backend.profile.flags.map((f) => f.name);

  return (
    <article className="instruction-detail" aria-labelledby="instruction-heading">
      <h2 id="instruction-heading"><span className="mono">{spec.mnemonic}</span> {spec.title} {spec.pseudo && <span className="badge">pseudoinstruction or alias</span>}</h2>
      <dl className="facts">
        <dt>Syntax</dt><dd className="mono">{spec.syntax}</dd>
        <dt>Effect</dt><dd>{spec.semantics}</dd>
        {spec.expansion && <><dt>Expands to</dt><dd className="mono">{spec.expansion}</dd></>}
        <dt>Operands</dt><dd>{spec.operands}</dd>
        <dt>Restrictions</dt><dd>{spec.restrictions}</dd>
        <dt>Registers and flags</dt><dd>{spec.effects}</dd>
        <dt>Format</dt><dd>{spec.format}</dd>
        <dt>Defined in</dt><dd>{spec.reference}</dd>
      </dl>

      <h3>Try it</h3>
      <label className="block-label" htmlFor="example-input">Assembly text (edit the operands; the real assembler encodes each change)</label>
      <textarea id="example-input" className="mono example-input" rows={Math.max(1, text.split('\n').length)} value={text} spellCheck={false} onChange={(e) => {
        setText(e.target.value);
        setEditError('');
      }} />
      <button type="button" className="link-button" onClick={() => setText(spec.example)}>Restore the example</button>
      {demo && !demo.ok && <div className="error-box" role="alert">{demo.message}</div>}
      {editError && <div className="error-box" role="alert">{editError}</div>}

      {demo && demo.ok && (
        <>
          <h3>Encoding</h3>
          {demo.listing.length > 1 && <p className="hint">The text assembles to {demo.listing.length} machine instructions.</p>}
          {demo.listing.map((l, k) => {
            const d = demo.decoded[k];
            return (
              <div key={l.address} className="encoding-block">
                <div className="encoding-title"><span className="mono">{l.text}</span> at {hex32(l.address)}{l.pseudo && <span className="muted"> (from {l.pseudo})</span>}</div>
                {d && d.ok && d.byteFields ? <ByteDiagram bytes={l.bytes} fields={d.byteFields} onEdit={(b) => onEditBytes(k, b)} />
                  : d && d.ok && d.fields ? <WordDiagram bytes={l.bytes} fields={d.fields} onEdit={(b) => onEditBytes(k, b)} />
                  : <div className="mono">{bytesText(l.bytes)}</div>}
              </div>
            );
          })}
          <p className="hint">Select a binary field to edit it. The new bytes are decoded by the real decoder, and the assembly text above is updated.</p>

          <h3>Worked state change</h3>
          {Object.keys(regs).length > 0 && (
            <div className="demo-inputs" role="group" aria-label="Initial register values">
              {Object.keys(regs).map((name) => (
                <label key={name}>
                  <span className="mono">{name}</span> =
                  <input type="number" className="arg-input mono" value={drafts[name] ?? String(regs[name])} onChange={(e) => {
                    const t = e.target.value;
                    setDrafts({ ...drafts, [name]: t });
                    // The value is kept as entered; the worked example writes its low 32 bits.
                    const n = Number(t);
                    if (t.trim() !== '' && Number.isInteger(n) && n >= -2147483648 && n <= 4294967295) setRegs({ ...regs, [name]: n });
                  }} onBlur={() => setDrafts((d) => {
                    const next = { ...d };
                    delete next[name];
                    return next;
                  })} />
                </label>
              ))}
            </div>
          )}
          {demo.fault && <div className="warning-box" role="status">The instruction faults from this state: {demo.fault}</div>}
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Register values before and after the example">
            <table className="plain-table">
              <caption className="visually-hidden">Register values before and after the example</caption>
              <thead><tr><th scope="col">Register</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Signed after</th></tr></thead>
              <tbody>
                {[...touched].map((name) => {
                  const before = demo.before.registers[name] ?? 0n;
                  const after = demo.after.registers[name] ?? 0n;
                  return (
                    <tr key={name} className={before !== after ? 'is-written' : ''}>
                      <th scope="row" className="mono">{name}</th>
                      <td className="mono">{hexWide(before, bits)}</td>
                      <td className="mono">{hexWide(after, bits)}{before !== after && <span className="tag tag-write">changed</span>}</td>
                      <td className="mono num">{signed32(after)}</td>
                    </tr>
                  );
                })}
                {flagNames.length > 0 && (
                  <tr>
                    <th scope="row">Flags {flagNames.join(' ')}</th>
                    <td className="mono">{flagNames.map((f) => demo.before.flags[f] ?? 0).join(' ')}</td>
                    <td className="mono">{flagNames.map((f) => demo.after.flags[f] ?? 0).join(' ')}</td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {demo.events.map((ev, k) => (
            <ol key={k} className="step-description">
              {describeStep(ev, flagNames).map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          ))}
        </>
      )}
    </article>
  );
}

function Operations() {
  // One array for the life of the view: the assembly effect depends on it and must run once per operation.
  const backends = useMemo(() => availableBackends(), []);
  const keys = useMemo(() => {
    const seen: string[] = [];
    for (const b of backends) for (const o of b.operations) if (!seen.includes(o.key)) seen.push(o.key);
    return seen;
  }, [backends]);
  const [key, setKey] = useState(keys[0] ?? '');
  const [bytes, setBytes] = useState<Record<string, AssembleResponse | null>>({});
  useEffect(() => {
    let live = true;
    setBytes({});
    for (const b of backends) {
      const op = b.operations.find((o) => o.key === key);
      if (!op) continue;
      // Labels that the sequence refers to but does not define are placed after it.
      const attempt = async (text: string, tries: number): Promise<AssembleResponse> => {
        const r = await engine().request<AssembleResponse>({ op: 'assemble', target: b.profile.id, text });
        const missing = !r.ok && tries > 0 ? /label '([^']+)' is not defined/.exec(r.errors[0]?.message ?? '') : null;
        return missing ? attempt(`${text}\n${missing[1]}:`, tries - 1) : r;
      };
      attempt(op.assembly.join('\n'), 4).then((r) => live && setBytes((prev) => ({ ...prev, [b.profile.id]: r })), () => undefined);
    }
    return () => {
      live = false;
    };
  }, [key, backends]);
  return (
    <div className="operations">
      <h2>One operation on each instruction set</h2>
      <p className="hint">
        Each column shows the shortest sequence the code generator of this tool uses for the operation, assembled by the real assembler.
        Where one instruction is not enough, the whole sequence is shown. Byte counts describe encoding size only; they say nothing about execution speed.
      </p>
      <label>
        Operation
        <select value={key} onChange={(e) => setKey(e.target.value)}>
          {keys.map((k) => <option key={k} value={k}>{OPERATION_TITLES[k] ?? k}</option>)}
        </select>
      </label>
      <div className="operation-grid">
        {backends.map((b) => {
          const op = b.operations.find((o) => o.key === key);
          const r = bytes[b.profile.id];
          return (
            <section key={b.profile.id} className="operation-card" aria-label={b.profile.name}>
              <h3>{b.profile.name}</h3>
              {!op ? <p className="muted">No sequence is recorded for this operation.</p> : (
                <>
                  {r && r.ok ? (
                    <table className="plain-table">
                      <caption className="visually-hidden">Sequence for {b.profile.name}</caption>
                      <thead><tr><th scope="col">Instruction</th><th scope="col">Bytes in memory</th></tr></thead>
                      <tbody>
                        {r.listing.map((l) => <tr key={l.address}><td className="mono">{l.text}</td><td className="mono">{bytesText(l.bytes)}</td></tr>)}
                      </tbody>
                      <tfoot><tr><th scope="row">Total</th><td>{r.listing.length} instruction{r.listing.length === 1 ? '' : 's'}, {r.bytes.length} bytes</td></tr></tfoot>
                    </table>
                  ) : (
                    <pre className="mono">{op.assembly.join('\n')}</pre>
                  )}
                  {r && !r.ok && <p className="muted">Not assembled: {r.errors[0]?.message}</p>}
                  <p>{op.notes}</p>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function Explorer(props: { target?: string; mnemonic?: string }) {
  const app = useAppState();
  const id = (props.target && BACKENDS[props.target as TargetId] ? props.target : app.target) as TargetId;
  const backend = BACKENDS[id] ?? availableBackends()[0]!;
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<InsnGroup | 'all'>('all');
  const [kind, setKind] = useState<'all' | 'real' | 'pseudo' | 'compiler'>('all');
  const view = props.mnemonic === '~operations' ? 'operations' : props.mnemonic ? 'instruction' : 'overview';
  const entries = MATRIX.targets[backend.profile.id] ?? {};

  useEffect(() => {
    if (backend.profile.id !== app.target) setState({ target: backend.profile.id });
  }, [backend, app.target]);

  const q = query.trim().toLowerCase();
  const filtered = backend.instructions.filter((i) =>
    (group === 'all' || i.group === group) &&
    (kind === 'all' || (kind === 'real' && !i.pseudo) || (kind === 'pseudo' && i.pseudo === true) || (kind === 'compiler' && entries[i.mnemonic]?.compilerGenerates === true)) &&
    (q === '' || i.mnemonic.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || i.semantics.toLowerCase().includes(q)));
  const spec = backend.instructions.find((i) => i.mnemonic === props.mnemonic);

  return (
    <div className="page explorer-page">
      <div className="toolbar" role="group" aria-label="Instruction set">
        <label>
          Instruction set
          <select aria-label="Instruction set" value={backend.profile.id} onChange={(e) => navigate('explore', e.target.value)}>
            {availableBackends().map((b) => <option key={b.profile.id} value={b.profile.id}>{TARGET_LABEL[b.profile.id]}</option>)}
          </select>
        </label>
        <a className={view === 'overview' ? 'button is-active' : 'button'} href={href('explore', backend.profile.id)}>Architecture overview</a>
        <a className={view === 'operations' ? 'button is-active' : 'button'} href={href('explore', backend.profile.id, '~operations')}>Compare operations across targets</a>
        <span className="toolbar-spacer" />
        <a className="button primary" href={href('workspace')}>Continue to the code workspace</a>
      </div>
      <div className="explorer-grid">
        <aside className="catalog" aria-labelledby="catalog-heading">
          <h2 id="catalog-heading">Instruction catalog</h2>
          <label className="block-label" htmlFor="catalog-search">Search</label>
          <input id="catalog-search" type="search" value={query} placeholder="mnemonic or word" onChange={(e) => setQuery(e.target.value)} />
          <label className="block-label" htmlFor="catalog-group">Group</label>
          <select id="catalog-group" value={group} onChange={(e) => setGroup(e.target.value as InsnGroup | 'all')}>
            <option value="all">All groups</option>
            {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
          <label className="block-label" htmlFor="catalog-kind">Show</label>
          <select id="catalog-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">Instructions and pseudoinstructions</option>
            <option value="real">Machine instructions only</option>
            <option value="pseudo">Pseudoinstructions and aliases only</option>
            {Object.keys(entries).length > 0 && <option value="compiler">Emitted by the compiler</option>}
          </select>
          <p className="hint" role="status">{filtered.length} of {backend.instructions.length} entries</p>
          <ul className="catalog-list">
            {filtered.map((i) => (
              <li key={i.mnemonic}>
                <a href={href('explore', backend.profile.id, i.mnemonic)} aria-current={i.mnemonic === props.mnemonic ? 'true' : undefined}>
                  <span className="mono">{i.mnemonic}</span> <span className="catalog-title">{i.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </aside>
        <div className="explorer-main">
          {view === 'operations' ? <Operations /> : spec ? <InstructionDetail backend={backend} spec={spec} /> : <Overview backend={backend} />}
        </div>
      </div>
    </div>
  );
}
