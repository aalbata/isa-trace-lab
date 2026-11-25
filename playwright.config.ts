import { defineConfig } from '@playwright/test';

// The production build is served under a repository-style path, as on GitHub Pages.
// PW_CHANNEL selects the browser: 'chrome' (installed Google Chrome, the default), 'msedge',
// or 'bundled' for the Chromium that `npx playwright install chromium` downloads.
// PW_PORT selects the port of the local test server (default 4174).
const channel = process.env.PW_CHANNEL ?? 'chrome';
const port = Number(process.env.PW_PORT ?? 4174);

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-results.json' }]],
  use: {
    baseURL: `http://localhost:${port}/isa-trace-lab/`,
    ...(channel === 'bundled' ? {} : { channel }),
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `node scripts/serve.mjs --port ${port} --base /isa-trace-lab/ --dir dist`,
    url: `http://localhost:${port}/isa-trace-lab/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
