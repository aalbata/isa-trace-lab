import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import { bytecodeNote } from '../../src/app/data/bytecodeNotes.ts';
import { TARGET_LABEL } from '../../src/app/components/format.ts';
import { DEFAULT_LIMITS, availableBackends, compareTargets, comparisonVerdict } from '../../src/core/api.ts';
import { makeExercise } from '../../src/core/learn.ts';
import { getBackend } from '../../src/core/target/index.ts';
import { ENDLESS, STATE_KEY, SUMMATION, withProgram } from './helpers.ts';

const machine = (page: Page) => page.locator('section[aria-labelledby="machine-heading"]');

/** Rows of the explorer's worked state change: register name, value before, value after. */
async function stateRows(page: Page): Promise<string[][]> {
  return page.getByRole('region', { name: 'Register values before and after the example' }).locator('tbody tr').evaluateAll((rows) =>
    rows.map((r) => [r.children[0]?.textContent ?? '', r.children[1]?.textContent ?? '', r.children[2]?.childNodes[0]?.textContent ?? '']));
}

async function savedState(page: Page): Promise<{ source: string; args: number[]; progress: Record<string, number>; answered: string[] }> {
  return page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '{}'), STATE_KEY);
}

// One multiplication by a large constant per iteration. RV32I has no multiply instruction and multiplies in a
// runtime helper, so it executes about fifteen times the instructions of the other targets.
const MULTIPLY_LOOP = 'def main(n):\n    x = 1\n    for i in range(n):\n        x = x * 1103515245 + 12345\n    return x\n';
const ENDLESS_MULTIPLY = 'def main():\n    x = 1\n    while True:\n        x = x * 1103515245 + 12345\n';

interface WorkerUse {
  /** Operations of the requests sent to a worker, in order. */
  ops: string[];
  /** Number of workers that the page terminated. */
  terminated: number;
}

/** Record, from the next page load on, the requests that the page sends to its workers and the workers it terminates. */
async function watchWorkers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const use: WorkerUse = { ops: [], terminated: 0 };
    (window as unknown as { workerUse: WorkerUse }).workerUse = use;
    const { postMessage, terminate } = Worker.prototype;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]): void {
      const op = (message as { op?: unknown } | null)?.op;
      if (typeof op === 'string') use.ops.push(op);
      (postMessage as (...a: unknown[]) => void).call(this, message, ...rest);
    };
    Worker.prototype.terminate = function (this: Worker): void {
      use.terminated++;
      terminate.call(this);
    };
  });
}

async function workerUse(page: Page): Promise<WorkerUse> {
  return page.evaluate(() => (window as unknown as { workerUse: WorkerUse }).workerUse);
}

test.describe('start page', () => {
  test('the start page counts the general-purpose registers of each profile', async ({ page }) => {
    await page.goto('./');
    const card = (name: string) => page.locator('.target-card', { has: page.getByRole('heading', { level: 3, name }) });
    // AArch64 has thirty-one general-purpose registers, x0 to x30, and a stack pointer that is not one of them.
    await expect(card('Arm AArch64 (A64)')).toContainText('31 general-purpose and a separate stack pointer, 64 bits');
    await expect(card('RISC-V RV32I')).toContainText('32 general-purpose, 32 bits');
    await expect(card('MIPS32 Release 2')).toContainText('32 general-purpose, 32 bits');
    await expect(card('x86-64')).toContainText('16 general-purpose, 64 bits');
  });
});

test.describe('about page', () => {
  test('the statement about local storage names every kind of saved data', async ({ page }) => {
    await page.goto('./#/exercises');
    const first = makeExercise(getBackend('riscv'), 'register', 1 * 7919 + 'register'.length)!;
    await page.getByLabel('Your answer').fill(first.answers[0]!);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.ok-box')).toContainText('Correct.');
    // The saved state holds these items and no others.
    expect(Object.keys(await savedState(page)).sort()).toEqual(['answered', 'args', 'beginner', 'exampleId', 'progress', 'source', 'target']);
    await page.goto('./#/about');
    await expect(page.locator('.about-page li', { hasText: 'local storage' })).toHaveText(
      "The selected instruction set, the current program, its arguments, the level of detail, the exercises already answered, and exercise counts are kept in this browser's local storage so that a visit can be resumed.",
    );
  });

  test('the licence paragraph names the third-party libraries inside the Pyodide runtime', async ({ page }) => {
    await page.goto('./#/about');
    const paragraph = page.locator('.about-page h2:has-text("Licences") + p');
    await expect(paragraph).toHaveText(
      'ISA Trace Lab is released under the MIT licence. The bundled Pyodide runtime is distributed under the Mozilla Public License 2.0. '
      + 'It includes CPython under the Python Software Foundation License and further third-party libraries, among them libffi, libmpdec, expat, zstd, zlib, musl '
      + 'and the LLVM runtime libraries, each under its own licence. CodeMirror and React are distributed under the MIT licence. '
      + 'The full notices are in the repository and in the third-party notice file shipped with the site.',
    );
    // The notice file that the paragraph links to has an entry for each library it names.
    const notices = readFileSync('public/THIRD_PARTY_NOTICES.txt', 'utf8').toLowerCase();
    for (const name of ['libffi', 'libmpdec', 'expat', 'zstd', 'zlib', 'musl', 'llvm']) expect(notices, name).toContain(name);
    await expect(paragraph.getByRole('link', { name: 'third-party notice file' })).toHaveAttribute('href', 'THIRD_PARTY_NOTICES.txt');
  });
});

