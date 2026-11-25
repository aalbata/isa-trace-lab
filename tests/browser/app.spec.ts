import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import { describeStep, programCounterUpdate } from '../../src/app/components/Datapath.tsx';
import type { CompareResponse, RequestMessage, ResponseMessage } from '../../src/app/engine/protocol.ts';
import { createDisassembler, MAX_BYTECODE_SOURCE } from '../../src/bytecode/disassembler.ts';
import { makeExercise } from '../../src/core/learn.ts';
import { getBackend } from '../../src/core/target/index.ts';
import { LAYOUT } from '../../src/core/target/memory.ts';
import type { StepEvent } from '../../src/core/target/types.ts';
import { ENDLESS, STATE_KEY, SUMMATION, withProgram } from './helpers.ts';

const machine = (page: Page) => page.locator('section[aria-labelledby="machine-heading"]');
const status = (page: Page) => machine(page).locator('.status').first();
const LIMIT_TEXT = 'stopped: the limit of 5000000 instructions was reached';

interface StatusEntry {
  /** Page time of the change, in milliseconds. */
  t: number;
  text: string;
  busy: string | null;
}

/** Record every change of the machine status text in the page, with its time. */
async function recordStatus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: { t: number; text: string; busy: string | null }[] = [];
    (window as unknown as { statusLog: typeof log }).statusLog = log;
    const section = document.querySelector('section[aria-labelledby="machine-heading"]')!;
    let last = section.querySelector('.status')?.textContent ?? '';
    new MutationObserver(() => {
      const el = section.querySelector('.status');
      const text = el?.textContent ?? '';
      if (text === last) return;
      last = text;
      log.push({ t: performance.now(), text, busy: el?.getAttribute('aria-busy') ?? null });
    }).observe(section, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}

const statusLog = (page: Page): Promise<StatusEntry[]> => page.evaluate(() => (window as unknown as { statusLog: StatusEntry[] }).statusLog);
const pageTime = (page: Page): Promise<number> => page.evaluate(() => performance.now());
const savedSource = (page: Page): Promise<string> => page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? '{}') as { source?: string }).source ?? '', STATE_KEY);

/** The note below a source editor, which is also its accessible description. */
const EDITOR_NOTE = 'In the editor, Tab and Shift+Tab change the indentation. To move focus out of the editor with the keyboard, press Escape and then, within two seconds, Tab or Shift+Tab. Ctrl+M switches Tab and Shift+Tab between changing the indentation and moving focus.';
const WORKSPACE_NOTE = `${EDITOR_NOTE} F9 sets or removes a breakpoint on the line with the cursor.`;

/** Whether focus is in a source editor, its panels and dialogs included. */
const inEditor = (page: Page): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('.cm-editor') != null);

/** The description of an editor is a note shown right below it at full size, not only to screen readers. */
async function expectNoteBelow(page: Page, editor: Locator): Promise<void> {
  const note = page.locator(`[id="${await editor.getAttribute('aria-describedby')}"]`);
  await expect(note).toBeVisible();
  const box = (await note.boundingBox())!;
  const above = (await page.locator('.cm-editor', { has: editor }).boundingBox())!;
  expect(box.width, 'width of the note').toBeGreaterThan(200);
  expect(box.height, 'height of the note').toBeGreaterThan(15);
  const gap = box.y - (above.y + above.height);
  expect(gap, 'distance of the note below the editor').toBeGreaterThanOrEqual(0);
  expect(gap, 'distance of the note below the editor').toBeLessThan(20);
}

/** Send one raw HTTP request; the result is the status code, or the connection error code. */
function rawGet(host: string, port: number, target: string): Promise<number | string> {
  return new Promise((done) => {
    let text = '';
    let settled = false;
    const finish = (r: number | string): void => {
      if (!settled) {
        settled = true;
        done(r);
      }
    };
    const socket = connect({ host, port }, () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    socket.setTimeout(10_000, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.on('data', (d) => (text += String(d)));
    socket.on('end', () => finish(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)));
    socket.on('error', (e: NodeJS.ErrnoException) => finish(e.code ?? e.message));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

test.describe('static hosting', () => {
  test('serves the application under a repository path and keeps the route on reload', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trace a program from source to machine code and execution');
    await expect(page.getByRole('heading', { level: 3, name: 'RISC-V RV32I' })).toBeVisible();
    for (const name of ['MIPS32 Release 2', 'Arm AArch64 (A64)', 'x86-64']) await expect(page.getByRole('heading', { level: 3, name })).toBeVisible();
    await page.goto('./#/compare');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Compare architectures' })).toBeVisible();
    await page.getByRole('link', { name: 'About' }).click();
    await expect(page).toHaveURL(/#\/about$/);
  });

  test('local server answers malformed requests, keeps paths inside its folder, and listens on the loopback interface only', async ({}, testInfo) => {
    // A folder "site" with a sibling whose name starts with the same characters.
    const site = testInfo.outputPath('site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<p>site</p>\n');
    mkdirSync(testInfo.outputPath('site-private'), { recursive: true });
    writeFileSync(testInfo.outputPath('site-private', 'secret.txt'), 'secret\n');
    const port = await freePort();
    const server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port), '--base', '/isa-trace-lab/', '--dir', site], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        server.stdout.on('data', (d) => String(d).includes('serving') && resolve());
        void exited.then(() => reject(new Error('the server exited before it was ready')));
      });
      expect(await rawGet('127.0.0.1', port, '/isa-trace-lab/')).toBe(200);
      for (const target of ['/isa-trace-lab/%E0%A4%A', '/isa-trace-lab/%', '//']) {
        expect(await rawGet('127.0.0.1', port, target), target).toBe(400);
      }
      expect(server.exitCode).toBeNull();
      expect(await rawGet('127.0.0.1', port, '/isa-trace-lab/')).toBe(200);
      for (const target of ['/isa-trace-lab/..%2fsite-private%2fsecret.txt', '/isa-trace-lab/..%5csite-private%5csecret.txt', '/isa-trace-lab/%2e%2e%2fsite-private%2fsecret.txt']) {
        expect(await rawGet('127.0.0.1', port, target), target).toBe(404);
      }
      // A request to a non-loopback address of this machine gets no HTTP answer, only a connection error.
      const external = Object.values(networkInterfaces()).flat().find((a) => a !== undefined && a.family === 'IPv4' && !a.internal);
      if (external) {
        const answer = await rawGet(external.address, port, '/isa-trace-lab/');
        expect(typeof answer, `request to a non-loopback address answered ${answer}`).toBe('string');
      }
    } finally {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill();
        await exited;
      }
    }
  });
});

