/**
 * Camera: "fit to activity" (the zoom level and centre that frame the rooms where agents are
 * working, kept framed without jumping the view around) and the pan/zoom rules (a zoom keeps the
 * point under an anchor still, a map smaller than the view is centred, a bigger one never shows void).
 *
 * Pure functions plus a tiny controller with an injected clock. The canvas component feeds it
 * once per frame and applies what it returns; nothing here touches the DOM.
 */

import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_LERP_FPS,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  FIT_CENTER_EASE_MS,
  FIT_MIN_ROOMS,
  FIT_PADDING_CSS_PX,
  LOUNGE_FURNITURE_TYPE,
  SHEET_FIT_EDGE_CUT,
  SHEET_MIN_ZOOM,
  TILE_SIZE,
  WALL_FACE_TILES,
  ZOOM_LEVELS,
  ZOOM_MIN,
} from '../constants.js';

/** Inclusive tile bounds. */
export interface TileBox {
  col0: number;
  row0: number;
  col1: number;
  row1: number;
}

export interface MapSize {
  cols: number;
  rows: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface FitResult {
  zoom: number;
  /** Centre of the framed area, in world px. */
  center: Point;
  /** The framed tiles (whole map without a target). Absent on a result that only tracks the view. */
  box?: TileBox;
}

/** A room's key in the room map for agents (and floor) outside every Area. */
export const LOBBY_ROOM = '';

export interface RoomLayout {
  cols: number;
  rows: number;
  /** Per tile, parallel to the floor: 0 is wall, 255 is void; everything else is floor. */
  tiles: ReadonlyArray<number>;
  /** Per tile Area label; null = none. */
  areaTiles?: ReadonlyArray<string | null>;
  furniture: ReadonlyArray<{ type: string; col: number; row: number }>;
}

export interface Rooms {
  /** Tile box of every room: the bbox of an Area's tiles, and the lobby (floor outside every Area). */
  boxes: Map<string, TileBox>;
  /** Label of the Area holding the coffee table, or null when no Area does. */
  lounge: string | null;
}

function growBox(box: TileBox | undefined, col: number, row: number): TileBox {
  if (!box) return { col0: col, row0: row, col1: col, row1: row };
  return {
    col0: Math.min(box.col0, col),
    row0: Math.min(box.row0, row),
    col1: Math.max(box.col1, col),
    row1: Math.max(box.row1, row),
  };
}

/**
 * The rooms of a layout: one box per Area (the bounding box of its tiles) plus the lobby, the
 * floor that belongs to no Area. A layout without Areas is one lobby, i.e. the whole floor.
 */
export function roomsOf(layout: RoomLayout): Rooms {
  const boxes = new Map<string, TileBox>();
  const WALL = 0;
  const VOID = 255;
  for (let i = 0; i < layout.tiles.length; i++) {
    const t = layout.tiles[i];
    if (t === WALL || t === VOID) continue;
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const key = layout.areaTiles?.[i] ?? LOBBY_ROOM;
    boxes.set(key, growBox(boxes.get(key), col, row));
  }
  let lounge: string | null = null;
  const table = layout.furniture.find((f) => f.type === LOUNGE_FURNITURE_TYPE);
  if (table) {
    const label = layout.areaTiles?.[table.row * layout.cols + table.col] ?? null;
    if (label && boxes.has(label)) lounge = label;
  }
  return { boxes, lounge };
}

/** Squared distance between the centres of two boxes. */
function boxGap(a: TileBox, b: TileBox): number {
  const dx = (a.col0 + a.col1) / 2 - (b.col0 + b.col1) / 2;
  const dy = (a.row0 + a.row1) / 2 - (b.row0 + b.row1) / 2;
  return dx * dx + dy * dy;
}

function unionBox(boxes: Iterable<TileBox>): TileBox | null {
  let u: TileBox | null = null;
  for (const b of boxes) {
    u = u
      ? {
          col0: Math.min(u.col0, b.col0),
          row0: Math.min(u.row0, b.row0),
          col1: Math.max(u.col1, b.col1),
          row1: Math.max(u.row1, b.row1),
        }
      : { ...b };
  }
  return u;
}

/** One agent as the fit sees it. */
export interface FitAgent {
  /** active and waiting agents hold the frame; idle ones (coffee walkers, nappers) never do. */
  working: boolean;
  /** Room of its seat (or of the tile it stands on without one); LOBBY_ROOM outside every Area. */
  room: string;
  /** Room of the tile it stands on right now: how the lounge notices someone walked in. */
  tileRoom: string;
}

/**
 * What the camera frames: the union of the room boxes where somebody is working, plus the lounge
 * when anyone at all is in it, widened to at least FIT_MIN_ROOMS rooms (the closest rooms join).
 * Null when nobody is working, and when the map has fewer rooms than that minimum: both frame the
 * whole map. Never a sprite box, so walking agents cannot make the frame twitch.
 */
export function fitTarget(rooms: Rooms, agents: Iterable<FitAgent>): TileBox | null {
  const chosen = new Set<string>();
  let anyone = false;
  let inLounge = false;
  for (const a of agents) {
    anyone = true;
    if (a.working && rooms.boxes.has(a.room)) chosen.add(a.room);
    if (rooms.lounge !== null && a.tileRoom === rooms.lounge) inLounge = true;
  }
  if (!anyone || chosen.size === 0) return null;
  if (inLounge && rooms.lounge !== null) chosen.add(rooms.lounge);
  if (rooms.boxes.size < FIT_MIN_ROOMS) return null;

  while (chosen.size < FIT_MIN_ROOMS) {
    const frame = unionBox([...chosen].map((k) => rooms.boxes.get(k)!))!;
    let best: string | null = null;
    let bestGap = Infinity;
    for (const [key, box] of rooms.boxes) {
      if (chosen.has(key)) continue;
      const gap = boxGap(frame, box);
      if (gap < bestGap) {
        best = key;
        bestGap = gap;
      }
    }
    if (best === null) break;
    chosen.add(best);
  }
  return unionBox([...chosen].map((k) => rooms.boxes.get(k)!));
}

function boxCenter(box: TileBox): Point {
  return {
    x: ((box.col0 + box.col1 + 1) / 2) * TILE_SIZE,
    y: ((box.row0 + box.row1 + 1) / 2) * TILE_SIZE,
  };
}

/** Largest zoom of ZOOM_LEVELS at or below `zoom`; ZOOM_MIN when none is. */
export function snapZoom(zoom: number): number {
  let best = ZOOM_MIN;
  for (const level of ZOOM_LEVELS) if (level <= zoom) best = level;
  return best;
}

/** The next zoom level in `dir` (+1 in, -1 out), staying put at either end. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const i = ZOOM_LEVELS.indexOf(snapZoom(zoom));
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + dir))];
}

/** Largest zoom level at which `tilesW` x `tilesH` tiles fit the canvas (device px). */
function zoomToFit(tilesW: number, tilesH: number, devW: number, devH: number): number {
  return snapZoom(Math.min(devW / (tilesW * TILE_SIZE), devH / (tilesH * TILE_SIZE)));
}

/** The framing padding in device px: a fixed CSS length, so it does not grow with the zoom level. */
function paddingDevPx(dpr: number): number {
  return FIT_PADDING_CSS_PX * dpr;
}

/** Zoom at which the whole map fits the canvas: the reference the plates scale against. */
export function fitZoomWholeMap(
  map: MapSize,
  canvas: { width: number; height: number },
  dpr: number,
): number {
  return zoomToFit(map.cols, map.rows, canvas.width * dpr, canvas.height * dpr);
}

/**
 * Zoom and centre that frame the target box, or the whole map when there is no target, with
 * FIT_PADDING_CSS_PX of canvas left free on every side. The zoom is the largest zoom level at
 * which the frame fits, so the frame fills the shorter viewport axis; the longer one is left to
 * the pan clamp's centring. `canvas` is in CSS px.
 */
export function fitView(
  target: TileBox | null,
  map: MapSize,
  canvas: { width: number; height: number },
  dpr: number,
): FitResult {
  const devW = canvas.width * dpr;
  const devH = canvas.height * dpr;
  const pad = paddingDevPx(dpr);
  // A room's box is its floor; its top wall (windows, signs, shelves) sits WALL_FACE_TILES above it
  // and belongs in the frame, or the fit cuts the windows in half.
  const box = target
    ? { ...target, row0: Math.max(0, target.row0 - WALL_FACE_TILES) }
    : { col0: 0, row0: 0, col1: map.cols - 1, row1: map.rows - 1 };
  const zoom = zoomToFit(
    box.col1 - box.col0 + 1,
    box.row1 - box.row0 + 1,
    devW - 2 * pad,
    devH - 2 * pad,
  );
  return { zoom, center: boxCenter(box), box };
}

/**
 * Whether a map of `mapW` x `mapH` device px fits a view of `viewW` x `viewH`: its height whole,
 * its width cut by at most SHEET_FIT_EDGE_CUT of itself per side.
 */
export function mapFitsView(mapW: number, mapH: number, viewW: number, viewH: number): boolean {
  return mapH <= viewH && mapW - viewW <= 2 * SHEET_FIT_EDGE_CUT * mapW;
}

/**
 * The zoom with the inspector sheet open: the largest level at which the whole map fits the view
 * the sheet leaves (padding kept, the edge cut allowed), but never under `floor`. `fits` is false
 * when the floor wins and the map overflows that view.
 */
export function sheetFit(
  map: MapSize,
  canvas: { width: number; height: number },
  dpr: number,
  floor: number,
): { zoom: number; fits: boolean } {
  const pad = paddingDevPx(dpr);
  const fitsAt = (zoom: number): boolean =>
    mapFitsView(
      map.cols * TILE_SIZE * zoom,
      map.rows * TILE_SIZE * zoom,
      canvas.width * dpr - 2 * pad,
      canvas.height * dpr - 2 * pad,
    );
  let best = ZOOM_MIN;
  for (const level of ZOOM_LEVELS) if (fitsAt(level)) best = level;
  const zoom = Math.max(best, floor);
  return { zoom, fits: fitsAt(zoom) };
}

/**
 * What to do when the fit target changed. Null when the new box (with padding) is already inside
 * the current view. Otherwise the view moves to the box, and the zoom only ever goes OUT: it never
 * zooms back in by itself, so an agent starting work cannot make the room jump closer. The Fit
 * button is how the user asks for the tightest frame.
 */
export function refitView(
  current: FitResult,
  target: TileBox | null,
  map: MapSize,
  canvas: { width: number; height: number },
  dpr: number,
): FitResult | null {
  if (!target) return null;
  const box = target;
  const pad = paddingDevPx(dpr) / current.zoom;
  const halfW = (canvas.width * dpr) / current.zoom / 2 - pad;
  const halfH = (canvas.height * dpr) / current.zoom / 2 - pad;
  const inside =
    box.col0 * TILE_SIZE >= current.center.x - halfW &&
    (box.col1 + 1) * TILE_SIZE <= current.center.x + halfW &&
    box.row0 * TILE_SIZE >= current.center.y - halfH &&
    (box.row1 + 1) * TILE_SIZE <= current.center.y + halfH;
  if (inside) return null;
  const next = fitView(target, map, canvas, dpr);
  return { zoom: Math.min(current.zoom, next.zoom), center: next.center };
}

// ── Pan and zoom rules ──────────────────────────────────────────

/**
 * Where the map's near edge may sit on one axis, device px. A map smaller than the view is
 * centred; a bigger one is clamped so no void shows on either side: the offset stays in
 * [view - map, 0].
 */
function clampOffset(view: number, mapPx: number, offset: number): number {
  if (mapPx <= view) return Math.floor((view - mapPx) / 2);
  return Math.max(view - mapPx, Math.min(0, offset));
}

/** Offset of the map's top-left corner for a pan, the renderer's formula (see `mapOffset`). */
function offsetOfPan(view: number, mapPx: number, pan: number): number {
  return Math.floor((view - mapPx) / 2) + Math.round(pan);
}

/** Pan whose offset is `offset` (the inverse of offsetOfPan). */
function panOfOffset(view: number, mapPx: number, offset: number): number {
  return offset - Math.floor((view - mapPx) / 2);
}

/**
 * `pan` moved onto the nearest legal one for this zoom: centred per axis when the map is small,
 * void-free when it is big. `insetRight` (device px) is the canvas's right edge an overlay covers
 * (the inspector sheet below 1600 px): the map is centred in, and clamped to, the rest.
 */
export function clampPan(
  pan: Point,
  canvas: { width: number; height: number },
  map: MapSize,
  zoom: number,
  insetRight = 0,
): Point {
  const mapW = map.cols * TILE_SIZE * zoom;
  const mapH = map.rows * TILE_SIZE * zoom;
  return {
    // The offset is the renderer's (full canvas); only the room it may use is narrower.
    x: panOfOffset(
      canvas.width,
      mapW,
      clampOffset(canvas.width - insetRight, mapW, offsetOfPan(canvas.width, mapW, pan.x)),
    ),
    y: panOfOffset(
      canvas.height,
      mapH,
      clampOffset(canvas.height, mapH, offsetOfPan(canvas.height, mapH, pan.y)),
    ),
  };
}

/**
 * The offset a zoom change leaves the map at, so the world point under `anchor` (canvas device px:
 * the viewport centre for buttons, the cursor for the wheel) stays under it.
 */
function zoomAbout(anchor: Point, offset: Point, fromZoom: number, toZoom: number): Point {
  const k = toZoom / fromZoom;
  return { x: anchor.x - (anchor.x - offset.x) * k, y: anchor.y - (anchor.y - offset.y) * k };
}

/** The pan after a zoom change about `anchor`, clamped for the new zoom (see clampPan for `insetRight`). */
export function panAfterZoom(
  anchor: Point,
  pan: Point,
  fromZoom: number,
  toZoom: number,
  canvas: { width: number; height: number },
  map: MapSize,
  insetRight = 0,
): Point {
  const oldW = map.cols * TILE_SIZE * fromZoom;
  const oldH = map.rows * TILE_SIZE * fromZoom;
  const offset = zoomAbout(
    anchor,
    { x: offsetOfPan(canvas.width, oldW, pan.x), y: offsetOfPan(canvas.height, oldH, pan.y) },
    fromZoom,
    toZoom,
  );
  const newW = map.cols * TILE_SIZE * toZoom;
  const newH = map.rows * TILE_SIZE * toZoom;
  return clampPan(
    {
      x: panOfOffset(canvas.width, newW, offset.x),
      y: panOfOffset(canvas.height, newH, offset.y),
    },
    canvas,
    map,
    toZoom,
    insetRight,
  );
}

/** Pan (device px, as the renderer's `panRef` holds it) that puts `center` in the middle of the canvas. */
export function panForCenter(center: Point, map: MapSize, zoom: number): Point {
  return {
    x: ((map.cols * TILE_SIZE) / 2) * zoom - center.x * zoom,
    y: ((map.rows * TILE_SIZE) / 2) * zoom - center.y * zoom,
  };
}

/**
 * Pan (device px) that puts the world point `at` under `screen` (CSS px from the canvas's top left),
 * for a canvas of `canvas` device px at `zoom` (device px per world px). The scenes use it to seat a
 * room inside the part of the stage a crop keeps.
 */
export function panForPoint(
  at: Point,
  screen: Point,
  canvas: { width: number; height: number },
  dpr: number,
  map: MapSize,
  zoom: number,
): Point {
  return panForCenter(
    {
      x: at.x - (screen.x * dpr - canvas.width / 2) / zoom,
      y: at.y - (screen.y * dpr - canvas.height / 2) / zoom,
    },
    map,
    zoom,
  );
}

/** World px centre of a room (an Area's tile box), or null when the layout has no such Area (case ignored). */
export function areaCenter(rooms: Rooms, label: string): Point | null {
  for (const [key, box] of rooms.boxes) {
    if (key !== LOBBY_ROOM && key.toLowerCase() === label.toLowerCase()) {
      return {
        x: ((box.col0 + box.col1 + 1) / 2) * TILE_SIZE,
        y: ((box.row0 + box.row1 + 1) / 2) * TILE_SIZE,
      };
    }
  }
  return null;
}

/** Centre currently framed by a pan; the inverse of panForCenter. */
export function centerForPan(pan: Point, map: MapSize, zoom: number): Point {
  return {
    x: (map.cols * TILE_SIZE) / 2 - pan.x / zoom,
    y: (map.rows * TILE_SIZE) / 2 - pan.y / zoom,
  };
}

/** Ease-in-out between two centres; `t` is elapsed / duration, clamped. */
export function easeCenter(from: Point, to: Point, t: number): Point {
  const k = Math.max(0, Math.min(1, t));
  const e = k * k * (3 - 2 * k);
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
}

/**
 * One step of the camera follow, `dt` seconds long. The pan closes CAMERA_FOLLOW_LERP of the gap to
 * `target` per frame at CAMERA_FOLLOW_LERP_FPS, the same per second at any frame rate, and lands on
 * the legal goal once within CAMERA_FOLLOW_SNAP_THRESHOLD of it on both axes: a bare lerp never
 * arrives, and an unsettled follow keeps the render loop drawing at full rate. The goal is the legal
 * pan, since a target past the map edge is one the clamp never lets the pan reach.
 */
export function followPan(
  pan: Point,
  target: Point,
  dt: number,
  legal: (p: Point) => Point,
): { pan: Point; settled: boolean } {
  const goal = legal(target);
  if (
    Math.abs(goal.x - pan.x) < CAMERA_FOLLOW_SNAP_THRESHOLD &&
    Math.abs(goal.y - pan.y) < CAMERA_FOLLOW_SNAP_THRESHOLD
  ) {
    return { pan: goal, settled: true };
  }
  const alpha = 1 - Math.pow(1 - CAMERA_FOLLOW_LERP, dt * CAMERA_FOLLOW_LERP_FPS);
  return {
    pan: legal({ x: pan.x + (target.x - pan.x) * alpha, y: pan.y + (target.y - pan.y) * alpha }),
    settled: false,
  };
}

export interface AutoFitInput {
  /** What the fit frames: the working rooms (see `fitTarget`); null frames the whole map. */
  target: TileBox | null;
  map: MapSize;
  canvas: { width: number; height: number };
  dpr: number;
  zoom: number;
  pan: Point;
  nowMs: number;
  /** The layout editor is open: the view is the user's. */
  editing: boolean;
  /** Camera follow or the greeter is steering the pan. */
  followed: boolean;
}

export interface AutoFitCommand {
  zoom?: number;
  /** Pan for the canvas, valid at `panZoom`; the host applies it once its zoom matches. */
  pan?: Point;
  panZoom?: number;
  /** Set while a re-centre is still easing: the host keeps drawing every frame until it lands. */
  easing?: true;
  /** The sheet's fit could not fit the map: the host follows the selected agent instead. */
  followSelected?: true;
}

/**
 * Auto-fit state. On at start; any manual zoom or pan, an open editor or a followed agent turns
 * it off, and `enable` (the Fit button) turns it on and frames the working rooms right away.
 */
export class AutoFit {
  private readonly onChange?: (enabled: boolean) => void;

