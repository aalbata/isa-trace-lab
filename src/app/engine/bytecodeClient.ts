/**
 * Client of the Pyodide worker. The worker is created on first use, so the
 * runtime (about 13 MB of files served with the application) is downloaded
 * only when the bytecode view is opened. A newer request supersedes an older
 * one; `cancel` terminates the worker. A worker that reports an error, for
 * example because its script failed to load, is discarded with its pending
 * requests, and the next request starts a new one.
 */
import type { BytecodeRequest, BytecodeResponse } from './pyodide.worker.ts';

export class BytecodeClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve(r: BytecodeResponse): void; reject(e: Error): void }>();

  /** URL of the directory with the Pyodide files, next to the application's index page. */
  static indexURL(): string {
    return new URL('pyodide/', document.baseURI).href;
  }

  disassemble(source: string): Promise<BytecodeResponse> {
    if (!this.worker) {
      const worker = new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<BytecodeResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        p.resolve(e.data);
      };
      worker.onerror = (e) => {
        worker.terminate();
        if (this.worker !== worker) return;
        this.worker = null;
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'the bytecode worker failed to load'));
        this.pending.clear();
      };
      this.worker = worker;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: BytecodeRequest = { id, indexURL: BytecodeClient.indexURL(), source };
      this.worker!.postMessage(request);
    });
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
  }
}

let shared: BytecodeClient | null = null;

export function bytecode(): BytecodeClient {
  if (!shared) shared = new BytecodeClient();
  return shared;
}
