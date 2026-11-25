/**
 * Application state shared by the pages: the selected target, the source
 * program, its arguments, and the level of detail. The state is kept in the
 * browser's local storage so that a visit can be resumed; nothing is sent to
 * a server.
 */
import { useSyncExternalStore } from 'react';
import type { TargetId } from '../core/api.ts';
import { EXAMPLES } from './data/examples.ts';

export interface AppState {
  target: TargetId;
  source: string;
  /** Identifier of the example the source was loaded from, or '' after an edit. */
  exampleId: string;
  args: number[];
  /** Reduced-detail view for readers new to the material. */
  beginner: boolean;
  /** Exercises answered correctly, by kind. */
  progress: Record<string, number>;
  /** Exercises whose first answer has been checked, as 'target:kind:question number'; they are not counted again. */
  answered: string[];
}

const KEY = 'isa-trace-lab/state/1';
const first = EXAMPLES.find((e) => e.id === 'summation') ?? EXAMPLES[0]!;

const defaults: AppState = {
  target: 'riscv',
  source: first.source,
  exampleId: first.id,
  args: first.args[0] ?? [],
  beginner: false,
  progress: {},
  answered: [],
};

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<AppState>;
    return {
      ...defaults,
      ...saved,
      args: Array.isArray(saved.args) ? saved.args.map((a) => Number(a) | 0) : defaults.args,
      answered: Array.isArray(saved.answered) ? saved.answered.filter((a) => typeof a === 'string') : defaults.answered,
    };
  } catch {
    return defaults;
  }
}

let state: AppState = load();
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage may be unavailable; the application works without it.
  }
  for (const l of listeners) l();
}

export function clearSavedState(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
  state = defaults;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState);
}
