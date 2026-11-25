/**
 * Cross-architecture comparison of the current program: outcomes, defined
 * metrics, synchronized stepping by source statement, and the recorded
 * boundary sequence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { availableBackends, formatDiagnostic } from '../../core/api.ts';
import type { Metrics, TargetId } from '../../core/api.ts';
import { TARGET_LABEL, hex32 } from '../components/format.ts';
import { Cancelled, engine } from '../engine/client.ts';
import type { ComparisonVerdict } from '../../core/trace/compare.ts';
import type { CompareResponse, CompileResponse, MachineView } from '../engine/protocol.ts';
import { href } from '../router.ts';
import { setState, useAppState } from '../store.ts';

const METRICS: { label: string; definition: string; value: (m: Metrics) => number; indent?: boolean }[] = [
  { label: 'Static instructions', definition: 'Number of machine instructions in the program image: startup stub, main, runtime error stubs, and runtime helpers.', value: (m) => m.staticInstructions },
  { label: 'in main', definition: 'Instructions of the compiled entry function, including its prologue and epilogue.', value: (m) => m.staticInstructionsByRegion.main, indent: true },
  { label: 'in startup, error stubs, helpers', definition: 'Runtime support code that is not generated from a source statement.', value: (m) => m.staticInstructionsByRegion.startup + m.staticInstructionsByRegion.trap + m.staticInstructionsByRegion.helper, indent: true },
  { label: 'Code bytes', definition: 'Size of the encoded program image in bytes.', value: (m) => m.codeBytes },
  { label: 'Executed instructions', definition: 'Number of instructions executed in this run, counted when fetched, in every part of the image.', value: (m) => m.executedInstructions },
  { label: 'in main', definition: 'Executed instructions that belong to the compiled entry function.', value: (m) => m.executedByRegion.main ?? 0, indent: true },
  { label: 'in runtime helpers', definition: 'Executed instructions of runtime helpers, such as software multiplication on targets without a multiply instruction.', value: (m) => m.executedByRegion.helper ?? 0, indent: true },
  { label: 'in startup and error stubs', definition: 'Executed instructions of the startup stub and of the runtime error stubs.', value: (m) => (m.executedByRegion.startup ?? 0) + (m.executedByRegion.trap ?? 0), indent: true },
  { label: 'Data loads', definition: 'Executed loads from the data and stack regions. Instruction fetches are not counted.', value: (m) => m.dataLoads },
  { label: 'Data stores', definition: 'Executed stores to the data and stack regions.', value: (m) => m.dataStores },
  { label: 'Registers written', definition: 'Registers written at least once, by the loader when it passes arguments or by an executed instruction.', value: (m) => m.registersWritten },
];

const MAX_ROWS = 300;

/** Response of the worker to a comparison, with the verdict and the targets that stopped at the instruction limit. */
type ComparisonResult = CompareResponse & { limitReached?: TargetId[]; verdict?: ComparisonVerdict };

/**
 * Verdict of a comparison. A response without a verdict is judged by the same rule as the core uses:
 * a disagreement first, then incomplete when a target stopped at the instruction limit.
 */
function verdictOf(r: ComparisonResult): ComparisonVerdict {
  if (r.verdict) return r.verdict;
  if (!r.outcomesAgree || !r.boundariesAgree) return 'disagree';
  return (r.limitReached ?? []).length > 0 ? 'incomplete' : 'agree';
}

/** Sentence that names a target stopped at the instruction limit and the boundaries on which it was compared. */
function limitSentence(r: ComparisonResult, id: TargetId): string {
  const compared = r.boundaries.filter((c) => c.steps[id] !== undefined).length;
  const run = r.runs.find((x) => x.target === id);
  const reached = run?.metrics.boundaries ?? compared;
  const boundaries = compared < reached ? `the first ${compared} of the ${reached} statement boundaries` : `the ${compared} statement ${compared === 1 ? 'boundary' : 'boundaries'}`;
  return `${TARGET_LABEL[id]} stopped at the instruction limit${run ? ` after ${run.metrics.executedInstructions} instructions` : ''} and was compared on ${boundaries} it reached.`;
}

