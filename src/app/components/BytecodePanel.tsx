/**
 * Path A: the bytecode that CPython itself produces for the source text.
 * The runtime is loaded only when the reader asks for it, and the source is
 * compiled without being executed.
 */
import { useEffect, useRef, useState } from 'react';
import type { BytecodeInstruction, DisassemblyResult } from '../../bytecode/disassembler.ts';
import { bytecodeNote } from '../data/bytecodeNotes.ts';
import { bytecode } from '../engine/bytecodeClient.ts';

interface Timing {
  loadMs: number;
  disassembleMs: number;
}

/**
 * Operand cell text: the argument and the description of `dis`. For a jump, `dis` names the target
 * by a label (L1, L2, ...) that the table does not show; the target offset, which the Offset column
 * marks with ▸, is shown in its place.
 */
function operandText(ins: BytecodeInstruction): string {
  if (ins.arg === null) return '';
  if (ins.argrepr === '') return String(ins.arg);
  const repr = ins.jumpTarget !== null ? ins.argrepr.replace(/\bL\d+\b/, String(ins.jumpTarget)) : ins.argrepr;
  return `${ins.arg} (${repr})`;
}

export function BytecodePanel(props: { source: string; focusLine: number | null; detailed: boolean; onHoverLine: (line: number | null) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DisassemblyResult | null>(null);
  const [error, setError] = useState('');
  const [timing, setTiming] = useState<Timing | null>(null);
  const token = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const mine = ++token.current;
    const handle = window.setTimeout(() => {
      setBusy(true);
      bytecode()
        .disassemble(props.source)
        .then((r) => {
          if (mine !== token.current) return;
          if (r.ok && r.result) {
            setResult(r.result);
            setError('');
            setTiming((t) => ({ loadMs: r.loadMs > 0 ? r.loadMs : t?.loadMs ?? 0, disassembleMs: r.disassembleMs }));
          } else setError(r.error ?? 'the runtime reported an error');
        })
        .catch((e: unknown) => mine === token.current && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => mine === token.current && setBusy(false));
    }, 350);
    return () => window.clearTimeout(handle);
  }, [enabled, props.source]);

  return (
    <section className="bytecode-panel" aria-labelledby="bytecode-heading">
      <h3 id="bytecode-heading">Path A: CPython bytecode <span className="path-tag path-a">inspection only</span></h3>
      <p className="hint">
        This is the bytecode the CPython interpreter would run for the same text, obtained from CPython's own compiler and its <span className="mono">dis</span> module.
        The source is compiled and never executed. The machine code of Path B is produced by a separate compiler and is not derived from this bytecode.
      </p>
      {!enabled ? (
        <div>
          <button type="button" onClick={() => setEnabled(true)}>Load the CPython runtime and show bytecode</button>
          <p className="hint">The Pyodide runtime (about 13 MB, served with this application) is downloaded on first use and then cached by the browser.</p>
        </div>
      ) : (
        <>
          <div className="bytecode-status" role="status" aria-live="polite">
            {busy && !result ? 'Loading the CPython runtime…' : busy ? 'Compiling…' : ''}
            {result && (
              <span>
                {result.ok ? `CPython ${result.python}` : 'CPython'} in Pyodide {result.pyodide}
                {timing ? `; runtime loaded in ${Math.round(timing.loadMs)} ms, compiled in ${timing.disassembleMs.toFixed(1)} ms` : ''}
              </span>
            )}
          </div>
          {error && <div className="error-box" role="alert">The bytecode view failed: {error}</div>}
          {result && !result.ok && (
            <div className="error-box" role="alert">
              CPython reports a syntax error{result.error.line !== null ? ` at line ${result.error.line}` : ''}: {result.error.message}
            </div>
          )}
          {result && result.ok && result.codeObjects.map((co) => (
            <details key={co.name} open={co.name !== '<module>'} className="code-object">
              <summary>
                Code object <span className="mono">{co.name}</span> ({co.instructions.length} instructions, {co.byteLength} bytes, stack depth {co.stackSize})
              </summary>
              {props.detailed && (
                <p className="hint">
                  Local names: <span className="mono">{co.localNames.join(', ') || 'none'}</span>. Global names: <span className="mono">{co.names.join(', ') || 'none'}</span>.
                  Constants: <span className="mono">{co.constants.join(', ') || 'none'}</span>.
                </p>
              )}
              <div className="table-scroll" tabIndex={0} role="region" aria-label={`Bytecode of ${co.name}`}>
                <table className="plain-table bytecode-table">
                  <caption className="visually-hidden">Bytecode instructions of the code object {co.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Line</th>
                      <th scope="col">Offset</th>
                      <th scope="col">Operation</th>
                      <th scope="col">Operand</th>
                      <th scope="col" title="Net change of the evaluation stack depth">Stack</th>
                      {props.detailed && <th scope="col" title="16-bit inline cache entries that follow the instruction">Cache</th>}
                      <th scope="col">Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {co.instructions.map((ins) => (
                      <tr
                        key={ins.offset}
                        className={ins.line !== null && ins.line === props.focusLine ? 'is-related' : ''}
                        onMouseEnter={() => props.onHoverLine(ins.line)}
                        onMouseLeave={() => props.onHoverLine(null)}
                      >
                        <td className="num">{ins.startsLine ? ins.line : ''}</td>
                        <td className="num mono">{ins.isJumpTarget ? '▸ ' : ''}{ins.offset}</td>
                        <td className="mono">{ins.opname}</td>
                        <td className="mono">{operandText(ins)}</td>
                        <td className="num mono">{ins.stackEffect === null ? '' : ins.stackEffect > 0 ? `+${ins.stackEffect}` : ins.stackEffect}</td>
                        {props.detailed && <td className="num mono">{ins.cacheUnits > 0 ? ins.cacheUnits : ''}</td>}
                        <td className="note">{bytecodeNote(ins.opname)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
          {result && result.ok && props.detailed && (
            <p className="hint">
              Offsets count bytes; each instruction is two bytes and may be followed by inline cache entries, which is why offsets can advance by more than two.
              The listing shows the instructions as compiled, before the interpreter specializes any of them at run time, because the code is not executed here.
            </p>
          )}
        </>
      )}
    </section>
  );
}
