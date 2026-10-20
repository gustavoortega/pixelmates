import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import type { TestHooksWindow } from '../../helpers/editor';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { buildSeedLayout } from '../../helpers/layout-seed';
import {
  closeAgentFromOverlay,
  expectOverlayCount,
  expectOverlayVisible,
} from '../../helpers/office';
import type { RecordedServerMessage } from '../../helpers/standalone';
import { openSettingsModal, setSettings } from '../../helpers/webview';

// The DebugView diagnostics block polls every 2s (see DebugView.tsx); allow a
// few polling rounds plus IPC/render slop.
const DIAGNOSTICS_POLL_TIMEOUT_MS = 15_000;
// onReloadAssets does its filesystem work after the externalAssetDirectoriesUpdated
// reply, so the re-broadcast lands slightly later than the dir-list update.
const ASSET_RELOAD_TIMEOUT_MS = 15_000;
// WebSocketTransport reconnects with exponential backoff: 1 s, doubling, capped at
// 30 s. A stop and restart spans the first few steps; allow a couple of them.
const CONNECTION_STATE_TIMEOUT_MS = 15_000;
// Longer than one backoff step after a quick reconnect: a refused reconnect would
// bring the indicator back (or take the notice away) within it.
const STEADY_MS = 3_000;

/** Assert `holds` at every look for `ms`: one look at the end would miss a flap. */
async function expectSteadyFor(page: Page, ms: number, holds: () => Promise<boolean>) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect(await holds()).toBe(true);
    await page.waitForTimeout(100);
  }
}

/** Top-level agents the office draws: helpers have negative ids, the greeter is no agent. */
async function officeAgentIds(page: Page): Promise<number[]> {
  return await page.evaluate(() => {
    interface CharacterHooks {
      getCharacters?: () => Array<{ id: number; isGreeter?: boolean }>;
    }
    const hooks = (window as { __pixelAgentsTestHooks?: CharacterHooks }).__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? [])
      .filter((c) => c.id > 0 && !c.isGreeter)
      .map((c) => c.id)
      .sort((a, b) => a - b);
  });
}

/** The agents a host holds, as its messages since its last existingAgents say. */
function hostAgentIds(messages: RecordedServerMessage[]): number[] {
  const at = messages.map((m) => m.type).lastIndexOf('existingAgents');
  const ids = new Set(at >= 0 ? (messages[at].agents as number[]) : []);
  for (const m of messages.slice(at + 1)) {
    if (m.type === 'agentCreated') ids.add(m.id as number);
    if (m.type === 'agentClosed') ids.delete(m.id as number);
  }
  return [...ids].sort((a, b) => a - b);
}

