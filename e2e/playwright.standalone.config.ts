import { defineConfig } from '@playwright/test';
import path from 'path';

import { namespaceE2EPath } from './run-config';

process.env['ALLURE_LABEL_epic'] ??= 'e2e';

const artifactsDir = namespaceE2EPath(path.join(__dirname, '../test-results/e2e'));
const htmlReportDir = namespaceE2EPath(path.join(__dirname, '../playwright-report/e2e'));

// The standalone project: the real CLI in a browser page. No VS Code and no global setup, so nothing
// downloads or launches an editor. CI runs this one (e2e/playwright.config.ts is the full local suite).
export default defineConfig({
  testDir: path.join(__dirname, 'tests/standalone'),
  // Needs the VS Code extension fixture.
  testIgnore: ['**/multi-server-hooks.spec.ts'],
  timeout: 120_000,
  reporter: [['list'], ['html', { outputFolder: htmlReportDir, open: 'never' }]],
  outputDir: artifactsDir,
  use: {
    video: 'retain-on-failure',
  },
  workers: 1,
  fullyParallel: true,
  retries: 1,
});
