/**
 * Example of the headless API: compile the running example for AArch64 and run
 * it, then compile it for every target and compare the four runs at the
 * statement boundaries.
 *
 *   node examples/api/compare-targets.ts
 *
 * Prints the output, return value, and executed instructions of the AArch64
 * run, then the comparison verdict and the executed instructions per target.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  availableBackends, compareTargets, comparisonVerdict,
  compileProgram, simulate,
} from '../../src/core/api.ts';

const file = join(import.meta.dirname, '..', 'array_traversal.py');
const source = readFileSync(file, 'utf8');

const compiled = compileProgram(source, 'aarch64');
if (!compiled.ok) throw new Error(compiled.diagnostics[0].message);
const run = simulate(compiled.compiled, 'aarch64', { args: [] });
const { output, returnValue } = run.outcome;
console.log(output, returnValue, run.metrics.executedInstructions);

const comparison = compareTargets(source, [], availableBackends());
const counts = comparison.runs.map(
  (r) => `${r.target}: ${r.metrics.executedInstructions}`);
console.log(comparisonVerdict(comparison), counts.join(', '));