  constructor(onChange?: (enabled: boolean) => void) {
    this.onChange = onChange;
  }

  private on = true;
  private started = false;
  private lastKey = '';
  /** The view size the last fit was for: a stage that changes size (the rail or the sheet
   *  taking width, a resized window) is framed again from scratch, as the Fit button does. */
  private lastSize = '';
  private anim: { from: Point; to: Point; startMs: number } | null = null;
  private zoom = 0;
  private insetCss = 0;
  private sheetOpen = false;
  /** The zoom the sheet's fit never goes under; null until the first step after opening reads it. */
  private sheetFloor: number | null = null;

  get enabled(): boolean {
    return this.on;
  }

  /** CSS px of the stage's right edge an overlay covers; the view is the rest. */
  get viewInsetCss(): number {
    return this.insetCss;
  }

  /**
   * The inspector sheet is open, covering `insetPx` CSS px of the stage's right edge (an overlay,
   * below 1600 px; 0 when it sits beside the stage). While it is open the fit frames the whole
   * map in the view it leaves (see `sheetFit`), never under the zoom the office had when it
   * opened nor under SHEET_MIN_ZOOM; when that overflows, the host follows the selected agent. A
   * change frames again from scratch, as a resize does.
   */
  setSheet(open: boolean, insetPx: number): void {
    if (open && !this.sheetOpen) this.sheetFloor = null;
    this.sheetOpen = open;
    this.insetCss = open ? Math.max(0, insetPx) : 0;
  }

