/**
 * The monitor's office: which desk lights for whom (Q3.1), where the tags go (the solver), and
 * where a workflow's banner hangs (Q3.3). Pure geometry, at the zooms the fit picks (2, 3, 4).
 *
 * Run with: npm test
 */
import { describe, expect, it } from 'vitest';

import {
  DESK_HIGHLIGHT_BLINK_MS,
  DESK_HIGHLIGHT_GAP_PX,
  DESK_HIGHLIGHT_INK,
  DESK_HIGHLIGHT_OUTLINE_PX,
  DESK_HIGHLIGHT_STUCK_COLOR,
  DESK_HIGHLIGHT_STUCK_FILL,
  DESK_HIGHLIGHT_WAIT_COLOR,
  DESK_HIGHLIGHT_WAIT_FILL,
  TAG_DESK_GAP_PX,
  TAG_FAR_REACH_PX,
  TAG_HEAD_GAP_PX,
  TAG_LEADER_AT_PX,
  TAG_LEADER_PX,
  TAG_PAD_PX,
  TAG_REACH_PX,
  TAG_SIDE_COST,
  TAG_STEP_PX,
} from '../src/constants.js';
import { crewBannerSize, crewBannerView, placeCrewBanner } from '../src/office/crewBanner.js';
import {
  attentionTone,
  deskHighlightFill,
  deskHighlightFrame,
  deskHighlights,
  highlightFrame,
  type HighlightSeat,
  separateFrames,
} from '../src/office/deskHighlight.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { placeTags, type Rect, type TagItem } from '../src/office/labelLayout.js';
import { openSideSlots, type SlotGeometry, tagRoom } from '../src/office/monitorTags.js';
import { type OfficeLayout, TileType } from '../src/office/types.js';
import { Direction } from '../src/office/types.js';

const T = 16;
const hit = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, b: Rect): boolean =>
  r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;

describe('Q3.1 the desk that lights', () => {
  it.each([
    [{ permission: true, question: false, finished: false, stuck: false }, 'wait'],
    [{ permission: false, question: true, finished: false, stuck: false }, 'wait'],
    [{ permission: false, question: false, finished: false, stuck: true }, 'stuck'],
    // Waiting on you outranks stuck, like the plate's tab.
    [{ permission: true, question: false, finished: false, stuck: true }, 'wait'],
    [{ permission: false, question: false, finished: false, stuck: false }, null],
    // Finished work is the user's turn, not an alarm: the desk stays dark.
    [{ permission: false, question: false, finished: true, stuck: false }, null],
  ] as const)('%o lights %s', (facts, tone) => {
    expect(attentionTone(facts)).toBe(tone);
  });

  // Three desks in a row, each 3 tiles wide and 2 tall from row 3; the chairs face down on each
  // desk's back row. Agent 2 is listed first but sits at the last desk.
  const desks = [0, 4, 8].map((col) => ({ x: col * T, y: 3 * T, w: 3 * T, h: 2 * T }));
  const deskAt = (col: number, row: number): Rect | null =>
    desks.find((d) => hit(d, { x: col * T + 1, y: row * T + 1, w: 1, h: 1 })) ?? null;
  const seats = new Map<string, HighlightSeat>([
    ['a', { seatCol: 1, seatRow: 3, facing: { dCol: 0, dRow: 1 } }],
    ['b', { seatCol: 5, seatRow: 3, facing: { dCol: 0, dRow: 1 } }],
    ['c', { seatCol: 9, seatRow: 3, facing: { dCol: 0, dRow: 1 } }],
  ]);

  it("frames each lit agent's own desk, seat and sprite, whatever the order", () => {
    const sprite = { x: 9 * T, y: 2 * T + 5, w: T, h: 27 };
    const lit = deskHighlights(
      [
        { id: 2, tone: 'wait', col: 9, row: 3, seatId: 'c', sprite },
        { id: 7, tone: 'stuck', col: 5, row: 3, seatId: 'b' },
      ],
      seats,
      deskAt,
    );
    expect(lit).toEqual([
      // The desk under the chair, grown up to the head of the agent sitting there.
      { id: 2, tone: 'wait', rect: { x: 8 * T, y: 2 * T + 5, w: 3 * T, h: 3 * T - 5 } },
      { id: 7, tone: 'stuck', rect: desks[1] },
    ]);
  });

  it('a back-view seat under its desk adds its own tile; no seat lights the tile it stands on', () => {
    const back = new Map<string, HighlightSeat>([
      ['d', { seatCol: 5, seatRow: 5, facing: { dCol: 0, dRow: -1 } }],
    ]);
    expect(
      deskHighlights(
        [
          { id: 1, tone: 'wait', col: 5, row: 5, seatId: 'd' },
          { id: 3, tone: 'wait', col: 12, row: 8, seatId: null },
        ],
        back,
        deskAt,
      ).map((h) => h.rect),
    ).toEqual([
      { x: 4 * T, y: 3 * T, w: 3 * T, h: 3 * T },
      { x: 12 * T, y: 8 * T, w: T, h: T },
    ]);
  });
});

