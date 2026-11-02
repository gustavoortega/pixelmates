import { spriteWorldHeight } from '../../../../core/src/assets/artDensity.js';
import { ART_DENSITY } from '../../../../core/src/assets/constants.js';
import type { ColorValue } from '../../components/ui/types.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  DESK_SEAT_COVER_PX,
  SOFA_FRONT_COVER_PX,
} from '../../constants.js';
import { getColorizedSprite } from '../colorize.js';
import type {
  FurnitureInstance,
  OfficeLayout,
  PlacedFurniture,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from '../types.js';
import { DEFAULT_COLS, DEFAULT_ROWS, Direction, TILE_SIZE, TileType } from '../types.js';
import { getCatalogEntry, getOrientationInGroup } from './furnitureCatalog.js';

/** A pixel at least this opaque counts as solid when reading a desk's top edge off its art. */
const OPAQUE_ALPHA = 128;

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = [];
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c]);
    }
    map.push(row);
  }
  return map;
}

/** A couch: a chair with more than one seat. Its seats are lounge seats, and it is drawn in two z layers. */
function isCouch(entry: { category?: string; footprintW: number; footprintH: number }): boolean {
  return entry.category === 'chairs' && entry.footprintW * entry.footprintH >= 2;
}

/** Rows [y0, y1) of a sprite as a sprite of their own. Memoized: the sprite cache keys on identity. */
const sliceMemo = new WeakMap<SpriteData, Map<string, SpriteData>>();
function sliceRows(sprite: SpriteData, y0: number, y1: number): SpriteData {
  let byRange = sliceMemo.get(sprite);
  if (!byRange) {
    byRange = new Map();
    sliceMemo.set(sprite, byRange);
  }
  const key = `${y0}:${y1}`;
  let slice = byRange.get(key);
  if (!slice) {
    slice = sprite.slice(y0, y1);
    byRange.set(key, slice);
  }
  return slice;
}

/**
 * A couch as z layers, one pair per footprint row: the back part sorts at the row's bottom edge,
 * behind whoever sits on it, and the front part just after it, in front of the sitter's lower body.
 * The cut is where the sofa front must start so it hides SOFA_FRONT_COVER_PX of a seated sprite.
 * A back-view couch is all front: its back is toward the camera and covers the sitter whole.
 * Pure geometry: nothing is remembered about who sits there, so standing up changes nothing.
 */
function couchInstances(
  sprite: SpriteData,
  x: number,
  y: number,
  row: number,
  footprintH: number,
  orientation: string | undefined,
  mirrored: boolean,
): FurnitureInstance[] {
  const out: FurnitureInstance[] = [];
  const cut = Math.round(TILE_SIZE / 2 + CHARACTER_SITTING_OFFSET_PX - SOFA_FRONT_COVER_PX);
  const mirror = mirrored ? { mirrored: true as const } : {};
  for (let r = 0; r < footprintH; r++) {
    const rowZ = (row + r + 1) * TILE_SIZE;
    const top = r * TILE_SIZE;
    const parts: Array<[number, number, number]> =
      orientation === 'back'
        ? [[top, top + TILE_SIZE, rowZ + 1]]
        : [
            [top, top + cut, rowZ],
            [top + cut, top + TILE_SIZE, rowZ + 1],
          ];
    for (const [y0, y1, zY] of parts) {
      // The cut is in world px; the sprite is art px.
      const part = sliceRows(sprite, y0 * ART_DENSITY, y1 * ART_DENSITY);
      if (part.length === 0) continue;
      out.push({ sprite: part, x, y: y + y0, zY, ...mirror });
    }
  }
  return out;
}

/** How one placed item is drawn this frame, without touching the saved layout. */
export interface FurnitureLook {
  /** Swap the sprite (a dark screen, say); the result must be the same size. */
  sprite?: (sprite: SpriteData) => SpriteData;
  /** World px to push the drawing down; the sort depth stays where the item stands. */
  dy?: number;
  /** Fill the PC's screen with this glyph (an agent waiting on the user sits at it). */
  screenGlyph?: 'ask' | 'done' | 'seen';
}

