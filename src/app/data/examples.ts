/** Example programs bundled with the application, read from the `examples` folder at build time. */
import index from '../../../examples/index.json';

const sources = import.meta.glob('../../../examples/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface Example {
  id: string;
  title: string;
  topic: string;
  source: string;
  args: number[][];
  expectDiagnostics: boolean;
}

export const EXAMPLES: Example[] = (index.examples as { id: string; file: string; title: string; topic: string; args: number[][]; expectDiagnostics?: boolean }[]).map((e) => ({
  id: e.id,
  title: e.title,
  topic: e.topic,
  source: sources[`../../../examples/${e.file}`] ?? '',
  args: e.args,
  expectDiagnostics: e.expectDiagnostics === true,
}));
