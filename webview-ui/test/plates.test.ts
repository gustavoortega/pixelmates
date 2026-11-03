/**
 * Plates scale with the zoom relative to the whole-map fit; up to zoom level 3 (the HUD's "Nx")
 * they are one compact line, from 4x the full two-line plate; beside the monitor's rail they are
 * full at every zoom. Hover or selection shows the full box, except for the agent the inspector
 * sheet shows. The kind is checked through the real overlay render.
 *
 * Run with: npm test
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NAMEPLATE_BG,
  NAMEPLATE_COMPACT_BG,
  PLATE_SELECTED_BG,
  TAG_QUIET_TEXT,
} from '../src/constants.js';
import { ToolOverlay } from '../src/office/components/ToolOverlay.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { plateAnchorAboveY, plateScale, setMonitorFullPlates } from '../src/office/nameplate.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const TITLE = 'Refactor the parser';

function overlayHtml(
  zoom: number,
  focus?: 'hover' | 'select',
  sheetOpen = false,
  idle = false,
): string {
  const cols = 12;
  const rows = 9;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
  const os = new OfficeState(layout);
  os.addAgent(1);
  os.setSessionTitle(1, TITLE);
  os.setRoster(1, {
    memberId: 'ada',
    name: 'Ada',
    level: 7,
    xp: 1,
    xpToNext: 10,
    streak: 0,
    mood: 'happy',
  });
  if (focus === 'hover') os.hoveredAgentId = 1;
  // The sheet shows the selected agent.
  if (focus === 'select' || sheetOpen) os.selectedAgentId = 1;
  os.monitorSheetOpen = sheetOpen;
  if (idle) os.setAgentActive(1, false);
  const container = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 900 }),
  } as unknown as HTMLDivElement;
  return renderToStaticMarkup(
    createElement(ToolOverlay, {
      officeState: os,
      agents: [1],
      agentTools: {},
      agentStatuses: {},
      subagentTools: {},
      subagentCharacters: [],
      containerRef: { current: container },
      zoom,
      panRef: { current: { x: 0, y: 0 } },
      onCloseAgent: () => {},
      onAckTripwire: () => {},
      onOpenInspector: () => {},
    }),
  );
}

describe('plate kind by zoom level', () => {
  const saved = globalThis.window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved;
  });

  it.each([4, 6])('zoom %i (level <= 3): one line, the name, no title, 13 px', (zoom) => {
    const html = overlayHtml(zoom);
    expect(html).toContain('Ada');
    expect(html).not.toContain(TITLE);
    expect(html).toContain('font-size:13px');
    expect(html).toContain(`--plate-bg:${NAMEPLATE_COMPACT_BG}`);
  });

  it.each([8, 10])('zoom %i (level >= 4): the full plate with its title line', (zoom) => {
    const html = overlayHtml(zoom);
    expect(html).toContain('Ada');
    expect(html).toContain(TITLE);
    expect(html).not.toContain('font-size:13px');
  });

  it.each(['hover', 'select'] as const)(
    '%s at a compact zoom shows the full box, not the plate',
    (focus) => {
      const html = overlayHtml(4, focus);
      expect(html).toContain('Ada');
      expect(html).not.toMatch(/class="nameplate /);
    },
  );

  it.each(['hover', 'select'] as const)(
    '%s of the agent the inspector sheet shows keeps its plate, on paper',
    (focus) => {
      const html = overlayHtml(8, focus, true);
      expect(html).toMatch(/class="nameplate /);
      expect(html).toContain(TITLE);
      expect(html).not.toContain('data-testid="context-gauge"');
      expect(html).toContain(`--plate-bg:${PLATE_SELECTED_BG}`);
    },
  );

  it('beside the rail, whole-map fit (zoom 2, dpr 1) shows a one-line tag in the small set: name 16 px, state 14 px, no line 2', () => {
    // The shell sets the rule from monitorLayout: 1920 x 1080 and 1280 x 800 both have a full rail.
    setMonitorFullPlates(true);
    try {
      const html = overlayHtml(2);
      expect(html).toMatch(/class="nameplate /);
      expect(html).toContain('nameplate-tag');
      expect(html).toContain('Ada');
      expect(html).toContain('data-testid="plate-state"');
      expect(html).not.toContain('data-testid="plate-line2"');
      expect(html).not.toContain(TITLE);
      // A tag is drawn at its size: no scale; at 2 CSS px per world px the small type set.
      expect(html).toContain('scale(1)');
      const plate = html.slice(html.indexOf('class="nameplate '));
      const px = (testId: string) =>
        Number(new RegExp(`font-size:(\\d+)px[^>]*data-testid="${testId}"`).exec(plate)?.[1]);
      expect(px('plate-name')).toBe(16);
      expect(px('plate-state')).toBe(14);
    } finally {
      setMonitorFullPlates(false);
    }
  });
});

describe('a quiet tag beside the rail', () => {
  const saved = globalThis.window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
    setMonitorFullPlates(true);
  });
  afterEach(() => {
    setMonitorFullPlates(false);
    (globalThis as { window?: unknown }).window = saved;
  });

  it('is opaque ink with its words in the dim cream: the office never shows through it', () => {
    const html = overlayHtml(2, undefined, false, true);
    const plate = html.slice(html.indexOf('class="nameplate '));
    expect(plate).toContain('data-plate-state="idle"');
    expect(plate).toContain(`--plate-bg:${NAMEPLATE_BG}`);
    expect(plate).toContain(`--plate-text:${TAG_QUIET_TEXT}`);
    expect(plate).not.toMatch(/rgba\s*\(/);
  });
});

describe('plateScale', () => {
  it.each([
    [3, 3, 1], // at the whole-map fit a plate is its authored size
    [6, 3, 1.5], // twice the fit zoom is capped
    [10, 3, 1.5],
    [1, 3, 0.6], // far out is floored
    [4, 3, 4 / 3],
    [2, 3, 2 / 3],
  ])('zoom %i against fit %i -> %f', (zoom, fit, expected) => {
    expect(plateScale(zoom, fit)).toBeCloseTo(expected, 10);
  });
});

describe('plateAnchorAboveY', () => {
  it('hangs 2 px over the sprite head: tile centre 40, sat at +6, head row 3 of 32', () => {
    // head top = 40 + 6 - 32 + 3 = 17; the plate's bottom edge is 2 px above it
    expect(plateAnchorAboveY(40, 6, false)).toBe(15);
  });

  it('rises by the slot clearance when a bubble or glyph owns the space above the head', () => {
    expect(plateAnchorAboveY(40, 6, true)).toBe(15 - 16);
  });
});
