/**
 * Automated accessibility checks with axe-core against WCAG 2.1 levels A and
 * AA. Automated rules cover only part of the success criteria; the results
 * are evidence for those rules and not a certification.
 */
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SUMMATION, withProgram } from './helpers.ts';

const ROUTES = ['./', './#/explore/riscv', './#/explore/aarch64/add', './#/explore/x86/add', './#/workspace', './#/compare', './#/assembler/riscv', './#/exercises', './#/about'];
const results: Record<string, { violations: { id: string; impact: string | null; nodes: number }[]; passes: number; incomplete: number }> = {};

test.afterAll(() => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/accessibility.json', JSON.stringify(results, null, 2) + '\n');
});

for (const route of ROUTES) {
  test(`has no automatically detectable WCAG 2.1 A or AA violations: ${route}`, async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto(route);
    await page.waitForTimeout(1500);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    results[route] = {
      violations: r.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
      passes: r.passes.length,
      incomplete: r.incomplete.length,
    };
    expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}