/** Convert placed furniture into renderable FurnitureInstance[]. `looks` is keyed by item uid. */
export function layoutToFurnitureInstances(
  furniture: PlacedFurniture[],
  looks?: ReadonlyMap<string, FurnitureLook>,
): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = getDeskTiles(furniture);

  const instances: FurnitureInstance[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = spriteWorldHeight(entry.sprite);
    let zY = y + spriteH;

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it).
        // Use the bottom footprint row so it sorts after the character
        // even when the chair has background tiles that push seats down.
        zY = (item.row + entry.footprintH) * TILE_SIZE + 1;
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5;
        }
      }
    }

    // Colorize sprite if this furniture has a color override
    let sprite = entry.sprite;
    if (item.color) {
      sprite = getColorizedSprite(entry.sprite, item.color);
    }
    const look = looks?.get(item.uid);
    if (look?.sprite) sprite = look.sprite(sprite);
    const drawY = y + (look?.dy ?? 0);

    // Determine if this instance should be mirrored (side asset used in "left" orientation)
    let mirrored = false;
    if (entry.mirrorSide) {
      const orientInGroup = getOrientationInGroup(item.type);
      if (orientInGroup === 'left') {
        mirrored = true;
      }
    }

    if (isCouch(entry)) {
      instances.push(
        ...couchInstances(
          sprite,
          x,
          y,
          item.row,
          entry.footprintH,
          entry.orientation,
          mirrored,
        ).map((inst) => ({ ...inst, type: item.type })),
      );
      continue;
    }
    instances.push({
      sprite,
      type: item.type,
      x,
      y: drawY,
      zY,
      ...(mirrored ? { mirrored: true } : {}),
      ...(look?.screenGlyph ? { screenGlyph: look.screenGlyph } : {}),
    });
  }
  return instances;
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        if (excludeTiles && excludeTiles.has(key)) continue;
        tiles.add(key);
      }
    }
  }
  return tiles;
}

/**
 * Every tile a piece of furniture occupies, background rows included. Unlike
 * `getBlockedTiles` this is not about walking: a character may walk through a
 * shelf's background row, but a companion should not stand inside the shelf.
 */
export function getFurnitureTiles(furniture: PlacedFurniture[]): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

/** Every desk tile, mapped to the sort depth (bottom edge) of the desk covering it. */
export function getDeskTiles(furniture: PlacedFurniture[]): Map<string, number> {
  const tiles = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    const zY = item.row * TILE_SIZE + spriteWorldHeight(entry.sprite);
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        tiles.set(key, Math.max(tiles.get(key) ?? 0, zY));
      }
    }
  }
  return tiles;
}

/** Every desk tile, mapped to its desk's footprint in world px: the desk a seat faces, whole. */
export function getDeskRects(
  furniture: PlacedFurniture[],
): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    const rect = {
      x: item.col * TILE_SIZE,
      y: item.row * TILE_SIZE,
      w: entry.footprintW * TILE_SIZE,
      h: entry.footprintH * TILE_SIZE,
    };
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++)
        out.set(`${item.col + dc},${item.row + dr}`, rect);
    }
  }
  return out;
}

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item */
export function getPlacementBlockedTiles(
  furniture: PlacedFurniture[],
  excludeUid?: string,
): Set<string> {
  const tiles = new Set<string>();
  for (const item of furniture) {
    if (item.uid === excludeUid) continue;
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const bgRows = entry.backgroundTiles || 0;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue; // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }
  return tiles;
}

/** Map chair orientation to character facing direction */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front':
      return Direction.DOWN;
    case 'back':
      return Direction.UP;
    case 'left':
      return Direction.LEFT;
    case 'right':
    case 'side':
      return Direction.RIGHT;
    default:
      return Direction.DOWN;
  }
}

