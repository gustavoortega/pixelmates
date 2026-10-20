import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import type { StandaloneSession } from '../../helpers/standalone';
import { advanceIntroToConsentStep, finishIntro } from '../../helpers/intro';
import { openSettingsModal, setSettings } from '../../helpers/webview';

/**
 * The monitor's attention rail on the real standalone server, driven by real hook events (and,
 * for the health mark, a real transcript the server reads): who gets a ticket, how long it has
 * waited by the server's clock, what a click selects, what privacy mode hides, how wide the rail
 * is at each window size, and that an absent limit never reads 0 %.
 */

const MIN = 60_000;
/** How far the page's clock is moved before a reconnect, so a since restamped on receipt reads 0. */
const JUMP_MIN = 7;

interface MonitorWindow extends Window {
  __pixelAgentsTestHooks?: {
    getCharacters?: () => Array<{ id: number; isGreeter?: boolean }>;
    getSelection?: () => { selectedAgentId: number | null; cameraFollowId: number | null };
  };
  __pixelAgentsDeliver?: (msg: unknown) => void;
}

async function agentIds(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    ((window as MonitorWindow).__pixelAgentsTestHooks?.getCharacters?.() ?? [])
      .filter((c) => c.id > 0 && !c.isGreeter)
      .map((c) => c.id)
      .sort((a, b) => a - b),
  );
}

/** Start a hook session and wait for its character: the id the office gave it. */
async function startAgent(
  page: Page,
  standalone: StandaloneSession,
  sessionId: string,
  firstTool: { name: string; input: Record<string, unknown> },
  transcriptPath?: string,
): Promise<number> {
  const before = await agentIds(page);
  await sendHookEvent(
    standalone.hookServerConfig,
    sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
  );
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: firstTool.name,
    tool_input: firstTool.input,
  });
  let id = -1;
  await expect
    .poll(async () => {
      id = (await agentIds(page)).find((a) => !before.includes(a)) ?? -1;
      return id;
    })
    .toBeGreaterThan(0);
  return id;
}

/**
 * A session with a transcript, as Claude Code runs one: the server reads its records (the open
 * tool a reconnect restates, the test runs health counts) beside the hooks.
 */
function transcriptSession(standalone: StandaloneSession, sessionId: string) {
  const projectDir = path.join(standalone.tmpHome, '.claude', 'projects', 'monitor-rail');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const append = (record: Record<string, unknown>) =>
    fs.appendFileSync(
      file,
      `${JSON.stringify({ sessionId, timestamp: new Date().toISOString(), ...record })}\n`,
    );
  append({ type: 'user', message: { role: 'user', content: 'go' } });
  const toolUse = (toolId: string, command: string) =>
    append({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }],
      },
    });
  const toolResult = (toolId: string, content: string) =>
    append({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content }],
      },
    });
  return { file, toolUse, toolResult };
}

/** A transcript session waiting on a prompt for `command`: its tool is in the transcript too, so
 *  a handshake restates it with the prompt still pending. */
async function promptedTranscriptAgent(
  page: Page,
  standalone: StandaloneSession,
  sessionId: string,
  command: string,
): Promise<number> {
  const session = transcriptSession(standalone, sessionId);
  const id = await startAgent(
    page,
    standalone,
    sessionId,
    { name: 'Bash', input: { command } },
    session.file,
  );
  session.toolUse(`toolu_${sessionId.slice(0, 8)}`, command);
  await askPermission(standalone, sessionId);
  await expect(ticket(page, id)).toHaveAttribute('data-kind', 'permission');
  // The poll reads the appended record within a second.
  await page.waitForTimeout(1_500);
  return id;
}

/** A transcript session with three red test runs and no edit between them: health marks it
 *  stuck, so it gets a Stuck ticket. Health reads the transcript only. */