/**
 * A top room as the bundled office has it, scaled to a zoom: a wall band of two tiles, four
 * face-on agents one pod (4 tiles) apart at desks two tiles deep, their tags as wide as a long
 * state reads. Each tag hangs from its open side (a face-on agent: above its head).
 */
function topRow(zoom: number, tagW = 120) {
  const z = (v: number) => v * zoom;
  const room: Rect = { x: 0, y: 0, w: z(17 * T), h: z(8 * T) };
  const agents = [2, 6, 10, 14].map((col, i) => {
    const headTop = z(2 * T) + 13;
    const body = { x: z(col * T), y: headTop, w: z(T), h: z(T + 5) };
    const desk = { x: z((col - 1) * T), y: headTop, w: z(3 * T), h: z(3 * T) - 13 };
    const tagH = 26;
    const geometry: SlotGeometry = {
      x: z(col * T + T / 2),
      unit: desk,
      body,
      headTop,
      tagH,
      groupH: tagH,
    };
    return {
      id: i + 1,
      body,
      desk,
      geometry,
      item: {
        id: i + 1,
        rank: 1,
        col,
        row: 3,
        w: tagW,
        tagH,
        slots: openSideSlots(Direction.DOWN, geometry),
        bounds: room,
      } satisfies TagItem,
    };
  });
  return { room, agents };
}

const SOLVER = {
  step: TAG_STEP_PX,
  leaderAt: TAG_LEADER_AT_PX,
  reach: TAG_REACH_PX,
  farReach: TAG_FAR_REACH_PX,
  pad: TAG_PAD_PX,
  sideCost: TAG_SIDE_COST,
  leaderPx: TAG_LEADER_PX,
};

describe('the open side', () => {
  const g: SlotGeometry = {
    x: 100,
    unit: { x: 70, y: 60, w: 60, h: 50 },
    body: { x: 92, y: 70, w: 16, h: 21 },
    headTop: 70,
    tagH: 20,
    groupH: 44,
  };

  it('an agent seated facing up hangs its tag under the desk unit, the others above the head', () => {
    const [under] = openSideSlots(Direction.UP, g);
    expect(under).toMatchObject({ below: true, y: 110 + TAG_DESK_GAP_PX, h: 20, anchor: g.unit });
    for (const facing of [Direction.DOWN, Direction.LEFT, Direction.RIGHT, null]) {
      const slots = openSideSlots(facing, g);
      expect(slots).toHaveLength(1);
      // The whole group (tag and riders) ends TAG_HEAD_GAP_PX over the head.
      expect(slots[0]).toMatchObject({
        below: false,
        y: 70 - TAG_HEAD_GAP_PX - 44,
        h: 44,
        anchor: g.body,
      });
    }
  });
});

