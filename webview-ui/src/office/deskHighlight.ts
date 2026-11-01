/**
 * The desk of an agent that needs you, lit on the canvas: gold while it waits on a permission or
 * a question, red while it is stuck. Pure: the office hands in plain facts and the desk lookup,
 * the renderer draws the rects this returns. Neighbouring frames keep air between them
 * (`separateFrames`), and the overlay pins a tag to the same outlines.
 */

import {
  DESK_HIGHLIGHT_BLINK_MS,
  DESK_HIGHLIGHT_HALO_PX,
  DESK_HIGHLIGHT_INK,
  DESK_HIGHLIGHT_INSET_PX,
  DESK_HIGHLIGHT_OUTLINE_PX,
  DESK_HIGHLIGHT_STUCK_COLOR,
  DESK_HIGHLIGHT_STUCK_FILL,
  DESK_HIGHLIGHT_STUCK_HALO,
  DESK_HIGHLIGHT_WAIT_COLOR,
  DESK_HIGHLIGHT_WAIT_FILL,
  DESK_HIGHLIGHT_WAIT_HALO,
  TILE_SIZE,
} from '../constants.js';
import type { Rect } from './labelLayout.js';

export type AttentionTone = 'wait' | 'stuck';

export interface AttentionFacts {
  /** A permission prompt is open. */
  permission: boolean;
  /** The agent stopped on a question for the user. */
  question: boolean;
  /** The agent finished and sits at its prompt (not a loop asleep until its next wake). The
   *  desk stays dark: it is the user's turn, not an alarm. */
  finished: boolean;
  /** Health stuck, looping or stalled, or an unacknowledged tripwire. */
  stuck: boolean;
}

/** The plate's precedence: waiting on you outranks stuck. */
export function attentionTone(f: AttentionFacts): AttentionTone | null {
  if (f.permission || f.question) return 'wait';
  return f.stuck ? 'stuck' : null;
}

export interface HighlightAgent {
  id: number;
  tone: AttentionTone;
  /** The tile the agent stands on. */
  col: number;
  row: number;
  seatId: string | null;
  /** The sprite's box, world px, when the agent sits at its seat: the frame goes around it too,
   *  so its top edge never crosses the face. */
  sprite?: Rect | null;
}

export interface HighlightSeat {
  seatCol: number;
  seatRow: number;
  /** The tile the seat faces, one step from the seat. */
  facing: { dCol: number; dRow: number };
}

export interface DeskHighlight {
  id: number;
  tone: AttentionTone;
  /** World px. */
  rect: Rect;
}

