/**
 * Self-checking exercises. Every question and expected answer is produced by
 * the assembler, decoder, and processor model of the selected target; nothing
 * is precomputed. Completion counts are kept only in this browser.
 */
import { useEffect, useState } from 'react';
import { BACKENDS, availableBackends } from '../../core/api.ts';
import type { TargetId } from '../../core/api.ts';
import { normalizeAnswer } from '../../core/learn.ts';
import type { Exercise } from '../../core/learn.ts';
import { TARGET_LABEL } from '../components/format.ts';
import { Cancelled, engine } from '../engine/client.ts';
import { getState, setState, useAppState } from '../store.ts';

const KINDS: { id: Exercise['kind']; label: string; text: string }[] = [
  { id: 'register', label: 'Predict a register value', text: 'Work out the value an instruction writes from the given register values.' },
  { id: 'field', label: 'Decode an operand field', text: 'Read the value of one field from the bytes of an instruction.' },
  { id: 'branch', label: 'Explain a branch', text: 'Decide whether a conditional branch is taken.' },
];

export function Exercises() {
  const app = useAppState();
  const backend = BACKENDS[app.target] ?? availableBackends()[0]!;
  const target = backend.profile.id;
  const [kind, setKind] = useState<Exercise['kind']>('register');
  const [counter, setCounter] = useState(1);
  // The exercise on the page and its identity: instruction set, kind, and question number.
  const [shown, setShown] = useState<{ exercise: Exercise | null; id: string }>({ exercise: null, id: '' });
  const exercise = shown.exercise;
  const [answer, setAnswer] = useState('');
  const [verdict, setVerdict] = useState<'right' | 'wrong' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setVerdict(null);
    setAnswer('');
    engine()
      .request<Exercise | null>({ op: 'exercise', target, kind, init: counter * 7919 + kind.length })
      .then((e) => {
        if (!live) return;
        setShown({ exercise: e, id: `${target}:${kind}:${counter}` });
        // An answer checked while this exercise was loading belongs to the exercise shown before; its verdict and text are cleared
        // here, so that the explanation of the new exercise appears only after an answer to it.
        setVerdict(null);
        setAnswer('');
        setError(e ? '' : 'No exercise of this kind is available for this instruction set.');
      })
      .catch((e: unknown) => live && !(e instanceof Cancelled) && setError(String(e)));
    return () => {
      live = false;
    };
  }, [target, kind, counter]);

  const check = (value: string): void => {
    if (!exercise) return;
    const ok = exercise.answers.includes(normalizeAnswer(value));
    setVerdict(ok ? 'right' : 'wrong');
    // Each exercise counts at most once, and only when its first answer is correct: a repeated answer, or one
    // given after the explanation was shown, does not count. Exercises are identified by question number, not by
    // content, and the ones already answered are kept with the counts, so an exercise shown again after the kind
    // is changed and changed back, after a visit to another page, or after a reload is not counted again.
    const { answered, progress } = getState();
    if (answered.includes(shown.id)) return;
    const key = `${exercise.target}:${exercise.kind}`;
    setState({ answered: [...answered, shown.id], progress: ok ? { ...progress, [key]: (progress[key] ?? 0) + 1 } : progress });
  };

  return (
    <div className="page exercises-page">
      <h1>Exercises</h1>
      <p className="lead">
        Short questions generated from the selected instruction set. The expected answer is computed by the same assembler, decoder, and simulator that the rest of
        the application uses. Answers are checked in this browser and the counts below are kept only on this device.
      </p>
      <div className="toolbar" role="group" aria-label="Exercise settings">
        <label>
          Instruction set
          <select aria-label="Instruction set" value={target} onChange={(e) => setState({ target: e.target.value as TargetId })}>
            {availableBackends().map((b) => <option key={b.profile.id} value={b.profile.id}>{TARGET_LABEL[b.profile.id]}</option>)}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Kind of exercise">
          {KINDS.map((k) => (
            <button key={k.id} type="button" className={kind === k.id ? 'is-active' : ''} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>
          ))}
        </div>
      </div>
      <p className="hint">{KINDS.find((k) => k.id === kind)!.text} Correct answers so far for this set and kind: {app.progress[`${target}:${kind}`] ?? 0}.</p>
      {error && <div className="error-box" role="alert">{error}</div>}
      {exercise && (
        <section className="exercise" aria-labelledby="exercise-prompt">
          <p id="exercise-prompt" className="exercise-prompt">{exercise.prompt}</p>
          <pre className="mono exercise-material">{exercise.material.join('\n')}</pre>
          {exercise.given.length > 0 && (
            <table className="plain-table">
              <caption>Values before the instruction</caption>
              <tbody>{exercise.given.map((g) => <tr key={g.name}><th scope="row" className="mono">{g.name}</th><td className="mono">{g.value}</td></tr>)}</tbody>
            </table>
          )}
          {exercise.choices ? (
            <div className="segmented" role="group" aria-label="Answer">
              {exercise.choices.map((c) => <button key={c} type="button" onClick={() => check(c)}>{c}</button>)}
            </div>
          ) : (
            <form onSubmit={(e) => {
              e.preventDefault();
              check(answer);
            }}>
              <label className="block-label" htmlFor="exercise-answer">Your answer</label>
              <input id="exercise-answer" className="mono" value={answer} onChange={(e) => setAnswer(e.target.value)} autoComplete="off" />
              <button type="submit" className="primary">Check</button>
            </form>
          )}
          <div role="status" aria-live="polite">
            {verdict === 'right' && <div className="ok-box">Correct. {exercise.explanation}</div>}
            {verdict === 'wrong' && <div className="error-box">Not this time. {exercise.explanation}</div>}
          </div>
          <button type="button" onClick={() => setCounter(counter + 1)}>Next question</button>
        </section>
      )}
    </div>
  );
}