async function stuckTranscriptAgent(
  page: Page,
  standalone: StandaloneSession,
  sessionId: string,
): Promise<number> {
  const session = transcriptSession(standalone, sessionId);
  const id = await startAgent(
    page,
    standalone,
    sessionId,
    { name: 'Read', input: { file_path: path.join(standalone.workspaceDir, 'cart.ts') } },
    session.file,
  );
  for (let run = 1; run <= 3; run++) {
    session.toolUse(`toolu_red_${run}`, 'npm test');
    session.toolResult(
      `toolu_red_${run}`,
      ' Test Files  1 failed (1)\n      Tests  3 failed | 41 passed (44)',
    );
  }
  await expect(ticket(page, id)).toHaveAttribute('data-kind', 'stuck', { timeout: 15_000 });
  return id;
}

async function askPermission(standalone: StandaloneSession, sessionId: string): Promise<void> {
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: sessionId,
    hook_event_name: 'PermissionRequest',
  });
}

function ticket(page: Page, id: number): Locator {
  return page.locator(`[data-testid="monitor-ticket"][data-agent-id="${id}"]`);
}

/** The minutes block as shown: `12MIN` reads 12. */
async function shownMinutes(t: Locator): Promise<string> {
  return ((await t.locator('.tk-time').textContent()) ?? '').replace('MIN', '').trim();
}

