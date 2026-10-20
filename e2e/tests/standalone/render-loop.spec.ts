import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup, stop } from '../../helpers/hooks';
import { buildSeedLayout } from '../../helpers/layout-seed';
import { expectOverlayCount } from '../../helpers/office';
import { launchStandalone } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

/**
 * The render loop of the built app, read off its own counters
 * (window.__pixelAgentsTestHooks.frames: animation-frame requests, update and
 * render calls, and the mode the loop last scheduled in) and off every
 * animation-frame request on the page (window.__pixelAgentsRafCalls, counted by
 * the standalone launch). Counters are read as deltas: one missing fails the
 * test rather than reading as 0.
 */

type LoopMode = 'active' | 'ambient' | 'idle' | 'stopped';

type RenderLoopWindow = Window & {
  __pixelAgentsTestHooks?: { frames?: { raf: number; render: number; mode: LoopMode } };
  __pixelAgentsRafCalls?: number;
  __pixelAgentsMonitorRenders?: number;
  __pixelAgentsDeliver?: (msg: unknown) => void;
};

interface QuietWindow {
  /** The loop's own animation-frame requests. */
  raf: number;
  /** Every animation-frame request on the page: a component with a frame loop of its own too. */
  pageRaf: number;
  render: number;
  /** Re-renders of the monitor panels: none, since no store changed. */
  monitorRenders: number;
  mode: LoopMode;
  /** Windows opened, the clean one included. */
  windows: number;
}

/**
 * Wait for the office to settle (the loop off animation frames for 3 s at
 * every 50 ms poll), then count what the loop does over 2 s. A window that
 * sees the loop go active (a pet setting off, a late greeter) is discarded and
 * another opened: at most 3, within 45 s.
 */
async function quietWindow(page: Page): Promise<QuietWindow> {
  return page.evaluate(async () => {
    const POLL_MS = 50;
    const FIRST_SETTLE_MS = 15_000;
    const QUIET_MS = 3000;
    const WINDOW_MS = 2000;
    const MAX_WINDOWS = 3;
    const TOTAL_MS = 45_000;
    const w = window as RenderLoopWindow;
    const frames = w.__pixelAgentsTestHooks?.frames;
    if (
      typeof frames?.raf !== 'number' ||
      typeof frames.render !== 'number' ||
      typeof w.__pixelAgentsRafCalls !== 'number' ||
      typeof w.__pixelAgentsMonitorRenders !== 'number'
    ) {
      throw new Error('render loop counters missing');
    }
    const monitorRenders = () => w.__pixelAgentsMonitorRenders ?? NaN;
    const pageRafs = () => w.__pixelAgentsRafCalls ?? NaN;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const quiet = () => frames.mode === 'ambient' || frames.mode === 'idle';
    const start = performance.now();
    while (!quiet()) {
      if (performance.now() - start > FIRST_SETTLE_MS) {
        throw new Error(`the loop never left animation frames (mode ${frames.mode})`);
      }
      await sleep(POLL_MS);
    }
    for (let windows = 1; windows <= MAX_WINDOWS; windows++) {
      let quietSince = performance.now();
      while (performance.now() - quietSince < QUIET_MS) {
        if (performance.now() - start > TOTAL_MS) throw new Error('no quiet window in 45 s');
        await sleep(POLL_MS);
        if (!quiet()) quietSince = performance.now();
      }
      const raf = frames.raf;
      const pageRaf = pageRafs();
      const render = frames.render;
      const monitor = monitorRenders();
      const opened = performance.now();
      let clean = true;
      for (let left = WINDOW_MS; left > 0; left = WINDOW_MS - (performance.now() - opened)) {
        await sleep(Math.min(POLL_MS, left));
        if (!quiet()) {
          clean = false;
          break;
        }
      }
      if (clean) {
        return {
          raf: frames.raf - raf,
          pageRaf: pageRafs() - pageRaf,
          render: frames.render - render,
          monitorRenders: monitorRenders() - monitor,
          mode: frames.mode,
          windows,
        };
      }
    }
    throw new Error(`every window saw the loop go active (${MAX_WINDOWS} tried)`);
  });
}

/** The settled-office rule at the window the suite opens with (zoom 2) and at 1920x1080, where the
 *  office beside the rail fits at zoom 3 (badge 1.5x), the one odd level a fit can land on. */
