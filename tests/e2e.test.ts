/**
 * End-to-end agreement of every engine on the corpus: the reference
 * evaluator, the IR interpreter, and the machine-code simulator of every
 * registered target must agree on the outcome and on the state at every
 * boundary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus, repoRoot } from '../scripts/lib/corpus.ts';
import { compileFrontEnd } from '../src/core/compile.ts';
import { generateProgram } from '../src/core/gen/programs.ts';
import { verifyIR } from '../src/core/ir/verify.ts';
import { availableBackends } from '../src/core/target/index.ts';
import { compareTargets, comparisonVerdict } from '../src/core/trace/compare.ts';
import { crossCheck, crossCheckVerdict } from '../src/core/trace/crosscheck.ts';

const backends = availableBackends();
const corpus = loadCorpus({ perFamily: 40 });

describe('corpus', () => {
  it('contains the documented program groups', () => {
    const groups = new Map<string, number>();
    for (const p of corpus) groups.set(p.group, (groups.get(p.group) ?? 0) + 1);
    expect(groups.get('example')).toBe(14);
    expect(groups.get('edge')).toBe(17);
    expect(groups.get('generated')).toBe(200);
  });

  it('is reproduced exactly from the recorded initialization values', () => {
    const a = generateProgram(1234, 'mixed');
    const b = generateProgram(1234, 'mixed');
    expect(a.source).toBe(b.source);
    expect(a.args).toEqual(b.args);
    expect(generateProgram(1235, 'mixed').source).not.toBe(a.source);
  });

  it('compiles to IR that passes the verifier', () => {
    for (const p of corpus) {
      const front = compileFrontEnd(p.source);
      expect(front.ok, p.name).toBe(true);
      expect(verifyIR(front.ir!), p.name).toEqual([]);
    }
  });
});

describe('cross-engine agreement', () => {
  it('has at least one target registered', () => {
    expect(backends.length).toBeGreaterThan(0);
  });

  for (const group of ['example', 'edge', 'generated'] as const) {
    it(`agrees on every ${group} program for ${backends.map((b) => b.profile.id).join(', ')}`, () => {
      let runs = 0;
      const statuses = new Set<string>();
      for (const p of corpus.filter((x) => x.group === group)) {
        for (const args of p.args) {
          const cc = crossCheck(p.source, args, backends);
          expect(cc.failures, `${p.name} ${JSON.stringify(args)}`).toEqual([]);
          expect(cc.ok).toBe(true);
          // Every engine ran to the end, so every boundary and the outcome were compared.
          expect(cc.limitReached, `${p.name} ${JSON.stringify(args)}`).toEqual([]);
          expect(crossCheckVerdict(cc), `${p.name} ${JSON.stringify(args)}`).toBe('agree');
          statuses.add(cc.reference!.status);
          runs++;
        }
      }
      expect(runs).toBeGreaterThan(group === 'generated' ? 400 : 40);
      if (group !== 'example') expect(statuses).toContain('trap');
      expect(statuses).toContain('exited');
    });
  }

  it('reports the unsupported-syntax example with diagnostics instead of compiling it', () => {
    const source = readFileSync(join(repoRoot(), 'examples', 'unsupported.py'), 'utf8');
    const front = compileFrontEnd(source);
    expect(front.ok).toBe(false);
    expect(front.diagnostics.every((d) => d.category === 'unsupported' || d.category === 'semantic')).toBe(true);
    expect(front.diagnostics.length).toBeGreaterThanOrEqual(5);
  });
});

describe('cross-architecture comparison', () => {
  it('aligns targets at statement boundaries with equal variable values', () => {
    const source = readFileSync(join(repoRoot(), 'examples', 'array_traversal.py'), 'utf8');
    const cmp = compareTargets(source, [], backends);
    expect(cmp.outcomesAgree).toBe(true);
    expect(cmp.boundariesAgree).toBe(true);
    expect(cmp.limitReached).toEqual([]);
    expect(comparisonVerdict(cmp)).toBe('agree');
    expect(cmp.boundaries.length).toBeGreaterThan(20);
    for (const run of cmp.runs) {
      const m = run.metrics;
      expect(m.executedInstructions).toBe(m.executedByRegion.startup + m.executedByRegion.main + m.executedByRegion.helper + m.executedByRegion.trap);
      expect(m.staticInstructions).toBe(Object.values(m.staticInstructionsByRegion).reduce((a, b) => a + b, 0));
      expect(m.codeBytes).toBe(Object.values(m.codeBytesByRegion).reduce((a, b) => a + b, 0));
      expect(m.boundaries).toBe(cmp.boundaries.length);
      expect(m.dataLoads).toBeGreaterThan(0);
    }
    // The step index at a boundary never decreases along the sequence.
    for (const run of cmp.runs) {
      let last = -1;
      for (const c of cmp.boundaries) {
        expect(c.steps[run.target]!).toBeGreaterThanOrEqual(last);
        last = c.steps[run.target]!;
      }
    }
  });
});