test.describe('instruction-set explorer', () => {
  test('the worked state change shows the profile register that a W or 32-bit name refers to', async ({ page }) => {
    // add w0, w1, w2 with w1 = 12 and w2 = 5: w1 and w2 are the low halves of x1 and x2.
    await page.goto('./#/explore/aarch64/add');
    await expect.poll(() => stateRows(page)).toEqual([
      ['x1', '0x000000000000000c', '0x000000000000000c'],
      ['x2', '0x0000000000000005', '0x0000000000000005'],
      ['x0', '0x0000000000000000', '0x0000000000000011'],
      ['Flags N Z C V', '0 0 0 0', '0 0 0 0'],
    ]);
    // add eax, ebx with eax = 12 and ebx = 5: eax and ebx are the low halves of rax and rbx.
    await page.goto('./#/explore/x86/add');
    await expect.poll(async () => (await stateRows(page)).filter((r) => !r[0]!.startsWith('Flags'))).toEqual([
      ['rax', '0x000000000000000c', '0x0000000000000011'],
      ['rbx', '0x0000000000000005', '0x0000000000000005'],
    ]);
  });

  test('register inputs keep a typed minus sign and values above 2^31 - 1', async ({ page }) => {
    await page.goto('./#/explore/riscv/add');
    const a1 = page.getByRole('group', { name: 'Initial register values' }).getByLabel('a1');
    await expect(a1).toHaveValue('12');
    await a1.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-5');
    await expect(a1).toHaveValue('-5');
    await expect.poll(async () => (await stateRows(page)).find((r) => r[0] === 'a1')).toEqual(['a1', '0xfffffffb', '0xfffffffb']);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('4294967295');
    await expect(a1).toHaveValue('4294967295');
    await expect.poll(async () => (await stateRows(page)).find((r) => r[0] === 'a1')).toEqual(['a1', '0xffffffff', '0xffffffff']);
    await page.keyboard.press('Tab');
    await expect(a1).toHaveValue('4294967295');

    // On a 64-bit register the value is the 32-bit pattern, zero-extended.
    await page.goto('./#/explore/x86/add');
    const eax = page.getByRole('group', { name: 'Initial register values' }).getByLabel('eax');
    await eax.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('4294967295');
    await expect(eax).toHaveValue('4294967295');
    await expect.poll(async () => (await stateRows(page)).find((r) => r[0] === 'rax')?.slice(0, 2)).toEqual(['rax', '0x00000000ffffffff']);
  });

  test('the operations view assembles each sequence once and keeps the result', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { assembleRequests: number };
      w.assembleRequests = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
        if ((message as { op?: string } | null)?.op === 'assemble') w.assembleRequests++;
        return (post as (...a: unknown[]) => void).call(this, message, ...rest);
      };
    });
    const requests = (): Promise<number> => page.evaluate(() => (window as unknown as { assembleRequests: number }).assembleRequests);
    await page.goto('./#/explore/riscv/~operations');
    const cards = page.locator('.operation-card');
    await expect(cards).toHaveCount(4);
    await expect(cards.locator('table')).toHaveCount(4);
    await expect(cards.locator('tfoot')).toHaveText(Array(4).fill(/^Total\d+ instructions?, \d+ bytes$/));
    const settled = await requests();
    expect(settled).toBe(4);
    await page.waitForTimeout(1000);
    expect(await requests()).toBe(settled);
    await expect(cards.locator('table')).toHaveCount(4);

    // Another operation is assembled once per target, plus one retry each that defines the branch label 'target'.
    await page.getByLabel('Operation').selectOption('branch-less-than');
    await expect.poll(requests).toBe(settled + 8);
    await expect(cards.locator('table')).toHaveCount(4);
    await expect(cards.locator('pre')).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(await requests()).toBe(settled + 8);
    await expect(cards.locator('table')).toHaveCount(4);
  });
});

