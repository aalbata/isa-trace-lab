/**
 * Takes the screenshot figure of the article from the production build.
 *
 *   npm run build
 *   node scripts/figures/screenshots.mjs [output-directory]
 *
 * The script serves dist/ with scripts/serve.mjs, opens the code workspace in
 * Google Chrome (PW_CHANNEL selects another browser, as for the browser tests)
 * with the running example of the article (examples/array_traversal.py) on
 * RISC-V, steps to the array load of the first pass through the loop, and
 * saves the workspace as workspace.png (device scale factor 2). The output
 * directory defaults to experiments/figures.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(import.meta.dirname, '..', '..');
const outDir = process.argv[2] ?? join(root, 'experiments', 'figures');
const port = Number(process.env.PW_PORT ?? 4175);
const channel = process.env.PW_CHANNEL ?? 'chrome';
const base = `http://localhost:${port}/isa-trace-lab/`;
const STATE_KEY = 'isa-trace-lab/state/1';

const source = readFileSync(join(root, 'examples', 'array_traversal.py'), 'utf8');

/** Address of the load of `data[i]` in `total += data[i]` in the RISC-V code of the running example. */
const LOAD_ADDRESS = '0x00400038';
/** Viewport width in CSS pixels: the narrowest width with the three-column layout. */
const WIDTH = 1200;
/** Space kept below the listing row of the load, in CSS pixels. */
const MARGIN = 2;

const server = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs'), '--port', String(port), '--base', '/isa-trace-lab/', '--dir', join(root, 'dist')], { stdio: 'ignore' });

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the static server did not start');
}

try {
  await waitForServer();
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(channel === 'bundled' ? {} : { channel });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce', colorScheme: 'light' });
  await context.addInitScript(([key, value]) => { window.localStorage.setItem(key, value); },
    [STATE_KEY, JSON.stringify({ target: 'riscv', source, exampleId: 'array_traversal', args: [], beginner: false, progress: {} })]);
  const page = await context.newPage();
  await page.goto(`${base}#/workspace`);
  const machine = page.locator('section[aria-labelledby="machine-heading"]');
  const status = machine.locator('.status').first();
  await page.getByText('No errors. Compiled for RISC-V RV32I.').waitFor();
  for (let i = 0; i < 50 && !(await status.textContent())?.includes(`paused at ${LOAD_ADDRESS}`); i++) {
    await machine.getByRole('button', { name: 'Step instruction' }).click();
    await page.waitForTimeout(50);
  }
  const text = await status.textContent();
  if (!text?.includes(`paused at ${LOAD_ADDRESS}`)) throw new Error(`the workspace did not stop at ${LOAD_ADDRESS}: ${text}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const box = await page.locator('main').boundingBox();
  const row = await page.locator('tr', { hasText: LOAD_ADDRESS }).first().boundingBox();
  if (!box || !row) throw new Error('the workspace or the listing row of the load is not visible');
  const height = row.y + row.height + MARGIN - box.y;
  await page.screenshot({ path: join(outDir, 'workspace.png'), fullPage: true, clip: { x: box.x, y: box.y, width: box.width, height } });
  await browser.close();
  console.log(`wrote ${join(outDir, 'workspace.png')}`);
} finally {
  server.kill();
}
