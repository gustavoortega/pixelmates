/**
 * Camera: the pan/zoom rules (zoom about an anchor, centred small maps, void-free big ones), the
 * fit target (the rooms where agents work, never a sprite box), and the auto-fit hysteresis.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test } from 'vitest';

import { monitorLayout } from '../src/components/monitorLayout.js';
import {
  areaCenter,
  AutoFit,
  type AutoFitInput,
  centerForPan,
  clampPan,
  fitTarget,
  fitView,
  fitZoomWholeMap,
  followPan,
  panAfterZoom,
  panForPoint,
  type Point,
  refitView,
  roomsOf,
  stepZoom,
  type TileBox,
} from '../src/office/camera.js';

const box = (col0: number, row0: number, col1: number, row1: number): TileBox => ({
  col0,
  row0,
  col1,
  row1,
});

// ── C1: pan and zoom rules (K1) ────────────────────────────────

test('clampPan: each axis follows its own rule', () => {
  const view = { width: 1000, height: 600 };
  // 10x5 tiles at zoom 2 = 320x160: small on both axes, so any pan lands centred.
  assert.deepEqual(clampPan({ x: 500, y: -300 }, view, { cols: 10, rows: 5 }, 2), { x: 0, y: 0 });
  // 40x5 tiles at zoom 2 = 1280x160: big across (clamped), small down (centred).
  assert.deepEqual(clampPan({ x: 9999, y: 40 }, view, { cols: 40, rows: 5 }, 2), { x: 140, y: 0 });
});

test('clampPan: a big map clamps both edges and leaves a legal pan alone', () => {
  const view = { width: 1000, height: 600 };
  const map = { cols: 40, rows: 20 }; // 1280x640 at zoom 2: pan limits are +-140 across, +-20 down
  assert.deepEqual(clampPan({ x: -9999, y: -9999 }, view, map, 2), { x: -140, y: -20 });
  assert.deepEqual(clampPan({ x: 9999, y: 9999 }, view, map, 2), { x: 140, y: 20 });
  assert.deepEqual(clampPan({ x: 50, y: -10 }, view, map, 2), { x: 50, y: -10 });
});

test('panAfterZoom: zooming from the viewport centre keeps the centred world point, then clamps', () => {
  const view = { width: 1000, height: 600 };
  const map = { cols: 40, rows: 20 };
  const centre = { x: 500, y: 300 };
  assert.deepEqual(panAfterZoom(centre, { x: 0, y: 0 }, 2, 3, view, map), { x: 0, y: 0 });
  // Panned 100px: the point under the centre is at world x 270; at zoom 3 the pan becomes 150.
  assert.deepEqual(panAfterZoom(centre, { x: 100, y: 0 }, 2, 3, view, map), { x: 150, y: 0 });
});

test('panAfterZoom: the world point under an off-centre wheel cursor stays under it', () => {
  const view = { width: 1000, height: 600 };
  const map = { cols: 40, rows: 20 };
  // Cursor (800,100) at pan 0, zoom 2 (offset -140,-20) sits over world (470,60). At zoom 3 the
  // offset must be anchor - world * 3 = (-610,-80), which is pan (-150,100) and inside the clamp.
  assert.deepEqual(panAfterZoom({ x: 800, y: 100 }, { x: 0, y: 0 }, 2, 3, view, map), {
    x: -150,
    y: 100,
  });
});

// ── C2/F3: the fit target (K2) ─────────────────────────────────

// 12x6 floor: rooms A (cols 0-3), B (4-7), C (8-11); the coffee table sits in C, the lounge.
const FLOOR = 1;
const layout = {
  cols: 12,
  rows: 6,
  tiles: new Array<number>(72).fill(FLOOR),
  areaTiles: Array.from({ length: 72 }, (_, i) => ['A', 'B', 'C'][Math.floor((i % 12) / 4)]),
  furniture: [{ type: 'COFFEE_TABLE', col: 9, row: 2 }],
};
const rooms = roomsOf(layout);
const agent = (room: string, working = true, tileRoom = room) => ({ working, room, tileRoom });

test('roomsOf: one box per Area, and the lounge is the Area holding the coffee table', () => {
  assert.deepEqual(rooms.boxes.get('B'), box(4, 0, 7, 5));
  assert.equal(rooms.lounge, 'C');
});

test('fitTarget: the working room plus its nearest neighbour, so at least two rooms', () => {
  assert.deepEqual(fitTarget(rooms, [agent('A')]), box(0, 0, 7, 5));
});

test('fitTarget: the lounge joins when anyone stands in it', () => {
  // A works; someone idle stands in C. A and C, not the room between them.
  const target = fitTarget(rooms, [agent('A'), agent('B', false, 'C')]);
  assert.deepEqual(target, box(0, 0, 11, 5));
});

test('fitTarget: idle agents hold nothing; nobody working frames the whole map', () => {
  assert.equal(fitTarget(rooms, [agent('A', false), agent('B', false)]), null);
  assert.equal(fitTarget(rooms, []), null);
});

test('fitTarget: a map with fewer rooms than the minimum frames the whole map', () => {
  const single = roomsOf({ ...layout, areaTiles: new Array<string | null>(72).fill('A') });
  assert.equal(fitTarget(single, [agent('A')]), null);
});

test('fitView: the frame is EXACTLY the room union, centred on it', () => {
  // 1280x720 canvas. Rooms A+B = cols 0-7, rows 0-5.
  const target = fitTarget(rooms, [agent('A')]);
  const fit = fitView(target, { cols: 12, rows: 6 }, { width: 1280, height: 720 }, 1);
  assert.deepEqual(fit.box, box(0, 0, 7, 5));
  // 8x6 tiles in 1264x704 px (8 px padding a side): min(9.875, 7.33) = 7.33, and the level under it is 6
  assert.equal(fit.zoom, 6);
  assert.deepEqual(fit.center, { x: 64, y: 48 });
});

test('fitView: a room target frames its top wall too, so the windows are never cut in half', () => {
  const map = { cols: 20, rows: 11 };
  const fit = fitView(box(3, 4, 8, 9), map, { width: 1280, height: 720 }, 1);
  assert.deepEqual(fit.box, box(3, 2, 8, 9));
  // never above the map
  assert.equal(fitView(box(3, 1, 8, 9), map, { width: 1280, height: 720 }, 1).box?.row0, 0);
});

test('fitView: 8 CSS px of padding a side, in CSS px whatever the dpr: it decides the zoom level', () => {
  // The whole 20x11 map is 320x176 world px. At zoom 4 it needs 1280x704 device px, and the
  // padding adds 16 CSS px a side pair; a tile of margin (32 px at zoom 4) would not fit.
  const map = { cols: 20, rows: 11 };
  const zoomOf = (width: number, height: number, dpr: number) =>
    fitView(null, map, { width, height }, dpr).zoom;
  assert.equal(zoomOf(1296, 720, 1), 4, 'exactly map + 8 px a side');
  assert.equal(zoomOf(1295, 720, 1), 3, 'a pixel short: the level below 4 is 3');
  assert.equal(zoomOf(1296, 719, 1), 3, 'a pixel short, vertically');
  // Zoom 8 needs 2560x1408 device px plus 16 a side at dpr 2 (the padding doubles with it).
  assert.equal(zoomOf(1296, 720, 2), 8, 'exactly map + 8 CSS px a side');
  assert.equal(zoomOf(1295, 720, 2), 6, 'a CSS pixel short');
  // A target is padded the same way: 2x2 floor tiles plus their 2 wall-face rows are 2x4 tiles,
  // 640x1280 at zoom 20, +16 a side.
  const fit = fitView(box(3, 3, 4, 4), map, { width: 656, height: 1296 }, 1);
  assert.equal(fit.zoom, 20);
  assert.equal(fitView(box(3, 3, 4, 4), map, { width: 655, height: 1296 }, 1).zoom, 18);
});

test('fitView: no target is the whole map at the biggest zoom level that fits', () => {
  const fit = fitView(null, { cols: 20, rows: 11 }, { width: 1296, height: 720 }, 1);
  assert.equal(fit.zoom, 4);
  assert.deepEqual(fit.center, { x: 160, y: 88 });
  // dpr doubles the device pixels: 2592 x 1440 less 16 a side fits 20 x 11 tiles at min(8, 8) = 8.
  assert.equal(fitView(null, { cols: 20, rows: 11 }, { width: 1296, height: 720 }, 2).zoom, 8);
});

test('fitView: the zoom is the largest of {1, 2, 3, 4, 6, ..., 20} that fits; 3 is the only odd level above 1', () => {
  // The whole 20x11 map on a very wide canvas: 11 rows x 16 px = 176 device px per zoom unit
  const fitAt = (height: number) =>
    fitView(null, { cols: 20, rows: 11 }, { width: 100000, height }, 1).zoom;
  assert.equal(fitAt(176 * 2.9), 2);
  assert.equal(fitAt(176 * 3.9), 3);
  assert.equal(fitAt(176 * 5), 4);
  assert.equal(fitAt(176 * 1.9), 1);
  assert.equal(fitAt(176 * 25), 20);
});

test('fitView: the bundled office beside the monitor rail fits at 3 on a 1080p screen, 2 at 1280x800 (Q1.1)', () => {
  // The stage is the window less the rail (the sheet closed); the fit frames the whole office.
  const { cols, rows } = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../public/assets/default-layout-1.json'), 'utf8'),
  ) as { cols: number; rows: number };
  const stageFit = (width: number, height: number, dpr: number) =>
    fitView(
      null,
      { cols, rows },
      { width: width - monitorLayout(width, height).railPx, height },
      dpr,
    ).zoom;
  const table: Array<[width: number, height: number, dpr: number, zoom: number]> = [
    [1920, 1080, 1, 3],
    [1920, 1080, 2, 6],
    [1280, 800, 1, 2],
    [1280, 800, 2, 4],
  ];
  for (const [width, height, dpr, zoom] of table) {
    assert.equal(stageFit(width, height, dpr), zoom, `${width}x${height} at dpr ${dpr}`);
  }
});

test('stepZoom: + and - walk the zoom levels, 1, 2, 3, 4 then by 2, and stop at the ends', () => {
  const walk = (from: number, dir: 1 | -1, n: number) => {
    const seen = [from];
    for (let i = 0; i < n; i++) seen.push(stepZoom(seen[seen.length - 1], dir));
    return seen;
  };
  assert.deepEqual(walk(1, 1, 5), [1, 2, 3, 4, 6, 8]);
  assert.deepEqual(walk(8, -1, 6), [8, 6, 4, 3, 2, 1, 1]);
  assert.deepEqual(walk(18, 1, 2), [18, 20, 20]);
});

test('fitZoomWholeMap: the 27x21 layout on a 2560x1300 device-px canvas fits at 3 (3.87 snaps down)', () => {
  assert.equal(fitZoomWholeMap({ cols: 27, rows: 21 }, { width: 1280, height: 650 }, 2), 3);
});

// ── Hysteresis ─────────────────────────────────────────────────

const WIDE = { cols: 40, rows: 11 };
const CANVAS = { width: 1296, height: 720 };

test('refitView: a target inside the current view changes nothing', () => {
  const current = { zoom: 4, center: { x: 160, y: 88 } };
  assert.equal(refitView(current, box(5, 5, 6, 6), WIDE, CANVAS, 1), null);
  assert.equal(refitView(current, null, WIDE, CANVAS, 1), null);
});

test('refitView: a target outside the view re-centres but never zooms in', () => {
  const current = { zoom: 3, center: { x: 48, y: 88 } };
  // the box alone would fit at zoom 11; the view stays at 3 and only moves (to the floor rows 5-6
  // plus the two wall-face rows above them)
  assert.deepEqual(refitView(current, box(30, 5, 32, 6), WIDE, CANVAS, 1), {
    zoom: 3,
    center: { x: 504, y: 80 },
  });
});

test('refitView: a target that no longer fits zooms out', () => {
  const current = { zoom: 5, center: { x: 160, y: 88 } };
  // the 20x11 tiles in 1280x704 px fit at min(4, 4), so the view drops from 5 to 4; one
  // CSS pixel less on the canvas and it would be 3
  assert.equal(refitView(current, box(0, 0, 19, 10), { cols: 20, rows: 11 }, CANVAS, 1)?.zoom, 4);
  assert.equal(
    refitView(current, box(0, 0, 19, 10), { cols: 20, rows: 11 }, { width: 1295, height: 720 }, 1)
      ?.zoom,
    3,
  );
});

const input = (patch: Partial<AutoFitInput> = {}): AutoFitInput => ({
  target: null,
  map: WIDE,
  canvas: CANVAS,
  dpr: 1,
  // the zoom level the first fit of these fixtures lands on
  zoom: 2,
  pan: { x: 0, y: 0 },
  nowMs: 0,
  editing: false,
  followed: false,
  ...patch,
});

test('AutoFit: fits once on start, then leaves a target inside the view alone', () => {
  const fit = new AutoFit();
  // whole 40x11 map: floor(min(2, 4.0)) = 2; the 1280 px map fills the width less padding, the height is centred
  assert.deepEqual(fit.step(input()), { zoom: 2, pan: { x: 0, y: 0 }, panZoom: 2 });
  assert.deepEqual(fit.step(input({ target: box(5, 5, 6, 6), zoom: 2, nowMs: 50 })), {});
});

test('AutoFit: a target outside the view eases the centre over 300 ms, keeps the zoom, and stays void-free', () => {
  const fit = new AutoFit();
  // 8x8 tiles: fits at zoom 4, a 20-tile-wide view that cannot see column 30
  fit.step(input({ target: box(0, 0, 7, 7), zoom: 4 }));
  const far = input({ target: box(30, 5, 32, 6), zoom: 4, nowMs: 1000 });
  const first = fit.step(far);
  assert.equal(first.zoom, undefined, 'the zoom is not animated or changed');
  assert.deepEqual(first.pan, { x: 0, y: 0 }, 'starts where the view is');
  const done = fit.step({ ...far, nowMs: 1300 });
  // The centre would pan -736, past the right edge of the 40-tile map: clamped to -632 (the right edge flush with the 1296 px view).
  assert.deepEqual(done.pan, { x: -632, y: 0 }, 'ends on the new rooms, without void');
});

test('AutoFit: a manual zoom or pan, an open editor or a followed agent stops refits; Fit resumes', () => {
  const states: boolean[] = [];
  const fit = new AutoFit((on) => states.push(on));
  fit.step(input({ target: box(0, 0, 5, 10) }));
  const far = input({ target: box(30, 5, 32, 6) });

  fit.disable(); // manual zoom or pan
  assert.deepEqual(fit.step(far), {});
  assert.equal(fit.enabled, false);

  fit.enable(); // the Fit button frames the rooms right away
  const refit = fit.step(far);
  assert.equal(typeof refit.zoom, 'number');
  assert.deepEqual(states, [false, true]);

  const editing = new AutoFit();
  editing.step(input());
  assert.deepEqual(editing.step({ ...far, editing: true }), {});
  assert.equal(editing.enabled, false);

  const following = new AutoFit();
  following.step(input());
  assert.deepEqual(following.step({ ...far, followed: true }), {});
  assert.equal(following.enabled, false);
});

test('AutoFit: a stage that changes size is framed again; with auto-fit off it is left alone', () => {
  const fit = new AutoFit();
  fit.step(input());
  // Narrower by a 360 px rail: the 40-tile map no longer fits at 2.
  const narrow = { width: 920, height: 720 };
  const refit = fit.step(input({ canvas: narrow, nowMs: 50 }));
  assert.equal(refit.zoom, 1);
  assert.equal(refit.panZoom, 1);
  assert.deepEqual(fit.step(input({ canvas: narrow, zoom: 1, nowMs: 100 })), {});

  const manual = new AutoFit();
  manual.step(input());
  manual.disable();
  assert.deepEqual(manual.step(input({ canvas: narrow, nowMs: 50 })), {});
});

// ── Camera follow ──────────────────────────────────────────────

test('camera follow: the same pan at 30 and 60 fps, then it lands on the legal goal and stops', () => {
  // The target sits past the map's left edge: the clamp stops the pan at x = -300.
  const legal = (p: Point): Point => ({ x: Math.min(0, Math.max(-300, p.x)), y: p.y });
  const target = { x: -400, y: 120 };
  const follow = (fps: number, seconds: number) => {
    let step = { pan: { x: 0, y: 0 }, settled: false };
    for (let i = 0; i < seconds * fps; i++) step = followPan(step.pan, target, 1 / fps, legal);
    return step;
  };

  const fast = follow(60, 0.5).pan;
  const capped = follow(30, 0.5).pan;
  assert.ok(
    Math.abs(fast.x - capped.x) + Math.abs(fast.y - capped.y) < 1,
    'same pan at either rate',
  );
  assert.deepEqual(follow(30, 5), { pan: { x: -300, y: 120 }, settled: true });
});

// ── Scene camera: a room framed inside the part of the stage a capture keeps ──

test('panForPoint: the world point lands under the requested screen point', () => {
  const canvas = { width: 2000, height: 1600 };
  const map = { cols: 25, rows: 20 };
  const dpr = 2;
  const zoom = 6;
  const at = { x: 137, y: 88 };
  const screen = { x: 290, y: 247 };
  const pan = panForPoint(at, screen, canvas, dpr, map, zoom);
  const centre = centerForPan(pan, map, zoom);
  // The canvas centre shows `centre`; `at` sits (at - centre) * zoom device px from it.
  assert.equal(canvas.width / 2 + (at.x - centre.x) * zoom, screen.x * dpr);
  assert.equal(canvas.height / 2 + (at.y - centre.y) * zoom, screen.y * dpr);
});

test('areaCenter: the middle of the Area box, matched without case, and null for none', () => {
  const rooms = { boxes: new Map([['Studio', box(2, 4, 5, 7)]]), lounge: null };
  assert.deepEqual(areaCenter(rooms, 'STUDIO'), { x: 64, y: 96 });
  assert.equal(areaCenter(rooms, 'Den'), null);
});
