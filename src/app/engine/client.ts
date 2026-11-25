/**
 * Client of the engine worker. Each request has an identifier; a response
 * settles the matching promise. `restart` terminates the worker and creates a
 * new one, which ends any computation in progress without shared memory and
 * rejects the requests that were pending. A worker that reports an error, for
 * example because its script failed to load, is discarded with its pending
 * requests, and the next request starts a new one.
 */
import type { MachineView, Request, RequestMessage, ResponseMessage } from './protocol.ts';

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (view: MachineView) => void;
}

export class EngineClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Incremented on every restart and on every discarded worker; machines loaded before no longer exist. */
  generation = 0;

  constructor() {
    this.start();
  }

  private start(): Worker {
    const worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ResponseMessage>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if ('progress' in m) {
        p.onProgress?.(m.progress);
        return;
      }
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      if (this.worker !== worker) return;
      this.worker = null;
      this.generation++;
      const error = new Error(e.message || 'the engine worker stopped unexpectedly');
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  request<T>(request: Request, onProgress?: (view: MachineView) => void): Promise<T> {
    const id = this.nextId++;
    const worker = this.worker ?? this.start();
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
      if (onProgress) entry.onProgress = onProgress;
      this.pending.set(id, entry);
      worker.postMessage({ ...request, id } as RequestMessage);
    });
  }

  /** Terminate the worker, reject pending requests, and start a fresh worker. */
  restart(): void {
    this.worker?.terminate();
    for (const p of this.pending.values()) p.reject(new Cancelled());
    this.pending.clear();
    this.generation++;
    this.start();
  }
}

let shared: EngineClient | null = null;

export function engine(): EngineClient {
  if (!shared) shared = new EngineClient();
  return shared;
}