describe('the tag solver', () => {
  it.each([2, 3, 4])(
    'at zoom %i every face-on tag goes above its own head, none on another or a body',
    (zoom) => {
      const { agents } = topRow(zoom, zoom * 40);
      const bodies = agents.map((a) => a.body);
      const placed = placeTags(
        agents.map((a) => a.item),
        bodies,
        SOLVER,
      );
      const hits = agents.map((a) => placed.get(a.id));
      expect(hits.every((h) => h && !h.below && !h.leader)).toBe(true);
      const rects = hits.map((h) => h!.tag);
      for (const [i, t] of rects.entries()) {
        for (const o of [...rects.slice(i + 1), ...bodies]) expect(hit(t, o)).toBe(false);
        // Over its own head.
        const { item, body } = agents[i];
        expect(t.y + t.h).toBeLessThanOrEqual(body.y);
        expect(t.x < item.slots[0].x && item.slots[0].x < t.x + t.w).toBe(true);
      }
    },
  );

  it('a tag whose open side is full goes to the other side, always on a leader', () => {
    const { agents } = topRow(3);
    const [a] = agents;
    // Everything over the head is taken, as far as the solver looks.
    const crowd = { x: a.body.x - 200, y: 0, w: a.body.w + 400, h: a.body.y };
    const other = { ...openSideSlots(Direction.UP, a.geometry)[0], leader: true };
    const item = { ...a.item, slots: [...a.item.slots, other] };
    const p = placeTags([item], [a.body, crowd], SOLVER).get(a.id);
    expect(p?.below).toBe(true);
    // It sits right under the desk (no shift) yet hangs from a leader: the owner stays explicit.
    expect(p?.shift).toBe(0);
    expect(p?.leader).toBe(true);
  });

  it('a tag moved past the leader distance hangs from a leader', () => {
    const { agents } = topRow(3, 40);
    const [a] = agents;
    const slot = a.item.slots[0];
    // A post on the slot's spot: the tag steps aside, clear of it, and the leader reaches the head.
    const post = { x: slot.x - 8, y: slot.y, w: 16, h: slot.h + TAG_HEAD_GAP_PX };
    const moved = placeTags([a.item], [a.body, post], SOLVER).get(a.id);
    expect(moved?.shift).toBeGreaterThan(TAG_LEADER_AT_PX);
    expect(moved?.leader).toBe(true);
  });

  it.each([
    ['within the reach', 10, false],
    ['past the reach', TAG_REACH_PX + 16, true],
  ])(
    'a tag left %s of what it hangs from, without moving, gets a leader only past it',
    (_n, gap, leader) => {
      const anchor = { x: 100, y: 200, w: 48, h: 48 };
      const item: TagItem = {
        id: 1,
        rank: 1,
        col: 0,
        row: 0,
        w: 40,
        tagH: 20,
        slots: [{ x: 124, y: 200 - gap - 20, h: 20, below: false, anchor }],
        bounds: { x: 0, y: 0, w: 400, h: 400 },
      };
      const p = placeTags([item], [], SOLVER).get(1);
      expect(p?.shift).toBe(0);
      expect(p?.leader).toBe(leader);
    },
  );

  it('a tag never leaves its room, even when its slot hangs past the room edge', () => {
    const room = { x: 0, y: 0, w: 200, h: 100 };
    const desk = { x: 140, y: 40, w: 60, h: 50 };
    const item: TagItem = {
      id: 1,
      rank: 1,
      col: 0,
      row: 0,
      w: 80,
      tagH: 20,
      // Under the desk is past the room's bottom; the head slot is past its right wall.
      slots: [
        { x: 170, y: 94, h: 20, below: true, anchor: desk },
        { x: 170, y: 14, h: 20, below: false, anchor: desk },
      ],
      bounds: room,
    };
    const p = placeTags([item], [desk], SOLVER).get(1);
    expect(p).not.toBeNull();
    expect(inside(p!.tag, room)).toBe(true);
  });

  it('a tag with no free spot in its room is not placed at all', () => {
    const room = { x: 0, y: 0, w: 100, h: 60 };
    const item: TagItem = {
      id: 1,
      rank: 1,
      col: 0,
      row: 0,
      w: 80,
      tagH: 20,
      slots: [{ x: 50, y: 10, h: 20, below: false, anchor: room }],
      bounds: room,
    };
    expect(placeTags([item], [room], SOLVER).get(1)).toBeNull();
  });
});