async function colorOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).color);
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test.describe('Standalone / monitor attention rail', () => {
  test.beforeEach(async ({ page, standalone }) => {
    void standalone;
    await setSettings(page, { watchAllSessions: true });
  });

  // C5.1: the ticket comes from the open tool row's permission wait (the row the prompt holds),
  // and goes when the tool runs.
  test('a permission prompt puts a ticket with its program and minutes, and answering removes it @area:standalone', async ({
    page,
    standalone,
  }) => {
    const id = await startAgent(page, standalone, 'rail-permission', {
      name: 'Bash',
      input: { command: 'git push origin main --force-with-lease' },
    });
    await expect(ticket(page, id)).toHaveCount(0);

    await askPermission(standalone, 'rail-permission');

    const t = ticket(page, id);
    await expect(t).toHaveAttribute('data-kind', 'permission');
    await expect(t.locator('.tk-why')).toHaveText('Allow git push?');
    await expect(t.locator('.tk-time')).toHaveText('0MIN');
    await expect(page.getByTestId('monitor-rail')).not.toContainText('origin');

    // Approved: the tool runs, and its result ends the prompt.
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: 'rail-permission',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    });
    await expect(t).toHaveCount(0);
  });

  // B2/B6: a question tool puts a ticket with the agent's own words, cut to two lines, so three
  // tickets still sit inside the rail at 800 px; answering it removes the ticket.
  test('a question tool puts a two-line ticket with its text, and three tickets fit at 800 px @area:standalone', async ({
    page,
    standalone,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const long =
      'Which database should the migration target when the staging copy is stale? '.repeat(2);
    const ask = (sessionId: string, question: string) =>
      sendHookEvent(standalone.hookServerConfig, {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question }] },
      });
    const a = await startAgent(page, standalone, 'rail-question-a', {
      name: 'Bash',
      input: { command: 'git push' },
    });
    const b = await startAgent(page, standalone, 'rail-question-b', {
      name: 'Read',
      input: { file_path: '/tmp/x' },
    });
    const c = await startAgent(page, standalone, 'rail-question-c', {
      name: 'Read',
      input: { file_path: '/tmp/y' },
    });
    await ask('rail-question-a', long);
    await ask('rail-question-b', 'Ship it?');
    await ask('rail-question-c', long);

    for (const id of [a, b, c]) {
      await expect(ticket(page, id)).toHaveAttribute('data-kind', 'question');
    }
    await expect(ticket(page, b).locator('.tk-why')).toHaveText('Ship it?');
    const rail = await page.getByTestId('monitor-rail').boundingBox();
    for (const id of [a, b, c]) {
      const box = await ticket(page, id).boundingBox();
      expect(box!.y + box!.height, `ticket ${id} bottom`).toBeLessThanOrEqual(
        rail!.y + rail!.height + 0.5,
      );
      expect(box!.y + box!.height, `ticket ${id} in the window`).toBeLessThanOrEqual(800);
    }
    const lines = await ticket(page, a)
      .locator('.tk-why')
      .evaluate((e) => {
        const style = getComputedStyle(e);
        return Math.round(e.getBoundingClientRect().height / parseFloat(style.lineHeight));
      });
    expect(lines).toBeLessThanOrEqual(2);

    await sendHookEvent(standalone.hookServerConfig, {
      session_id: 'rail-question-b',
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion',
    });
    await expect(ticket(page, b)).toHaveCount(0);
  });

  // C5.2: the minutes are the server's permissionSince, which the reconnect's resend restates.
  test('after a reconnect the ticket keeps the minutes the server dated its prompt to @area:standalone', async ({
    page,
    standalone,
  }) => {
    const id = await promptedTranscriptAgent(
      page,
      standalone,
      '6f1c1d2e-0000-4000-8000-00000000c502',
      'npm publish',
    );
    const t = ticket(page, id);
    await expect(t.locator('.tk-why')).toHaveText('Allow npm publish?');
    const since = (await standalone.drainMessages()).find(
      (m) => m.type === 'agentToolPermission',
    )?.permissionSince;
    expect(typeof since).toBe('number');

    // The page's clock moves on: a since stamped on receipt would restart at 0 now.
    await page.clock.setFixedTime((since as number) + JUMP_MIN * MIN + 5_000);
    await standalone.dropSocket();
    await expect
      .poll(async () => (await standalone.drainMessages()).map((m) => m.type))
      .toContain('handshakeDone');

    await expect(t).toHaveAttribute('data-kind', 'permission');
    await expect.poll(() => shownMinutes(t)).toBe(String(JUMP_MIN));
  });

  // C5.3. The whole map fits the stage here, so the selection starts no follow (Q4.4).
  test('a click on a ticket selects that agent @area:standalone', async ({ page, standalone }) => {
    const first = await startAgent(page, standalone, 'rail-click-a', {
      name: 'Bash',
      input: { command: 'git push' },
    });
    const second = await startAgent(page, standalone, 'rail-click-b', {
      name: 'Bash',
      input: { command: 'gh pr merge' },
    });
    // Asked in this order, so the second agent's ticket is the second one down.
    await askPermission(standalone, 'rail-click-a');
    await expect(ticket(page, first)).toHaveCount(1);
    await page.waitForTimeout(1_100);
    await askPermission(standalone, 'rail-click-b');
    const tickets = page.getByTestId('monitor-ticket');
    await expect(tickets).toHaveCount(2);
    await expect(tickets.nth(1)).toHaveAttribute('data-agent-id', String(second));

    await tickets.nth(1).click();

    await expect
      .poll(() =>
        page.evaluate(() => (window as MonitorWindow).__pixelAgentsTestHooks?.getSelection?.()),
      )
      .toEqual({ selectedAgentId: second, cameraFollowId: null });
    await expect(ticket(page, second)).toHaveAttribute('data-selected', 'true');
    await expect(ticket(page, first)).toHaveAttribute('data-selected', 'false');
  });

  // C5.4: masked = transparent text over a bar; the S1 emitter of the branch is not merged yet,
  // so the branch arrives as the server will send it, through the page's socket.
  test('P masks the branch and the reason, keeps the name, and stays on after a reload @area:standalone', async ({
    page,
    standalone,
  }) => {
    // The branch is on the stub, which only the 360 px rail shows.
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = await promptedTranscriptAgent(
      page,
      standalone,
      '6f1c1d2e-0000-4000-8000-00000000c504',
      'git push',
    );
    await page.evaluate(
      (agentId) =>
        (window as MonitorWindow).__pixelAgentsDeliver?.({
          type: 'agentSession',
          id: agentId,
          branch: 'feat/secret-launch',
        }),
      id,
    );
    const t = ticket(page, id);
    const where = t.locator('[data-part="where"]');
    const reason = t.locator('[data-part="reason"]');
    const name = t.locator('[data-part="name"]');
    await expect(where).toHaveText('feat/secret-launch');
    await expect(where).toBeVisible();
    expect(await colorOf(where)).not.toBe(TRANSPARENT);

    await page.keyboard.press('p');

    await expect.poll(() => colorOf(where)).toBe(TRANSPARENT);
    expect(await colorOf(reason)).toBe(TRANSPARENT);
    expect(await colorOf(name)).not.toBe(TRANSPARENT);
    await expect(t.locator('.tk-time')).not.toHaveCSS('color', TRANSPARENT);

    await page.reload();
    await expect(ticket(page, id).locator('[data-part="reason"]')).toHaveText('Allow git push?');
    expect(await colorOf(ticket(page, id).locator('[data-part="reason"]'))).toBe(TRANSPARENT);
    expect(await colorOf(ticket(page, id).locator('[data-part="name"]'))).not.toBe(TRANSPARENT);

    await page.keyboard.press('p');
    await expect
      .poll(() => colorOf(ticket(page, id).locator('[data-part="reason"]')))
      .not.toBe(TRANSPARENT);
  });

  // C5.7: the health mark's minutes are the server's since too. Health reads the transcript only,
  // so the agent's own transcript gets three red test runs.
  test('a stuck agent keeps its minutes across a reconnect @area:standalone', async ({
    page,
    standalone,
  }) => {
    const id = await stuckTranscriptAgent(page, standalone, '6f1c1d2e-0000-4000-8000-00000000c507');

    const t = ticket(page, id);
    await expect(t.locator('.tk-why')).toContainText('tests failing ×3');
    let since: unknown;
    await expect
      .poll(async () => {
        since ??= (await standalone.drainMessages()).find((m) => m.type === 'agentHealth')?.since;
        return typeof since;
      })
      .toBe('number');

    await page.clock.setFixedTime((since as number) + JUMP_MIN * MIN + 5_000);
    await standalone.dropSocket();
    await expect
      .poll(async () => (await standalone.drainMessages()).map((m) => m.type))
      .toContain('handshakeDone');

    await expect(t).toHaveAttribute('data-kind', 'stuck');
    await expect.poll(() => shownMinutes(t)).toBe(String(JUMP_MIN));
  });
});

