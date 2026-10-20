import fs from 'node:fs';
import path from 'node:path';

import type { Page, TestInfo } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

import { applyAllureLabels } from '../helpers/allure-labels';
import { launchStandalone, type StandaloneSession } from '../helpers/standalone';

export interface StandaloneContext extends StandaloneSession {}

async function attachTextFileIfExists(
  testInfo: TestInfo,
  name: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) return;
    await testInfo.attach(name, {
      body: fs.readFileSync(filePath, 'utf8'),
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

async function attachText(
  testInfo: TestInfo,
  name: string,
  body: string,
  contentType: string,
): Promise<void> {
  try {
    if (body.length === 0) return;
    await testInfo.attach(name, {
      body,
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

/** A policy refusal as Chrome or Firefox (which hyphenates the name) words it,
 *  or as nosniff words a script or stylesheet served with the wrong type. */
const POLICY_REFUSAL = /Content[ -]Security[ -]Policy|Refused to /i;

type CspWindow = Window & { __csp?: string[] };

async function readCspViolations(page: Page): Promise<string[]> {
  return await page.evaluate(() => [...((window as CspWindow).__csp ?? [])]);
}

/**
 * The server's security headers are only as good as the SPA's ability to live
 * under them, so every standalone spec runs the real SPA under them: watch the
 * page from before its first navigation, and hand back the teardown check.
 */
async function watchPagePolicy(page: Page): Promise<() => Promise<void>> {
  const refusals: string[] = [];
  let socketFrames = 0;
  page.on('console', (message) => {
    if (POLICY_REFUSAL.test(message.text())) refusals.push(message.text());
  });
  // Other uncaught errors belong to the spec: the reconnect spec kills the
  // server on purpose.
  page.on('pageerror', (error) => {
    if (POLICY_REFUSAL.test(error.message)) refusals.push(error.message);
  });
  // connect-src 'self' admits the socket only through CSP3 matching ws: on the
  // page's own host and port, so the SPA must get frames on exactly that one.
  page.on('websocket', (socket) => {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/ws\?token=/.test(socket.url())) return;
    socket.on('framereceived', () => {
      socketFrames += 1;
    });
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      ((window as CspWindow).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });

  return async () => {
    expect(refusals, 'policy refusals in the console or thrown').toEqual([]);
    expect(socketFrames, 'frames on the ws://127.0.0.1 /ws?token= socket').toBeGreaterThan(0);
    if (page.isClosed()) return;
    expect(await readCspViolations(page), 'securitypolicyviolation events').toEqual([]);

    // Positive control: with no policy in force (a dropped header, a bypassCSP
    // context) every check above passes on silence. An inline script must be
    // refused and reach the collector.
    await page.evaluate(() => {
      const probe = document.createElement('script');
      probe.textContent = 'window.__cspProbeRan = true;';
      document.body.appendChild(probe);
    });
    await expect
      .poll(() => readCspViolations(page), { message: 'the inline-script probe is refused' })
      .toEqual([expect.stringMatching(/^script-src/)]);
    expect(
      await page.evaluate(() => (window as Window & { __cspProbeRan?: boolean }).__cspProbeRan),
    ).toBeUndefined();
  };
}

export const test = base.extend<{
  standalone: StandaloneContext;
  _allureLabels: void;
  /** Seed a granted Claude hooksConsent entry in the isolated HOME (default). The
   *  consent specs opt out via `test.use({ seedHooksConsent: false })` so the
   *  first-run dialog shows — they are the only ones that want it. */
  seedHooksConsent: boolean;
}>({
  seedHooksConsent: [true, { option: true }],
  // Auto-fixture: tag every test with Allure epic + feature derived from its
  // @area: annotation and enclosing describe path. Runs before standalone.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  standalone: async ({ page, seedHooksConsent }, use, testInfo) => {
    const assertPagePolicy = await watchPagePolicy(page);
    const standalone = await launchStandalone(page, { seedHooksConsent });

    try {
      await use(standalone);
      await assertPagePolicy();
    } finally {
      await attachText(testInfo, 'standalone-host-log', standalone.getHostLogs(), 'text/plain');
      await attachTextFileIfExists(
        testInfo,
        'server-json',
        path.join(standalone.tmpHome, '.pixelmates', 'server.json'),
        'application/json',
      );

      try {
        const screenshotPath = testInfo.outputPath('final-screenshot.png');
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach('final-screenshot', {
          path: screenshotPath,
          contentType: 'image/png',
        });
      } catch {
        // Screenshot failures are non-fatal in teardown.
      }

      await standalone.cleanup();
    }
  },
});

export { expect };