test.describe('Standalone / UI', () => {
  test('closeAgent despawns the character @area:standalone', async ({ page, standalone }) => {
    await setSettings(page, {
      hooksEnabled: true,
      watchAllSessions: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'standalone-close-agent-session';
    const filePath = path.join(standalone.workspaceDir, 'close-agent.ts');

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Reading close-agent.ts');
    await standalone.drainMessages();

    await closeAgentFromOverlay(page, { text: 'Reading close-agent.ts' });

    await expectOverlayCount(page, 0);
    const messages = await standalone.drainMessages();
    expect(messages.some((message) => message.type === 'agentClosed')).toBe(true);
  });

  test('Debug View renders JSONL diagnostics in standalone @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      debugView: true,
      hooksEnabled: true,
      watchAllSessions: true,
    });

    const sessionId = 'standalone-debug-view-session';
    const filePath = path.join(standalone.workspaceDir, 'debug-view.ts');

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    // Presence of the diagnostics block (either branch) is the proof that the
    // agentDiagnostics reply reached the webview via transport.onMessage; do
    // not assert a specific jsonlExists branch (a hook-only session may or may
    // not have a materialized transcript file).
    await expect(page.getByText(/JSONL (connected|not found)/)).toBeVisible({
      timeout: DIAGNOSTICS_POLL_TIMEOUT_MS,
    });
  });

  test('adding an external asset directory triggers a live asset reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    const modal = await openSettingsModal(page);
    await standalone.drainMessages();

    await modal
      .locator('input[placeholder="Absolute asset directory path"]')
      .fill(standalone.workspaceDir);
    await modal.locator('button', { hasText: 'Add' }).click();

    // getByTitle matches the title attribute literally; a raw CSS
    // [title="..."] selector would mis-parse the backslashes in a Windows path
    // as CSS escapes and never match its own title.
    await expect(modal.getByTitle(standalone.workspaceDir, { exact: true })).toBeVisible();

    // Light depth: prove the onReloadAssets re-broadcast fired, not a
    // character-count delta (no fixture PNGs staged in workspaceDir).
    await expect
      .poll(
        async () => {
          const messages = await standalone.drainMessages();
          return messages.some((message) => message.type === 'characterSpritesLoaded');
        },
        { timeout: ASSET_RELOAD_TIMEOUT_MS },
      )
      .toBe(true);
  });

  test('browser Export Layout downloads the layout file @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    const modal = await openSettingsModal(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      modal.locator('button', { hasText: 'Export Layout' }).click(),
    ]);

    expect(download.suggestedFilename()).toBe('pixelmates-layout.json');
  });

  test('browser Import Layout applies the chosen file @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const uniqueLabel = `Imported Area ${Date.now().toString()}`;
    const layout = buildSeedLayout({
      areas: [{ label: uniqueLabel, color: '#4287f5' }],
      areaTiles: [{ col: 1, row: 1, label: uniqueLabel }],
    });
    const tmpFile = path.join(os.tmpdir(), `pixel-agents-import-${Date.now().toString()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(layout));

    try {
      const modal = await openSettingsModal(page);
      // Set the hidden import input directly rather than clicking "Import
      // Layout" (which would open the OS file dialog Playwright can't drive).
      await page.setInputFiles('input[type="file"]', tmpFile);
      await expect(modal).toBeHidden();

      // saveLayout is client→server and unrecorded by drainMessages (Seam A),
      // so assert the applied OfficeState instead of the wire message.
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as TestHooksWindow).__pixelAgentsTestHooks?.getAreas?.() ?? [],
          ),
        )
        .toContainEqual({ label: uniqueLabel, color: '#4287f5' });
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test('ConnectionIndicator shows a drop, and a host restarted with the same token resyncs the page without a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { hooksEnabled: true, watchAllSessions: true });
    // A session start, confirmed by its first tool call (the closeAgent flow above).
    const startSession = async (sessionId: string) => {
      await sendHookEvent(
        standalone.hookServerConfig,
        sessionStartStartup(sessionId, standalone.workspaceDir),
      );
      await sendHookEvent(standalone.hookServerConfig, {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: path.join(standalone.workspaceDir, `${sessionId}.ts`) },
      });
    };
    // Only this host knows the session: hook-only, no transcript, so a restart cannot
    // restore it.
    await startSession('standalone-reconnect-ended');
    await expect.poll(() => officeAgentIds(page)).toHaveLength(1);
    const [endedId] = await officeAgentIds(page);
    await standalone.drainMessages();
    await page.evaluate(() => {
      (window as { __beforeRestart?: boolean }).__beforeRestart = true;
    });

    // Settle wait before the negative assertion (office.ts wait-strategy
    // convention): give the runtime a chance to render the indicator wrongly
    // before checking absence.
    await page.waitForTimeout(500);
    await expect(page.getByText(/Reconnecting|Disconnected/)).toHaveCount(0);

    // Fallback for assumption A1: `page.context().setOffline(true)` does not
    // reliably close an already-open WebSocket on this Chromium build (verified
    // empirically — the indicator never appeared). Stopping the real host
    // process closes the socket from the server side instead. A crash, not a
    // shutdown: a graceful stop sends agentClosed for every agent first, and the
    // page must learn that this one ended from the resync alone.
    await standalone.stopHost({ crash: true });
    await expect(page.getByText(/Reconnecting|Disconnected/)).toBeVisible({
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });

    await standalone.startHost(standalone.token);
    const indicator = page.getByTestId('connection-indicator');
    await expect(indicator).toHaveCount(0, { timeout: CONNECTION_STATE_TIMEOUT_MS });
    await expectSteadyFor(page, STEADY_MS, async () => (await indicator.count()) === 0);

    // The office shows the second host's agents: the first host's session went with it,
    // and one the second host adopts appears.
    const received = await standalone.drainMessages();
    const atResync = hostAgentIds(received);
    expect(atResync).not.toContain(endedId);
    await expect.poll(() => officeAgentIds(page)).toEqual(atResync);
    await startSession('standalone-reconnect-new');
    await expect
      .poll(async () => {
        received.push(...(await standalone.drainMessages()));
        const host = hostAgentIds(received);
        const office = await officeAgentIds(page);
        return host.length > atResync.length && office.join() === host.join();
      })
      .toBe(true);
    expect(
      await page.evaluate(() => (window as { __beforeRestart?: boolean }).__beforeRestart),
    ).toBe(true);
  });

  test('a host restarted with another token leaves a lasting notice instead of a reconnect loop @area:standalone', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await standalone.stopHost();
    await expect(page.getByText(/Reconnecting|Disconnected/)).toBeVisible({
      timeout: CONNECTION_STATE_TIMEOUT_MS,
    });

    // No token: the restarted host mints its own, which the page's URL does not carry.
    await standalone.startHost();
    const notice = page.getByText('Server token changed. Open the link printed by the CLI.');
    await expect(notice).toBeVisible({ timeout: CONNECTION_STATE_TIMEOUT_MS });
    await expectSteadyFor(page, STEADY_MS, () => notice.isVisible());
  });
});
