/**
 * React hook for one simulated machine in the engine worker.
 * Every response is tagged with the load it belongs to, so a result that
 * arrives after the program was reloaded is ignored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TargetId } from '../../core/api.ts';
import { LAYOUT } from '../../core/target/memory.ts';
import type { MemoryRegionChoice } from '../components/StateViews.tsx';
import { Cancelled, engine } from './client.ts';
import type { MachineView, MemoryWindow, Request } from './protocol.ts';

const WINDOW_BYTES = 256;

export interface MachineControl {
  view: MachineView | null;
  error: string;
  /** Information about a recovery action, such as a restart of the worker. */
  notice: string;
  /** True while a full-speed run is in progress in the worker. */
  running: boolean;
  /** True while stepping automatically at the selected speed. */
  playing: boolean;
  region: MemoryRegionChoice;
  setRegion(r: MemoryRegionChoice): void;
  load(target: TargetId, source: string, args: number[]): Promise<void>;
  loadAssembly(target: TargetId, text: string): Promise<void>;
  unload(): void;
  step(count?: number): void;
  stepSource(): void;
  back(count?: number): void;
  backSource(): void;
  run(): void;
  pause(): void;
  play(stepsPerSecond: number, bySource: boolean): void;
  reset(): void;
  poke(address: number, bytes: number[]): void;
  setRegister(name: string, value: bigint): void;
  setFlag(name: string, value: number): void;
  setBreakpoints(addresses: number[], lines: number[]): void;
}

