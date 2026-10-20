import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { ourHookEvents } from '../../helpers/hooks';
import { advanceIntroToConsentStep, finishIntro } from '../../helpers/intro';
import { getSettingChecked, openSettingsModal } from '../../helpers/webview';

const STATUSLINE_LABEL = 'Claude status line (official limits)';
const USER_STATUS_LINE = { type: 'command', command: 'echo user-status', padding: 1 };

function settingsPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude', 'settings.json');
}

function readStatusLine(tmpHome: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(settingsPath(tmpHome), 'utf8')) as { statusLine?: unknown })
      .statusLine;
  } catch {
    return undefined;
  }
}

/** Click the status line checkbox once, whatever it shows: the click under test, never a conditional one. */
async function clickStatuslineCheckbox(page: Page): Promise<Locator> {
  const modal = await openSettingsModal(page);
  await modal.locator('button', { hasText: STATUSLINE_LABEL }).click();
  return modal;
}

/** The checkbox as an open Settings modal shows it. */
async function statuslineChecked(modal: Locator): Promise<boolean> {
  const indicator = modal.locator('button', { hasText: STATUSLINE_LABEL }).locator('span').last();
  return ((await indicator.textContent()) ?? '').trim().toLowerCase() === 'x';
}

/**
 * The official limits wrapper (provider 'claude-statusline') is off by default and the Settings checkbox is the only
 * way in: a toggle-on asks first in the Intro, Install chains the wrapper in front of the user's status line, and a
 * toggle-off puts the original back exactly. The fixture seeds a granted Claude consent, so the hooks install at
 * startup and only the wrapper is asked about.
 */
test.describe('Standalone / status line wrapper', () => {
  test.skip(process.platform === 'win32', 'the wrapper runs the original through sh: POSIX only');

  test('the status line checkbox asks first, Install chains the wrapper, off restores the original @area:standalone', async ({
    page,
    standalone,
  }) => {
    const { tmpHome } = standalone;
    // The user's own status line, next to the hooks the startup install wrote.
    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    const settings = JSON.parse(fs.readFileSync(settingsPath(tmpHome), 'utf8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      settingsPath(tmpHome),
      JSON.stringify({ ...settings, statusLine: USER_STATUS_LINE }, null, 2),
    );
    // Its own row: off while the hooks are on.
    expect(await getSettingChecked(page, STATUSLINE_LABEL)).toBe(false);

    const modal = await clickStatuslineCheckbox(page);

    // Asked, not installed: Settings gives way to the Intro, which carries the wrapper's own terms.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(modal).toBeHidden({ timeout: 15_000 });
    await advanceIntroToConsentStep(dialog);
    await expect(dialog).toContainText('statusLine.command');
    expect(readStatusLine(tmpHome)).toEqual(USER_STATUS_LINE);

    await dialog.getByRole('button', { name: 'Install Hooks' }).click();

    const tee = path.join(tmpHome, '.pixelmates', 'hooks', 'statusline-tee.js');
    await expect
      .poll(() => readStatusLine(tmpHome), { timeout: 15_000 })
      .toEqual({ ...USER_STATUS_LINE, command: `node "${tee}" 'echo user-status'` });
    await finishIntro(dialog);
    expect(await getSettingChecked(page, STATUSLINE_LABEL)).toBe(true);

    // Off uninstalls, and the original comes back exactly.
    const reopened = await clickStatuslineCheckbox(page);

    await expect.poll(() => readStatusLine(tmpHome), { timeout: 15_000 }).toEqual(USER_STATUS_LINE);
    await expect.poll(() => statuslineChecked(reopened), { timeout: 15_000 }).toBe(false);
  });
});
