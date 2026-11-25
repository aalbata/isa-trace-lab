/**
 * The validation corpus: the example programs, the hand-designed edge cases,
 * and the generated programs. The corpus is a pure function of the files in
 * the repository and of the recorded generator settings.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FAMILIES, GENERATOR_VERSION, generateProgram } from '../../src/core/gen/programs.ts';

export interface CorpusProgram {
  name: string;
  group: 'example' | 'edge' | 'generated';
  family: string;
  source: string;
  args: number[][];
}

export const CORPUS_SETTINGS = {
  generatorVersion: GENERATOR_VERSION,
  /** First initialization value; program k of a family uses firstInit + k. */
  firstInit: 1000,
  programsPerFamily: 200,
  /** Argument tuples of a generated program with parameters; a program without parameters has one, empty, tuple. */
  argumentTuplesPerProgram: 3,
};

export function repoRoot(): string {
  return join(import.meta.dirname, '..', '..');
}

export function loadCorpus(options: { perFamily?: number } = {}): CorpusProgram[] {
  const root = repoRoot();
  const out: CorpusProgram[] = [];
  const examples = JSON.parse(readFileSync(join(root, 'examples', 'index.json'), 'utf8')) as {
    examples: { id: string; file: string; topic: string; args: number[][]; expectDiagnostics?: boolean }[];
  };
  for (const ex of examples.examples) {
    if (ex.expectDiagnostics) continue;
    out.push({ name: `example/${ex.id}`, group: 'example', family: ex.topic, source: readFileSync(join(root, 'examples', ex.file), 'utf8'), args: ex.args });
  }
  const edgeDir = join(root, 'validation', 'corpus', 'edge');
  const edgeArgs = JSON.parse(readFileSync(join(edgeDir, 'args.json'), 'utf8')) as Record<string, number[][]>;
  for (const file of readdirSync(edgeDir).filter((f) => f.endsWith('.py')).sort()) {
    const id = file.replace(/\.py$/, '');
    out.push({ name: `edge/${id}`, group: 'edge', family: 'edge', source: readFileSync(join(edgeDir, file), 'utf8'), args: edgeArgs[id] ?? [[]] });
  }
  const per = options.perFamily ?? CORPUS_SETTINGS.programsPerFamily;
  for (const family of FAMILIES) {
    for (let k = 0; k < per; k++) {
      const g = generateProgram(CORPUS_SETTINGS.firstInit + k, family, CORPUS_SETTINGS.argumentTuplesPerProgram);
      out.push({ name: `generated/${family}-${g.init}`, group: 'generated', family, source: g.source, args: g.args });
    }
  }
  return out;
}