describe('the room a tag may fill', () => {
  // Two rooms side by side under a two-row wall, and a lobby tile (no area) at the top left.
  const cols = 10;
  const rows = 8;
  const areaTiles = Array.from({ length: cols * rows }, (_, i) => {
    const row = Math.floor(i / cols);
    if (row < 3) return null;
    return i % cols < 5 ? 'Den' : 'Studio';
  });
  const layout = { cols, rows, areaTiles };

  it('is the room of the tile the agent stands on, with its wall face, not its seat room', () => {
    // Seated in the Den, but standing on a Studio tile: the Studio's rect.
    expect(tagRoom(layout, { tileCol: 7, tileRow: 5 })).toEqual({
      x: 5 * T,
      y: 3 * T - 2 * T,
      w: 5 * T,
      h: 5 * T + 2 * T,
    });
    expect(tagRoom(layout, { tileCol: 1, tileRow: 4 }).x).toBe(0);
  });

  it('is the whole map on a tile with no area', () => {
    expect(tagRoom(layout, { tileCol: 2, tileRow: 0 })).toEqual({
      x: 0,
      y: 0,
      w: cols * T,
      h: rows * T,
    });
  });
});

describe('an idle wait is finished, a question is a question', () => {
  function seated(): OfficeState {
    const layout = {
      version: 1,
      cols: 6,
      rows: 6,
      tiles: new Array<TileType>(36).fill(TileType.FLOOR_1),
      furniture: [],
    } as OfficeLayout;
    const os = new OfficeState(layout);
    os.addAgent(1);
    os.showWaitingBubble(1, true);
    return os;
  }
  const facts = (os: OfficeState, now?: number) => os.attentionFacts(os.characters.get(1)!, now);

  it('an idle wait is finished and lights no desk', () => {
    const os = seated();
    os.setAwaiting(1, 'idle', undefined);
    expect(facts(os)).toMatchObject({ finished: true, question: false });
    expect(os.litDeskCount()).toBe(0);
  });

  it('a question wait lights the desk gold', () => {
    const os = seated();
    os.setAwaiting(1, 'question', 'Ship it?');
    expect(facts(os)).toMatchObject({ finished: false, question: true });
    expect(os.litDeskCount()).toBe(1);
  });

  it('an idle wait while a loop sleeps is not finished; once the wake passes it is', () => {
    const os = seated();
    os.setAwaiting(1, 'idle', undefined);
    os.setLoop(1, { nextAt: 5_000 });
    expect(facts(os, 1_000).finished).toBe(false);
    expect(facts(os, 6_000).finished).toBe(true);
  });
});

describe('the speech bubble over a lit agent', () => {
  function litAgent(): { os: OfficeState; ch: ReturnType<OfficeState['characters']['get']> } {
    const layout = {
      version: 1,
      cols: 6,
      rows: 6,
      tiles: new Array<TileType>(36).fill(TileType.FLOOR_1),
      furniture: [],
    } as OfficeLayout;
    const os = new OfficeState(layout);
    os.addAgent(1);
    const ch = os.characters.get(1)!;
    ch.bubbleType = 'permission';
    return { os, ch };
  }

  it('is drawn in the panel, and left to the tag beside the rail', () => {
    const { os, ch } = litAgent();
    // The permission lights the desk: the frame and the tag's tab say it.
    expect(os.litDeskCount()).toBe(1);
    expect(os.bubbleShown(ch!)).toBe(true);
    os.hideLitBubbles = true;
    expect(os.bubbleShown(ch!)).toBe(false);
  });

  it('stays for an agent whose desk is not lit', () => {
    const { os, ch } = litAgent();
    ch!.isSubagent = true;
    os.hideLitBubbles = true;
    expect(os.bubbleShown(ch!)).toBe(true);
  });
});

