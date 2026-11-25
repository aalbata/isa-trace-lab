/**
 * Example of the headless API: compile every example program for every target,
 * run it with its first argument tuple, and print a table of the defined
 * metrics as comma-separated values.
 *
 *   node examples/api/metrics-table.ts > metrics.csv
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableBackends, compileProgram, simulate } from '../../src/core/api.ts';

const dir = join(import.meta.dirname, '..');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
  examples: { id: string; file: string; args: number[][]; expectDiagnostics?: boolean }[];
};

const columns = ['program', 'target', 'status', 'return_value', 'static_instructions', 'code_bytes', 'executed_instructions', 'executed_in_helpers', 'data_loads', 'data_stores'];
console.log(columns.join(','));
for (const example of index.examples) {
  if (example.expectDiagnostics) continue;
  const source = readFileSync(join(dir, example.file), 'utf8');
  for (const backend of availableBackends()) {
    const target = backend.profile.id;
    const compiled = compileProgram(source, target);
    if (!compiled.ok) throw new Error(`${example.id} does not compile for ${target}`);
    const run = simulate(compiled.compiled, target, { args: example.args[0] ?? [] });
    const m = run.metrics;
    console.log([
      example.id, target, run.outcome.status, run.outcome.returnValue ?? '', m.staticInstructions, m.codeBytes,
      m.executedInstructions, m.executedByRegion.helper, m.dataLoads, m.dataStores,
    ].join(','));
  }
}