test.describe('comparison', () => {
  test('the boundary table describes the instructions from each boundary to the next', async ({ page }) => {
    const cmp = compareTargets(SUMMATION, [3], availableBackends());
    const ids = cmp.runs.map((r) => r.target);
    const expected = cmp.boundaries.slice(0, 4).map((c, k) => {
      const next = cmp.boundaries[k + 1];
      const cells = ids.map((id) => String((next ? next.steps[id]! : cmp.runs.find((r) => r.target === id)!.metrics.executedInstructions) - c.steps[id]!));
      return [String(c.ordinal + 1), String(c.line), ...cells, c.agree ? 'yes' : 'no'];
    });
    // The first statement, total = 0, is one instruction on every target.
    expect(expected[0]!.slice(2, 6)).toEqual(['1', '1', '1', '1']);

    await withProgram(page, { source: SUMMATION, args: [3] });
    await page.goto('./#/compare');
    const region = page.getByRole('region', { name: 'Sequence of statement boundaries' });
    await expect(region).toBeVisible();
    const hint = page.locator('h2:has-text("Sequence of statement boundaries") + p.hint');
    await expect(hint).toContainText('The numbers are the instructions each target executes from this boundary until the next one');
    await expect(hint).toContainText('Instructions executed before the first boundary, in the startup stub and the prologue of main, are not counted in any row.');
    await expect(hint).not.toContainText('since the previous boundary');
    const rows = await region.locator('tbody tr').evaluateAll((rs) => rs.slice(0, 4).map((r) => [...r.children].map((c) => c.textContent ?? '')));
    expect(rows).toEqual(expected);
  });

  test('a synchronized run disables the other controls and can be paused', async ({ page }) => {
    // The comparison of an endless program runs every target to the instruction limit before the machines load.
    test.setTimeout(180_000);
    await withProgram(page, { source: ENDLESS });
    await page.goto('./#/compare');
    const run = page.getByRole('button', { name: 'Run every target to the end' });
    await expect(run).toBeEnabled({ timeout: 120_000 });
    await run.click();
    const pause = page.getByRole('button', { name: 'Pause' });
    await expect(pause).toBeVisible();
    // Each target runs for about a second; the states are read in one step so that the pause follows at once.
    const controls = await page.locator('.compare-page button').evaluateAll((bs) => bs.map((b) => `${b.textContent}: ${(b as HTMLButtonElement).disabled ? 'disabled' : 'enabled'}`));
    expect(controls).toEqual([
      'Step one statement on every target: disabled',
      'Pause: enabled',
      'Reset every target: disabled',
      ...Array(4).fill('Step one instruction here: disabled'),
    ]);
    await pause.click();
    await expect(run).toBeEnabled();
    await expect(page.locator('.error-box')).toHaveCount(0);
    // The run stopped before it reached every target.
    const statuses = await page.locator('.sync-card .status').allTextContents();
    expect(statuses.some((s) => /^paused at|limit/.test(s)), statuses.join(' | ')).toBe(true);
    expect(statuses.some((s) => s.startsWith('ready at 0x00400000')), statuses.join(' | ')).toBe(true);
    await page.getByRole('button', { name: 'Reset every target' }).click();
    await expect(page.locator('.sync-card .status', { hasText: 'ready at 0x00400000' })).toHaveCount(4);
    await expect(page.locator('.error-box')).toHaveCount(0);
  });

  test('a comparison in which only RV32I stops at the instruction limit is incomplete and not a disagreement', async ({ page }) => {
    const cmp = compareTargets(MULTIPLY_LOOP, [60000], availableBackends());
    expect(cmp.limitReached).toEqual(['riscv']);
    expect(comparisonVerdict(cmp)).toBe('incomplete');
    const riscv = cmp.runs.find((r) => r.target === 'riscv')!;
    const mips = cmp.runs.find((r) => r.target === 'mips')!;
    expect(riscv.metrics.executedInstructions).toBe(DEFAULT_LIMITS.maxSteps);
    expect(mips.outcome.status).toBe('exited');
    // RV32I passed more boundaries than the comparison keeps, and fewer than the targets that ran to the end.
    const compared = cmp.boundaries.filter((c) => c.steps.riscv !== undefined).length;
    expect(compared).toBeLessThan(riscv.metrics.boundaries);
    expect(riscv.metrics.boundaries).toBeLessThan(mips.metrics.boundaries);

    await withProgram(page, { source: MULTIPLY_LOOP, args: [60000] });
    await page.goto('./#/compare');
    const verdict = page.locator('h2:has-text("Outcome") + div');
    await expect(verdict).toHaveText(
      `The comparison is incomplete. RISC-V RV32I stopped at the instruction limit after ${DEFAULT_LIMITS.maxSteps} instructions and was compared on the first ${compared} of the ${riscv.metrics.boundaries} statement boundaries it reached. `
      + 'The targets that ran to the end ended the same way with the same output and return value. '
      + 'No disagreement was found at the boundaries compared. What a stopped target would do after the limit was not compared.',
    );
    await expect(verdict).toHaveClass('warning-box');
    await expect(page.locator('.error-box')).toHaveCount(0);
    await expect(page.locator('.ok-box')).toHaveCount(0);
    const outcomes = page.getByRole('region', { name: 'Outcome per target' }).locator('tbody tr td:nth-child(2)');
    await expect(outcomes).toHaveText(['stopped at the instruction limit', ...Array(3).fill(`main returned ${mips.outcome.returnValue}`)]);
    // The machines load after an incomplete comparison as after a complete one.
    await expect(page.getByRole('button', { name: 'Step one statement on every target' })).toBeEnabled();
  });

  test('the comparison of a program that never ends stops every target at the instruction limit', async ({ page }) => {
    await withProgram(page, { source: ENDLESS_MULTIPLY });
    await page.goto('./#/compare');
    const verdict = page.locator('h2:has-text("Outcome") + div');
    // Four runs of at most 5,000,000 instructions take a few seconds. A limit counted in statements would let RV32I
    // run about a hundred times as many instructions.
    await expect(verdict).toBeVisible({ timeout: 30_000 });
    await expect(verdict).toHaveClass('warning-box');
    await expect(verdict).toContainText('The comparison is incomplete.');
    for (const b of availableBackends()) {
      await expect(verdict).toContainText(`${TARGET_LABEL[b.profile.id]} stopped at the instruction limit after ${DEFAULT_LIMITS.maxSteps} instructions and was compared on the first 5000 of the `);
    }
    await expect(verdict).not.toContainText('ended the same way');
    await expect(page.locator('.error-box')).toHaveCount(0);
    await expect(page.locator('.ok-box')).toHaveCount(0);
  });

  test('the comparison runs with one argument per parameter of main whatever arguments are stored', async ({ page }) => {
    const verdict = page.locator('h2:has-text("Outcome") + div');
    const shown = page.locator('.compare-page .toolbar > span').first();
    const results = page.getByRole('region', { name: 'Outcome per target' }).locator('tbody tr td:nth-child(2)');
    // Program, stored arguments, arguments after the page has loaded, the text that shows them, value that main returns.
    const stored: [string, number[], number[], string, number][] = [
      [SUMMATION, [], [0], '0', 0],
      [SUMMATION, [3, 9], [3], '3', 6],
      ['def main():\n    return 7\n', [5], [], 'none', 7],
      ['def main(a, b):\n    return a - b\n', [4], [4, 0], '4, 0', 4],
    ];
    for (const [source, args, fitted, text, value] of stored) {
      await page.goto('about:blank');
      await withProgram(page, { source, args });
      await page.goto('./#/compare');
      await expect(verdict, source).toHaveClass('ok-box');
      await expect(results).toHaveText(Array(4).fill(`main returned ${value}`));
      await expect(shown).toHaveText(`Arguments of main: ${text}`);
      expect((await savedState(page)).args).toEqual(fitted);
      // The machines are loaded with the same arguments, so they reach the same result.
      await page.getByRole('button', { name: 'Run every target to the end' }).click();
      await expect(page.locator('.sync-card .status', { hasText: `main returned ${value} after` })).toHaveCount(4);
      await expect(page.locator('.error-box')).toHaveCount(0);
    }
  });

  test('leaving the page cancels a comparison that is still running and leaves a finished one alone', async ({ page }) => {
    await watchWorkers(page);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    const compiled = page.getByText('No errors. Compiled for RISC-V RV32I.');

    // A comparison that has ended: the worker is kept when the page is left.
    await withProgram(page, { source: SUMMATION, args: [3] });
    await page.goto('./#/compare');
    await expect(page.getByRole('button', { name: 'Step one statement on every target' })).toBeEnabled();
    await nav.getByRole('link', { name: 'Code workspace' }).click();
    await expect(compiled).toBeVisible();
    expect((await workerUse(page)).terminated).toBe(0);

    // A comparison that the worker is still computing: the worker is terminated, and the next page does not wait for it.
    await page.goto('about:blank');
    await withProgram(page, { source: ENDLESS_MULTIPLY });
    await page.goto('./#/compare');
    await expect.poll(async () => (await workerUse(page)).ops).toContain('compare');
    await expect(page.getByText('Compiling and running on 4 targets')).toBeVisible();
    await nav.getByRole('link', { name: 'Code workspace' }).click();
    await expect(page.locator('.compare-page')).toHaveCount(0);
    expect((await workerUse(page)).terminated).toBe(1);
    await expect(compiled).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.error-box')).toHaveCount(0);
    // Only the comparison was cancelled: no later request made the page restart the worker again.
    expect((await workerUse(page)).terminated).toBe(1);
  });
});

