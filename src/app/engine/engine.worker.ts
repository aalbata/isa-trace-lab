/// <reference lib="webworker" />
/**
 * Engine worker. All parsing, compilation, assembly, and simulation requested
 * by the interface runs here, off the main thread. Long runs are executed in
 * slices; between slices the worker returns to its message loop, so a pause
 * request takes effect without shared memory. The interface can also end any
 * work by terminating the worker and creating a new one.
 */
import {
  assembleText, compareTargets, comparisonVerdict, compile, compiledProgramDocument, decodeBytes, formatIR, getBackend, recordTrace,
} from '../../core/api.ts';
import { makeExercise, runDemo } from '../../core/learn.ts';
import { Debugger, listingOf } from '../../core/debugger.ts';
import type { AssembleResponse, CompareResponse, CompileResponse, MachineView, MemoryWindow, RequestMessage, ResponseMessage } from './protocol.ts';

/**
 * Loaded machines. `windows` holds the memory windows of the latest run or view request, which the
 * views of a run in progress use, so a region chosen during the run is kept.
 */
const machines = new Map<string, { control: Debugger; busy: boolean; pause: boolean; windows: MemoryWindow[] }>();
const post = (m: ResponseMessage): void => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const SLICE = 200_000;

function viewOf(name: string, windows?: MemoryWindow[]): MachineView {
  const entry = machines.get(name);
  if (!entry) throw new Error(`machine '${name}' is not loaded`);
  return { ...(entry.control.view(windows ?? []) as Omit<MachineView, 'machine' | 'busy'>), machine: name, busy: entry.busy };
}

function requireIdle(name: string): Debugger {
  const entry = machines.get(name);
  if (!entry) throw new Error(`machine '${name}' is not loaded`);
  if (entry.busy) throw new Error('the program is running; pause it first');
  return entry.control;
}