/** Alpha of a sprite pixel (`''` is clear; `#RRGGBBAA` carries one). */
function pixelAlpha(px: string): number {
  if (px === '') return 0;
  return px.length === 9 ? parseInt(px.slice(7, 9), 16) : 255;
}

/**
 * Extra px a face-on seat sinks so the desk in front of it hides DESK_SEAT_COVER_PX of the seated
 * sprite: the desk is the one that covers (it sorts in front), the sink just makes the cover real.
 * Read off the desk's own art, row by row, so a redrawn desk needs no number changed.
 * 0 when the seat does not face down or has no desk on its own tile or the one below.
 */
function deskSeatSink(
  furniture: PlacedFurniture[],
  seatCol: number,
  seatRow: number,
  facing: Direction,
): number {
  if (facing !== Direction.DOWN) return 0;
  for (const dr of [0, 1]) {
    const col = seatCol;
    const row = seatRow + dr;
    for (const item of furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || !entry.isDesk) continue;
      if (
        col < item.col ||
        col >= item.col + entry.footprintW ||
        row < item.row ||
        row >= item.row + entry.footprintH
      ) {
        continue;
      }
      // First art row with an opaque pixel in the seat's column, read at art resolution and
      // brought back to world px.
      const x0 = (col - item.col) * TILE_SIZE * ART_DENSITY;
      const x1 = x0 + TILE_SIZE * ART_DENSITY;
      let top = -1;
      for (let y = 0; y < entry.sprite.length && top < 0; y++) {
        for (let x = x0; x < x1; x++) {
          if (pixelAlpha(entry.sprite[y]?.[x] ?? '') >= OPAQUE_ALPHA) {
            top = y;
            break;
          }
        }
      }
      if (top < 0) continue;
      const deskTopY = item.row * TILE_SIZE + top / ART_DENSITY;
      const seatY = seatRow * TILE_SIZE + TILE_SIZE / 2;
      return Math.max(
        0,
        Math.round(deskTopY + DESK_SEAT_COVER_PX - seatY - CHARACTER_SITTING_OFFSET_PX),
      );
    }
  }
  return 0;
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>();

  // Build set of all desk tiles
  const deskTiles = new Set<string>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`);
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP }, // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN }, // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT }, // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT }, // desk is right of chair → face RIGHT
  ];

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || entry.category !== 'chairs') continue;

    let seatCount = 0;
    const bgRows = entry.backgroundTiles ?? 0;
    for (let dr = bgRows; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc;
        const tileRow = item.row + dr;

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN;
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation);
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing;
              break;
            }
          }
        }

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`;
        const couch = isCouch(entry);
        const sink = couch ? 0 : deskSeatSink(furniture, tileCol, tileRow, facingDir);
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
          ...(couch ? { couch: true } : {}),
          ...(sink > 0 ? { sink } : {}),
        });
        seatCount++;
      }
    }
  }

  return seats;
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles)
 * @internal */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>();
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`);
  }
  return tiles;
}

/** Default floor colors for the two rooms */
const DEFAULT_LEFT_ROOM_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 }; // warm beige
const DEFAULT_RIGHT_ROOM_COLOR: ColorValue = { h: 25, s: 45, b: 5, c: 10 }; // warm brown

/** Create a minimal fallback layout (used only when no default-layout.json exists) */
export function createDefaultLayout(): OfficeLayout {
  const W = TileType.WALL;
  const F1 = TileType.FLOOR_1;
  const F2 = TileType.FLOOR_2;

  const tiles: TileTypeVal[] = [];
  const tileColors: Array<ColorValue | null> = [];

  for (let r = 0; r < DEFAULT_ROWS; r++) {
    for (let c = 0; c < DEFAULT_COLS; c++) {
      if (r === 0 || r === DEFAULT_ROWS - 1 || c === 0 || c === DEFAULT_COLS - 1) {
        tiles.push(W);
        tileColors.push(null);
      } else if (c < 10) {
        tiles.push(F1);
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
      } else {
        tiles.push(F2);
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
      }
    }
  }

  // Minimal fallback with no furniture — the default-layout.json provides the real default
  return { version: 1, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, tiles, tileColors, furniture: [] };
}

/** Serialize layout to JSON string
 * @internal */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout);
}

// ── Furniture type migration ────────────────────────────────────

/** Map old hardcoded FurnitureType values to new manifest-based IDs */
const LEGACY_TYPE_MAP: Record<string, string | null> = {
  desk: 'DESK_FRONT',
  chair: 'WOODEN_CHAIR_FRONT',
  bookshelf: 'BOOKSHELF',
  plant: 'PLANT',
  cooler: null, // no equivalent in new assets — remove
  whiteboard: 'WHITEBOARD',
  pc: 'PC_FRONT_OFF',
  lamp: null, // no equivalent in new assets — remove
};

/** Migrate old furniture type strings to new manifest IDs */
function migrateFurnitureTypes(furniture: PlacedFurniture[]): PlacedFurniture[] {
  const migrated: PlacedFurniture[] = [];
  for (const item of furniture) {
    const newType = LEGACY_TYPE_MAP[item.type];
    if (newType === undefined) {
      // Not a legacy type — keep as-is
      migrated.push(item);
    } else if (newType !== null) {
      // Migrate to new type
      migrated.push({ ...item, type: newType });
    }
    // newType === null → remove the item (no equivalent)
  }
  return migrated;
}

/** Deserialize layout from JSON string, migrating old tile types if needed
 * @internal */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json);
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return migrateLayout(obj as OfficeLayout);
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

/**
 * Ensure layout has tileColors. If missing, generate defaults based on tile types.
 * Exported for use by message handlers that receive layouts over the wire.
 */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout);
}

/**
 * Migrate old layouts that use legacy tile types (TILE_FLOOR=1, WOOD_FLOOR=2, CARPET=3, DOORWAY=4)
 * to the new pattern-based system. Also migrates old furniture type strings and old VOID value.
 */
function migrateLayout(layout: OfficeLayout): OfficeLayout {
  // Migrate furniture types
  layout = { ...layout, furniture: migrateFurnitureTypes(layout.furniture) };

  // Migrate old VOID value (was 8, now 255) — only for legacy layouts since FLOOR_8 reuses value 8
  const OLD_VOID = 8;
  if (!layout.layoutRevision && layout.tiles.includes(OLD_VOID as TileTypeVal)) {
    layout = {
      ...layout,
      tiles: layout.tiles.map((t) => (t === OLD_VOID ? (TileType.VOID as TileTypeVal) : t)),
    };
  }

  // Default pets to empty array if absent (backward-compat for legacy layouts).
  if (!layout.pets) {
    layout = { ...layout, pets: [] };
  }

  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout; // Already migrated tile colors
  }

  // Check if any tiles use old values (1-4) — these map directly to FLOOR_1-4
  // but need color assignments
  const tileColors: Array<ColorValue | null> = [];
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0: // WALL
        tileColors.push(null);
        break;
      case 1: // was TILE_FLOOR → FLOOR_1 beige
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR);
        break;
      case 2: // was WOOD_FLOOR → FLOOR_2 brown
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR);
        break;
      case 3: // was CARPET → FLOOR_3 purple
        tileColors.push({ h: 280, s: 40, b: -5, c: 0 });
        break;
      case 4: // was DOORWAY → FLOOR_4 tan
        tileColors.push({ h: 35, s: 25, b: 10, c: 0 });
        break;
      default:
        // Floor tile types without colors — use neutral gray
        tileColors.push(tile > 0 && tile !== TileType.VOID ? { h: 0, s: 0, b: 0, c: 0 } : null);
    }
  }

  return { ...layout, tileColors };
}