describe('separateFrames: lit desks keep air between them', () => {
  const O = DESK_HIGHLIGHT_OUTLINE_PX;
  const G = DESK_HIGHLIGHT_GAP_PX;
  const all = { top: true, right: true, bottom: true, left: true };

  it('a lone desk keeps its whole outline and every halo side', () => {
    const unit = { x: 100, y: 100, w: 48, h: 64 };
    expect(separateFrames([unit], O, G)).toEqual([
      { outline: { x: 100 - O, y: 100 - O, w: 48 + 2 * O, h: 64 + 2 * O }, halo: all },
    ]);
  });

  it('two stacked desks 2 px apart end up at least the gap apart, with no halo between them', () => {
    const upper = { x: 100, y: 100, w: 48, h: 64 };
    const lower = { x: 100, y: 166, w: 48, h: 64 };
    const [a, b] = separateFrames([upper, lower], O, G);
    expect(b.outline.y - (a.outline.y + a.outline.h)).toBeGreaterThanOrEqual(G);
    expect(a.halo).toEqual({ ...all, bottom: false });
    expect(b.halo).toEqual({ ...all, top: false });
    // The sides meet at the midline between the desks, half the gap each.
    expect(a.outline.y + a.outline.h).toBe(165 - G / 2);
  });

  it('desks side by side meet on their left and right sides', () => {
    const [a, b] = separateFrames(
      [
        { x: 100, y: 100, w: 48, h: 64 },
        { x: 150, y: 100, w: 48, h: 64 },
      ],
      O,
      G,
    );
    expect(b.outline.x - (a.outline.x + a.outline.w)).toBeGreaterThanOrEqual(G);
    expect(a.halo.right).toBe(false);
    expect(b.halo.left).toBe(false);
  });

  it('desks far apart are left alone', () => {
    const frames = separateFrames(
      [
        { x: 0, y: 0, w: 48, h: 48 },
        { x: 300, y: 300, w: 48, h: 48 },
      ],
      O,
      G,
    );
    expect(frames.every((f) => Object.values(f.halo).every(Boolean))).toBe(true);
  });
});

describe('R1.3 the lit desk is the loudest thing in the room', () => {
  const r = { x: 100, y: 50, w: 96, h: 120 };
  /** The frame of a lone desk at `dpr`, as the canvas builds it (outline and gap in device px). */
  const frameAt = (dpr: number) =>
    separateFrames([r], DESK_HIGHLIGHT_OUTLINE_PX * dpr, DESK_HIGHLIGHT_GAP_PX * dpr)[0];
  it.each([1, 2])(
    'at dpr %i a 4 px outline in the tile color, a 1 px ink inset and a wash',
    (dpr) => {
      for (const [tone, color, wash] of [
        ['wait', DESK_HIGHLIGHT_WAIT_COLOR, DESK_HIGHLIGHT_WAIT_FILL],
        ['stuck', DESK_HIGHLIGHT_STUCK_COLOR, DESK_HIGHLIGHT_STUCK_FILL],
      ] as const) {
        const ops = deskHighlightFrame(frameAt(dpr), tone, 1, dpr);
        const outline = ops.filter((o) => o.color === color);
        expect(outline).toHaveLength(4);
        // Top and bottom bars are the outline's thickness tall, the sides as wide.
        expect(outline.map((o) => Math.min(o.w, o.h))).toEqual([4, 4, 4, 4].map((t) => t * dpr));
        const ink = ops.filter((o) => o.color === DESK_HIGHLIGHT_INK);
        expect(ink.map((o) => Math.min(o.w, o.h))).toEqual([dpr, dpr, dpr, dpr]);
        // The ink runs inside the outline, on the desk's own edge.
        expect(ink[0].y).toBe(r.y);
        expect(deskHighlightFill(r, tone)).toEqual({ color: wash, ...r });
        // A 12% wash: the carpet still reads through it.
        expect(wash).toMatch(/, 0\.12\)$/);
      }
    },
  );

  it('pulses: the halo shows on one frame and not the other', () => {
    const halo = (frame: 0 | 1) =>
      deskHighlightFrame(frameAt(1), 'wait', frame, 1).filter((o) => o.color.startsWith('rgba'))
        .length;
    expect([halo(0), halo(1)]).toEqual([4, 0]);
  });

  it('the blink alternates every half second of the office clock', () => {
    const at = (ms: number) => highlightFrame(ms);
    expect([
      at(0),
      at(DESK_HIGHLIGHT_BLINK_MS - 1),
      at(DESK_HIGHLIGHT_BLINK_MS),
      at(2 * DESK_HIGHLIGHT_BLINK_MS),
    ]).toEqual([0, 0, 1, 0]);
  });

  it('a side that meets a neighbour draws no halo bar', () => {
    const [a] = separateFrames([r, { ...r, y: r.y + r.h + 2 }], 4, 8);
    const bars = deskHighlightFrame(a, 'wait', 0, 1).filter((o) => o.color.startsWith('rgba'));
    expect(bars).toHaveLength(3);
  });
});