const yieldToMessages = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function handle(msg: RequestMessage): Promise<unknown> {
  switch (msg.op) {
    case 'compile': {
      const backend = getBackend(msg.target);
      const r = compile(msg.source, backend);
      const out: CompileResponse = {
        ok: r.ok, diagnostics: r.diagnostics, target: msg.target,
        document: r.ok ? compiledProgramDocument(backend, r.compiled) : null,
        irText: r.front.ir ? formatIR(r.front.ir) : '',
        parameters: r.front.checked.main?.params.map((p) => p.name) ?? [],
      };
      return out;
    }
    case 'load': {
      const backend = getBackend(msg.target);
      const r = compile(msg.source, backend);
      if (!r.ok) throw new Error('the program has errors and cannot be loaded');
      machines.set(msg.machine, { control: new Debugger(backend, { compiled: r.compiled }, { args: msg.args }), busy: false, pause: false, windows: [] });
      return viewOf(msg.machine, msg.memory);
    }
    case 'loadAssembly': {
      const backend = getBackend(msg.target);
      const r = assembleText(backend, msg.text);
      if (!r.ok) throw new Error(r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
      machines.set(msg.machine, { control: new Debugger(backend, { program: r.program }), busy: false, pause: false, windows: [] });
      return viewOf(msg.machine, msg.memory);
    }
    case 'step':
      requireIdle(msg.machine).step(Math.max(1, Math.min(msg.count, 1_000_000)));
      return viewOf(msg.machine, msg.memory);
    case 'stepSource':
      requireIdle(msg.machine).stepSource();
      return viewOf(msg.machine, msg.memory);
    case 'back':
      requireIdle(msg.machine).back(msg.count);
      return viewOf(msg.machine, msg.memory);
    case 'backSource':
      requireIdle(msg.machine).backSource();
      return viewOf(msg.machine, msg.memory);
    case 'reset':
      requireIdle(msg.machine).reset();
      return viewOf(msg.machine, msg.memory);
    case 'view': {
      const entry = machines.get(msg.machine);
      if (entry && msg.memory) entry.windows = msg.memory;
      return viewOf(msg.machine, msg.memory);
    }
    case 'run': {
      const entry = machines.get(msg.machine);
      if (!entry) throw new Error(`machine '${msg.machine}' is not loaded`);
      if (entry.busy) throw new Error('the program is already running');
      entry.busy = true;
      entry.pause = false;
      entry.windows = msg.memory ?? [];
      let lastProgress = performance.now();
      try {
        for (;;) {
          const more = entry.control.runSlice(SLICE);
          if (!more) break;
          await yieldToMessages();
          // The machine may have been replaced or closed while the worker handled other messages.
          if (machines.get(msg.machine) !== entry) return null;
          if (entry.pause) {
            entry.control.stopReason = 'paused';
            break;
          }
          if (performance.now() - lastProgress > 120) {
            lastProgress = performance.now();
            post({ id: msg.id, progress: viewOf(msg.machine, entry.windows) });
          }
        }
      } finally {
        entry.busy = false;
      }
      return viewOf(msg.machine, entry.windows);
    }
    case 'pause': {
      const entry = machines.get(msg.machine);
      if (entry) entry.pause = true;
      return null;
    }
    case 'poke': {
      const ok = requireIdle(msg.machine).poke(msg.address, msg.bytes);
      if (!ok) throw new Error('the address is outside the mapped memory regions');
      return viewOf(msg.machine, msg.memory);
    }
    case 'setRegister':
      requireIdle(msg.machine).setRegister(msg.name, msg.value);
      return viewOf(msg.machine, msg.memory);
    case 'setFlag':
      requireIdle(msg.machine).setFlag(msg.name, msg.value);
      return viewOf(msg.machine, msg.memory);
    case 'setBreakpoints': {
      const entry = machines.get(msg.machine);
      if (entry) entry.control.setBreakpoints(msg.addresses, msg.lines);
      return null;
    }
    case 'close':
      machines.delete(msg.machine);
      return null;
    case 'compare': {
      const backends = msg.targets.map((t) => getBackend(t));
      const cmp = compareTargets(msg.source, msg.args, backends);
      const out: CompareResponse = {
        ok: cmp.front.ok, diagnostics: cmp.front.diagnostics,
        runs: cmp.runs.map((r) => ({ target: r.target, outcome: r.outcome, metrics: r.metrics, document: compiledProgramDocument(getBackend(r.target), r.compiled) })),
        boundaries: cmp.boundaries, boundariesTruncated: cmp.boundariesTruncated, outcomesAgree: cmp.outcomesAgree, boundariesAgree: cmp.boundariesAgree,
        limitReached: cmp.limitReached, verdict: comparisonVerdict(cmp),
      };
      return out;
    }
    case 'assemble': {
      const backend = getBackend(msg.target);
      const r = assembleText(backend, msg.text);
      const out: AssembleResponse = r.ok
        ? { ok: true, errors: [], listing: listingOf(r.program), bytes: Array.from(r.program.bytes), base: r.program.base }
        : { ok: false, errors: r.errors, listing: [], bytes: [], base: 0 };
      return out;
    }
    case 'decode':
      return decodeBytes(msg.target, Uint8Array.from(msg.bytes), msg.address);
    case 'demo': {
      const d = runDemo(getBackend(msg.target), msg.text, { registers: msg.registers, memory: msg.memory, flags: msg.flags });
      return {
        ok: d.ok, message: d.message, listing: d.listing, before: d.before, after: d.after, events: d.events, fault: d.fault,
        decoded: decodeBytes(msg.target, Uint8Array.from(d.listing.flatMap((l) => l.bytes))),
      };
    }
    case 'exercise':
      return makeExercise(getBackend(msg.target), msg.kind, msg.init);
    case 'trace': {
      const backend = getBackend(msg.target);
      const r = compile(msg.source, backend);
      if (!r.ok) throw new Error('the program has errors and cannot be traced');
      return recordTrace(backend, r.compiled, { args: msg.args, maxTraceSteps: msg.maxTraceSteps });
    }
  }
}

self.onmessage = (e: MessageEvent<RequestMessage>): void => {
  const msg = e.data;
  handle(msg).then(
    (result) => post({ id: msg.id, ok: true, result }),
    (error: unknown) => post({ id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
};