test.describe('code workspace', () => {
  test('compiles, steps, and runs the program on every target', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    await expect(status(page)).toContainText('ready at 0x00400000');
    await machine(page).getByRole('button', { name: 'Step statement' }).click();
    await machine(page).getByRole('button', { name: 'Step statement' }).click();
    await expect(status(page)).toContainText('paused at');
    await machine(page).getByRole('button', { name: 'Back statement' }).click();
    await expect(status(page)).toContainText('paused at');
    await machine(page).getByRole('button', { name: 'Reset' }).click();
    await expect(status(page)).toContainText('ready at 0x00400000');
    for (const [id, label] of [['riscv', 'RISC-V RV32I'], ['mips', 'MIPS32 Release 2'], ['aarch64', 'Arm AArch64 (A64)'], ['x86', 'x86-64']]) {
      await page.getByLabel('Target', { exact: true }).selectOption(id);
      await expect(page.getByText(`No errors. Compiled for ${label}.`)).toBeVisible();
      await expect(status(page)).toContainText('ready at 0x00400000');
      await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
      await expect(status(page)).toContainText('main returned 55');
      await expect(machine(page).locator('.output-list li')).toHaveText(['55']);
    }
  });

  test('reports errors with their lines and recovers after an edit', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    const editor = page.locator('.cm-content').first();
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('def main():');
    await page.keyboard.press('Enter');
    await page.keyboard.type('return 7 / 2');
    await expect(page.locator('.diagnostic-list')).toContainText("operator '/' is not part of the source language");
    await expect(page.locator('.diagnostic-list')).toContainText('Outside the language');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(status(page)).toContainText('main returned 7');
  });

  test('executes edited code bytes and marks the edited instruction', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    // The range start of the loop is loaded by "addi s3, zero, 1"; the immediate field is set to 2.
    const row = page.locator('tr.listing-row', { hasText: 'addi s3, zero, 1' });
    await row.getByRole('button', { name: /^Bytes 93 09 10 00/ }).click();
    const input = page.getByLabel(/New bytes for the instruction at/);
    await input.fill('93 09 20 00');
    await input.press('Enter');
    await expect(page.locator('tr.listing-row.is-stale')).toHaveCount(1);
    await expect(page.getByText('Code bytes were edited.')).toBeVisible();
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(status(page)).toContainText('main returned 54');
    await machine(page).getByRole('button', { name: 'Reset' }).click();
    await expect(page.locator('tr.listing-row.is-stale')).toHaveCount(0);
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(status(page)).toContainText('main returned 55');
  });

  test('pauses a long run', async ({ page }) => {
    await withProgram(page, { source: ENDLESS });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await machine(page).getByRole('button', { name: 'Pause' }).click();
    // The stop reason "(paused)" is shown only for a run that stopped on the pause request, before the
    // instruction limit; the machine can then be stepped again.
    await expect(status(page)).toContainText(/^paused at 0x[0-9a-f]{8} after \d+ instructions \(paused\)$/);
    await expect(machine(page).getByRole('button', { name: 'Step instruction' })).toBeEnabled();
    await expect(machine(page).locator('.info-box')).toHaveCount(0);
  });

  test('reports a full-speed run as running until it stops', async ({ page }) => {
    await withProgram(page, { source: ENDLESS });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    await recordStatus(page);
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(status(page)).toHaveText(LIMIT_TEXT);
    const log = await statusLog(page);
    const progress = log.slice(0, -1);
    expect(progress.length, 'progress updates during the run').toBeGreaterThan(0);
    for (const entry of progress) {
      expect(entry.text).toMatch(/^running \(\d+ instructions executed so far\)$/);
      expect(entry.busy).toBe('true');
    }
    expect(log.at(-1)).toMatchObject({ text: LIMIT_TEXT, busy: 'false' });
  });

  test('a pause does not end a run started after the paused run stopped', async ({ page }) => {
    await withProgram(page, { target: 'x86', source: ENDLESS });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    await recordStatus(page);
    const m = machine(page);
    // Pause a full-speed run, then Pause automatic stepping; each time, start a run 1.2 s after the
    // pause, before the 1.5 s within which a paused run must stop.
    for (const start of ['Run', 'Play']) {
      await m.getByRole('button', { name: start, exact: true }).click();
      if (start === 'Play') await expect(status(page)).toContainText(/after \d+ instructions/);
      await m.getByRole('button', { name: 'Pause' }).click();
      const pausedAt = await pageTime(page);
      if (start === 'Run') await expect(status(page)).toContainText('(paused)');
      await expect(m.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
      await page.waitForTimeout(Math.max(0, pausedAt + 1200 - (await pageTime(page))));
      await m.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(status(page)).toHaveText(LIMIT_TEXT);
      const end = (await statusLog(page)).find((e) => e.t > pausedAt && e.text === LIMIT_TEXT);
      expect(end, 'the run reached the instruction limit').toBeDefined();
      // The run was still in progress 1.5 s after the pause and was not ended.
      expect(end!.t - pausedAt).toBeGreaterThan(1500);
      await expect(m.locator('.info-box')).toHaveCount(0);
      await m.getByRole('button', { name: 'Reset' }).click();
      await expect(status(page)).toContainText('ready at 0x00400000');
    }
  });

  test('keeps the memory region chosen during a run', async ({ page }) => {
    await withProgram(page, { target: 'x86', source: ENDLESS });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    const regions = machine(page).getByRole('group', { name: 'Memory region' });
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(machine(page).getByRole('button', { name: 'Pause' })).toBeVisible();
    // Select the stack region and confirm, in the same task, that the run was still in progress.
    const chosenDuringRun = await regions.getByRole('button', { name: 'Stack' }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      return [...document.querySelectorAll('section[aria-labelledby="machine-heading"] button')].some((b) => b.textContent === 'Pause');
    });
    expect(chosenDuringRun).toBe(true);
    await expect(status(page)).toHaveText(LIMIT_TEXT);
    await expect(regions.getByRole('button', { name: 'Stack' })).toHaveAttribute('aria-pressed', 'true');
    const first = Number(await machine(page).locator('.memory-table tbody th').first().textContent());
    expect(first).toBeGreaterThanOrEqual(LAYOUT.stackTop - LAYOUT.stackSize);
    expect(first).toBeLessThan(LAYOUT.stackTop);
  });

  test('marks the registers that the last instruction read through their 32-bit names on AArch64', async ({ page }) => {
    await withProgram(page, { target: 'aarch64', source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for Arm AArch64 (A64).')).toBeVisible();
    await expect(status(page)).toContainText('ready at 0x00400000');
    const description = machine(page).locator('.step-description');
    for (let i = 1; i <= 20; i++) {
      await machine(page).getByRole('button', { name: 'Step instruction' }).click();
      await expect(status(page)).toContainText(`after ${i} instructions`);
      if (((await description.textContent()) ?? '').includes('"orr w19, wzr, w0"')) break;
    }
    await expect(description).toContainText('Read registers: wzr = 0, w0 = 10.');
    await expect(machine(page).locator('.register-table tr.is-read th')).toHaveText([/^x0(?!\d)/]);
    await expect(machine(page).locator('.register-table tr.is-written th')).toHaveText([/^x19(?!\d)/]);
  });

  test('sets source breakpoints from the line numbers and from the keyboard', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    // The gutter keeps a hidden marker as a spacer; only visible markers are breakpoints.
    const dots = page.locator('.cm-breakpoint-dot:visible');
    const lineNumber = (n: number) => page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${n}$`) });
    // Line 3 is "total = 0".
    await lineNumber(3).click();
    await expect(dots).toHaveCount(1);
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(status(page)).toContainText('(breakpoint at source line 3)');
    await lineNumber(3).click();
    await expect(dots).toHaveCount(0);
    await machine(page).getByRole('button', { name: 'Reset' }).click();
    await expect(status(page)).toContainText('ready at 0x00400000');
    // Line 5 is "total += i": move the cursor there with the keyboard and press F9.
    const editor = page.getByRole('textbox', { name: 'Source program' });
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('F9');
    await expect(dots).toHaveCount(1);
    await machine(page).getByRole('button', { name: 'Run', exact: true }).click();
    await expect(status(page)).toContainText('(breakpoint at source line 5)');
    expect(await savedSource(page)).toBe(SUMMATION);
  });

  test('shows genuine CPython bytecode without running the program', async ({ page }) => {
    // Module-level statements have an effect only if the text is executed: the print would reach the
    // standard output of the CPython runtime, which Pyodide writes to the worker's console, and the
    // raise would end the request with an error.
    const marker = 'isa-trace-lab: this text was executed';
    const consoleText: string[] = [];
    page.on('console', (m) => consoleText.push(m.text()));
    await withProgram(page, { source: `${SUMMATION}print("${marker}")\nraise RuntimeError("${marker}")\n`, args: [10] });
    await page.goto('./#/workspace');
    await page.getByRole('button', { name: 'Load the CPython runtime and show bytecode' }).click();
    // Wait for the answer of the runtime, a listing or an error.
    const panel = page.locator('.bytecode-panel');
    const listed = panel.locator('.bytecode-status').filter({ hasText: /CPython 3\.14\.\d+ in Pyodide 314\.0\.\d+/ });
    await expect(listed.or(panel.locator('.error-box')).first()).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('.error-box')).toHaveCount(0);
    await expect(listed).toBeVisible();
    const table = page.locator('.bytecode-table').last();
    await expect(table).toContainText('FOR_ITER');
    await expect(table).toContainText('BINARY_OP');
    await expect(page.locator('.bytecode-table').first()).toContainText('RAISE_VARARGS');
    expect(consoleText.filter((t) => t.includes(marker))).toEqual([]);
  });

  test('names the target of every bytecode jump by an offset shown in the table', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await page.getByRole('button', { name: 'Load the CPython runtime and show bytecode' }).click();
    await expect(page.getByText(/CPython 3\.14\.\d+ in Pyodide 314\.0\.\d+/)).toBeVisible({ timeout: 60_000 });
    const tables = await page.locator('.bytecode-table').evaluateAll((list) => list.map((t) => [...(t as HTMLTableElement).tBodies[0]!.rows].map((r) => ({
      offset: r.cells[1]!.textContent ?? '',
      operand: r.cells[3]!.textContent ?? '',
    }))));
    let jumps = 0;
    for (const rows of tables) {
      const marked = new Set(rows.filter((r) => r.offset.startsWith('▸')).map((r) => r.offset.slice(1).trim()));
      for (const r of rows) {
        const target = /\((?:to|from) ([^)]+)\)$/.exec(r.operand)?.[1];
        if (target === undefined) continue;
        jumps++;
        expect(marked.has(target), `operand "${r.operand}" names an offset marked as a jump target`).toBe(true);
      }
    }
    expect(jumps).toBeGreaterThan(0);
  });

  test('the bytecode view counts the size limit of the source text in characters', async ({ page }) => {
    // A character outside the Basic Multilingual Plane is one character and two UTF-16 code units.
    const face = String.fromCodePoint(0x1f600);
    // A stand-in for the runtime, which records the text that reaches the CPython compiler.
    const passed: string[] = [];
    const disassembler = createDisassembler({
      version: 'stand-in',
      runPython: () => undefined,
      globals: {
        get: () => (source: string) => {
          passed.push(source);
          return JSON.stringify({ ok: true, python: '', implementation: '', codeObjects: [] });
        },
      },
    });
    const longest = face.repeat(MAX_BYTECODE_SOURCE);
    expect(longest.length).toBe(2 * MAX_BYTECODE_SOURCE);
    expect(disassembler.disassemble(longest).ok, `${MAX_BYTECODE_SOURCE} characters`).toBe(true);
    expect(passed).toEqual([longest]);
    for (const tooLong of [longest + face, longest + 'x', 'x'.repeat(MAX_BYTECODE_SOURCE + 1)]) {
      expect(disassembler.disassemble(tooLong), `${[...tooLong].length} characters`).toEqual({
        ok: false, pyodide: 'stand-in', error: { message: `source is longer than ${MAX_BYTECODE_SOURCE} characters`, line: null, column: null },
      });
    }
    expect(passed).toEqual([longest]);

    // In the application: a program whose comments make it longer than the limit in code units, not in characters.
    const source = `# ${face.repeat(50)}\n`.repeat(660) + SUMMATION;
    expect(source.length).toBeGreaterThan(MAX_BYTECODE_SOURCE);
    expect([...source].length).toBeLessThan(MAX_BYTECODE_SOURCE);
    await withProgram(page, { source, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    await page.getByRole('button', { name: 'Load the CPython runtime and show bytecode' }).click();
    const panel = page.locator('.bytecode-panel');
    const listed = panel.locator('.bytecode-status').filter({ hasText: /CPython 3\.14\.\d+ in Pyodide 314\.0\.\d+/ });
    await expect(listed.or(panel.locator('.error-box')).first()).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('.error-box')).toHaveCount(0);
    await expect(page.locator('.bytecode-table').last()).toContainText('FOR_ITER');
  });

  test('starts a new worker after a worker script failed to load', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    const failed: string[] = [];
    await page.route(/\/assets\/(engine|pyodide)\.worker-[^/]+\.js$/, async (route) => {
      const name = /(engine|pyodide)\.worker-/.exec(route.request().url())![1]!;
      if (failed.includes(name)) await route.continue();
      else {
        failed.push(name);
        await route.abort();
      }
    });
    const edit = async (): Promise<void> => {
      await page.locator('.cm-content').first().click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('# edited\n');
    };
    await page.goto('./#/workspace');
    await expect.poll(() => failed).toContain('engine');
    await page.waitForTimeout(500);
    // The first engine worker never started; the compile request after an edit must reach a new worker.
    await edit();
    await expect(status(page)).toContainText('ready at 0x00400000');
    await page.getByRole('button', { name: 'Load the CPython runtime and show bytecode' }).click();
    await expect(page.locator('.bytecode-panel .error-box')).toContainText('The bytecode view failed');
    expect(failed).toContain('pyodide');
    await edit();
    await expect(page.getByText(/CPython 3\.14\.\d+ in Pyodide 314\.0\.\d+/)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.bytecode-table').last()).toContainText('FOR_ITER');
  });

  test('exports a compiled-program document that matches its schema', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(page.getByText('No errors. Compiled for RISC-V RV32I.')).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export compiled program' }).click()]);
    const doc = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile(JSON.parse(readFileSync('schemas/compiled-program.schema.json', 'utf8')));
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc.configuration.target).toBe('riscv');
  });
});

