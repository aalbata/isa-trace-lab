/**
 * Code workspace: the source program, its translation for one target (IR,
 * assembly, bytes), the CPython bytecode of the same text as a separate path,
 * and the simulated machine.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BACKENDS, LIMITS, TARGET_ORDER, availableBackends, formatDiagnostic } from '../../core/api.ts';
import type { CompiledProgramDocument, Diagnostic, TargetId } from '../../core/api.ts';
import { sourceProgramDocument } from '../../core/trace/documents.ts';
import { BytecodePanel } from '../components/BytecodePanel.tsx';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { Listing } from '../components/Listing.tsx';
import { MachineControls, MachinePanels } from '../components/MachinePanel.tsx';
import { TARGET_LABEL } from '../components/format.ts';
import { EXAMPLES } from '../data/examples.ts';
import { Cancelled, engine } from '../engine/client.ts';
import type { CompileResponse, ListingLine } from '../engine/protocol.ts';
import { useMachine } from '../engine/useMachine.ts';
import { setState, useAppState } from '../store.ts';

function download(name: string, document: unknown): void {
  const blob = new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function listingFromDocument(doc: CompiledProgramDocument): ListingLine[] {
  return doc.instructions.map((i) => {
    const line: ListingLine = {
      address: i.address,
      bytes: (i.bytes.match(/../g) ?? []).map((h) => parseInt(h, 16)),
      text: i.text,
      labels: i.labels,
      region: i.region,
      lines: i.lines,
      ir: i.ir,
    };
    if (i.pseudo) line.pseudo = i.pseudo.text;
    if (i.note) line.note = i.note;
    return line;
  });
}

function IRView(props: { doc: CompiledProgramDocument; currentOps: ReadonlySet<number>; relatedOps: ReadonlySet<number>; onHover: (op: { id: number; line: number } | null) => void }) {
  const { doc } = props;
  const byId = new Map(doc.ir.ops.map((o) => [o.id, o]));
  return (
    <div className="ir-view">
      <p className="hint">
        The intermediate representation is the same for every target. Temporaries (<span className="mono">%t</span>) are defined once; range checks are explicit
        branches to trap blocks; <span className="mono">mark</span> records a statement boundary and produces no machine code.
      </p>
      {doc.ir.blocks.map((b) => (
        <div key={b.id} className="ir-block">
          <div className="ir-block-title mono">b{b.id}:{b.label ? <span className="muted"> {b.label}</span> : null}</div>
          <ul className="ir-ops">
            {b.ops.map((id) => {
              const op = byId.get(id)!;
              const cls = props.currentOps.has(id) ? 'is-current' : props.relatedOps.has(id) ? 'is-related' : '';
              return (
                <li key={id} className={cls} onMouseEnter={() => props.onHover({ id, line: op.span.startLine })} onMouseLeave={() => props.onHover(null)}>
                  <span className="mono ir-text">{op.text}</span>
                  <span className="ir-line">line {op.span.startLine}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function Workspace() {
  const app = useAppState();
  const backend = BACKENDS[app.target] ?? availableBackends()[0]!;
  const target = backend.profile.id;
  const machine = useMachine('workspace', backend.profile.conventions.stackPointer);
  const [compiled, setCompiled] = useState<CompileResponse | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [tab, setTab] = useState<'assembly' | 'ir'>('assembly');
  const [cursorLine, setCursorLine] = useState<number | null>(null);
  const [hover, setHover] = useState<{ lines: number[]; ops: number[]; addresses: number[] } | null>(null);
  const [breakAddresses, setBreakAddresses] = useState<Set<number>>(new Set());
  const [breakLines, setBreakLines] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<{ source: boolean; translation: boolean; machine: boolean }>({ source: false, translation: false, machine: false });
  const [message, setMessage] = useState('');
  // Text of an argument input while it is being edited, so that a partial entry such as '-' stays visible.
  const [argDrafts, setArgDrafts] = useState<Record<number, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const detailed = !app.beginner;
  const argsKey = app.args.join(',');

  // Compile after edits settle, then load the program into the simulator.
  useEffect(() => {
    setCompiling(true);
    // False once the program, the target or the arguments have changed or the page has been left.
    let current = true;
    const request = (): void => {
      engine()
        .request<CompileResponse>({ op: 'compile', source: app.source, target })
        .then((r) => {
          if (!current) return;
          setCompiled(r);
          // A program that compiles is run with one argument per parameter of main. Stored arguments of another
          // number are replaced by the values that the argument fields show, and the effect runs again with them.
          if (r.ok && r.parameters.length !== app.args.length) {
            setState({ args: r.parameters.map((_, k) => app.args[k] ?? 0) });
            return;
          }
          setCompiling(false);
          if (r.ok) void machine.load(target, app.source, app.args);
          else machine.unload();
        })
        .catch((e: unknown) => {
          if (!current) return;
          // The worker was restarted while the request was pending, so the request is sent to the new worker.
          if (e instanceof Cancelled) {
            request();
            return;
          }
          setCompiling(false);
          setMessage(e instanceof Error ? e.message : String(e));
        });
    };
    const handle = window.setTimeout(request, 250);
    return () => {
      current = false;
      window.clearTimeout(handle);
    };
    // The machine object is recreated on every render; its load function is stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.source, target, argsKey]);

  useEffect(() => {
    machine.setBreakpoints([...breakAddresses], [...breakLines]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakAddresses, breakLines, machine.view?.machine, compiled]);

  // A program compiled for another target is neither shown nor exported while the selected target is compiled.
  const doc = compiled?.document && compiled.target === target ? compiled.document : null;
  const parameters = compiled?.parameters ?? [];
  const listing = useMemo(() => (doc ? listingFromDocument(doc) : []), [doc]);
  const view = machine.view;
  const diagnostics: Diagnostic[] = compiled?.diagnostics ?? [];
  const errors = diagnostics.filter((d) => d.severity === 'error');

  // Lines and operations related to the cursor line or to the item under the pointer.
  const focusLine = hover?.lines[0] ?? cursorLine;
  const relatedAddresses = useMemo(() => {
    if (hover && hover.addresses.length > 0) return new Set(hover.addresses);
    const s = new Set<number>();
    if (focusLine !== null) for (const l of listing) if (l.lines.includes(focusLine)) s.add(l.address);
    return s;
  }, [hover, focusLine, listing]);
  const relatedOps = useMemo(() => {
    if (hover && hover.ops.length > 0) return new Set(hover.ops);
    const s = new Set<number>();
    if (focusLine !== null && doc) for (const o of doc.ir.ops) if (o.span.startLine === focusLine) s.add(o.id);
    return s;
  }, [hover, focusLine, doc]);
  const currentLines = view?.nextBoundaries.length ? view.nextBoundaries.map((c) => c.line) : view?.next?.lines ?? [];
  const currentOps = new Set(view?.next?.ir ?? []);

  const loadExample = (id: string): void => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setState({ source: ex.source, exampleId: ex.id, args: ex.args[0] ?? [] });
    setBreakAddresses(new Set());
    setBreakLines(new Set());
  };
  const setArg = (i: number, text: string): void => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isInteger(n) || n < -2147483648 || n > 2147483647) return;
    const next = parameters.map((_, k) => app.args[k] ?? 0);
    next[i] = n;
    setState({ args: next });
  };
  const toggle = (set: Set<number>, value: number): Set<number> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const importProgram = (file: File): void => {
    file.text().then((text) => {
      try {
        const d = JSON.parse(text) as { schema?: string; source?: unknown; args?: unknown };
        if (d.schema !== 'isa-trace-lab/source-program' || typeof d.source !== 'string') throw new Error('the file is not a source-program document');
        // The limit counts characters (code points), as the language check and schemas/source-program.schema.json do.
        if (d.source.length > LIMITS.maxSourceLength && [...d.source].length > LIMITS.maxSourceLength) throw new Error('the source text is too long');
        // schemas/source-program.schema.json: at most four arguments, each an integer from -2^31 to 2^31 - 1.
        const args: unknown = d.args === undefined ? [] : d.args;
        if (!Array.isArray(args) || args.length > 4 || !args.every((a): a is number => Number.isInteger(a) && a >= -2147483648 && a <= 2147483647)) {
          throw new Error('the arguments of main must be a list of at most four integers from -2147483648 to 2147483647');
        }
        setState({ source: d.source, exampleId: '', args });
        setMessage(`Imported ${file.name}.`);
      } catch (e) {
        setMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, () => setMessage('Import failed: the file could not be read.'));
  };
  const exportProgram = (): void => {
    // schemas/source-program.schema.json allows at most four arguments, one for each parameter main may have. Values kept for
    // further parameters of a main that exceeds this limit are left out, so that the document can be imported again.
    download('program.json', sourceProgramDocument(app.exampleId || 'program', app.source, app.args.slice(0, LIMITS.maxParams)));
  };
  const exportTrace = (): void => {
    engine()
      .request({ op: 'trace', target, source: app.source, args: app.args, maxTraceSteps: 20000 })
      .then((trace) => download(`trace-${target}.json`, trace))
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };

  const columns = [collapsed.source ? '2.4rem' : 'minmax(18rem, 1fr)', collapsed.translation ? '2.4rem' : 'minmax(22rem, 1.25fr)', collapsed.machine ? '2.4rem' : 'minmax(22rem, 1.15fr)'].join(' ');
  const collapseButton = (key: keyof typeof collapsed, label: string) => (
    <button
      type="button"
      className="collapse-button"
      aria-expanded={!collapsed[key]}
      aria-label={`${collapsed[key] ? 'Show' : 'Hide'} the ${label} panel`}
      onClick={() => setCollapsed({ ...collapsed, [key]: !collapsed[key] })}
    >
      {collapsed[key] ? '▸' : '◂'}
    </button>
  );

  return (
    <div className="page workspace-page">
      <div className="toolbar" role="group" aria-label="Program and target">
        <label>
          Example
          <select aria-label="Example" value={app.exampleId} onChange={(e) => loadExample(e.target.value)}>
            {app.exampleId === '' && <option value="">(edited program)</option>}
            {EXAMPLES.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
        </label>
        <label>
          Target
          <select aria-label="Target" value={target} onChange={(e) => setState({ target: e.target.value as TargetId })}>
            {TARGET_ORDER.filter((id) => BACKENDS[id]).map((id) => <option key={id} value={id}>{TARGET_LABEL[id]}</option>)}
          </select>
        </label>
        {parameters.map((p, i) => (
          <label key={p}>
            <span className="mono">{p}</span> =
            <input
              className="arg-input mono" type="number" value={argDrafts[i] ?? String(app.args[i] ?? 0)} min={-2147483648} max={2147483647} step={1}
              onChange={(e) => {
                setArgDrafts({ ...argDrafts, [i]: e.target.value });
                setArg(i, e.target.value);
              }}
              onBlur={() => setArgDrafts({})}
              aria-label={`Argument ${p} of main`}
            />
          </label>
        ))}
        <label className="check-label">
          <input type="checkbox" checked={app.beginner} onChange={(e) => setState({ beginner: e.target.checked })} />
          Beginner view
        </label>
        <span className="toolbar-spacer" />
        <button type="button" onClick={exportProgram}>Export program</button>
        <button type="button" disabled={!doc || compiling} onClick={() => doc && !compiling && download(`compiled-${doc.configuration.target}.json`, doc)}>Export compiled program</button>
        <button type="button" disabled={!doc || compiling} onClick={() => doc && !compiling && exportTrace()}>Export trace</button>
        <button type="button" onClick={() => fileInput.current?.click()}>Import program</button>
        <input ref={fileInput} type="file" tabIndex={-1} accept="application/json,.json" className="visually-hidden" aria-label="Import a source-program document" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importProgram(f);
          e.target.value = '';
        }} />
      </div>
      {message && <div className="info-box" role="status">{message} <button type="button" className="link-button" onClick={() => setMessage('')}>Dismiss</button></div>}

      <div className="workspace-grid" style={{ gridTemplateColumns: columns }}>
        <section className={collapsed.source ? 'column is-collapsed' : 'column'} aria-labelledby="source-heading">
          <header className="column-header">
            {collapseButton('source', 'source')}
            <h2 id="source-heading">Source</h2>
          </header>
          {!collapsed.source && (
            <div className="column-body">
              <p className="language-note">
                Python syntax with <strong>32-bit integers</strong>: arithmetic wraps modulo 2<sup>32</sup>, unlike Python. One function <span className="mono">main</span>,
                integers, Booleans, fixed-length arrays, <span className="mono">if</span>, <span className="mono">while</span>, <span className="mono">for … in range</span>,
                and <span className="mono">print</span> of one integer. Select the line-number margin to set a breakpoint.
              </p>
              <CodeEditor
                value={app.source}
                onChange={(s) => setState({ source: s, exampleId: EXAMPLES.find((e) => e.source === s)?.id ?? '' })}
                diagnostics={diagnostics}
                currentLines={currentLines}
                relatedLines={hover ? hover.lines : []}
                breakpoints={[...breakLines]}
                onToggleBreakpoint={(line) => setBreakLines(toggle(breakLines, line))}
                onCursorLine={setCursorLine}
                ariaLabel="Source program"
                minHeight="16rem"
              />
              <div className="diagnostics" role="status" aria-live="polite">
                {compiling ? <span className="muted">Compiling…</span> : errors.length === 0 ? <span className="ok-text">No errors. Compiled for {TARGET_LABEL[target]}.</span> : (
                  <ul className="diagnostic-list">
                    {diagnostics.map((d, i) => (
                      <li key={i} className={`diagnostic diagnostic-${d.category}`}>
                        <span className="diagnostic-kind">{d.category === 'unsupported' ? 'Outside the language' : d.category === 'syntax' ? 'Syntax error' : d.category === 'semantic' ? 'Language rule' : 'Limit'}</span>
                        {formatDiagnostic(d).replace(/^\w+ \[[^\]]+\] /, '')}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <BytecodePanel source={app.source} focusLine={focusLine} detailed={detailed} onHoverLine={(line) => setHover(line === null ? null : { lines: [line], ops: [], addresses: [] })} />
            </div>
          )}
        </section>

        <section className={collapsed.translation ? 'column is-collapsed' : 'column'} aria-labelledby="translation-heading">
          <header className="column-header">
            {collapseButton('translation', 'translation')}
            <h2 id="translation-heading">Path B: compiled for {TARGET_LABEL[target]} <span className="path-tag path-b">native code</span></h2>
          </header>
          {!collapsed.translation && (
            <div className="column-body">
              {!doc ? <p className="muted">{errors.length > 0 ? 'Correct the reported errors to see the translation.' : 'Compiling…'}</p> : (
                <>
                  <div className="tabs" role="tablist" aria-label="Translation views">
                    <button type="button" role="tab" id="tab-assembly" aria-selected={tab === 'assembly'} aria-controls="panel-translation" className={tab === 'assembly' ? 'is-active' : ''} onClick={() => setTab('assembly')}>Assembly and bytes</button>
                    <button type="button" role="tab" id="tab-ir" aria-selected={tab === 'ir'} aria-controls="panel-translation" className={tab === 'ir' ? 'is-active' : ''} onClick={() => setTab('ir')}>Intermediate representation</button>
                  </div>
                  <div role="tabpanel" id="panel-translation" aria-labelledby={tab === 'assembly' ? 'tab-assembly' : 'tab-ir'}>
                    {tab === 'assembly' ? (
                      <>
                        <p className="hint">
                          {doc.instructions.length} instructions, {doc.code.bytes.length / 2} bytes, loaded at <span className="mono">0x{doc.code.base.toString(16).padStart(8, '0')}</span>.
                          One source line can produce several instructions, and runtime support code has no source line.
                          {detailed && ' Select the bytes of an instruction to edit them in memory while the program is paused.'}
                        </p>
                        <Listing
                          caption={`Assembly listing for ${TARGET_LABEL[target]}`}
                          lines={listing}
                          pc={view && view.status === 'running' && view.pc64 === undefined ? view.pc : null}
                          related={relatedAddresses}
                          stale={new Set(view?.staleAddresses ?? [])}
                          breakpoints={breakAddresses}
                          onToggleBreakpoint={(a) => setBreakAddresses(toggle(breakAddresses, a))}
                          onHover={(l) => setHover(l ? { lines: l.lines, ops: l.ir, addresses: [l.address] } : null)}
                          onEditBytes={view && view.status === 'running' && !machine.running && !machine.playing ? (address, bytes) => machine.poke(address, bytes) : undefined}
                          compact={app.beginner}
                        />
                      </>
                    ) : (
                      <IRView doc={doc} currentOps={currentOps} relatedOps={relatedOps} onHover={(op) => setHover(op ? { lines: [op.line], ops: [op.id], addresses: listing.filter((l) => l.ir.includes(op.id)).map((l) => l.address) } : null)} />
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        <section className={collapsed.machine ? 'column is-collapsed' : 'column'} aria-labelledby="machine-heading">
          <header className="column-header">
            {collapseButton('machine', 'machine')}
            <h2 id="machine-heading">Simulated machine</h2>
          </header>
          {!collapsed.machine && (
            <div className="column-body">
              {!view ? <p className="muted">{machine.error || 'The machine is loaded when the program compiles without errors.'}</p> : (
                <>
                  <MachineControls machine={machine} hasSource label="Execution controls" />
                  {view.next && (
                    <p className="next-instruction">
                      Next: <span className="mono">{view.next.text}</span>
                      {view.nextBoundaries.length > 0 && <span className="boundary-note"> begins the statement on line {view.nextBoundaries.map((c) => c.line).join(', ')}</span>}
                    </p>
                  )}
                  {view.nextStale && view.status === 'running' && (
                    <p className="next-instruction">Next: the edited bytes at the program counter, which have no listing entry.</p>
                  )}
                  <MachinePanels machine={machine} profile={backend.profile} detailed={detailed} />
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