/**
 * Q2.1: the smallest type anywhere in the rail, as computed. The plan's sizes are how tall type
 * reads: FS Pixel Sans draws caps 7/16 em tall, so 12 px type (caps 0.7 x 12 px) needs 19.2 px.
 */
const MIN_RAIL_FONT_PX = (12 * 0.7 * 16) / 7;
/** R2: how tall FS Pixel Sans reads per CSS px, rounded down from that 0.625. */
const READS_AS = 0.6;

async function smallestRailText(page: Page): Promise<{ px: number; text: string }> {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-testid="monitor-rail"]');
    let px = Infinity;
    let text = '';
    if (!rail) return { px, text: 'no rail' };
    const walker = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const shown = n.textContent?.trim();
      if (!shown || !n.parentElement) continue;
      const size = parseFloat(getComputedStyle(n.parentElement).fontSize);
      if (size < px) {
        px = size;
        text = shown;
      }
    }
    return { px, text };
  });
}

test.describe('Standalone / monitor rail type', () => {
  test.beforeEach(async ({ page, standalone }) => {
    void standalone;
    await setSettings(page, { watchAllSessions: true });
  });

  // Q2.1: a permission ticket, a stuck one (with its reason's tail), the minutes' unit, the stub
  // and the Pace header all on screen, at both rail widths. R2: beside the 1920 office a name
  // reads 16 px, a reason 20 and the stub 12; below 1400 wide the stub, which would only fit cut,
  // is gone.
  test('no rail text reads under 12 px beside the 1920 and the 1280 office, and the 1920 rail reads from across the room @area:standalone', async ({
    page,
    standalone,
  }) => {
    const asked = await startAgent(page, standalone, 'rail-type-permission', {
      name: 'Bash',
      input: { command: 'git push' },
    });
    await askPermission(standalone, 'rail-type-permission');
    await expect(ticket(page, asked)).toHaveAttribute('data-kind', 'permission');
    const stuck = await stuckTranscriptAgent(
      page,
      standalone,
      '6f1c1d2e-0000-4000-8000-0000000002a1',
    );
    await expect(ticket(page, stuck).locator('.tk-why small')).toHaveText('no edits');
    await expect(page.getByTestId('pace-panel')).toContainText('limits off');

    for (const [width, height, rail] of [
      [1920, 1080, 'wide'],
      [1280, 800, 'mid'],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.getByTestId('monitor-rail')).toHaveAttribute('data-rail', rail);
      const smallest = await smallestRailText(page);
      expect(smallest.px, `"${smallest.text}" at ${width}`).toBeGreaterThanOrEqual(
        MIN_RAIL_FONT_PX,
      );
      const stub = ticket(page, stuck).locator('.tk-stub');
      if (width >= 1400) {
        await expect(stub).toBeVisible();
        for (const [part, px] of [
          ['.tk-name', 16],
          ['.tk-why', 20],
          ['.tk-stub', 12],
        ] as const) {
          const size = await ticket(page, stuck)
            .locator(part)
            .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
          expect(size * READS_AS, `${part} at ${width}`).toBeGreaterThanOrEqual(px);
        }
      } else {
        await expect(stub).toBeHidden();
      }
    }
  });
});

