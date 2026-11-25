/**
 * Direct assembly and decoding. Assembly text is assembled at the start of
 * the code region and can be run on the simulator; byte sequences are decoded
 * by the real decoder, which separates invalid encodings from valid
 * instructions outside the implemented subset.
 */
import { useEffect, useRef, useState } from 'react';
import { BACKENDS, availableBackends } from '../../core/api.ts';
import type { DecodedInstruction, TargetId } from '../../core/api.ts';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { ByteDiagram, WordDiagram } from '../components/FieldDiagram.tsx';
import { Listing } from '../components/Listing.tsx';
import { MachineControls, MachinePanels } from '../components/MachinePanel.tsx';
import { TARGET_LABEL, hex32 } from '../components/format.ts';
import { ASM_EXAMPLES, BYTE_EXAMPLES } from '../data/asmExamples.ts';
import { Cancelled, engine } from '../engine/client.ts';
import type { AssembleResponse } from '../engine/protocol.ts';
import { useMachine } from '../engine/useMachine.ts';
import { navigate } from '../router.ts';
import { setState, useAppState } from '../store.ts';

const KIND_TEXT: Record<string, string> = {
  invalid: 'Not a valid encoding in this profile',
  unsupported: 'A defined instruction outside the implemented subset',
  truncated: 'More bytes are needed to complete the instruction',
};