test.describe('exercises', () => {
  test('an exercise is counted once, and only when its first answer is correct', async ({ page }) => {
    const exercise = (counter: number) => makeExercise(getBackend('riscv'), 'register', counter * 7919 + 'register'.length)!;
    const first = exercise(1);
    const second = exercise(2);
    expect(second.material).not.toEqual(first.material);
    const hint = page.locator('p.hint').first();
    const material = page.locator('.exercise-material');

    await page.goto('./#/exercises');
    await expect(material).toHaveText(first.material.join('\n'));
    await expect(hint).toContainText('Correct answers so far for this set and kind: 0.');
    await page.getByLabel('Your answer').fill(first.answers[0]!);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Check' }).click();
    await page.getByLabel('Your answer').press('Enter');
    await expect(page.locator('.ok-box')).toContainText('Correct.');
    await expect(hint).toContainText('Correct answers so far for this set and kind: 1.');

    // A wrong first answer shows the solution; the right answer given afterwards does not count.
    await page.getByRole('button', { name: 'Next question' }).click();
    await expect(material).toHaveText(second.material.join('\n'));
    await page.getByLabel('Your answer').fill('12345678');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.exercise .error-box')).toContainText('Not this time.');
    await page.getByLabel('Your answer').fill(second.answers[0]!);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.ok-box')).toContainText('Correct.');

    // The same exercise is shown again after the kind is changed and changed back.
    await page.getByRole('button', { name: 'Explain a branch' }).click();
    await page.getByRole('button', { name: 'Predict a register value' }).click();
    await expect(material).toHaveText(second.material.join('\n'));
    await page.getByLabel('Your answer').fill(second.answers[0]!);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.ok-box')).toContainText('Correct.');
    await expect(hint).toContainText('Correct answers so far for this set and kind: 1.');
    expect((await savedState(page)).progress).toEqual({ 'riscv:register': 1 });
  });

  test('an answer checked while the next exercise loads does not show the explanation of that exercise', async ({ page }) => {
    const exercise = (counter: number) => makeExercise(getBackend('riscv'), 'register', counter * 7919 + 'register'.length)!;
    const first = exercise(1);
    const second = exercise(2);
    const hint = page.locator('p.hint').first();
    const material = page.locator('.exercise-material');
    const boxes = page.locator('.exercise .ok-box, .exercise .error-box');

    await page.goto('./#/exercises');
    await expect(material).toHaveText(first.material.join('\n'));
    // In one task, so that the worker cannot answer in between: ask for the next question, type an answer, and check it.
    // The page is read after its pending updates, which run as microtasks of the same task.
    const during = await page.evaluate(async () => {
      const button = (name: string) => [...document.querySelectorAll('.exercise button')].find((b) => b.textContent === name) as HTMLButtonElement;
      button('Next question').click();
      const input = document.getElementById('exercise-answer') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '12345678');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      button('Check').click();
      for (let k = 0; k < 20; k++) await Promise.resolve();
      return { material: document.querySelector('.exercise-material')!.textContent, verdict: document.querySelector('.exercise .error-box')?.textContent ?? '' };
    });
    // The answer was checked against the first exercise, which was still on the page.
    expect(during.material).toBe(first.material.join('\n'));
    expect(during.verdict).toBe(`Not this time. ${first.explanation}`);

    // The second exercise arrives without a verdict, without its explanation, and with an empty answer field.
    await expect(material).toHaveText(second.material.join('\n'));
    await expect(boxes).toHaveCount(0);
    await expect(page.locator('.exercise')).not.toContainText(second.explanation);
    await expect(page.getByLabel('Your answer')).toHaveValue('');
    expect((await savedState(page)).answered).toEqual(['riscv:register:1']);

    // Its first answer is therefore given without the explanation, and counts.
    await page.getByLabel('Your answer').fill(second.answers[0]!);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.ok-box')).toHaveText(`Correct. ${second.explanation}`);
    await expect(hint).toContainText('Correct answers so far for this set and kind: 1.');
    expect((await savedState(page)).answered).toEqual(['riscv:register:1', 'riscv:register:2']);
  });

  test('an exercise is not counted again after a visit to another page or a reload', async ({ page }) => {
    const first = makeExercise(getBackend('riscv'), 'register', 1 * 7919 + 'register'.length)!;
    const hint = page.locator('p.hint').first();
    const nav = page.getByRole('navigation', { name: 'Sections' });
    // The page opens at the first question each time it is shown.
    const answerFirst = async () => {
      await expect(page.locator('.exercise-material')).toHaveText(first.material.join('\n'));
      await page.getByLabel('Your answer').fill(first.answers[0]!);
      await page.getByRole('button', { name: 'Check' }).click();
      await expect(page.locator('.ok-box')).toContainText('Correct.');
      await expect(hint).toContainText('Correct answers so far for this set and kind: 1.');
      expect((await savedState(page)).progress).toEqual({ 'riscv:register': 1 });
    };

    await page.goto('./#/exercises');
    await answerFirst();
    for (const other of ['Start', 'About']) {
      await nav.getByRole('link', { name: other }).click();
      await expect(page.locator('.exercises-page')).toHaveCount(0);
      await nav.getByRole('link', { name: 'Exercises' }).click();
      await answerFirst();
    }
    await page.reload();
    await answerFirst();
  });

  test('a later question with the same content as an earlier one is another exercise', async ({ page }) => {
    const make = (kind: 'register' | 'branch', counter: number) => makeExercise(getBackend('riscv'), kind, counter * 7919 + kind.length)!;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    // The first branch question whose content repeats the question before it.
    const n = Array.from({ length: 40 }, (_, k) => k + 2).find((c) => same(make('branch', c), make('branch', c - 1)))!;
    expect(n).toBeGreaterThan(1);
    const hint = page.locator('p.hint').first();
    const material = page.locator('.exercise-material');
    const answerBranch = async (counter: number) => {
      const exercise = make('branch', counter);
      await expect(material).toHaveText(exercise.material.join('\n'));
      const right = exercise.answers[0] === 'taken' ? 'taken' : 'not taken';
      await page.getByRole('group', { name: 'Answer' }).getByRole('button', { name: right, exact: true }).click();
      await expect(page.locator('.ok-box')).toContainText('Correct.');
    };

    await page.goto('./#/exercises');
    await expect(material).toHaveText(make('register', 1).material.join('\n'));
    for (let c = 2; c < n; c++) {
      await page.getByRole('button', { name: 'Next question' }).click();
      await expect(material).toHaveText(make('register', c).material.join('\n'));
    }
    await page.getByRole('button', { name: 'Explain a branch' }).click();
    await answerBranch(n - 1);
    await expect(hint).toContainText('Correct answers so far for this set and kind: 1.');

    // Question n is reached through a register question, so that the branch question shown afterwards is question n.
    await page.getByRole('button', { name: 'Predict a register value' }).click();
    await expect(material).toHaveText(make('register', n - 1).material.join('\n'));
    await page.getByRole('button', { name: 'Next question' }).click();
    await expect(material).toHaveText(make('register', n).material.join('\n'));
    await page.getByRole('button', { name: 'Explain a branch' }).click();
    await answerBranch(n);
    await expect(hint).toContainText('Correct answers so far for this set and kind: 2.');
    expect((await savedState(page)).progress).toEqual({ 'riscv:branch': 2 });
  });
});

