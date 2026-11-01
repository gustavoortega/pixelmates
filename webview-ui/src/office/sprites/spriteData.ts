import { emptyArtSprite, spriteAtArtDensity } from '../../../../core/src/assets/artDensity.js';
import { CHAR_FRAME_H, CHAR_FRAME_W } from '../../../../core/src/assets/constants.js';
import type { ColorValue } from '../../components/ui/types.js';
import { HELPER_LOOK, PALETTE_COUNT } from '../../constants.js';
import { getHueLockedSprite } from '../colorize.js';
import type { Direction, SpriteData } from '../types.js';
import { Direction as Dir } from '../types.js';
import bubbleAskData from './bubble-ask.json';
import bubbleDoneData from './bubble-done.json';
import bubblePermissionData from './bubble-permission.json';
import bubblePetData from './bubble-pet.json';
import bubbleWaitingData from './bubble-waiting.json';
import screenAskData from './screen-ask.json';
import screenDoneData from './screen-done.json';

// ── Speech Bubble Sprites ───────────────────────────────────────

interface BubbleSpriteJson {
  /** Art px per world px; absent = legacy 1x. */
  density?: number;
  palette: Record<string, string>;
  pixels: string[][];
}

function resolveBubbleSprite(data: BubbleSpriteJson): SpriteData {
  const sprite = data.pixels.map((row) => row.map((key) => data.palette[key] ?? key));
  return spriteAtArtDensity(sprite, data.density, 'bubble sprite');
}

/** Permission bubble: white square with "..." in amber, and a tail pointer (11x13 world px) */
export const BUBBLE_PERMISSION_SPRITE: SpriteData = resolveBubbleSprite(bubblePermissionData);

/** Waiting bubble: white square with green checkmark, and a tail pointer (11x13 world px) */
export const BUBBLE_WAITING_SPRITE: SpriteData = resolveBubbleSprite(bubbleWaitingData);

/** Heart bubble: pet petting feedback (11x13 world px) */
export const BUBBLE_HEART_SPRITE: SpriteData = resolveBubbleSprite(bubblePetData);

/** Side bubbles beside a head: gold "?" for a question, sage check for a finished turn (14x14
 *  world px, 2x art, tail on the left at mid height). */
export const BUBBLE_ASK_SPRITE: SpriteData = resolveBubbleSprite(bubbleAskData);
export const BUBBLE_DONE_SPRITE: SpriteData = resolveBubbleSprite(bubbleDoneData);

/** The same two glyphs filling a monitor screen (8x6 world px = MONITOR_SCREEN_RECT). */
export const SCREEN_ASK_SPRITE: SpriteData = resolveBubbleSprite(screenAskData);
export const SCREEN_DONE_SPRITE: SpriteData = resolveBubbleSprite(screenDoneData);

// ════════════════════════════════════════════════════════════════
// Loaded character sprites (from PNG assets)
// ════════════════════════════════════════════════════════════════

interface LoadedCharacterData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
}

let loadedCharacters: LoadedCharacterData[] | null = null;

/** Set pre-colored character sprites loaded from PNG assets. Call this when characterSpritesLoaded message arrives. */
export function setCharacterTemplates(data: LoadedCharacterData[]): void {
  loadedCharacters = data;
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
}

/** Return the number of loaded character palettes, or PALETTE_COUNT as fallback. */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : PALETTE_COUNT;
}

/** Flip a SpriteData horizontally (for generating left sprites from right) */
function flipSpriteHorizontal(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse());
}

// ════════════════════════════════════════════════════════════════
// Sprite resolution + caching
// ════════════════════════════════════════════════════════════════

type IdleFrames = [SpriteData, SpriteData, SpriteData, SpriteData, SpriteData, SpriteData];

export interface CharacterSprites {
  walk: Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>;
  typing: Record<Direction, [SpriteData, SpriteData]>;
  reading: Record<Direction, [SpriteData, SpriteData]>;
  /** Front-view idle poses (sheet row 3, `down` frames 7..12): sit-idle, head-down (nap),
   *  page-turn A, page-turn B, head-down breathing in, sip. A sheet without the row falls back to
   *  the typing frames; one without the last two poses repeats the nap and the sit. */
  idle: IdleFrames;
}

const spriteCache = new Map<string, CharacterSprites>();