  /** The user took the camera. */
  disable(): void {
    this.anim = null;
    if (this.on) {
      this.on = false;
      this.onChange?.(false);
    }
  }

  /** Fit button: frame the working rooms again and keep following changes. */
  enable(): void {
    this.started = false;
    this.anim = null;
    if (!this.on) {
      this.on = true;
      this.onChange?.(true);
    }
  }

  step(input: AutoFitInput): AutoFitCommand {
    if (input.editing || input.followed) this.disable();
    const inset = Math.min(this.insetCss, input.canvas.width);
    if (!this.on || input.canvas.width - inset <= 0 || input.canvas.height <= 0) return {};
    const { map, canvas, dpr } = input;
    // Beside or under the sheet the office is framed whole in what the sheet leaves.
    const target = this.sheetOpen ? null : input.target;
    const view = { width: canvas.width - inset, height: canvas.height };
    const key = target ? JSON.stringify(target) : '';
    const size = `${canvas.width}x${canvas.height}@${dpr}-${this.sheetOpen ? inset : 'closed'}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.started = false;
    }
    // A centre is the uncovered view's: the pan for the full canvas's centre, shifted left by half
    // the inset. Pans leave here already legal for the zoom they are valid at, so the canvas
    // applies them as given.
    const shift = (inset * dpr) / 2;
    const legal = (center: Point, zoom: number): Point => {
      const pan = panForCenter(center, map, zoom);
      return clampPan(
        { x: pan.x - shift, y: pan.y },
        { width: canvas.width * dpr, height: canvas.height * dpr },
        map,
        zoom,
        inset * dpr,
      );
    };

    if (!this.started && this.sheetOpen) {
      this.started = true;
      this.lastKey = key;
      // The zoom the office had when the sheet opened, read before this fit changes it.
      this.sheetFloor ??= Math.max(SHEET_MIN_ZOOM, input.zoom);
      const fit = sheetFit(map, view, dpr, this.sheetFloor);
      this.zoom = fit.zoom;
      this.anim = null;
      const center = { x: (map.cols * TILE_SIZE) / 2, y: (map.rows * TILE_SIZE) / 2 };
      return {
        zoom: fit.zoom,
        pan: legal(center, fit.zoom),
        panZoom: fit.zoom,
        ...(fit.fits ? {} : { followSelected: true as const }),
      };
    }

    if (!this.started) {
      this.started = true;
      this.lastKey = key;
      const fit = fitView(target, map, view, dpr);
      this.zoom = fit.zoom;
      this.anim = null;
      return { zoom: fit.zoom, pan: legal(fit.center, fit.zoom), panZoom: fit.zoom };
    }

    if (this.zoom === 0) this.zoom = input.zoom;
    const cmd: AutoFitCommand = {};

    if (key !== this.lastKey) {
      this.lastKey = key;
      const current: FitResult = {
        zoom: this.zoom,
        center: centerForPan({ x: input.pan.x + shift, y: input.pan.y }, map, this.zoom),
      };
      const next = refitView(current, target, map, view, dpr);
      if (next) {
        if (next.zoom !== this.zoom) {
          this.zoom = next.zoom;
          cmd.zoom = next.zoom;
        }
        this.anim = { from: current.center, to: next.center, startMs: input.nowMs };
      }
    }

    if (this.anim) {
      const t = (input.nowMs - this.anim.startMs) / FIT_CENTER_EASE_MS;
      cmd.pan = legal(easeCenter(this.anim.from, this.anim.to, t), this.zoom);
      cmd.panZoom = this.zoom;
      if (t >= 1) this.anim = null;
      else cmd.easing = true;
    }
    return cmd;
  }
}