test.describe('other pages', () => {
  test('cross-architecture comparison agrees and can be cancelled', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/compare');
    await expect(page.getByText('All targets ended the same way with the same output and return value.')).toBeVisible();
    // The first statement step stops every target at the first statement; the second at the next one.
    await page.getByRole('button', { name: 'Step one statement on every target' }).click();
    await expect(page.locator('.sync-status')).toContainText('Every target is at statement boundary 1, about to execute source line 3.');
    await page.getByRole('button', { name: 'Step one statement on every target' }).click();
    await expect(page.locator('.sync-status')).toContainText('Every target is at statement boundary 2, about to execute source line 4.');
    await page.goto('about:blank');
    await withProgram(page, { source: ENDLESS });
    await page.goto('./#/compare');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('The comparison was cancelled by stopping the simulator worker.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run the comparison again' })).toBeVisible();
  });

  test('explorer encodes edited operands with the real encoder', async ({ page }) => {
    await page.goto('./#/explore/riscv/addi');
    await expect(page.getByRole('heading', { level: 2, name: /addi Add immediate/ })).toBeVisible();
    await page.getByLabel(/Assembly text \(edit the operands/).fill('addi a0, a1, 100');
    await expect(page.locator('.word-diagram')).toContainText('000001100100');
    await expect(page.locator('.word-diagram')).toContainText('100 (sign-extended)');
    await page.getByLabel(/Assembly text \(edit the operands/).fill('addi a0, a1, 5000');
    await expect(page.locator('.error-box')).toContainText('12-bit signed field');
    await page.goto('./#/explore/x86/add');
    await expect(page.locator('.byte-diagram').first()).toContainText('opcode');
  });

  test('assembler runs assembly text and separates kinds of decoding failures', async ({ page }) => {
    await page.goto('./#/assembler/mips');
    await expect(page.getByText(/13 instructions, \d+ bytes\./)).toBeVisible();
    await page.locator('section[aria-labelledby="asm-machine-heading"]').getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('.output-list li')).toHaveText(['55']);
    await page.goto('./#/assembler/x86');
    await page.getByRole('button', { name: 'Decode bytes' }).click();
    await expect(page.locator('.decoded-list')).toContainText('Not a valid encoding in this profile');
    await expect(page.locator('.decoded-list')).toContainText('More bytes are needed');
  });

  test('datapath shows a value loaded from data memory only for loads', async ({ page }) => {
    await page.goto('./#/assembler/x86');
    const asm = page.locator('section[aria-labelledby="asm-machine-heading"]');
    await page.locator('.cm-content').first().fill('mov eax, 7\npush rax\npop rbx\ncall f\nf:\nmov eax, 2\nsyscall\n');
    await expect(page.getByText(/^6 instructions, \d+ bytes\.$/)).toBeVisible();
    await expect(asm.locator('.status').first()).toContainText('ready at 0x00400000');
    const wires = () => asm.locator('.dp-wire.is-active .dp-wire-label').allTextContents();
    const expected: [string, RegExp, boolean][] = [
      ['mov eax, 7', /Write registers: rax = 7\./, false],
      ['push rax', /Memory write: 7 stored in 8 bytes/, false],
      ['pop rbx', /Memory read: 8 bytes at 0x[0-9a-f]{8} hold 7\./, true],
      ['call', /Memory write: /, false],
    ];
    for (const [i, [text, sentence, loaded]] of expected.entries()) {
      await asm.getByRole('button', { name: 'Step instruction' }).click();
      await expect(asm.locator('.status').first()).toContainText(`after ${i + 1} instructions`);
      await expect(asm.locator('.step-description')).toContainText(text);
      await expect(asm.locator('.step-description')).toContainText(sentence);
      expect((await wires()).includes('loaded value'), `"loaded value" wire for ${text}`).toBe(loaded);
    }
  });

  test('datapath shows that a faulting instruction leaves the program counter unchanged', async ({ page }) => {
    const asm = page.locator('section[aria-labelledby="asm-machine-heading"]');
    // Labels of the highlighted wires that bring the next program counter.
    const pcWires = async (): Promise<string[]> =>
      (await asm.locator('.dp-wire.is-active .dp-wire-label').allTextContents()).filter((l) => l === 'new program counter' || l.startsWith('pc + '));
    // Each program ends with a load from address 0, which is not mapped. `before` gives the wire of each step before it.
    const programs: { target: string; lines: string[]; count: number; before: string[]; fault: string; at: string }[] = [
      { target: 'riscv', lines: ['j over', 'addi t0, zero, 1', 'over:', 'addi t0, zero, 1', 'lw t0, 0(zero)'], count: 4, before: ['new program counter', 'pc + 4'], fault: 'lw t0, 0(zero)', at: '0x0040000c' },
      { target: 'mips', lines: ['addiu $t0, $zero, 1', 'lw $t0, 0($zero)'], count: 2, before: ['pc + 4'], fault: 'lw $t0, 0($zero)', at: '0x00400004' },
      { target: 'aarch64', lines: ['mov x0, #1', 'ldr x0, [x1]'], count: 2, before: ['pc + 4'], fault: 'ldr x0, [x1]', at: '0x00400004' },
      { target: 'x86', lines: ['mov eax, 7', 'mov eax, [rbx]'], count: 2, before: ['pc + 5'], fault: 'mov eax, dword ptr [rbx]', at: '0x00400005' },
    ];
    for (const p of programs) {
      await page.goto(`./#/assembler/${p.target}`);
      await page.locator('.cm-content').first().fill(p.lines.join('\n') + '\n');
      await expect(page.getByText(new RegExp(`^${p.count} instructions, \\d+ bytes\\.$`))).toBeVisible();
      await expect(asm.locator('.status').first()).toContainText('ready at 0x00400000');
      const description = asm.locator('.step-description');
      for (const [i, wire] of p.before.entries()) {
        await asm.getByRole('button', { name: 'Step instruction' }).click();
        await expect(asm.locator('.status').first()).toContainText(`after ${i + 1} instructions`);
        await expect(description).toContainText('Next program counter: 0x');
        expect(await pcWires(), `${p.target}: program counter wire of step ${i + 1}`).toEqual([wire]);
      }
      await asm.getByRole('button', { name: 'Step instruction' }).click();
      await expect(asm.locator('.status').first()).toHaveText('fault: load from unmapped address 0x00000000');
      await expect(description).toContainText(`Decode: the bytes encode "${p.fault}".`);
      await expect(description.locator('li').filter({ hasText: 'Next program counter' }))
        .toHaveText([`Next program counter: unchanged at ${p.at}, because the instruction did not complete.`]);
      await expect(description.locator('li').last()).toHaveText('Fault: load from unmapped address 0x00000000.');
      expect(await pcWires(), `${p.target}: program counter wires of the faulting step`).toEqual([]);
    }
  });

  test('datapath gives a code address above 32 bits in full', () => {
    // An AArch64 "br x1" at 0x0040000c, with the events of x1 = 0x100400010 and of x1 = 0x00400010.
    const br = (fields: Partial<StepEvent>): StepEvent => ({
      index: 3, pc: 0x0040000c, length: 4, bytes: [0x20, 0x00, 0x1f, 0xd6], text: 'br x1', klass: 'jump',
      regReads: [], regWrites: [], memReads: [], memWrites: [], nextPc: 0x00400010, ...fields,
    });
    const high = br({ branch: { conditional: false, taken: true, target: 0x00400010, target64: 0x100400010n }, nextPc64: 0x100400010n });
    const low = br({ branch: { conditional: false, taken: true, target: 0x00400010 } });
    // The low 32 bits of the high target are the address of the following instruction, which is not executed next.
    expect(describeStep(high, []).slice(-2)).toEqual(['Jump to 0x0000000100400010.', 'Next program counter: 0x0000000100400010.']);
    expect(programCounterUpdate(high)).toBe('redirected');
    expect(describeStep(low, []).slice(-2)).toEqual(['Jump to 0x00400010.', 'Next program counter: 0x00400010 (the following instruction).']);
    expect(programCounterUpdate(low)).toBe('sequential');
    // A branch decision with a full target.
    const decision = br({ branch: { conditional: true, taken: true, target: 0x00400010, target64: 0xffffffff00400010n }, nextPc64: 0xffffffff00400010n });
    expect(describeStep(decision, []).slice(-2)).toEqual(['Branch decision: taken; target 0xffffffff00400010.', 'Next program counter: 0xffffffff00400010.']);
    expect(programCounterUpdate(br({ nextPc: 0x00400000 }))).toBe('redirected');
    expect(programCounterUpdate(br({ stop: { kind: 'service' } }))).toBe('sequential');
    expect(programCounterUpdate(br({ nextPc: 0x0040000c, stop: { kind: 'fault', message: 'load from unmapped address 0x00000000' } }))).toBe('unchanged');
  });

  test('the engine worker reports the verdict of a comparison and the targets that stopped at the step limit', async ({ page }) => {
    const scripts = readdirSync(join('dist', 'assets')).filter((f) => /^engine\.worker-.+\.js$/.test(f));
    expect(scripts, 'engine worker script of the build').toHaveLength(1);
    await page.goto('./#/about');
    const compare = (source: string, args: number[], targets: string[]): Promise<CompareResponse> =>
      page.evaluate(([file, request]) => new Promise<CompareResponse>((resolve, reject) => {
        const worker = new Worker(new URL(`assets/${file}`, document.baseURI), { type: 'module' });
        worker.onerror = (e) => reject(new Error(e.message || 'the engine worker failed'));
        worker.onmessage = (e: MessageEvent<ResponseMessage>) => {
          const m = e.data;
          if ('progress' in m) return;
          worker.terminate();
          if (m.ok) resolve(m.result as CompareResponse);
          else reject(new Error(m.error));
        };
        worker.postMessage(request);
      }), [scripts[0]!, { id: 1, op: 'compare', source, args, targets } as RequestMessage] as const);

    const finished = await compare(SUMMATION, [10], ['riscv', 'mips', 'aarch64', 'x86']);
    expect(finished.ok).toBe(true);
    expect(finished.runs.map((r) => r.outcome.status)).toEqual(['exited', 'exited', 'exited', 'exited']);
    expect(finished.limitReached).toEqual([]);
    expect(finished.verdict).toBe('agree');
    // Every run of a program that never ends stops at its step limit, so the comparison is incomplete.
    const endless = await compare(ENDLESS, [], ['riscv', 'x86']);
    expect(endless.ok).toBe(true);
    expect(endless.runs.map((r) => r.outcome.status)).toEqual(['limit', 'limit']);
    expect(endless.limitReached).toEqual(['riscv', 'x86']);
    expect(endless.verdict).toBe('incomplete');
  });

  test('exercise answers are checked against the simulator', async ({ page }) => {
    await page.goto('./#/exercises');
    // The page draws the first register exercise from the initialization value 1 * 7919 + 8.
    const exercise = makeExercise(getBackend('riscv'), 'register', 7919 + 'register'.length)!;
    await expect(page.locator('#exercise-prompt')).toHaveText(exercise.prompt);
    await page.getByLabel('Your answer').fill(exercise.answers[0]!);
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.locator('.ok-box')).toContainText('Correct.');
  });
});

