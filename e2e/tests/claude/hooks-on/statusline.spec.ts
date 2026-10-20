import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../../fixtures/pixel-agents';
import { ourHookEvents } from '../../../helpers/hooks';
import { advanceIntroToConsentStep, finishIntro } from '../../../helpers/intro';
import { openSettingsModal } from '../../../helpers/webview';

const STATUSLINE_LABEL = 'Claude status line (official limits)';
const USER_STATUS_LINE = { type: 'command', command: 'echo user-status', padding: 1 };

function readStatusLine(tmpHome: string): unknown {
  try {
    const raw = fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf8');
    return (JSON.parse(raw) as { statusLine?: unknown }).statusLine;
  } catch {
    return undefined;
  }
}

/**
 * The official limits wrapper in VS Code. The webview's Settings toggle reaches PixelAgentsViewProvider's own
 * dispatch, not the standalone handler, so the ask-first rule is pinned here too: a toggle-on over an unanswered ask
 * shows the wrapper's disclosure before anything is written, and Install chains it (the executor's install must not
 * loop back into the guarded toggle and ask again). Claude's consent is seeded, so its hooks install at startup and
 * only the wrapper is asked about.
 */
test.describe('Status line wrapper / VS Code', () => {
  test.use({ seedClaudeSettings: { statusLine: USER_STATUS_LINE } });

  test.skip(process.platform === 'win32', 'the wrapper runs the original through sh: POSIX only');

  test('the status line toggle asks before chaining the wrapper, and after Install the Usage panel waits for a reading @area:cross-cutting', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, narrator } = pixelAgents;

    await expect.poll(() => ourHookEvents(tmpHome).length, { timeout: 30_000 }).toBe(12);
    expect(readStatusLine(tmpHome)).toEqual(USER_STATUS_LINE);
    narrator.check('hooks installed at startup, the user status line untouched');

    narrator.step('turning on Claude status line (official limits)');
    const modal = await openSettingsModal(frame);
    await modal.locator('button', { hasText: STATUSLINE_LABEL }).click();

    const dialog = frame.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await advanceIntroToConsentStep(dialog);
    await expect(dialog).toContainText('statusLine.command');
    expect(readStatusLine(tmpHome)).toEqual(USER_STATUS_LINE);
    narrator.check('the Intro asks with the wrapper disclosure, nothing written yet');

    narrator.step('Install');
    await dialog.getByRole('button', { name: 'Install Hooks' }).click();

    const tee = path.join(tmpHome, '.pixelmates', 'hooks', 'statusline-tee.js');
    await expect
      .poll(() => readStatusLine(tmpHome), { timeout: 15_000 })
      .toEqual({ ...USER_STATUS_LINE, command: `node "${tee}" 'echo user-status'` });
    await finishIntro(dialog);
    narrator.check('statusLine.command chains the wrapper in front of the user command');

    // This window owns the server, so the panel knows the limits are on their way before the first reading.
    await frame.locator('button', { hasText: 'Usage' }).click();
    await expect(frame.getByText("Waiting for Claude Code's status line…")).toBeVisible({
      timeout: 15_000,
    });
    narrator.check('the Usage panel waits for the first status line reading');
  });
});
