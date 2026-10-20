import { defineConfig } from '@playwright/test';
import path from 'path';

/**
 * Render cost measurement, outside the e2e suite (e2e/playwright.config.ts never sees it): the
 * dev server's scenes sampled for frames drawn, animation frames requested and main-thread task
 * time. `npm run e2e:perf` starts the branch's dev server; PIXELMATES_PERF_URL measures one
 * already running instead (another checkout's, to compare).
 */
const PORT = 5199;
const externalUrl = process.env['PIXELMATES_PERF_URL'];

export default defineConfig({
  testDir: __dirname,
  timeout: 5 * 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(__dirname, '../../test-results/e2e-perf'),
  use: {
    baseURL: externalUrl ?? `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
  },
  webServer: externalUrl
    ? undefined
    : {
        command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
        cwd: path.join(__dirname, '../../webview-ui'),
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