export function Assembler(props: { target?: string }) {
  const app = useAppState();
  const id = (props.target && BACKENDS[props.target as TargetId] ? props.target : app.target) as TargetId;
  const backend = BACKENDS[id] ?? availableBackends()[0]!;
  const target = backend.profile.id;
  const [mode, setMode] = useState<'assemble' | 'decode'>('assemble');
  const [texts, setTexts] = useState<Partial<Record<TargetId, string>>>({});
  const [byteTexts, setByteTexts] = useState<Partial<Record<TargetId, string>>>({});
  const [assembled, setAssembled] = useState<AssembleResponse | null>(null);
  const [decoded, setDecoded] = useState<DecodedInstruction[] | null>(null);
  const [byteError, setByteError] = useState('');
  const machine = useMachine('assembler', backend.profile.conventions.stackPointer);
  const token = useRef(0);
  const text = texts[target] ?? ASM_EXAMPLES[target];
  const bytesText = byteTexts[target] ?? BYTE_EXAMPLES[target];

  useEffect(() => {
    if (mode !== 'assemble') return undefined;
    const mine = ++token.current;
    const handle = window.setTimeout(() => {
      engine()
        .request<AssembleResponse>({ op: 'assemble', target, text })
        .then((r) => {
          if (mine !== token.current) return;
          setAssembled(r);
          if (r.ok) void machine.loadAssembly(target, text);
          else machine.unload();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Cancelled) && mine === token.current) setAssembled({ ok: false, errors: [{ line: 0, message: String(e) }], listing: [], bytes: [], base: 0 });
        });
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, target, mode]);

  useEffect(() => {
    if (mode !== 'decode') return undefined;
    const mine = ++token.current;
    const cleaned = bytesText.replace(/0x/gi, '').replace(/[\s,]/g, '');
    if (cleaned === '') {
      setDecoded([]);
      setByteError('');
      return undefined;
    }
    if (!/^([0-9a-fA-F]{2})+$/.test(cleaned)) {
      setByteError('Enter bytes as pairs of hexadecimal digits, separated by spaces if you like.');
      setDecoded(null);
      return undefined;
    }
    if (cleaned.length > 2 * 4096) {
      setByteError('At most 4,096 bytes are decoded at a time.');
      setDecoded(null);
      return undefined;
    }
    setByteError('');
    const bytes = cleaned.match(/../g)!.map((h) => parseInt(h, 16));
    engine()
      .request<DecodedInstruction[]>({ op: 'decode', target, bytes, address: 0x00400000 })
      .then((d) => mine === token.current && setDecoded(d))
      .catch(() => undefined);
    return undefined;
  }, [bytesText, target, mode]);

  const errorLines = assembled && !assembled.ok ? assembled.errors : [];

  return (
    <div className="page assembler-page">
      <h1>Assembler and decoder</h1>
      <div className="toolbar" role="group" aria-label="Target and mode">
        <label>
          Instruction set
          <select aria-label="Instruction set" value={target} onChange={(e) => {
            setState({ target: e.target.value as TargetId });
            navigate('assembler', e.target.value);
          }}>
            {availableBackends().map((b) => <option key={b.profile.id} value={b.profile.id}>{TARGET_LABEL[b.profile.id]}</option>)}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Mode">
          <button type="button" className={mode === 'assemble' ? 'is-active' : ''} aria-pressed={mode === 'assemble'} onClick={() => setMode('assemble')}>Assemble text</button>
          <button type="button" className={mode === 'decode' ? 'is-active' : ''} aria-pressed={mode === 'decode'} onClick={() => setMode('decode')}>Decode bytes</button>
        </div>
      </div>

      {mode === 'assemble' ? (
        <div className="assembler-grid">
          <section aria-labelledby="asm-source-heading">
            <h2 id="asm-source-heading">Assembly text</h2>
            <p className="hint">
              The program is assembled at <span className="mono">0x00400000</span>. Labels end with a colon; numeric branch targets are absolute addresses.
              Services: put the number in <span className="mono">{backend.profile.conventions.serviceNumber}</span> (1 print, 2 exit) and the value in{' '}
              <span className="mono">{backend.profile.conventions.serviceArg}</span>, then execute <span className="mono">{backend.profile.conventions.serviceInsn}</span>.
              Data directives <span className="mono">.word</span>, <span className="mono">.half</span>, and <span className="mono">.byte</span> place raw values in the code.
            </p>
            <CodeEditor value={text} onChange={(v) => setTexts({ ...texts, [target]: v })} language="plain" ariaLabel={`Assembly program for ${TARGET_LABEL[target]}`} minHeight="18rem" />
            <button type="button" className="link-button" onClick={() => setTexts({ ...texts, [target]: ASM_EXAMPLES[target] })}>Restore the example</button>
            <div role="status" aria-live="polite">
              {errorLines.length > 0 ? (
                <ul className="diagnostic-list">
                  {errorLines.map((e, i) => <li key={i} className="diagnostic diagnostic-syntax"><span className="diagnostic-kind">Line {e.line}</span>{e.message}</li>)}
                </ul>
              ) : assembled?.ok ? <span className="ok-text">{assembled.listing.length} instructions, {assembled.bytes.length} bytes.</span> : null}
            </div>
            {assembled?.ok && (
              <Listing
                caption={`Assembled program for ${TARGET_LABEL[target]}`}
                lines={assembled.listing}
                pc={machine.view?.status === 'running' && machine.view.pc64 === undefined ? machine.view.pc : null}
                stale={new Set(machine.view?.staleAddresses ?? [])}
                onEditBytes={machine.view?.status === 'running' && !machine.running && !machine.playing ? (a, b) => machine.poke(a, b) : undefined}
              />
            )}
          </section>
          <section aria-labelledby="asm-machine-heading">
            <h2 id="asm-machine-heading">Simulated machine</h2>
            {machine.view ? (
              <>
                <MachineControls machine={machine} hasSource={false} label="Execution controls" />
                <MachinePanels machine={machine} profile={backend.profile} detailed={!app.beginner} />
              </>
            ) : <p className="muted">{machine.error || 'The program runs here once it assembles without errors.'}</p>}
          </section>
        </div>
      ) : (
        <section aria-labelledby="decode-heading">
          <h2 id="decode-heading">Bytes to decode</h2>
          <p className="hint">
            Bytes are given in memory order (lowest address first) and decoded from address <span className="mono">0x00400000</span>.
            Decoding continues after an invalid or unsupported instruction and stops when the bytes run out in the middle of an instruction.
          </p>
          <label className="block-label" htmlFor="decode-input">Hexadecimal bytes</label>
          <textarea id="decode-input" className="mono example-input" rows={3} value={bytesText} spellCheck={false} onChange={(e) => setByteTexts({ ...byteTexts, [target]: e.target.value })} />
          <button type="button" className="link-button" onClick={() => setByteTexts({ ...byteTexts, [target]: BYTE_EXAMPLES[target] })}>Restore the example</button>
          {byteError && <div className="error-box" role="alert">{byteError}</div>}
          {decoded && (
            <ol className="decoded-list">
              {decoded.map((d) => (
                <li key={d.address} className={d.ok ? 'decoded-item' : 'decoded-item is-error'}>
                  <div className="encoding-title">
                    <span className="mono">{hex32(d.address)}</span>{' '}
                    {d.ok ? <><span className="mono">{d.text}</span>{d.alias && <span className="muted"> (preferred spelling: <span className="mono">{d.alias}</span>)</span>}</>
                      : <><strong>{KIND_TEXT[d.kind ?? 'invalid']}.</strong> {d.message}</>}
                  </div>
                  {d.ok && d.byteFields && <ByteDiagram bytes={(d.bytes.match(/../g) ?? []).map((h) => parseInt(h, 16))} fields={d.byteFields} />}
                  {d.ok && !d.byteFields && d.fields && <WordDiagram bytes={(d.bytes.match(/../g) ?? []).map((h) => parseInt(h, 16))} fields={d.fields} />}
                  {!d.ok && <div className="mono">{d.bytes.match(/../g)?.join(' ')}</div>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