describe('Q3.3 the crew banner on its wall', () => {
  const view = crewBannerView(
    {
      status: 'running',
      name: 'review-pr',
      phases: [
        { name: 'scan', started: 1, done: 1 },
        { name: 'review', started: 3, done: 0 },
      ],
      started: 4,
      done: 1,
      since: 0,
    },
    'Linus',
    21 * 60_000,
  );

  it.each([2, 3, 4])('at zoom %i it hangs inside the top wall band over its helpers', (zoom) => {
    // A 12-tile room whose floor starts under a two-tile wall; helpers sit on its second floor row.
    const z = (v: number) => v * zoom;
    const band: Rect = { x: 0, y: 0, w: z(12 * T), h: z(2 * T) };
    const room: Rect = { x: 0, y: 0, w: z(12 * T), h: z(10 * T) };
    const heads = [3, 7].map((c) => ({ x: z(c * T), y: z(4 * T) }));
    const size = crewBannerSize(view, 'wall');
    // The largest scale that fits the band, as the overlay asks for it.
    const k = Math.min(1.5, (band.h - 4) / (size.h + 4));
    const placed = placeCrewBanner({
      wall: { band, sizes: [{ w: size.w * k, h: (size.h + 4) * k }] },
      free: crewBannerSize(view),
      heads,
      room,
      map: room,
      wallAvoid: [],
      avoid: [],
    });
    expect(placed?.onWall).toBe(true);
    expect(inside(placed!.rect, band)).toBe(true);
  });

  it('slides along the wall off a plaque, and leaves the wall when nothing there is free', () => {
    const band: Rect = { x: 0, y: 0, w: 600, h: 96 };
    const room: Rect = { x: 0, y: 0, w: 600, h: 400 };
    const size = { w: 260, h: 80 };
    const heads = [{ x: 60, y: 200 }];
    const plaque: Rect = { x: 24, y: 30, w: 80, h: 30 };
    const wall = placeCrewBanner({
      wall: { band, sizes: [size] },
      free: size,
      heads,
      room,
      map: room,
      wallAvoid: [plaque],
      avoid: [],
    });
    expect(wall?.onWall).toBe(true);
    expect(hit(wall!.rect, plaque)).toBe(false);
    const off = placeCrewBanner({
      wall: { band, sizes: [size] },
      free: size,
      heads,
      room,
      map: room,
      wallAvoid: [band],
      avoid: [],
    });
    expect(off?.onWall).toBe(false);
  });
});