// Q2.4: the bar gets out of the office's way when the pointer rests, and comes back on a move.
test.describe('Standalone / monitor bottom bar', () => {
  test('the bar hides after 3 s without the pointer moving and shows again on a move @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    const bar = page.getByTestId('bottom-toolbar');
    // Every timer on the installed clock (one armed before it would run on the real one), held
    // still so only runFor moves it.
    await page.clock.install();
    await page.reload();
    await expect(bar).toBeAttached();
    await page.clock.pauseAt(Date.now() + 10_000);
    // A move over the stage shows the bar and arms its timer.
    await page.mouse.move(700, 300);
    await page.mouse.move(720, 320);
    await expect(bar).toHaveAttribute('data-hidden', 'false');

    await page.clock.runFor(2_500);
    await expect(bar).toHaveAttribute('data-hidden', 'false');
    await page.clock.runFor(600);
    await expect(bar).toHaveAttribute('data-hidden', 'true');
    await expect(bar).toHaveCSS('opacity', '0');

    await page.mouse.move(760, 340);
    await expect(bar).toHaveAttribute('data-hidden', 'false');
    await expect(bar).toHaveCSS('opacity', '1');
  });
});

// C5.6
test.describe('Standalone / monitor pace', () => {
  test.skip(process.platform === 'win32', 'the status line wrapper is POSIX only');

  test('no official limits never reads 0 %, and a window with no reading has no row @area:standalone', async ({
    page,
    standalone,
  }) => {
    const pace = page.getByTestId('pace-panel');
    await expect(pace).toContainText('limits off');
    await expect(page.getByTestId('monitor-rail')).not.toContainText(/(^|\D)0%/);

    // The wrapper on (through the consent the Settings toggle asks for), then a reading that
    // carries the 5-hour window only.
    const modal = await openSettingsModal(page);
    await modal.locator('button', { hasText: 'Claude status line (official limits)' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await advanceIntroToConsentStep(dialog);
    await dialog.getByRole('button', { name: 'Install Hooks' }).click();
    await finishIntro(dialog);
    await expect(pace).toContainText("Waiting for Claude Code's status line");

    const now = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${standalone.hookServerConfig.port}/api/statusline/claude-statusline`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${standalone.hookServerConfig.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fiveHour: { usedPercentage: 37, resetsAt: Math.floor((now + 2 * 60 * MIN) / 1000) },
          sevenDay: null,
        }),
      },
    );
    expect(response.ok).toBe(true);

    await expect(pace.locator('[data-window="fiveHour"]')).toContainText('37%');
    await expect(pace.locator('[data-window="sevenDay"]')).toHaveCount(0);
    await expect(page.getByTestId('monitor-rail')).not.toContainText(/(^|\D)0%/);
    await expect(page.getByTestId('hud-card')).not.toContainText('%');
  });
});

/** C5.5: the rail takes layout width (the stage shrinks and the map re-fits beside it), never
 *  covers the map, and plates keep their second line beside a full rail. */
const VIEWPORTS = [
  { width: 1920, height: 1080, rail: 'wide', railPx: 360, wholeMap: true },
  { width: 1280, height: 800, rail: 'mid', railPx: 300, wholeMap: true },
  // A VS Code panel: the map is taller than the panel even at the smallest zoom, so only its
  // sides are checked there.
  { width: 1100, height: 300, rail: 'slim', railPx: 76, wholeMap: false },
] as const;

async function expectLayout(page: Page, v: (typeof VIEWPORTS)[number]): Promise<void> {
  await page.setViewportSize({ width: v.width, height: v.height });
  const rail = page.getByTestId('monitor-rail');
  await expect(rail).toHaveAttribute('data-rail', v.rail);
  await expect.poll(async () => (await rail.boundingBox())?.width).toBe(v.railPx);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // The map at its fit: right of the rail, inside the window.
  const map = page.getByTestId('map-vignette');
  await expect
    .poll(async () => {
      const m = await map.boundingBox();
      if (!m) return 'no map';
      const fits =
        m.x >= v.railPx - 0.5 &&
        m.x + m.width <= v.width + 0.5 &&
        (!v.wholeMap || (m.y >= -0.5 && m.y + m.height <= v.height + 0.5));
      return fits ? 'inside' : `${m.x},${m.y} ${m.width}x${m.height}`;
    })
    .toBe('inside');
}

for (const dpr of [1, 2] as const) {
  test.describe(`Standalone / monitor layout at dpr ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test(`the rail takes its width at 1920, 1280 and 1100 wide, beside the whole map (dpr ${dpr}) @area:standalone`, async ({
      page,
      standalone,
    }) => {
      void standalone;
      for (const v of VIEWPORTS) await expectLayout(page, v);
    });
  });
}

/** Zoom with the HUD's buttons to a level (the badge reads zoom / 2). */
async function zoomTo(page: Page, level: string): Promise<void> {
  const badge = page.getByTestId('zoom-level');
  for (let i = 0; i < 6 && (await badge.textContent()) !== level; i++) {
    const current = parseFloat((await badge.textContent()) ?? '0');
    await page
      .getByRole('button', { name: current < parseFloat(level) ? 'Zoom in' : 'Zoom out' })
      .click();
  }
  await expect(badge).toHaveText(level);
}

// C5.5 (A6, B3; Q3 tags): beside a full rail every plate is a one-line monitor tag at any zoom
// (no second line, so no folder); in a short window (a VS Code panel) it is the compact plate.
test.describe('Standalone / monitor plates', () => {
  test('plates are one-line tags beside a full rail and compact plates in a short window @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { watchAllSessions: true });
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = await startAgent(page, standalone, 'rail-plates', {
      name: 'Read',
      input: { file_path: path.join(standalone.workspaceDir, 'notes.md') },
    });
    const folder = path.basename(standalone.workspaceDir);
    const plate = page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`);
    await zoomTo(page, '2x');
    await expect(plate.locator('.nameplate-tag')).toHaveCount(1);
    await expect(plate.getByTestId('plate-line2')).toHaveCount(0);
    await expect(plate).not.toContainText(folder);

    await page.setViewportSize({ width: 1100, height: 300 });
    await expect(page.getByTestId('monitor-rail')).toHaveAttribute('data-rail', 'slim');
    await zoomTo(page, '2x');
    await expect(plate).not.toHaveText('');
    await expect(plate.locator('.nameplate-tag')).toHaveCount(0);
  });
});