function tileRect(col: number, row: number): Rect {
  return { x: col * TILE_SIZE, y: row * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * Where each lit agent's frame goes, world px: its assigned seat and the desk that seat faces (a
 * face-on chair stands on the desk's back row, so the seat tile itself is tried first), plus the
 * sprite while it sits there. An agent with no seat gets its own tile.
 */
export function deskHighlights(
  agents: readonly HighlightAgent[],
  seats: ReadonlyMap<string, HighlightSeat>,
  deskRectAt: (col: number, row: number) => Rect | null,
): DeskHighlight[] {
  return agents.map((a) => {
    const seat = a.seatId ? seats.get(a.seatId) : undefined;
    if (!seat) return { id: a.id, tone: a.tone, rect: tileRect(a.col, a.row) };
    let rect = tileRect(seat.seatCol, seat.seatRow);
    const desk =
      deskRectAt(seat.seatCol, seat.seatRow) ??
      deskRectAt(seat.seatCol + seat.facing.dCol, seat.seatRow + seat.facing.dRow);
    if (desk) rect = union(rect, desk);
    if (a.sprite) rect = union(rect, a.sprite);
    return { id: a.id, tone: a.tone, rect };
  });
}

/** Which of the two frames shows at `nowMs`: 0 with the halo, 1 the outline alone. */
export function highlightFrame(nowMs: number): 0 | 1 {
  return Math.floor(nowMs / DESK_HIGHLIGHT_BLINK_MS) % 2 === 0 ? 0 : 1;
}

/** One solid rect to paint, device px. */
export interface PaintOp {
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The four sides of a frame `t` thick around `r`, outside it. */
function ring(r: Rect, t: number, color: string): PaintOp[] {
  return [
    { color, x: r.x - t, y: r.y - t, w: r.w + 2 * t, h: t },
    { color, x: r.x - t, y: r.y + r.h, w: r.w + 2 * t, h: t },
    { color, x: r.x - t, y: r.y, w: t, h: r.h },
    { color, x: r.x + r.w, y: r.y, w: t, h: r.h },
  ];
}

/** Which sides of an outline carry the blinking halo. */
export interface HaloSides {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/** A lit desk's outline (its unit grown by the outline's thickness, then pulled back where a
 *  neighbour is too near) and the sides that still draw a halo. */
export interface LitFrame {
  outline: Rect;
  halo: HaloSides;
}

/**
 * The outlines of the lit desks, in one unit (device px for the canvas, CSS px for the tag
 * overlay): each unit grown by `outlinePx`, and where two outlines meet or come within `gapPx` of
 * each other across the axis the units sit apart on, the facing sides pulled back to the midline
 * `gapPx` apart. Those sides draw no halo. A neighbour is the pair whose outlines also overlap on
 * the other axis (stacked pods, pods side by side); the axis is the one the units are farther
 * apart on (or overlap least on). Sides only ever move inward, so a desk with no neighbour keeps
 * its whole outline and all four halo sides.
 */
export function separateFrames(
  units: readonly Rect[],
  outlinePx: number,
  gapPx: number,
): LitFrame[] {
  const frames: LitFrame[] = units.map((u) => ({
    outline: {
      x: u.x - outlinePx,
      y: u.y - outlinePx,
      w: u.w + 2 * outlinePx,
      h: u.h + 2 * outlinePx,
    },
    halo: { top: true, right: true, bottom: true, left: true },
  }));
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      const alongX = gapX > gapY;
      const along = alongX ? gapX : gapY;
      const across = alongX ? gapY : gapX;
      if (across >= 2 * outlinePx || along - 2 * outlinePx >= gapPx) continue;
      const aFirst = alongX ? a.x <= b.x : a.y <= b.y;
      const [lo, hi] = aFirst ? [i, j] : [j, i];
      const end = alongX ? units[lo].x + units[lo].w : units[lo].y + units[lo].h;
      const start = alongX ? units[hi].x : units[hi].y;
      const loEnd = Math.floor((end + start) / 2 - gapPx / 2);
      const hiStart = loEnd + gapPx;
      const first = frames[lo];
      const second = frames[hi];
      if (alongX) {
        first.outline.w = Math.min(first.outline.x + first.outline.w, loEnd) - first.outline.x;
        const left = Math.max(second.outline.x, hiStart);
        second.outline.w -= left - second.outline.x;
        second.outline.x = left;
        first.halo.right = false;
        second.halo.left = false;
      } else {
        first.outline.h = Math.min(first.outline.y + first.outline.h, loEnd) - first.outline.y;
        const top = Math.max(second.outline.y, hiStart);
        second.outline.h -= top - second.outline.y;
        second.outline.y = top;
        first.halo.bottom = false;
        second.halo.top = false;
      }
    }
  }
  return frames;
}

/** The faint wash of a lit desk on the carpet, under its furniture and people: its unit cut to its
 *  outline, so a wash never crosses into a neighbour's frame. Both device px. */
export function washRect(unit: Rect, outline: Rect): Rect {
  const x = Math.max(unit.x, outline.x);
  const y = Math.max(unit.y, outline.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(unit.x + unit.w, outline.x + outline.w) - x),
    h: Math.max(0, Math.min(unit.y + unit.h, outline.y + outline.h) - y),
  };
}

/** The faint wash of a lit desk on the carpet, under its furniture and people: `r` device px. */
export function deskHighlightFill(r: Rect, tone: AttentionTone): PaintOp {
  return { color: tone === 'stuck' ? DESK_HIGHLIGHT_STUCK_FILL : DESK_HIGHLIGHT_WAIT_FILL, ...r };
}

/**
 * A lit desk's frame over the scene, device px: the outline in the rail tile's color along the
 * edge of `frame.outline` (inside it), an ink line just inside that, and on blink frame 0 a hard
 * halo outside the outline on the sides that keep one. Thicknesses are CSS px times `dpr`, whole
 * device px.
 */
export function deskHighlightFrame(
  frame: LitFrame,
  tone: AttentionTone,
  blink: 0 | 1,
  dpr: number,
): PaintOp[] {
  const line = Math.max(1, Math.round(DESK_HIGHLIGHT_OUTLINE_PX * dpr));
  const inset = Math.max(1, Math.round(DESK_HIGHLIGHT_INSET_PX * dpr));
  const halo = Math.max(1, Math.round(DESK_HIGHLIGHT_HALO_PX * dpr));
  const stuck = tone === 'stuck';
  const o = frame.outline;
  // The colored band runs along the outline's edge, inside it; `core` is what it surrounds.
  const core = { x: o.x + line, y: o.y + line, w: o.w - 2 * line, h: o.h - 2 * line };
  const inner = {
    x: core.x + inset,
    y: core.y + inset,
    w: core.w - 2 * inset,
    h: core.h - 2 * inset,
  };
  const haloColor = stuck ? DESK_HIGHLIGHT_STUCK_HALO : DESK_HIGHLIGHT_WAIT_HALO;
  const sides = frame.halo;
  // A bar reaches past a corner only where the side that meets it draws a halo too.
  const left = o.x - (sides.left ? halo : 0);
  const right = o.x + o.w + (sides.right ? halo : 0);
  const halos: PaintOp[] = [
    ...(sides.top ? [{ color: haloColor, x: left, y: o.y - halo, w: right - left, h: halo }] : []),
    ...(sides.bottom
      ? [{ color: haloColor, x: left, y: o.y + o.h, w: right - left, h: halo }]
      : []),
    ...(sides.left ? [{ color: haloColor, x: o.x - halo, y: o.y, w: halo, h: o.h }] : []),
    ...(sides.right ? [{ color: haloColor, x: o.x + o.w, y: o.y, w: halo, h: o.h }] : []),
  ];
  return [
    ...(blink === 0 ? halos : []),
    ...ring(core, line, stuck ? DESK_HIGHLIGHT_STUCK_COLOR : DESK_HIGHLIGHT_WAIT_COLOR),
    ...ring(inner, inset, DESK_HIGHLIGHT_INK),
  ];
}
