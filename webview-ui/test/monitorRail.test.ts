/**
 * The attention rail with nobody to show: one all-clear tile, and no count anywhere (absent is
 * never 0).
 *
 * Run with: npm run test:webview
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';

import { monitorLayout } from '../src/components/monitorLayout.js';
import { MonitorRail } from '../src/components/MonitorRail.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function office(): OfficeState {
  const layout: OfficeLayout = {
    version: 1,
    cols: 9,
    rows: 7,
    tiles: new Array<TileType>(63).fill(TileType.FLOOR_1),
    furniture: [],
  };
  return new OfficeState(layout);
}

/** Visible text: tags dropped. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// Q2.2
it.each([
  [1920, 1080],
  [1280, 800],
  [1000, 700],
])('an empty rail at %ix%i shows the all-clear tile and no 0', (w, h) => {
  const html = renderToStaticMarkup(
    createElement(MonitorRail, {
      officeState: office(),
      monitor: { version: 0, selectedAgentId: null },
      layout: monitorLayout(w, h),
      attention: { needs: [], stuck: [], yours: [] },
      limits: null,
      statuslineInstalled: false,
      onSelect: () => {},
      onOpen: () => {},
    }),
  );

  expect(html).toContain('data-testid="rail-all-clear"');
  expect(text(html)).not.toMatch(/(^|\D)0(\D|$)/);
  expect(text(html)).not.toMatch(/needs you|stuck/i);
});

// Finished work gets its own list, below the all-clear tile: it is the user's turn, not an alarm.
it('lists an idle wait under Your turn, after the all-clear tile, never under Needs you', () => {
  // The face tile reads the device pixel ratio.
  (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
  const os = office();
  os.addAgent(1);
  const html = renderToStaticMarkup(
    createElement(MonitorRail, {
      officeState: os,
      monitor: { version: 0, selectedAgentId: null },
      layout: monitorLayout(1920, 1080),
      attention: {
        needs: [],
        stuck: [],
        yours: [{ id: 1, kind: 'idle', glyph: '–', reason: 'Finished' }],
      },
      limits: null,
      statuslineInstalled: false,
      onSelect: () => {},
      onOpen: () => {},
    }),
  );
  const t = text(html);
  expect(t).toContain('Your turn');
  expect(t).not.toContain('Needs you');
  expect(t).toContain('Finished');
  expect(html.indexOf('rail-all-clear')).toBeGreaterThan(-1);
  expect(html.indexOf('rail-all-clear')).toBeLessThan(html.indexOf('Your turn'));
});
