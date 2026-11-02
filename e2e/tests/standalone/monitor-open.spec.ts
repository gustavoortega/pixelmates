import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';

/**
 * A double-click opens the inspector: on a rail ticket, and on the agent itself in the office.
 * Messages reach the page's own socket handler (`__pixelAgentsDeliver`), as the server would send
 * them. The single click still only selects.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type OpenWindow = Window & {
  __pixelAgentsDeliver?: (msg: unknown) => void;
  __pixelAgentsTestHooks?: {
    getSelection?: () => { selectedAgentId: number | null; cameraFollowId: number | null };
    getTagLayout?: () => { heads: Array<{ id: number; rect: Box }> };
  };
};

async function deliver(page: Page, messages: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((msgs) => {
    const send = (window as OpenWindow).__pixelAgentsDeliver;
    if (!send) throw new Error('message delivery missing');
    for (const m of msgs) send(m);
  }, messages);
}

async function selectedId(page: Page): Promise<number | null> {
  return page.evaluate(
    () => (window as OpenWindow).__pixelAgentsTestHooks?.getSelection?.().selectedAgentId ?? null,
  );
}

/** The page position of an agent's face, once it has stopped moving (it walks to its seat). */
async function settledHead(page: Page, id: number): Promise<Box> {
  let last = '';
  let box: Box | undefined;
  await expect
    .poll(
      async () => {
        const heads = await page.evaluate(
          () => (window as OpenWindow).__pixelAgentsTestHooks?.getTagLayout?.().heads ?? [],
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

const SHEET_OPEN = '[data-testid="monitor-sheet"][data-open="true"]';

test.describe('Standalone / double-click opens the inspector', () => {
  test('a double-click on a rail ticket opens the sheet on that agent @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_601;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentStatus', id, status: 'waiting', awaitingInput: true },
    ]);
    const ticket = page.locator(`[data-testid="monitor-ticket"][data-agent-id="${id}"]`);
    await expect(ticket).toBeVisible();
    // One click selects and leaves the sheet shut.
    await ticket.click();
    await expect.poll(() => selectedId(page)).toBe(id);
    await expect(page.locator(SHEET_OPEN)).toHaveCount(0);

    await ticket.dblclick();
    await expect(page.locator(SHEET_OPEN)).toBeVisible();
    await expect(page.getByTestId('inspector-state')).toBeVisible();
    expect(await selectedId(page)).toBe(id);
  });

  test('a double-click on an agent in the office selects it and opens the sheet, and a single click on it keeps it selected @area:standalone', async ({
    page,
    standalone,
  }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_602;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentStatus', id, status: 'waiting', awaitingInput: true },
    ]);
    const head = await settledHead(page, id);
    const x = head.x + head.w / 2;
    const y = head.y + head.h / 2;

    // A click on the selected agent no longer deselects it.
    await page.mouse.click(x, y);
    await expect.poll(() => selectedId(page)).toBe(id);
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
    expect(await selectedId(page)).toBe(id);
    await expect(page.locator(SHEET_OPEN)).toHaveCount(0);

    await page.mouse.dblclick(x, y);
    await expect(page.locator(SHEET_OPEN)).toBeVisible();
    await expect(page.getByTestId('inspector-state')).toBeVisible();
    expect(await selectedId(page)).toBe(id);
  });

  test("a double-click on the selected agent's card opens the sheet @area:standalone", async ({
    page,
    standalone,
  }) => {
    void standalone;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const id = 9_603;
    await deliver(page, [
      { type: 'agentCreated', id, folderName: 'repo' },
      { type: 'agentStatus', id, status: 'waiting', awaitingInput: true },
    ]);
    const head = await settledHead(page, id);
    await page.mouse.click(head.x + head.w / 2, head.y + head.h / 2);
    await expect.poll(() => selectedId(page)).toBe(id);

    // The selected card takes pointer events, so the canvas never sees a double-click on it.
    const card = page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`);
    await expect(card).toBeVisible();
    await expect(page.locator(SHEET_OPEN)).toHaveCount(0);
    await card.dblclick({ position: { x: 6, y: 6 } });
    await expect(page.locator(SHEET_OPEN)).toBeVisible();
    expect(await selectedId(page)).toBe(id);
  });
});
