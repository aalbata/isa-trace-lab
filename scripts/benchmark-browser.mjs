/**
 * End-to-end timings of the web application in Google Chrome, driven by
 * Playwright, on the production build served under a repository path.
 *
 *   npm run build
 *   node scripts/benchmark-browser.mjs [--repetitions 10] [--out experiments/results/benchmark-browser.json]
 *
 * Measured, each separately:
 *   cold start       new browser context (empty cache), from navigation to the workspace until the
 *                    program is compiled and the simulated machine is ready;
 *   bytecode load    from the request for the bytecode view until CPython bytecode is shown (empty cache);
 *   step latency     from a click on "Step instruction" until the status line shows the new count
 *                    (worker round trip and rendering);
 *   long run         from a click on "Run" until the result is shown, for a loop of 60,000 iterations,
 *                    which executes between about 0.5 and 0.7 million instructions depending on the
 *                    target (sliced execution in the worker, with progress updates); the result file
 *                    records the count of each target.
 * Times are wall-clock milliseconds. Cold start, bytecode load, and long run are measured with
 * Date.now() in the Node.js process around the Playwright actions; step latency is measured with
 * performance.now() in the page.
 *
 * The browser is the installed Google Chrome, or the one that the environment variable PW_CHANNEL
 * selects, as for the browser tests: another installed channel such as msedge, or bundled for the
 * browser that Playwright downloads. The result file records the browser, its channel and version,
 * the Node.js and Playwright versions, and the timing method.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const repetitions = Number(opt('repetitions', '10'));
const out = join(root, opt('out', 'experiments/results/benchmark-browser.json'));
const port = 4175;
const base = `http://localhost:${port}/isa-trace-lab/`;
const KEY = 'isa-trace-lab/state/1';
const SUM = '# Sum of the integers from 1 to n with a for loop.\ndef main(n):\n    total = 0\n    for i in range(1, n + 1):\n        total += i\n    print(total)\n    return total\n';
const LONG = 'def main(n):\n    total = 0\n    for i in range(n):\n        total += i ^ (i >> 3)\n    return total\n';

function summary(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const r = (v) => Math.round(v * 10) / 10;
  return { n: s.length, median: r(q(0.5)), p25: r(q(0.25)), p75: r(q(0.75)), min: r(s[0]), max: r(s[s.length - 1]) };
}

const server = spawn(process.execPath, ['scripts/serve.mjs', '--port', String(port), '--base', '/isa-trace-lab/', '--dir', 'dist'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const channel = process.env.PW_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ channel: channel === 'bundled' ? undefined : channel });
const version = browser.version();

async function newPage(source, args, target = 'riscv') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [KEY, JSON.stringify({ target, source, exampleId: '', args, beginner: false, progress: {} })]);
  const page = await context.newPage();
  return { context, page };
}
const statusText = (page) => page.locator('section[aria-labelledby="machine-heading"] .status').first();

const cold = [];
const bytecode = [];
const steps = [];
const longRun = {};
try {
  for (let k = 0; k < repetitions; k++) {
    const { context, page } = await newPage(SUM, [10]);
    const t0 = Date.now();
    await page.goto(base + '#/workspace');
    await statusText(page).getByText('ready at 0x00400000').waitFor({ timeout: 60000 });
    cold.push(Date.now() - t0);

    const t1 = Date.now();
    await page.getByRole('button', { name: 'Load the CPython runtime and show bytecode' }).click();
    await page.getByText(/CPython 3\.14\.\d+ in Pyodide/).waitFor({ timeout: 120000 });
    bytecode.push(Date.now() - t1);

    for (let s = 1; s <= 20; s++) {
      const t2 = await page.evaluate(() => performance.now());
      await page.getByRole('button', { name: 'Step instruction' }).click();
      await statusText(page).getByText(`after ${s} instruction${s === 1 ? '' : 's'}`).waitFor();
      const t3 = await page.evaluate(() => performance.now());
      steps.push(t3 - t2);
    }
    await context.close();
  }
  for (const target of ['riscv', 'mips', 'aarch64', 'x86']) {
    const xs = [];
    let executed = 0;
    for (let k = 0; k < Math.max(3, Math.floor(repetitions / 2)); k++) {
      const { context, page } = await newPage(LONG, [60000], target);
      await page.goto(base + '#/workspace');
      await statusText(page).getByText('ready at 0x00400000').waitFor({ timeout: 60000 });
      const t0 = Date.now();
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await statusText(page).getByText(/main returned/).waitFor({ timeout: 120000 });
      xs.push(Date.now() - t0);
      const text = await statusText(page).textContent();
      executed = Number(/after (\d+) instructions/.exec(text ?? '')?.[1] ?? 0);
      await context.close();
    }
    longRun[target] = { executedInstructions: executed, ms: summary(xs) };
  }
} finally {
  await browser.close();
  server.kill();
}

const result = {
  environment: {
    date: new Date().toISOString(),
    browser: `${{ chrome: 'Google Chrome', msedge: 'Microsoft Edge', bundled: 'Chrome Headless Shell downloaded by Playwright' }[channel] ?? channel} ${version}`,
    channel,
    node: process.version,
    playwright: createRequire(import.meta.url)('@playwright/test/package.json').version,
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    server: 'scripts/serve.mjs on localhost (no network transfer time beyond the loopback interface)',
    method: 'cold start, bytecode load, and long run: Date.now() in the Node.js process around the Playwright actions; step latency: performance.now() in the page, read before the click and after the status line shows the new count',
    repetitions,
  },
  coldStartMs: summary(cold),
  bytecodeFirstLoadMs: summary(bytecode),
  stepLatencyMs: summary(steps),
  longRun,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ cold: result.coldStartMs, bytecode: result.bytecodeFirstLoadMs, step: result.stepLatencyMs, longRun }, null, 1));
