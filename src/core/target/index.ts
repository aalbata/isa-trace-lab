/** Registry of the target backends. */
import { aarch64 } from './aarch64/index.ts';
import { mips } from './mips/index.ts';
import { riscv } from './riscv/index.ts';
import type { Backend, TargetId } from './types.ts';
import { x86 } from './x86/index.ts';

export const BACKENDS: Partial<Record<TargetId, Backend>> = {
  riscv,
  aarch64,
  mips,
  x86,
};

export const TARGET_ORDER: TargetId[] = ['riscv', 'mips', 'aarch64', 'x86'];

/** Backends that are available, in display order. */
export function availableBackends(): Backend[] {
  return TARGET_ORDER.map((id) => BACKENDS[id]).filter((b): b is Backend => b !== undefined);
}

export function getBackend(id: string): Backend {
  const b = BACKENDS[id as TargetId];
  if (!b) throw new Error(`unknown target '${id}'; available targets: ${availableBackends().map((x) => x.profile.id).join(', ')}`);
  return b;
}