test.describe('code workspace', () => {
  test('the argument input keeps a typed minus sign', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    const n = page.getByLabel('Argument n of main');
    await expect(n).toHaveValue('10');
    await n.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-5');
    await expect(n).toHaveValue('-5');
    await expect.poll(async () => (await savedState(page)).args).toEqual([-5]);
    await page.keyboard.press('Tab');
    await expect(n).toHaveValue('-5');
  });

  test('exports the compiled program of the selected target and of the current source only', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    const exportButton = page.getByRole('button', { name: 'Export compiled program' });

    // Export right after a change of target.
    await page.getByLabel('Target', { exact: true }).selectOption('mips');
    const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const doc = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expect(download.suggestedFilename()).toBe('compiled-mips.json');
    expect(doc.configuration.target).toBe('mips');
    await expect(page.getByText('No errors. Compiled for MIPS32 Release 2.')).toBeVisible();

    // Export right after an edit of the source.
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('# edited\n');
    const [again] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
    const edited = JSON.parse(readFileSync((await again.path())!, 'utf8'));
    const source = (await savedState(page)).source;
    expect(source.startsWith('# edited\n')).toBe(true);
    expect(edited.source.text).toBe(source);
  });

  test('the hidden file input is not a Tab stop', async ({ page }) => {
    // Listening from the start makes Playwright intercept the file chooser before any key is pressed.
    const chooser = page.waitForEvent('filechooser');
    await page.goto('./#/workspace');
    const importButton = page.getByRole('button', { name: 'Import program' });
    await importButton.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Hide the source panel' })).toBeFocused();
    // The button remains the keyboard control that opens the file chooser.
    await importButton.focus();
    await page.keyboard.press('Enter');
    expect((await chooser).isMultiple()).toBe(false);
  });

  test('import rejects arguments that the source-program schema does not allow', async ({ page }) => {
    const SRC = 'def main(a, b, c):\n    print(a)\n    print(b)\n    print(c)\n    return 0\n';
    const document = (args: unknown) => ({ schema: 'isa-trace-lab/source-program', schemaVersion: '1.0', name: 'x', source: SRC, args });
    const file = (name: string, args: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document(args))) });
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    const input = page.getByLabel('Import a source-program document');
    const message = page.locator('.info-box').first();

    const rejected = [
      ['shifted.json', [1, '2', 3]], ['fraction.json', [1.5, 2, 3]], ['range.json', [4294967295, 1e20, 7]], ['below.json', [-2147483649, 2, 3]],
      ['five.json', [1, 2, 3, 4, 5]], ['null.json', null],
    ] as const;
    for (const [name, args] of rejected) {
      await input.setInputFiles(file(name, args));
      await expect(message).toContainText('Import failed: the arguments of main must be a list of at most four integers from -2147483648 to 2147483647', { timeout: 5000 });
      const saved = await savedState(page);
      expect(saved.source, name).toBe(SUMMATION);
      expect(saved.args, name).toEqual([10]);
      await message.getByRole('button', { name: 'Dismiss' }).click();
    }

    await input.setInputFiles(file('valid.json', [1, -2, 2147483647]));
    await expect(message).toContainText('Imported valid.json.');
    await expect(page.getByLabel('Argument a of main')).toHaveValue('1');
    await expect(page.getByLabel('Argument b of main')).toHaveValue('-2');
    await expect(page.getByLabel('Argument c of main')).toHaveValue('2147483647');
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(machine(page).locator('.output-list li')).toHaveText(['1', '-2', '2147483647']);
  });

  test('Export program writes a document that matches the source-program schema and can be imported again', async ({ page }) => {
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile(JSON.parse(readFileSync('schemas/source-program.schema.json', 'utf8')));
    const fields = () => page.locator('input.arg-input').evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).value));
    const message = page.locator('.info-box').first();
    const roundTrip = async (): Promise<{ source: string; args: number[] }> => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export program' }).click()]);
      const text = readFileSync((await download.path())!, 'utf8');
      const doc = JSON.parse(text);
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      await page.getByLabel('Import a source-program document').setInputFiles({ name: 'program.json', mimeType: 'application/json', buffer: Buffer.from(text) });
      await expect(message).toContainText('Imported program.json.');
      await message.getByRole('button', { name: 'Dismiss' }).click();
      return doc;
    };

    // A main with five parameters is a limit error, and each of its parameters still has an argument field.
    const FIVE = 'def main(a, b, c, d, e):\n    print(a)\n    print(b)\n    print(c)\n    return 0\n';
    await withProgram(page, { source: FIVE, args: [] });
    await page.goto('./#/workspace');
    await expect(page.locator('.diagnostics')).toContainText('the entry function accepts at most 4 integer parameters');
    await page.getByLabel('Argument a of main').fill('1');
    await page.getByLabel('Argument e of main').fill('7');
    await expect.poll(async () => (await savedState(page)).args).toEqual([1, 0, 0, 0, 7]);
    const five = await roundTrip();
    expect(five.source).toBe(FIVE);
    expect(five.args).toEqual([1, 0, 0, 0]);
    expect((await savedState(page)).args).toEqual([1, 0, 0, 0]);

    // When the source is changed to a main with three parameters, which compiles, three arguments stay stored.
    await page.getByLabel('Argument e of main').fill('7');
    await expect.poll(async () => (await savedState(page)).args).toEqual([1, 0, 0, 0, 7]);
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < ', d, e'.length; i++) await page.keyboard.press('Backspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    await expect.poll(fields).toEqual(['1', '0', '0']);
    expect((await savedState(page)).args).toEqual([1, 0, 0]);
    const three = await roundTrip();
    expect(three.source).toBe(FIVE.replace(', d, e', ''));
    expect(three.args).toEqual([1, 0, 0]);
    await expect.poll(fields).toEqual(['1', '0', '0']);
    expect((await savedState(page)).args).toEqual([1, 0, 0]);
  });

  test('the stored arguments follow the parameters of main, so that a trace can be exported', async ({ page }) => {
    const fields = () => page.locator('input.arg-input').evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).value));
    const compiled = page.getByText('No errors. Compiled for RISC-V RV32I.');
    const exportTrace = async (): Promise<{ args: number[]; outcome: { status: string; returnValue: number } }> => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export trace' }).click()]);
      return JSON.parse(readFileSync((await download.path())!, 'utf8'));
    };

    // More stored arguments than parameters.
    await withProgram(page, { source: SUMMATION, args: [3, 9] });
    await page.goto('./#/workspace');
    await expect(compiled).toBeVisible();
    expect((await savedState(page)).args).toEqual([3]);
    let trace = await exportTrace();
    expect(trace.args).toEqual([3]);
    expect(trace.outcome).toMatchObject({ status: 'exited', returnValue: 6 });

    // An edit that adds a parameter: the new parameter gets the value that its field shows.
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type(', m');
    await expect.poll(async () => (await savedState(page)).args).toEqual([3, 0]);
    await expect(compiled).toBeVisible();
    expect(await fields()).toEqual(['3', '0']);
    trace = await exportTrace();
    expect(trace.args).toEqual([3, 0]);
    expect(trace.outcome).toMatchObject({ status: 'exited', returnValue: 6 });

    // An imported document with fewer arguments than its main has parameters, and one with arguments for a main without parameters.
    const input = page.getByLabel('Import a source-program document');
    const file = (source: string, args: number[]) => ({
      name: 'program.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schema: 'isa-trace-lab/source-program', schemaVersion: '1.0', name: 'x', source, args })),
    });
    await input.setInputFiles(file('def main(a, b):\n    return a - b\n', [8]));
    await expect.poll(async () => (await savedState(page)).args).toEqual([8, 0]);
    await expect(compiled).toBeVisible();
    trace = await exportTrace();
    expect(trace.args).toEqual([8, 0]);
    expect(trace.outcome).toMatchObject({ status: 'exited', returnValue: 8 });
    await input.setInputFiles(file('def main():\n    return 7\n', [5, 6]));
    await expect.poll(async () => (await savedState(page)).args).toEqual([]);
    await expect(compiled).toBeVisible();
    trace = await exportTrace();
    expect(trace.args).toEqual([]);
    expect(trace.outcome).toMatchObject({ status: 'exited', returnValue: 7 });
    await expect(page.locator('.info-box')).not.toContainText('argument');
  });

  test('import counts the characters of the source text as the language does', async ({ page }) => {
    // A character outside the Basic Multilingual Plane is one character and two UTF-16 code units.
    const body = 'def main():\n    return 7\n';
    const source = (characters: number): string => `# ${'\u{1F600}'.repeat(characters - 3 - body.length)}\n${body}`;
    const file = (name: string, text: string) => ({
      name, mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ schema: 'isa-trace-lab/source-program', schemaVersion: '1.0', name: 'x', source: text, args: [] })),
    });
    const longest = source(65536);
    expect([...longest].length).toBe(65536);
    expect(longest.length).toBeGreaterThan(65536);
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    const input = page.getByLabel('Import a source-program document');
    const message = page.locator('.info-box').first();

    await input.setInputFiles(file('over.json', source(65537)));
    await expect(message).toContainText('Import failed: the source text is too long');
    expect((await savedState(page)).source).toBe(SUMMATION);
    await message.getByRole('button', { name: 'Dismiss' }).click();

    await input.setInputFiles(file('longest.json', longest));
    await expect(message).toContainText('Imported longest.json.');
    expect((await savedState(page)).source).toBe(longest);
    await expect(page.locator('.arg-input')).toHaveCount(0);
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(machine(page).locator('.status')).toContainText('main returned 7');
  });

  test('a compile request that is pending when the worker is restarted is sent to the new worker', async ({ page }) => {
    interface Held {
      /** True while requests to run, to pause and to compile are not delivered to the worker. */
      hold: boolean;
      /** Operations of the requests that were not delivered, in order. */
      held: string[];
      terminated: number;
      /** Source text of every load request, in order. */
      loads: string[];
    }
    // A worker that does not answer: from the moment hold is set until the page terminates the worker, the
    // requests to run, to pause and to compile do not reach it.
    await page.addInitScript(() => {
      const state: Held = { hold: false, held: [], terminated: 0, loads: [] };
      (window as unknown as { held: Held }).held = state;
      const { postMessage, terminate } = Worker.prototype;
      Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]): void {
        const m = message as { op?: unknown; source?: unknown } | null;
        if (m?.op === 'load') state.loads.push(String(m.source));
        if (state.hold && (m?.op === 'run' || m?.op === 'pause' || m?.op === 'compile')) {
          state.held.push(m.op);
          return;
        }
        (postMessage as (...a: unknown[]) => void).call(this, message, ...rest);
      };
      Worker.prototype.terminate = function (this: Worker): void {
        state.terminated++;
        state.hold = false;
        terminate.call(this);
      };
    });
    const held = () => page.evaluate(() => (window as unknown as { held: Held }).held);
    const compiled = page.getByText('No errors. Compiled for RISC-V RV32I.');
    await withProgram(page, { source: ENDLESS });
    await page.goto('./#/workspace');
    await expect(compiled).toBeVisible();
    const run = machine(page).getByRole('button', { name: 'Run', exact: true });
    await expect(run).toBeEnabled();

    await page.evaluate(() => {
      (window as unknown as { held: Held }).held.hold = true;
    });
    await run.click();
    const pause = machine(page).getByRole('button', { name: 'Pause' });
    await expect(pause).toBeVisible();
    // An edit during the run: its compile request stays pending.
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('# edited\n');
    await expect.poll(async () => (await held()).held).toEqual(['run', 'compile']);
    await expect(page.locator('.diagnostics')).toHaveText('Compiling…');
    // The run does not stop within 1.5 s of the pause, so the page restarts the worker.
    await pause.click();
    await expect.poll(async () => (await held()).terminated).toBe(1);

    await expect(compiled).toBeVisible();
    const edited = (await savedState(page)).source;
    expect(edited).toBe(`# edited\n${ENDLESS}`);
    // The machine holds the edited program: the last load request carries it, and its first statement is on line 3.
    await expect(run).toBeEnabled();
    await machine(page).getByRole('button', { name: 'Step statement', exact: true }).click();
    await expect(machine(page).locator('.next-instruction')).toContainText('begins the statement on line 3');
    const after = await held();
    expect(after.loads[after.loads.length - 1]).toBe(edited);
    expect(after.terminated).toBe(1);
    await expect(run).toBeEnabled();
  });

  test('the JUMP_FORWARD note gives the unit of its operand', async ({ page }) => {
    const SRC = 'def main(n):\n    x = 0\n    if n > 3:\n        x = n + 1\n    else:\n        x = n * 3\n    for i in range(n):\n        x += i\n    print(x)\n    return x\n';
    await withProgram(page, { source: SRC, args: [5] });
    await page.goto('./#/workspace');
    await page.getByRole('button', { name: 'Load the CPython runtime and show bytecode' }).click();
    await expect(page.getByText(/CPython 3\.14\.\d+ in Pyodide 314\.0\.\d+/)).toBeVisible({ timeout: 60_000 });
    const region = page.getByRole('region', { name: 'Bytecode of main' });
    await expect(region.locator('tbody tr', { hasText: 'JUMP_FORWARD' })).toHaveCount(1);
    // Columns: line, offset, operation, operand, stack, cache, meaning.
    const rows = await region.locator('tbody tr').evaluateAll((rs) => rs.map((r) => [...r.children].map((c) => c.textContent ?? '')));
    const offset = (r: string[]): number => Number(r[1]!.replace('▸', '').trim());
    const jump = rows.find((r) => r[2] === 'JUMP_FORWARD')!;
    const operand = Number(/^\d+/.exec(jump[3]!)![0]);
    const target = rows.find((r) => offset(r) === offset(jump) + 2 + 2 * operand);
    expect(target?.[1]).toMatch(/^▸/);
    const skipped = rows.filter((r) => offset(r) > offset(jump) && offset(r) < offset(target!));
    const cacheUnits = skipped.reduce((sum, r) => sum + Number(r[5] || 0), 0);
    // The operand counts the skipped instructions and their inline cache entries.
    expect(skipped.length + cacheUnits).toBe(operand);
    expect(skipped.length).toBeLessThan(operand);
    expect(jump[6]).toBe(bytecodeNote('JUMP_FORWARD'));
    expect(jump[6]).toContain('2-byte code units');
    expect(jump[6]).toContain('inline cache entries');
    expect(jump[6]).not.toContain('number of instructions.');
  });
});