test.describe('layout and keyboard', () => {
  for (const size of [{ width: 768, height: 1024 }, { width: 375, height: 812 }]) {
    test(`has no horizontal page scroll at ${size.width} pixels`, async ({ page }) => {
      await page.setViewportSize(size);
      for (const route of ['./', './#/workspace', './#/explore/riscv/addi', './#/explore/x86/add', './#/compare', './#/assembler', './#/exercises', './#/about']) {
        await page.goto(route);
        await page.waitForTimeout(800);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, route).toBeLessThanOrEqual(0);
      }
    });
  }

  test('offers a skip link that moves focus to the main content of the current page', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    for (const [route, heading] of [
      ['./', 'Trace a program from source to machine code and execution'],
      ['./#/workspace', 'Source'],
      ['./#/explore/riscv/addi', 'Instruction catalog'],
      ['./#/about', 'About ISA Trace Lab'],
    ]) {
      // A new document for every route, so that the first Tab starts at the top of the page.
      await page.goto('about:blank');
      await page.goto(route);
      await expect(page.locator('main').getByRole('heading', { name: heading, exact: true })).toBeVisible();
      const fragment = new URL(page.url()).hash;
      const entries = await page.evaluate(() => history.length);
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to the main content' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('main#main')).toBeFocused();
      expect(new URL(page.url()).hash, route).toBe(fragment);
      expect(await page.evaluate(() => history.length), route).toBe(entries);
      await expect(page.locator('main').getByRole('heading', { name: heading, exact: true })).toBeVisible();
      // The next Tab reaches the first control inside the main content.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('main')!.contains(document.activeElement)), route).toBe(true);
    }
  });

  test('reaches the machine controls from the top of the workspace with the keyboard', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    const editor = page.getByRole('textbox', { name: 'Source program' });
    // The editor uses Tab for indentation, so its description, a note below it, tells how to move focus out of it.
    await expect(editor).toHaveAccessibleDescription(WORKSPACE_NOTE);
    await expectNoteBelow(page, editor);
    const step = machine(page).getByRole('button', { name: 'Step instruction' });
    let escapes = 0;
    for (let i = 0; i < 150; i++) {
      await page.keyboard.press('Tab');
      if (await step.evaluate((el) => el === document.activeElement)) break;
      if (await editor.evaluate((el) => el.contains(document.activeElement))) {
        await page.keyboard.press('Escape');
        escapes++;
      }
    }
    expect(escapes, 'Tab stops inside the source editor').toBe(1);
    await expect(step).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status(page)).toContainText('paused at');
    expect(await savedSource(page)).toBe(SUMMATION);
    // The assembler uses the same editor.
    await page.goto('./#/assembler/riscv');
    const assembly = page.getByRole('textbox', { name: 'Assembly program for RISC-V RV32I' });
    await expect(assembly).toHaveAccessibleDescription(EDITOR_NOTE);
    await expectNoteBelow(page, assembly);
  });

  test('moves focus out of the source editor with the keys of its note, whatever the editor shows', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    const editor = page.getByRole('textbox', { name: 'Source program' });
    // Focus in the editor, at the start of the program, with nothing selected.
    const enter = async (): Promise<void> => {
      await editor.focus();
      await page.keyboard.press('ControlOrMeta+Home');
      expect(await inEditor(page)).toBe(true);
    };
    // Tab and Shift+Tab change the indentation and keep focus in the editor.
    await enter();
    await page.keyboard.press('Tab');
    expect(await inEditor(page), 'Tab').toBe(true);
    expect(await savedSource(page)).toBe(`  ${SUMMATION}`);
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Shift+Tab').toBe(true);
    expect(await savedSource(page)).toBe(SUMMATION);
    // Escape and then Tab or Shift+Tab, also when that Escape reduces the selection or closes a panel or a dialog.
    const states: [string, () => Promise<void>][] = [
      ['nothing selected', async () => undefined],
      ['part of a line selected', () => page.keyboard.press('Shift+End')],
      ['two lines selected', () => page.keyboard.press('Shift+ArrowDown')],
      ['everything selected', () => page.keyboard.press('ControlOrMeta+KeyA')],
      ['search panel open', async () => {
        await page.keyboard.press('ControlOrMeta+KeyF');
        await expect(page.locator('.cm-search input[name="search"]')).toBeFocused();
      }],
      ['diagnostics panel open', async () => {
        await page.keyboard.press('ControlOrMeta+Shift+KeyM');
        await expect(page.locator('.cm-panel-lint ul')).toBeFocused();
      }],
      ['go-to-line dialog open', async () => {
        await page.keyboard.press('ControlOrMeta+Alt+KeyG');
        await expect(page.locator('.cm-dialog input[name="line"]')).toBeFocused();
      }],
    ];
    for (const [state, prepare] of states) {
      for (const key of ['Tab', 'Shift+Tab']) {
        await enter();
        await prepare();
        await page.keyboard.press('Escape');
        await page.keyboard.press(key);
        expect(await inEditor(page), `${state}: Escape, then ${key}`).toBe(false);
      }
    }
    // Ctrl+M makes Tab and Shift+Tab move focus until it is pressed again.
    await enter();
    await page.keyboard.press('Control+KeyM');
    await page.keyboard.press('Tab');
    expect(await inEditor(page), 'Ctrl+M, then Tab').toBe(false);
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Shift+Tab back into the editor').toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Shift+Tab out of the editor').toBe(false);
    await enter();
    await page.keyboard.press('Control+KeyM');
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Ctrl+M again, then Shift+Tab').toBe(true);
    expect(await savedSource(page)).toBe(SUMMATION);
    // Escape that closes the completion list, which typing the start of a name opens.
    await enter();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.type(' + tot');
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    const typed = await savedSource(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    expect(await inEditor(page), 'completion list open: Escape, then Tab').toBe(false);
    expect(await savedSource(page)).toBe(typed);
  });

  test('moves focus out of the source editor with the same keys under the macOS key bindings', async ({ page }) => {
    // CodeMirror chooses its key bindings by the platform that the browser reports.
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    expect(await page.evaluate(() => navigator.platform)).toBe('MacIntel');
    const editor = page.getByRole('textbox', { name: 'Source program' });
    // The cursor is at the start of the program.
    await editor.focus();
    await page.keyboard.press('Tab');
    expect(await inEditor(page), 'Tab').toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Shift+Tab').toBe(true);
    await page.keyboard.press('Control+KeyM');
    await page.keyboard.press('Tab');
    expect(await inEditor(page), 'Ctrl+M, then Tab').toBe(false);
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Shift+Tab back into the editor').toBe(true);
    await page.keyboard.press('Control+KeyM');
    await page.keyboard.press('Shift+Tab');
    expect(await inEditor(page), 'Ctrl+M again, then Shift+Tab').toBe(true);
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    expect(await inEditor(page), 'part of a line selected: Escape, then Tab').toBe(false);
    expect(await savedSource(page)).toBe(SUMMATION);
    // The note names the same keys on every platform.
    await expect(editor).toHaveAccessibleDescription(WORKSPACE_NOTE);
  });

  test('returns focus to an edited value after Enter or Escape', async ({ page }) => {
    await withProgram(page, { source: SUMMATION, args: [10] });
    await page.goto('./#/workspace');
    await expect(status(page)).toContainText('ready at 0x00400000');
    const m = machine(page);
    const edits: { open: () => Locator; input: () => Locator; value: string; after: () => Locator }[] = [
      {
        open: () => m.getByRole('button', { name: /^a0: 0x[0-9a-f]+; edit$/ }),
        input: () => m.getByLabel('New value for a0'),
        value: '0x5',
        after: () => m.getByRole('button', { name: 'a0: 0x00000005; edit' }),
      },
      {
        open: () => m.getByRole('button', { name: /^word at 0x10000000: 0x[0-9a-f]+; edit$/ }),
        input: () => m.getByLabel('New value for word at 0x10000000'),
        value: '7',
        after: () => m.getByRole('button', { name: 'word at 0x10000000: 0x00000007; edit' }),
      },
      {
        open: () => page.locator('tr.listing-row', { hasText: 'addi s3, zero, 1' }).locator('.bytes-button'),
        input: () => page.getByLabel(/New bytes for the instruction at/),
        value: '93 09 20 00',
        after: () => page.locator('tr.listing-row', { hasText: 'addi s3, zero, 1' }).locator('.bytes-button'),
      },
    ];
    for (const e of edits) {
      await e.open().click();
      await e.input().fill(e.value);
      await e.input().press('Enter');
      await expect(e.after()).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(e.input()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(e.after()).toBeFocused();
    }
    // A bit field of the instruction explorer.
    await page.goto('./#/explore/riscv/addi');
    await page.getByRole('button', { name: /^rd: binary [01]{5}; edit$/ }).click();
    await page.getByLabel('New binary value for rd (5 bits)').fill('01011');
    await page.getByLabel('New binary value for rd (5 bits)').press('Enter');
    await expect(page.getByRole('button', { name: 'rd: binary 01011; edit' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('New binary value for rd (5 bits)')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'rd: binary 01011; edit' })).toBeFocused();
  });
});