const SETTLED_VIEWS = [
  {
    title: 'a settled office requests no animation frame and redraws at most ten times a second',
    viewport: null,
  },
  {
    title:
      'a settled office at zoom 3 (1920x1080 beside the rail) requests no animation frame either',
    viewport: { width: 1920, height: 1080, badge: '1.5x' },
  },
] as const;

test.describe('Render loop', () => {
  for (const { title, viewport } of SETTLED_VIEWS) {
    test(`${title} @area:render`, async ({ page, standalone: _standalone }) => {
      if (viewport) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await expect(page.getByTestId('zoom-level')).toHaveText(viewport.badge);
      }
      const counted = await quietWindow(page);
      test.info().annotations.push({ type: 'quiet window', description: JSON.stringify(counted) });
      expect(counted.raf).toBe(0);
      expect(counted.pageRaf).toBe(0);
      // 2 s at the 10 Hz ambient redraw, plus one for a tick on each edge.
      expect(counted.render).toBeLessThanOrEqual(21);
      // The frames drawn changed nothing the monitor shows.
      expect(counted.monitorRenders).toBe(0);
    });
  }

  test('an office where nothing moves redraws once a second @area:render', async ({ page }) => {
    // No agents, no pets, no furniture: nothing in it animates, by day or by night.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-render-e2e-home-'));
    fs.mkdirSync(path.join(home, '.pixelmates'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.pixelmates', 'layout.json'),
      JSON.stringify(buildSeedLayout()),
    );
    const session = await launchStandalone(page, { homeDir: home });
    try {
      const counted = await quietWindow(page);
      test.info().annotations.push({ type: 'quiet window', description: JSON.stringify(counted) });
      expect(counted.mode).toBe('idle');
      expect(counted.raf).toBe(0);
      expect(counted.pageRaf).toBe(0);
      // 2 s at the 1 s idle redraw: at least one, plus one for a redraw on each edge.
      expect(counted.render).toBeGreaterThanOrEqual(1);
      expect(counted.render).toBeLessThanOrEqual(3);
    } finally {
      await session.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('C0.5 a monitor store write re-renders the monitor once, and the frames after it none @area:render', async ({
    page,
    standalone: _standalone,
  }) => {
    const counted = await quietWindow(page);
    expect(counted.monitorRenders).toBe(0);

    // A loop for an id with no character: the store keeps it, and nothing else on screen moves.
    for (const nextAt of [1_000, 2_000, 3_000]) {
      const before = await page.evaluate((at) => {
        const w = window as RenderLoopWindow;
        const renders = w.__pixelAgentsMonitorRenders;
        if (typeof renders !== 'number' || !w.__pixelAgentsDeliver) {
          throw new Error('monitor render counter or message delivery missing');
        }
        w.__pixelAgentsDeliver({ type: 'agentLoop', id: 9_999, nextAt: at });
        return renders;
      }, nextAt);
      await page.waitForFunction(
        (n) => (window as RenderLoopWindow).__pixelAgentsMonitorRenders === n + 1,
        before,
        { polling: 20, timeout: 5_000 },
      );
      // Ten more drawn frames, none of them a change: none re-renders the monitor.
      const rendered = await page.evaluate(
        () => (window as RenderLoopWindow).__pixelAgentsTestHooks?.frames?.render ?? NaN,
      );
      await page.waitForFunction(
        (r) => ((window as RenderLoopWindow).__pixelAgentsTestHooks?.frames?.render ?? 0) >= r + 10,
        rendered,
        { polling: 20, timeout: 5_000 },
      );
      expect(
        await page.evaluate(() => (window as RenderLoopWindow).__pixelAgentsMonitorRenders),
      ).toBe(before + 1);
    }
  });

  test('a message that starts an idle agent working is back on animation frames at once @area:render', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { hooksEnabled: true, watchAllSessions: true, debugView: false });
    const sessionId = 'render-loop-wake-session';
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir),
    );
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(standalone.workspaceDir, 'wake.ts') },
    });
    await expectOverlayCount(page, 1);
    await sendHookEvent(standalone.hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
    });
    await sendHookEvent(standalone.hookServerConfig, stop(sessionId));
    const created = (await standalone.drainMessages()).find((m) => m.type === 'agentCreated');
    expect(typeof created?.id).toBe('number');

    // Seated and done, the agent leaves the loop on its timer.
    await page.waitForFunction(
      () => {
        const mode = (window as RenderLoopWindow).__pixelAgentsTestHooks?.frames?.mode;
        return mode === 'ambient' || mode === 'idle';
      },
      undefined,
      { polling: 50, timeout: 15_000 },
    );

    // Read in the same task as the delivery: the socket event, the message handler and its wake
    // all run before it returns, so the loop's own 100 ms tick cannot be what switched it.
    const wake = await page.evaluate((id) => {
      const frames = (window as RenderLoopWindow).__pixelAgentsTestHooks?.frames;
      const deliver = (window as RenderLoopWindow).__pixelAgentsDeliver;
      if (typeof frames?.raf !== 'number' || typeof frames.render !== 'number' || !deliver) {
        throw new Error('render loop counters or message delivery missing');
      }
      const before = frames.mode;
      const raf = frames.raf;
      deliver({ type: 'agentStatus', id, status: 'active' });
      return { before, mode: frames.mode, raf: frames.raf - raf };
    }, created?.id);
    expect(wake.before).not.toBe('active');
    expect(wake.mode).toBe('active');
    expect(wake.raf).toBeGreaterThan(0);
  });

  test('Q3.4 a lit desk blinks on the timer, and an office with nothing lit idles @area:render', async ({
    page,
  }) => {
    // One desk and its chair: an agent sits still at it, and nothing else in the room animates.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-render-e2e-home-'));
    fs.mkdirSync(path.join(home, '.pixelmates'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.pixelmates', 'layout.json'),
      JSON.stringify({
        ...buildSeedLayout(),
        furniture: [
          { uid: 'desk', type: 'DESK_FRONT', col: 4, row: 4 },
          { uid: 'chair', type: 'CUSHIONED_CHAIR_FRONT', col: 5, row: 4 },
        ],
      }),
    );
    const session = await launchStandalone(page, { homeDir: home });
    const lit = () =>
      page.evaluate(
        () =>
          (
            window as RenderLoopWindow & {
              __pixelAgentsTestHooks?: { getDeskHighlights?: () => Array<{ id: number }> };
            }
          ).__pixelAgentsTestHooks?.getDeskHighlights?.() ?? null,
      );
    try {
      // Nobody in, nothing lit: idle.
      const empty = await quietWindow(page);
      expect(empty.mode).toBe('idle');
      expect(await lit()).toEqual([]);

      // A seated agent with a question: its desk lights and blinks, the loop stays off frames.
      const id = 9_301;
      await page.evaluate((agentId) => {
        const send = (window as RenderLoopWindow).__pixelAgentsDeliver;
        if (!send) throw new Error('message delivery missing');
        send({ type: 'agentCreated', id: agentId, folderName: 'repo' });
        send({ type: 'agentStatus', id: agentId, status: 'waiting', awaitingInput: true });
      }, id);
      await expect.poll(async () => (await lit())?.map((h) => h.id)).toEqual([id]);
      const blink = await page.evaluate(async () => {
        const w = window as RenderLoopWindow & {
          __pixelAgentsTestHooks?: { getDeskHighlights?: () => Array<{ frame: 0 | 1 }> };
        };
        const frames = w.__pixelAgentsTestHooks?.frames;
        const read = w.__pixelAgentsTestHooks?.getDeskHighlights;
        if (!frames || !read) throw new Error('render loop counters or highlight hook missing');
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        // Settle off animation frames (the spawn effect), then watch two seconds.
        for (let t = 0; frames.mode === 'active' && t < 10_000; t += 50) await sleep(50);
        const raf = frames.raf;
        const modes = new Set<string>();
        const seen = new Set<number>();
        for (let t = 0; t < 2_000; t += 50) {
          await sleep(50);
          modes.add(frames.mode);
          for (const h of read()) seen.add(h.frame);
        }
        return { raf: frames.raf - raf, modes: [...modes], seen: [...seen].sort() };
      });
      expect(blink.raf).toBe(0);
      expect(blink.modes).toEqual(['ambient']);
      expect(blink.seen).toEqual([0, 1]);

      // The agent leaves: nothing lit, the office idles again.
      await page.evaluate((agentId) => {
        (window as RenderLoopWindow).__pixelAgentsDeliver?.({ type: 'agentClosed', id: agentId });
      }, id);
      const after = await quietWindow(page);
      expect(after.mode).toBe('idle');
      expect(await lit()).toEqual([]);
    } finally {
      await session.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
