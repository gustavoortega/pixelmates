import { type CDPSession, type Page, test } from '@playwright/test';

/**
 * What each dev scene costs per wall second: canvas frames drawn, animation frames requested and
 * main-thread task time (CDP Performance.getMetrics TaskDuration). Draws and requests are counted
 * by wrapping the browser APIs, so a checkout without the loop's own counters measures the same
 * way. A measurement, not a gate: the numbers land in the report as annotations.
 *
 * The hero scene never settles (a napper, an XP pop every few seconds, a storm), so it measures the
 * active cap; the default mock has no agents and no pets, so it reads idle by day and ambient at
 * night (the fairy lights); `?scene=empty` turns the lighting off and reads idle around the clock.
 */

const WARMUP_MS = 10_000;
const SAMPLE_MS = 30_000;
const SCENES = [
  { name: 'hero', path: '/?scene=hero' },
  { name: 'default mock', path: '/' },
  { name: 'empty', path: '/?scene=empty' },
];

interface Sample {
  wallMs: number;
  draws: number;
  rafs: number;
  /** The loop's own counters, where the checkout has them. */
  frames: { raf: number; render: number } | null;
  taskSec: number;
}

type PerfWindow = Window & {
  __perfDraws: number;
  __perfRafs: number;
  __pixelAgentsTestHooks?: { frames?: { raf: number; render: number } };
};

async function sample(page: Page, cdp: CDPSession): Promise<Sample> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const counts = await page.evaluate(() => {
    const w = window as unknown as PerfWindow;
    const f = w.__pixelAgentsTestHooks?.frames;
    return {
      wallMs: performance.now(),
      draws: w.__perfDraws,
      rafs: w.__perfRafs,
      frames: f ? { raf: f.raf, render: f.render } : null,
    };
  });
  const task = metrics.find((m) => m.name === 'TaskDuration');
  if (!task) throw new Error('no TaskDuration metric');
  return { ...counts, taskSec: task.value };
}

test.describe.configure({ mode: 'serial' });

for (const scene of SCENES) {
  test(`render cost: ${scene.name}`, async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as PerfWindow;
      // The e2e flag turns on the loop's counters; the wrappers count on any checkout.
      (window as unknown as { __PIXELMATES_E2E?: boolean }).__PIXELMATES_E2E = true;
      w.__perfDraws = 0;
      w.__perfRafs = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        w.__perfRafs++;
        return raf(cb);
      };
      // renderFrame clears the office canvas once per drawn frame.
      const clearRect = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.isConnected) w.__perfDraws++;
        return clearRect.apply(this, args);
      };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(scene.path);
    await page.waitForTimeout(WARMUP_MS);
    const before = await sample(page, cdp);
    await page.waitForTimeout(SAMPLE_MS);
    const after = await sample(page, cdp);

    const seconds = (after.wallMs - before.wallMs) / 1000;
    const perSec = (a: number, b: number) => Math.round(((b - a) / seconds) * 10) / 10;
    const row = {
      scene: scene.name,
      drawsPerSec: perSec(before.draws, after.draws),
      rafsPerSec: perSec(before.rafs, after.rafs),
      loopRenderPerSec:
        before.frames && after.frames ? perSec(before.frames.render, after.frames.render) : null,
      loopRafPerSec:
        before.frames && after.frames ? perSec(before.frames.raf, after.frames.raf) : null,
      taskMsPerSec: Math.round(((after.taskSec - before.taskSec) * 1000 * 10) / seconds) / 10,
    };
    test.info().annotations.push({ type: 'render cost', description: JSON.stringify(row) });
    console.log(`[render cost] ${JSON.stringify(row)}`);
  });
}