/** Text of the verdict box: agreement, disagreement, or an incomplete comparison with each target that stopped at the instruction limit. */
function verdictText(r: ComparisonResult): string {
  const stopped = r.limitReached ?? [];
  const limits = stopped.map((id) => limitSentence(r, id));
  // The outcome of a target that stopped at the instruction limit is not compared with the others.
  const outcomes = !r.outcomesAgree ? 'The targets ended differently.'
    : stopped.length === 0 ? 'All targets ended the same way with the same output and return value.'
    : r.runs.length - stopped.length > 1 ? 'The targets that ran to the end ended the same way with the same output and return value.' : '';
  if (verdictOf(r) === 'incomplete') {
    return ['The comparison is incomplete.', ...limits, outcomes, 'No disagreement was found at the boundaries compared. What a stopped target would do after the limit was not compared.'].filter(Boolean).join(' ');
  }
  const boundaries = r.boundariesAgree
    ? `They agree on the statement reached and on every source variable at all ${r.boundaries.length}${r.boundariesTruncated ? ' recorded' : ''} boundaries.`
    : `${outcomes ? 'They' : 'The targets'} disagree at one or more boundaries.`;
  return [outcomes, boundaries, ...limits].filter(Boolean).join(' ');
}

export function Compare() {
  const app = useAppState();
  const backends = availableBackends();
  const ids = backends.map((b) => b.profile.id);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [views, setViews] = useState<Partial<Record<TargetId, MachineView>>>({});
  const [attempt, setAttempt] = useState(0);
  const [runningAll, setRunningAll] = useState(false);
  const [notice, setNotice] = useState('');
  // The synchronized run in progress: the target the worker is running and whether a pause was requested.
  const run = useRef<{ target: TargetId | null; stop: boolean } | null>(null);
  const token = useRef(0);
  const argsKey = app.args.join(',');
  const idsKey = ids.join(',');

  const machineId = (id: TargetId): string => `compare-${id}`;

  const loadMachines = async (mine: number): Promise<void> => {
    const loaded: Partial<Record<TargetId, MachineView>> = {};
    for (const id of ids) loaded[id] = await engine().request<MachineView>({ op: 'load', machine: machineId(id), target: id, source: app.source, args: app.args });
    if (mine === token.current) setViews(loaded);
  };

  useEffect(() => {
    const mine = ++token.current;
    setBusy(true);
    setError('');
    setNotice('');
    // True while the worker computes the comparison that this effect requested.
    let comparing = false;
    // False once the program or the arguments have changed or the page has been left.
    let current = true;
    const handle = window.setTimeout(() => {
      // The program is compiled for one target first, which gives the parameters of main.
      engine()
        .request<CompileResponse>({ op: 'compile', source: app.source, target: ids[0] ?? app.target })
        .then((c) => {
          if (!current || mine !== token.current) return null;
          // The comparison takes one argument per parameter of main. Stored arguments of another number are
          // replaced by the same values as the code workspace shows, and the effect runs again with them.
          const args = c.parameters.map((_, k) => app.args[k] ?? 0);
          if (c.ok && args.length !== app.args.length) {
            setState({ args });
            return null;
          }
          comparing = true;
          return engine()
            .request<ComparisonResult>({ op: 'compare', source: app.source, args, targets: ids })
            .finally(() => {
              comparing = false;
            });
        })
        .then(async (r) => {
          if (!r || mine !== token.current) return;
          setResult(r);
          setBusy(false);
          if (!r.ok) {
            setViews({});
            return;
          }
          await loadMachines(mine);
        })
        .catch((e: unknown) => {
          if (mine !== token.current || e instanceof Cancelled) return;
          setBusy(false);
          setError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(handle);
      // The worker computes a comparison in one piece. When the page is left or the program changes before
      // the result arrives, the worker is restarted, so that the comparison does not delay the next page.
      if (comparing) engine().restart();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.source, argsKey, idsKey, attempt]);

  const cancel = (): void => {
    token.current++;
    engine().restart();
    setBusy(false);
    setResult(null);
    setViews({});
    setError('The comparison was cancelled by stopping the simulator worker.');
  };

  useEffect(() => () => {
    for (const id of ids) void engine().request({ op: 'close', machine: machineId(id) }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const apply = useCallback(async (targets: TargetId[], op: 'step' | 'stepSource' | 'reset' | 'run'): Promise<void> => {
    const mine = token.current;
    setError('');
    setNotice('');
    // A run executes the targets one after another; the controls are disabled and Pause is offered until it ends.
    const current = op === 'run' ? { target: null as TargetId | null, stop: false } : null;
    if (current) {
      run.current = current;
      setRunningAll(true);
    }
    try {
      const next: Partial<Record<TargetId, MachineView>> = {};
      for (const id of targets) {
        if (current?.stop) break;
        if (current) current.target = id;
        const s = `compare-${id}`;
        next[id] = await engine().request<MachineView>(op === 'step' ? { op, machine: s, count: 1 } : { op, machine: s });
      }
      if (mine === token.current) setViews((prev) => ({ ...prev, ...next }));
    } catch (e) {
      if (!(e instanceof Cancelled) && mine === token.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current) {
        if (run.current === current) run.current = null;
        setRunningAll(false);
      }
    }
  }, []);

  const pauseAll = (): void => {
    const current = run.current;
    if (!current) return;
    current.stop = true;
    if (current.target) void engine().request({ op: 'pause', machine: machineId(current.target) }).catch(() => undefined);
    // The worker checks for a pause between slices of a run. If the run has not stopped after 1.5 s, the
    // worker is terminated and a new one is started, and the machines are loaded again from the start.
    window.setTimeout(() => {
      if (run.current !== current) return;
      run.current = null;
      engine().restart();
      setNotice('The run did not stop in time, so the simulator worker was restarted and the machines were loaded again from the start.');
      loadMachines(token.current).catch((e: unknown) => {
        if (!(e instanceof Cancelled)) setError(e instanceof Error ? e.message : String(e));
      });
    }, 1500);
  };

  const loadedViews = ids.map((id) => views[id]).filter((v): v is MachineView => v !== undefined);
  const allLoaded = loadedViews.length === ids.length && ids.length > 0;
  const running = loadedViews.filter((v) => v.status === 'running');
  const sameBoundary = allLoaded && loadedViews.every((v) => v.boundaryCount === loadedViews[0]!.boundaryCount && v.nextBoundaries.length > 0 === (loadedViews[0]!.nextBoundaries.length > 0));
  const atBoundary = allLoaded && loadedViews.every((v) => v.status !== 'running' || v.nextBoundaries.length > 0);
  const variableNames = allLoaded ? [...new Set(loadedViews.flatMap((v) => v.variables.filter((x) => !x.type.includes('compiler')).map((x) => x.name)))] : [];
  const line = allLoaded && sameBoundary ? loadedViews[0]!.nextBoundaries[0]?.line ?? null : null;
  const verdict = result ? verdictOf(result) : null;

  if (result && !result.ok) {
    return (
      <div className="page compare-page">
        <h1>Compare architectures</h1>
        <div className="error-box" role="alert">
          The program has errors and cannot be compared. <a href={href('workspace')}>Open it in the code workspace.</a>
          <ul>{result.diagnostics.map((d, i) => <li key={i}>{formatDiagnostic(d)}</li>)}</ul>
        </div>
      </div>
    );
  }

  return (
    <div className="page compare-page">
      <h1>Compare architectures</h1>
      <p className="lead">
        The program from the code workspace is compiled from the same intermediate representation for every target, with the same policy and no optimization,
        and each target runs on its own simulator. Runs are aligned at source statements, not at instruction numbers, because the targets need different numbers
        of instructions for the same statement.
      </p>
      <div className="toolbar" role="group" aria-label="Program">
        <span>Arguments of main: <span className="mono">{app.args.length > 0 ? app.args.join(', ') : 'none'}</span></span>
        <a className="button" href={href('workspace')}>Edit the program in the code workspace</a>
        <label className="check-label">
          <input type="checkbox" checked={app.beginner} onChange={(e) => setState({ beginner: e.target.checked })} />
          Beginner view
        </label>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {busy && (
        <div className="info-box" role="status">
          Compiling and running on {ids.length} targets…{' '}
          <button type="button" onClick={cancel}>Cancel</button>
        </div>
      )}
      {!busy && !result && error && <button type="button" onClick={() => setAttempt(attempt + 1)}>Run the comparison again</button>}

      {result && result.ok && (
        <>
          <h2>Outcome</h2>
          <div className={verdict === 'agree' ? 'ok-box' : verdict === 'incomplete' ? 'warning-box' : 'error-box'} role="status">{verdictText(result)}</div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Outcome per target">
            <table className="plain-table">
              <caption className="visually-hidden">Outcome of the run on each target</caption>
              <thead><tr><th scope="col">Target</th><th scope="col">Result</th><th scope="col">Output</th></tr></thead>
              <tbody>
                {result.runs.map((r) => (
                  <tr key={r.target}>
                    <th scope="row">{TARGET_LABEL[r.target]}</th>
                    <td>
                      {r.outcome.status === 'exited' ? `main returned ${r.outcome.returnValue}`
                        : r.outcome.status === 'trap' ? `runtime error ${r.outcome.trap?.code}: ${r.outcome.trap?.message} (line ${r.outcome.trap?.line ?? '?'})`
                        : r.outcome.status === 'limit' ? (r.outcome.limit === 'output' ? 'stopped at the output limit' : 'stopped at the instruction limit') : `fault: ${r.outcome.fault}`}
                    </td>
                    <td className="mono">{r.outcome.output.slice(0, 20).join(', ')}{r.outcome.output.length > 20 ? ', …' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Metrics</h2>
          <p className="hint">
            The counts describe this compiler's output under its documented, unoptimized code-generation policy and this run. They are not measurements of
            processor speed, energy, or quality of an instruction set, and they would differ under another compiler.
          </p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Metrics per target">
            <table className="plain-table metrics-table">
              <caption className="visually-hidden">Static and dynamic metrics per target</caption>
              <thead>
                <tr><th scope="col">Metric</th>{result.runs.map((r) => <th key={r.target} scope="col">{TARGET_LABEL[r.target]}</th>)}{!app.beginner && <th scope="col">Definition</th>}</tr>
              </thead>
              <tbody>
                {METRICS.filter((m) => !app.beginner || !m.indent).map((m, i) => (
                  <tr key={i}>
                    <th scope="row" className={m.indent ? 'indent' : ''}>{m.label}</th>
                    {result.runs.map((r) => <td key={r.target} className="num mono">{m.value(r.metrics)}</td>)}
                    {!app.beginner && <td className="note">{m.definition}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>Step through the program on every target</h2>
          <div className="controls" role="toolbar" aria-label="Synchronized execution controls">
            <button type="button" className="primary" disabled={!allLoaded || running.length === 0 || runningAll} onClick={() => void apply(running.map((v) => v.target), 'stepSource')}>
              Step one statement on every target
            </button>
            {runningAll ? (
              <button type="button" onClick={pauseAll}>Pause</button>
            ) : (
              <button type="button" disabled={!allLoaded || running.length === 0} onClick={() => void apply(running.map((v) => v.target), 'run')}>Run every target to the end</button>
            )}
            <button type="button" disabled={!allLoaded || runningAll} onClick={() => void apply(ids, 'reset')}>Reset every target</button>
          </div>
          {notice && <div className="info-box" role="status">{notice}</div>}
          <div className="sync-status" role="status" aria-live="polite">
            {!allLoaded ? 'Loading the machines…'
              : runningAll ? 'Running every target to the end, one target after another. Pause stops the run.'
              : running.length === 0 ? 'Every target has stopped.'
              : sameBoundary && atBoundary && line !== null ? `Every target is at statement boundary ${loadedViews[0]!.boundaryCount + 1}, about to execute source line ${line}.`
              : sameBoundary ? `Every target has passed ${loadedViews[0]!.boundaryCount} boundaries.`
              : 'The targets are at different points of the program because they were stepped independently. Step one statement on every target to realign them.'}
          </div>
          <div className="sync-grid">
            {ids.map((id) => {
              const v = views[id];
              const doc = result.runs.find((r) => r.target === id)?.document;
              const stmtLine = v?.nextBoundaries[0]?.line ?? v?.next?.lines[0] ?? null;
              const snippet = doc && stmtLine !== null ? doc.instructions.filter((i) => i.lines.includes(stmtLine)) : [];
              return (
                <section key={id} className="sync-card" aria-label={TARGET_LABEL[id]}>
                  <h3>{TARGET_LABEL[id]}</h3>
                  {!v ? <p className="muted">Loading…</p> : (
                    <>
                      <p className={`status status-${v.status}`}>{v.statusText}</p>
                      <dl className="facts compact">
                        <dt>Executed</dt><dd>{v.executed} instructions</dd>
                        <dt>Statement boundaries passed</dt><dd>{v.boundaryCount}</dd>
                        <dt>Next</dt><dd className="mono">{v.next ? v.next.text : 'none'}</dd>
                      </dl>
                      <button type="button" disabled={v.status !== 'running' || runningAll} onClick={() => void apply([id], 'step')}>Step one instruction here</button>
                      {v.lastEvent && (
                        <p className="hint">
                          Last: <span className="mono">{v.lastEvent.text}</span>
                          {v.lastEvent.regWrites.length > 0 && <> wrote {v.lastEvent.regWrites.map((w) => `${w.reg} = ${Number(BigInt.asIntN(32, w.value))}`).join(', ')}</>}
                        </p>
                      )}
                      {snippet.length > 0 && (
                        <>
                          <div className="snippet-title">Instructions for source line {stmtLine} ({snippet.length})</div>
                          <ol className="snippet mono">
                            {snippet.map((i) => <li key={i.address} className={i.address === v.pc && v.pc64 === undefined ? 'is-current' : ''}><span className="snippet-address">{hex32(i.address)}</span> {i.text}</li>)}
                          </ol>
                        </>
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>
          {allLoaded && variableNames.length > 0 && (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Source variables per target">
              <table className="plain-table">
                <caption>Source variables on each target{sameBoundary ? '' : ' (targets are not at the same boundary)'}</caption>
                <thead><tr><th scope="col">Variable</th>{ids.map((id) => <th key={id} scope="col">{TARGET_LABEL[id]}</th>)}<th scope="col">Same value</th></tr></thead>
                <tbody>
                  {variableNames.map((name) => {
                    const values = ids.map((id) => views[id]!.variables.find((x) => x.name === name)?.value ?? null);
                    const same = values.every((x) => x === values[0]);
                    return (
                      <tr key={name}>
                        <th scope="row" className="mono">{name}</th>
                        {values.map((x, k) => <td key={k} className="mono num">{x === null ? <span className="muted">not assigned</span> : x}</td>)}
                        <td>{same ? 'yes' : sameBoundary ? 'no' : 'not comparable'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!app.beginner && (
            <>
              <h2>Sequence of statement boundaries</h2>
              <p className="hint">
                One row per statement boundary of the complete run. The numbers are the instructions each target executes from this boundary until the next one,
                or until the end of the run after the last boundary. Instructions executed before the first boundary, in the startup stub and the prologue of main,
                are not counted in any row.
                {result.boundaries.length > MAX_ROWS ? ` The first ${MAX_ROWS} of ${result.boundaries.length} boundaries are shown.` : ''}
              </p>
              <div className="table-scroll boundary-scroll" tabIndex={0} role="region" aria-label="Sequence of statement boundaries">
                <table className="plain-table">
                  <caption className="visually-hidden">Instructions executed between consecutive boundaries on each target</caption>
                  <thead><tr><th scope="col">Boundary</th><th scope="col">Source line</th>{ids.map((id) => <th key={id} scope="col">{TARGET_LABEL[id]}</th>)}<th scope="col">State agrees</th></tr></thead>
                  <tbody>
                    {result.boundaries.slice(0, MAX_ROWS).map((c, k) => {
                      const next = result.boundaries[k + 1];
                      return (
                        <tr key={c.ordinal}>
                          <td className="num">{c.ordinal + 1}</td>
                          <td className="num">{c.line}</td>
                          {ids.map((id) => {
                            const end = next ? next.steps[id] : result.runs.find((r) => r.target === id)?.metrics.executedInstructions;
                            const start = c.steps[id];
                            return <td key={id} className="num mono">{start !== undefined && end !== undefined ? end - start : ''}</td>;
                          })}
                          <td>{c.agree ? 'yes' : 'no'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