export function useMachine(machineId: string, stackPointerName: string): MachineControl {
  const [view, setView] = useState<MachineView | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  /** Number of full-speed runs started, so that a pause can tell its run from a later one. */
  const runCount = useRef(0);
  const lastLoad = useRef<Request | null>(null);
  const [playing, setPlaying] = useState(false);
  const [region, setRegionState] = useState<MemoryRegionChoice>('data');
  const epoch = useRef(0);
  const regionRef = useRef<MemoryRegionChoice>('data');
  const viewRef = useRef<MachineView | null>(null);
  const timer = useRef<number | null>(null);
  const spName = useRef(stackPointerName);
  spName.current = stackPointerName;
  viewRef.current = view;

  const windows = useCallback((): MemoryWindow[] => {
    const v = viewRef.current;
    switch (regionRef.current) {
      case 'data':
        return [{ address: LAYOUT.dataBase, length: WINDOW_BYTES }];
      case 'code': {
        const pc = v?.pc ?? LAYOUT.codeBase;
        const start = Math.max(LAYOUT.codeBase, Math.min(pc - (pc % 16) - 32, LAYOUT.codeBase + LAYOUT.codeSize - WINDOW_BYTES));
        return [{ address: start, length: WINDOW_BYTES }];
      }
      case 'stack': {
        const sp = v ? Number(BigInt.asUintN(32, v.registers.find((r) => r.name === spName.current)?.value ?? BigInt(LAYOUT.stackTop))) : LAYOUT.stackTop;
        const base = LAYOUT.stackTop - LAYOUT.stackSize;
        const start = Math.max(base, Math.min(sp - (sp % 16) - 64, LAYOUT.stackTop - WINDOW_BYTES));
        return [{ address: start, length: WINDOW_BYTES }];
      }
    }
  }, []);

  const send = useCallback(
    (request: Request, onProgress?: (v: MachineView) => void): Promise<void> => {
      const mine = epoch.current;
      return engine()
        .request<MachineView | null>(request, onProgress ? (v) => mine === epoch.current && onProgress(v) : undefined)
        .then((v) => {
          if (mine !== epoch.current) return;
          if (v) setView(v);
          setError('');
        })
        .catch((e: unknown) => {
          if (mine !== epoch.current || e instanceof Cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    },
    [],
  );

  const stopPlaying = useCallback((): void => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
  }, []);

  useEffect(() => () => {
    stopPlaying();
    epoch.current++;
    void engine().request({ op: 'close', machine: machineId }).catch(() => undefined);
  }, [machineId, stopPlaying]);

  const setRunningBoth = (value: boolean): void => {
    runningRef.current = value;
    setRunning(value);
  };

  const control: MachineControl = {
    view,
    error,
    notice,
    running,
    playing,
    region,
    setRegion(r) {
      regionRef.current = r;
      setRegionState(r);
      if (viewRef.current) void send({ op: 'view', machine: machineId, memory: windows() });
    },
    async load(target, source, args) {
      stopPlaying();
      epoch.current++;
      setRunningBoth(false);
      setNotice('');
      lastLoad.current = { op: 'load', machine: machineId, target, source, args };
      await send({ op: 'load', machine: machineId, target, source, args, memory: windows() });
    },
    async loadAssembly(target, text) {
      stopPlaying();
      epoch.current++;
      setRunningBoth(false);
      setNotice('');
      lastLoad.current = { op: 'loadAssembly', machine: machineId, target, text };
      await send({ op: 'loadAssembly', machine: machineId, target, text, memory: windows() });
    },
    unload() {
      stopPlaying();
      epoch.current++;
      setView(null);
      setError('');
      setRunningBoth(false);
      lastLoad.current = null;
    },
    step(count = 1) {
      void send({ op: 'step', machine: machineId, count, memory: windows() });
    },
    stepSource() {
      void send({ op: 'stepSource', machine: machineId, memory: windows() });
    },
    back(count = 1) {
      void send({ op: 'back', machine: machineId, count, memory: windows() });
    },
    backSource() {
      void send({ op: 'backSource', machine: machineId, memory: windows() });
    },
    run() {
      stopPlaying();
      runCount.current++;
      setRunningBoth(true);
      const mine = epoch.current;
      void send({ op: 'run', machine: machineId, memory: windows() }, (v) => setView(v)).finally(() => {
        if (mine === epoch.current) setRunningBoth(false);
      });
    },
    pause() {
      stopPlaying();
      const mine = epoch.current;
      const paused = runCount.current;
      const wasRunning = runningRef.current;
      void engine().request({ op: 'pause', machine: machineId }).catch(() => undefined);
      if (!wasRunning) return;
      // The worker checks for a pause between slices of a run. If the paused run has not stopped after 1.5 s,
      // the worker is terminated and a new one is started, and the program is loaded again from the start.
      // A run started after the paused one stopped is not affected.
      window.setTimeout(() => {
        if (mine !== epoch.current || paused !== runCount.current || !runningRef.current) return;
        engine().restart();
        epoch.current++;
        setRunningBoth(false);
        setView(null);
        setNotice('The run did not stop in time, so the simulator worker was restarted and the program was loaded again from the start.');
        const again = lastLoad.current;
        if (again) void send({ ...again, memory: windows() } as Request);
      }, 1500);
    },
    play(stepsPerSecond, bySource) {
      stopPlaying();
      setPlaying(true);
      let busy = false;
      timer.current = window.setInterval(() => {
        const v = viewRef.current;
        if (!v || v.status !== 'running') {
          stopPlaying();
          return;
        }
        if (busy) return;
        busy = true;
        void send(bySource ? { op: 'stepSource', machine: machineId, memory: windows() } : { op: 'step', machine: machineId, count: 1, memory: windows() }).finally(() => {
          busy = false;
        });
      }, Math.max(20, Math.round(1000 / stepsPerSecond)));
    },
    reset() {
      stopPlaying();
      void send({ op: 'reset', machine: machineId, memory: windows() });
    },
    poke(address, bytes) {
      void send({ op: 'poke', machine: machineId, address, bytes, memory: windows() });
    },
    setRegister(name, value) {
      void send({ op: 'setRegister', machine: machineId, name, value, memory: windows() });
    },
    setFlag(name, value) {
      void send({ op: 'setFlag', machine: machineId, name, value, memory: windows() });
    },
    setBreakpoints(addresses, lines) {
      void engine().request({ op: 'setBreakpoints', machine: machineId, addresses, lines }).catch(() => undefined);
    },
  };
  return control;
}