/** Run a per-sprite transform over every frame of a CharacterSprites set. */
function mapCharacterSprites(
  sprites: CharacterSprites,
  shift: (s: SpriteData) => SpriteData,
): CharacterSprites {
  const shiftWalk = (
    arr: [SpriteData, SpriteData, SpriteData, SpriteData],
  ): [SpriteData, SpriteData, SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
    shift(arr[2]),
    shift(arr[3]),
  ];
  const shiftPair = (arr: [SpriteData, SpriteData]): [SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
  ];
  return {
    walk: {
      [Dir.DOWN]: shiftWalk(sprites.walk[Dir.DOWN]),
      [Dir.UP]: shiftWalk(sprites.walk[Dir.UP]),
      [Dir.RIGHT]: shiftWalk(sprites.walk[Dir.RIGHT]),
      [Dir.LEFT]: shiftWalk(sprites.walk[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>,
    typing: {
      [Dir.DOWN]: shiftPair(sprites.typing[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.typing[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.typing[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.typing[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
    reading: {
      [Dir.DOWN]: shiftPair(sprites.reading[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.reading[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.reading[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.reading[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
    idle: sprites.idle.map(shift) as unknown as IdleFrames,
  };
}

/** Adjust every pixel except the HUE_LOCKED ones: the face stays the parent's, only hair and
 *  outfit change. */
function adjustSpritesKeepingSkin(sprites: CharacterSprites, color: ColorValue): CharacterSprites {
  return mapCharacterSprites(sprites, (s) => getHueLockedSprite(s, color));
}

/** Apply hue shift to every sprite in a CharacterSprites set. Skin pixels keep their color:
 *  only hair and outfit change, so a repeated palette never turns green-skinned. */
export function hueShiftSprites(sprites: CharacterSprites, hueShift: number): CharacterSprites {
  return adjustSpritesKeepingSkin(sprites, { h: hueShift, s: 0, b: 0, c: 0 });
}

/** The helper look: the parent's sheet with hair and outfit washed out to gray. */
export function helperSprites(sprites: CharacterSprites): CharacterSprites {
  return adjustSpritesKeepingSkin(sprites, HELPER_LOOK);
}

/**
 * Sprites of a palette; `helper` gives the sub-agent look (the same sheet washed to gray, cached
 * under its own key so the parent's sprites are never touched).
 */
export function getCharacterSprites(
  paletteIndex: number,
  hueShift = 0,
  helper = false,
): CharacterSprites {
  const cacheKey = helper ? `${paletteIndex}:${hueShift}:helper` : `${paletteIndex}:${hueShift}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  let sprites: CharacterSprites;

  if (loadedCharacters) {
    // Use pre-colored character sprites directly (no palette swapping)
    const char = loadedCharacters[paletteIndex % loadedCharacters.length];
    const d = char.down;
    const u = char.up;
    const rt = char.right;
    const flip = flipSpriteHorizontal;

    sprites = {
      walk: {
        [Dir.DOWN]: [d[0], d[1], d[2], d[1]],
        [Dir.UP]: [u[0], u[1], u[2], u[1]],
        [Dir.RIGHT]: [rt[0], rt[1], rt[2], rt[1]],
        [Dir.LEFT]: [flip(rt[0]), flip(rt[1]), flip(rt[2]), flip(rt[1])],
      },
      typing: {
        [Dir.DOWN]: [d[3], d[4]],
        [Dir.UP]: [u[3], u[4]],
        [Dir.RIGHT]: [rt[3], rt[4]],
        [Dir.LEFT]: [flip(rt[3]), flip(rt[4])],
      },
      reading: {
        [Dir.DOWN]: [d[5], d[6]],
        [Dir.UP]: [u[5], u[6]],
        [Dir.RIGHT]: [rt[5], rt[6]],
        [Dir.LEFT]: [flip(rt[5]), flip(rt[6])],
      },
      idle: [
        d[7] ?? d[3],
        d[8] ?? d[3],
        d[9] ?? d[5],
        d[10] ?? d[6],
        d[11] ?? d[8] ?? d[3],
        d[12] ?? d[7] ?? d[3],
      ],
    };
  } else {
    // Fallback: transparent placeholders of one frame's size
    const e = emptyArtSprite(CHAR_FRAME_W, CHAR_FRAME_H);
    const walkSet: [SpriteData, SpriteData, SpriteData, SpriteData] = [e, e, e, e];
    const pairSet: [SpriteData, SpriteData] = [e, e];
    sprites = {
      walk: {
        [Dir.DOWN]: walkSet,
        [Dir.UP]: walkSet,
        [Dir.RIGHT]: walkSet,
        [Dir.LEFT]: walkSet,
      },
      typing: {
        [Dir.DOWN]: pairSet,
        [Dir.UP]: pairSet,
        [Dir.RIGHT]: pairSet,
        [Dir.LEFT]: pairSet,
      },
      reading: {
        [Dir.DOWN]: pairSet,
        [Dir.UP]: pairSet,
        [Dir.RIGHT]: pairSet,
        [Dir.LEFT]: pairSet,
      },
      idle: [e, e, e, e, e, e],
    };
  }

  // Apply hue shift if non-zero
  if (hueShift !== 0) {
    sprites = hueShiftSprites(sprites, hueShift);
  }
  if (helper) sprites = helperSprites(sprites);

  spriteCache.set(cacheKey, sprites);
  return sprites;
}
