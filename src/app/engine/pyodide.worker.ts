/// <reference lib="webworker" />
/**
 * Worker for Path A. It loads the pinned Pyodide runtime on the first
 * request, from files served with the application, and uses CPython's own
 * compiler and `dis` module. Submitted source is compiled, never executed.
 */
import { createDisassembler } from '../../bytecode/disassembler.ts';
import type { Disassembler, DisassemblyResult } from '../../bytecode/disassembler.ts';

export interface BytecodeRequest {
  id: number;
  /** Absolute URL of the directory that holds the Pyodide files. */
  indexURL: string;
  source: string;
}

export interface BytecodeResponse {
  id: number;
  ok: boolean;
  result?: DisassemblyResult;
  error?: string;
  /** Milliseconds spent loading the runtime; zero when it was already loaded. */
  loadMs: number;
  /** Milliseconds spent compiling and disassembling. */
  disassembleMs: number;
}

let ready: Promise<Disassembler> | null = null;

async function load(indexURL: string): Promise<Disassembler> {
  const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as { loadPyodide(options: { indexURL: string }): Promise<unknown> };
  const pyodide = await module.loadPyodide({ indexURL });
  return createDisassembler(pyodide as Parameters<typeof createDisassembler>[0]);
}

self.onmessage = async (e: MessageEvent<BytecodeRequest>): Promise<void> => {
  const { id, indexURL, source } = e.data;
  const post = (m: BytecodeResponse): void => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
  const t0 = performance.now();
  let loadMs = 0;
  try {
    if (!ready) {
      ready = load(indexURL);
      const d = await ready;
      loadMs = performance.now() - t0;
      void d;
    }
    const dis = await ready;
    const t1 = performance.now();
    const result = dis.disassemble(source);
    post({ id, ok: true, result, loadMs, disassembleMs: performance.now() - t1 });
  } catch (error) {
    ready = null;
    post({ id, ok: false, error: error instanceof Error ? error.message : String(error), loadMs, disassembleMs: 0 });
  }
};
