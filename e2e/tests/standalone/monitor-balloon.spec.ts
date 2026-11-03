import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import type { StandaloneSession } from '../../helpers/standalone';

/**
 * The speech balloon over a hovered character in the monitor: what it says for a finished turn, a
 * question and a permission prompt, that the name tag stays, that P masks it, and when there is
 * no balloon (an active agent, a selected one). Messages reach the page's own socket handler
 * (`__pixelAgentsDeliver`), as the server would send them; the permission case uses a real hook.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type BalloonWindow = Window & {
  __pixelAgentsDeliver?: (msg: unknown) => void;
  __pixelAgentsTestHooks?: {
    getCharacters?: () => Array<{ id: number; isGreeter?: boolean }>;
    getTagLayout?: () => { heads: Array<{ id: number; rect: Box }> };
  };
};

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function deliver(page: Page, messages: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((msgs) => {
    const send = (window as BalloonWindow).__pixelAgentsDeliver;
    if (!send) throw new Error('message delivery missing');
    for (const m of msgs) send(m);
  }, messages);
}

/** The page position of an agent's face, once it has stopped moving (it walks to its seat). */
async function settledHead(page: Page, id: number): Promise<Box> {
  let last = '';
  let box: Box | undefined;
  await expect
    .poll(
      async () => {
        const heads = await page.evaluate(
          () => (window as BalloonWindow).__pixelAgentsTestHooks?.getTagLayout?.().heads ?? [],
        );
        box = heads.find((h) => h.id === id)?.rect;
        const now = JSON.stringify(box ?? null);
        const settled = box !== undefined && now === last;
        last = now;
        return settled;
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBe(true);
  return box!;
}

async function hoverHead(page: Page, id: number): Promise<{ x: number; y: number }> {
  const head = await settledHead(page, id);
  const at = { x: head.x + head.w / 2, y: head.y + head.h / 2 };
  await page.mouse.move(at.x, at.y);
  return at;
}

function balloon(page: Page, id: number): Locator {
  return page.locator(`[data-testid="agent-balloon"][data-agent-id="${id}"]`);
}

async function agentIds(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    ((window as BalloonWindow).__pixelAgentsTestHooks?.getCharacters?.() ?? [])
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
): Promise<number> {
  const before = await agentIds(page);
  await sendHookEvent(
    standalone.hookServerConfig,
    sessionStartStartup(sessionId, standalone.workspaceDir),
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

async function askPermission(standalone: StandaloneSession, sessionId: string): Promise<void> {
  await sendHookEvent(standalone.hookServerConfig, {
    session_id: sessionId,
    hook_event_name: 'PermissionRequest',
  });
}

test.describe('Standalone / hover speech balloon', () => {
  test('a finished agent shows its title and how long ago, and keeps its name tag @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_701;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentSessionTitle', id, title: 'Ship the checkout fix' },
      {
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'idle',
        since: Date.now() - 4 * 60_000,
      },
    ]);
    await hoverHead(page, id);

    const b = balloon(page, id);
    await expect(b).toBeVisible();
    await expect(b.locator('[data-part="balloon-title"]')).toHaveText('Ship the checkout fix');
    await expect(b.locator('[data-part="balloon-detail"]')).toHaveText(/^Finished \d+m ago$/);
    // The name stays: the balloon is added, the hovered full card does not replace the tag.
    await expect(
      page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"] .nameplate-tag`),
    ).toBeVisible();
  });

  test('P masks the balloon title like the rail reason @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_702;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentSessionTitle', id, title: 'Ship the secret launch' },
      { type: 'agentStatus', id, status: 'waiting', awaitingInput: true, awaitingReason: 'idle' },
    ]);
    await hoverHead(page, id);
    const title = balloon(page, id).locator('[data-part="balloon-title"]');
    await expect(title).toHaveText('Ship the secret launch');
    await expect(title).not.toHaveCSS('color', TRANSPARENT);

    await page.keyboard.press('p');

    await expect(title).toHaveCSS('color', TRANSPARENT);
    const reason = page.locator(
      `[data-testid="monitor-ticket"][data-agent-id="${id}"] [data-part="reason"]`,
    );
    const bg = await reason.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe(TRANSPARENT);
    await expect(title).toHaveCSS('background-color', bg);
  });

  test('a question shows its own words @area:standalone', async ({ page, standalone }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_703;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      {
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'question',
        question: 'Monday or Sunday?',
      },
    ]);
    await hoverHead(page, id);

    const b = balloon(page, id);
    await expect(b).toHaveAttribute('data-kind', 'question');
    await expect(b.locator('[data-part="balloon-detail"]')).toHaveText('Monday or Sunday?');
  });

  test('an active agent has no balloon, and gets one once it waits @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_704;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentStatus', id, status: 'active' },
    ]);
    await hoverHead(page, id);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('agent-balloon')).toHaveCount(0);

    // Same hover, now waiting: proves the hover reached the agent.
    await deliver(page, [
      { type: 'agentStatus', id, status: 'waiting', awaitingInput: true, awaitingReason: 'idle' },
    ]);
    await expect(balloon(page, id)).toBeVisible();
  });

  test('a selected agent gives up its balloon @area:standalone', async ({ page, standalone }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_705;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentStatus', id, status: 'waiting', awaitingInput: true, awaitingReason: 'idle' },
    ]);
    const at = await hoverHead(page, id);
    await expect(balloon(page, id)).toBeVisible();

    await page.mouse.click(at.x, at.y);

    await expect(page.getByTestId('agent-balloon')).toHaveCount(0);
  });

  test('a permission prompt shows what it wants to run @area:standalone', async ({
    page,
    standalone,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const sessionId = '6f1c1d2e-0000-4000-8000-00000000b701';
    const id = await startAgent(page, standalone, sessionId, {
      name: 'Bash',
      input: { command: 'git push' },
    });
    await askPermission(standalone, sessionId);
    await expect(
      page.locator(`[data-testid="monitor-ticket"][data-agent-id="${id}"]`),
    ).toHaveAttribute('data-kind', 'permission');
    await hoverHead(page, id);

    const b = balloon(page, id);
    await expect(b).toHaveAttribute('data-kind', 'permission');
    await expect(b.locator('[data-part="balloon-detail"]')).toHaveText(/^Allow .+\?$/);
  });
});
