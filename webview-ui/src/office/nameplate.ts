/**
 * Nameplate geometry: which side of the character it sits on and how big the box is, so the
 * collision layout reserves the plate the DOM will actually draw. Pure; no DOM.
 */

import { ART_DENSITY } from '../../../core/src/assets/constants.js';
import {
  CHARACTER_SPRITE_HEIGHT_PX,
  MEDAL_COMPACT_PX,
  MEDAL_FULL_PX,
  MONITOR_TYPE_LARGE_MIN_CSS_ZOOM,
  NAMEPLATE_BG,
  NAMEPLATE_BORDER_COLOR,
  NAMEPLATE_BORDER_PX,
  NAMEPLATE_COMPACT_BG,
  NAMEPLATE_COMPACT_FONT_PX,
  NAMEPLATE_COMPACT_LINE_PX,
  NAMEPLATE_HEAD_GAP_PX,
  NAMEPLATE_PAD_Y_PX,
  NAMEPLATE_PILL_GAP_PX,
  NAMEPLATE_PILL_HEIGHT_PX,
  NAMEPLATE_SHADOW_PX,
  NAMEPLATE_SLOT_CLEARANCE_PX,
  NAMEPLATE_TEXT_COLOR,
  PIXEL_FONT_GLYPH_EM,
  PIXEL_FONT_NARROW_EM,
  PIXEL_FONT_WIDE_EM,
  PLATE_COMPACT_MAX_LEVEL,
  PLATE_FULL_LINE1_PX,
  PLATE_FULL_LINE2_PX,
  PLATE_FULL_MAX_WIDTH_PX,
  PLATE_FULL_MIN_TEXT_PX,
  PLATE_FULL_MIN_WIDTH_PX,
  PLATE_FULL_NAME_FONT_PX,
  PLATE_FULL_PITCH_TILES,
  PLATE_FULL_REF_CSS_ZOOM,
  PLATE_FULL_STATE_FONT_PX,
  PLATE_FULL_SUB_FONT_PX,
  PLATE_HELPER_FONT_PX,
  PLATE_HELPER_LINE_PX,
  PLATE_ITEM_GAP_PX,
  PLATE_PAD_X_PX,
  PLATE_QUIET_BG,
  PLATE_QUIET_BORDER,
  PLATE_SCALE_FIT_FLOOR,
  PLATE_SCALE_MAX,
  PLATE_SCALE_MIN,
  PLATE_SELECTED_BG,
  PLATE_SELECTED_STATE,
  PLATE_SELECTED_TEXT,
  PLATE_STATE_COLOR,
  PLATE_STUB_EM,
  TAG_BORDER_PX,
  TAG_LARGE,
  TAG_PAD_Y_PX,
  TAG_QUIET_TEXT,
  TAG_SHADOW_PX,
  TAG_SMALL,
  TILE_SIZE,
} from '../constants.js';
import { ANCHORS } from './flair/accessories.js';
import { alertText, stateText, tagStateText } from './plateState.js';
import type { NameplateContent, PlatePart } from './toolUtils.js';
import type { Direction } from './types.js';
import { Direction as Dir } from './types.js';

export type PlateSide = 'above' | 'below';

/**
 * Scale of the plates: the zoom relative to the zoom at which the whole map fits, so a plate keeps
 * the same share of the screen however big the map is. Clamped: past the bounds a plate is either
 * unreadable or a billboard.
 */
export function plateScale(zoom: number, fitZoomWholeMap: number): number {
  // The staged README scene frames one room as the whole map, which would pin the ratio at 1; it
  // shows its plates (and the FX text riding them) at full size instead.
  if (fullPlates) return PLATE_SCALE_MAX;
  return Math.max(
    PLATE_SCALE_MIN,
    Math.min(PLATE_SCALE_MAX, zoom / Math.max(PLATE_SCALE_FIT_FLOOR, fitZoomWholeMap)),
  );
}

/**
 * Plates are one-line compact (no line 2) up to zoom level 3; from 4x the full two-line plate
 * shows. Beside the monitor's full attention rail they keep both lines at every zoom.
 */
export function plateIsCompact(zoom: number): boolean {
  return !fullPlates && !monitorFullPlates && zoom / ART_DENSITY <= PLATE_COMPACT_MAX_LEVEL;
}

/** Scale of full plates beside the rail: the map's CSS px per world px against the reference,
 *  never so small that line-1 text drops under PLATE_FULL_MIN_TEXT_PX, capped like plateScale. */
export function monitorPlateScale(zoom: number, dpr: number): number {
  const floor = Math.max(
    PLATE_SCALE_MIN,
    PLATE_FULL_MIN_TEXT_PX /
      Math.min(PLATE_FULL_STATE_FONT_PX, PLATE_FULL_NAME_FONT_PX, PLATE_HELPER_FONT_PX),
  );
  return Math.max(floor, Math.min(PLATE_SCALE_MAX, zoom / dpr / PLATE_FULL_REF_CSS_ZOOM));
}

/** Widest a full plate may be, CSS px: about two desk pitches (neighbours alternate rows), clamped. */
export function fullPlateMaxWidth(zoom: number, dpr: number): number {
  const pitch = (PLATE_FULL_PITCH_TILES * TILE_SIZE * zoom) / dpr;
  return Math.max(PLATE_FULL_MIN_WIDTH_PX, Math.min(PLATE_FULL_MAX_WIDTH_PX, 2 * pitch - 16));
}

let fullPlates = false;
let monitorFullPlates = false;
let sceneTextScale = 1;
let sceneTwoLine = false;

/** Dev-only (the README hero scene, `&text=1.25`): grows line 2 of the full plate so it stays legible once the scene is scaled down. */
export function setSceneTextScale(mul: number): void {
  sceneTextScale = mul;
}

/** Dev-only (`&text=1.25`): the staged scene's plates are two lines, `LvN Name` over the state. */
export function setSceneTwoLinePlates(on: boolean): void {
  sceneTwoLine = on;
}

export function isSceneTwoLinePlates(): boolean {
  return fullPlates && sceneTwoLine;
}

/** The scene's text multiplier: 1 everywhere but the staged scene. */
export function sceneTextMultiplier(): number {
  return fullPlates ? sceneTextScale : 1;
}

/** Font and line height of a full plate's line 2, CSS px at scale 1. The scene's two-line plate sets
 *  line 2 tight under line 1 (the task subtitle's blank row is gone). */
export function plateLine2Metrics(): { font: number; line: number } {
  const k = sceneTextMultiplier();
  const font = PLATE_FULL_SUB_FONT_PX * k;
  return { font, line: isSceneTwoLinePlates() ? Math.ceil(font) : PLATE_FULL_LINE2_PX * k };
}

/** The scene's pop and banner multiplier: pops stay at the 36 px floor, not the plate text's size. */
export const SCENE_FX_TEXT_SCALE = 1.2;
export function sceneFxMultiplier(): number {
  return isSceneTwoLinePlates() || sceneMonitorText > 1 ? SCENE_FX_TEXT_SCALE : 1;
}

let sceneMonitorText = 1;
let sceneBanner = false;

/**
 * Dev-only (the story GIF, `&text=1.2` in the monitor scene): grows the monitor's office text (tags,
 * helper tags, plaques) so it clears the legibility floor once the capture is cropped, and sets pops
 * and the banner on an ink box like the hero's. The rail's own text is untouched.
 */
export function setSceneMonitorText(mul: number): void {
  sceneMonitorText = mul;
}

/** Dev-only (`&banner=1`): the level-up banner reads `Ada Lv13` instead of `Level 13!`. */
export function setSceneBanner(on: boolean): void {
  sceneBanner = on;
}

export function isSceneBanner(): boolean {
  return sceneBanner;
}

/** Every size of a monitor type set grown by the scene's factor (1: as is), whole px. */
function scaledMonitorType(t: MonitorType): MonitorType {
  if (sceneMonitorText === 1) return t;
  return Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, Math.floor(v * sceneMonitorText)]),
  ) as unknown as MonitorType;
}

/** The scene's plates float this far (CSS px) above where the head slot would put them, clear of a napper's Zz. */
export const SCENE_PLATE_LIFT_PX = 30;

/** Line 1 of the scene's two-line plate: the name's own height, no blank band under it. */
const SCENE_PLATE_LINE1_PX = 24;

/** The monitor layout's rule (monitorLayout `fullPlates`): a full rail beside a stage tall enough
 *  for two-line plates. Unlike the hero scene's switch it leaves the plates' scale alone. */
export function setMonitorFullPlates(on: boolean): void {
  monitorFullPlates = on;
}

/** The monitor layout's full-plates rule as the shell last set it. */
export function isMonitorFullPlates(): boolean {
  return monitorFullPlates;
}

/** Dev-only (the README hero scene): keeps the two-line plate at any zoom, since a 1x display fits the room at a compact zoom. */
export function forceFullPlates(on: boolean): void {
  fullPlates = on;
}

/** World y of the top of the sprite's head: `y` is the tile centre, `sit` the draw offset. */
export function spriteHeadTopY(y: number, sit: number, headBobPx = 0): number {
  return y + sit - CHARACTER_SPRITE_HEIGHT_PX + ANCHORS.down.headTopY + headBobPx;
}

/**
 * World y of the line a plate above the head hangs from: 2 px over the sprite's head, or higher
 * by the slot clearance when a bubble, glyph or beacon is drawn there. `y` is the character's (or
 * its tile's) centre and `sit` how far below it the sprite is drawn.
 */
export function plateAnchorAboveY(
  y: number,
  sit: number,
  slotTaken: boolean,
  headBobPx = 0,
): number {
  const headTop = spriteHeadTopY(y, sit, headBobPx);
  return headTop - NAMEPLATE_HEAD_GAP_PX - (slotTaken ? NAMEPLATE_SLOT_CLEARANCE_PX : 0);
}

/**
 * A character facing the camera (DOWN) keeps its face visible, so the plate goes above the head,
 * in the gap above the pod. One facing away (UP) shows its back, so the plate goes below the feet.
 * Sideways and walking characters take the above slot like DOWN.
 */
export function plateSide(dir: Direction): PlateSide {
  return dir === Dir.UP ? 'below' : 'above';
}

/** Beside the rail a plate is a tag: one line at a fixed size, for agents and helpers alike. */
export function isMonitorTag(compact: boolean): boolean {
  return monitorFullPlates && !fullPlates && !compact;
}

/** The type sizes of the monitor's office text (tags, helper tags, plaques), CSS px. */
export type MonitorType = { readonly [K in keyof typeof TAG_LARGE]: number };

/** The large set where the map is drawn at 3 CSS px per world px or more (1920 beside the rail),
 *  the small one below (1280 at zoom 2), where the large tags would be wider than a desk. */
export function monitorType(cssZoom: number): MonitorType {
  return cssZoom >= MONITOR_TYPE_LARGE_MIN_CSS_ZOOM ? TAG_LARGE : TAG_SMALL;
}

let tagType: MonitorType = TAG_LARGE;

/** The overlay sets the map's CSS zoom (zoom / dpr) before it measures any tag. */
export function setMonitorTagZoom(cssZoom: number): void {
  tagType = scaledMonitorType(monitorType(cssZoom));
}

/** The monitor type set the overlay last chose. */
export function currentMonitorType(): MonitorType {
  return tagType;
}

/** The sizes a plate is drawn with: compact, a monitor tag, a helper's one line, or the full plate. */
export function plateMetrics(c: Pick<NameplateContent, 'helper'>, compact: boolean) {
  const box = {
    border: NAMEPLATE_BORDER_PX,
    padY: NAMEPLATE_PAD_Y_PX,
    shadow: NAMEPLATE_SHADOW_PX,
  };
  if (compact)
    return {
      ...box,
      line1: NAMEPLATE_COMPACT_LINE_PX,
      nameFont: NAMEPLATE_COMPACT_FONT_PX,
      stateFont: NAMEPLATE_COMPACT_FONT_PX,
      medal: MEDAL_COMPACT_PX,
    };
  if (isMonitorTag(compact))
    return {
      border: TAG_BORDER_PX,
      padY: TAG_PAD_Y_PX,
      shadow: TAG_SHADOW_PX,
      line1: tagType.line,
      nameFont: tagType.name,
      stateFont: tagType.state,
      medal: tagType.medal,
    };
  if (c.helper)
    return {
      ...box,
      line1: PLATE_HELPER_LINE_PX,
      nameFont: PLATE_HELPER_FONT_PX,
      stateFont: PLATE_HELPER_FONT_PX,
      medal: MEDAL_COMPACT_PX,
    };
  return {
    ...box,
    line1: isSceneTwoLinePlates() ? SCENE_PLATE_LINE1_PX : PLATE_FULL_LINE1_PX,
    nameFont: PLATE_FULL_NAME_FONT_PX,
    stateFont: PLATE_FULL_STATE_FONT_PX,
    medal: MEDAL_FULL_PX,
  };
}

/** A plate shows line 2 only in its full form: never compact, never as a monitor tag. */
function hasLine2(c: NameplateContent, compact: boolean): boolean {
  return !!c.sub && !compact && !isMonitorTag(compact);
}

/** Height of the plate itself in CSS px, with its border and hard shadow. 0 when it has no lines.
 *  A compact plate and a monitor tag never show line 2. */
export function plateBoxHeight(c: NameplateContent, compact = false): number {
  const m = plateMetrics(c, compact);
  const line1 = c.name || c.state ? m.line1 : 0;
  const lines = line1 + (hasLine2(c, compact) ? plateLine2Metrics().line : 0);
  return lines > 0 ? lines + 2 * m.padY + 2 * m.border + m.shadow : 0;
}

/** Width of `text` in FS Pixel Sans at `fontPx`, CSS px. An estimate on the safe side: no DOM. */
export function pixelTextWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) {
    if (ch === '\u2068' || ch === '\u2069') continue;
    em += /[il.,:;'|!\u00B7 ]/.test(ch)
      ? PIXEL_FONT_NARROW_EM
      : /[mwMW\u21BB]/.test(ch)
        ? PIXEL_FONT_WIDE_EM
        : PIXEL_FONT_GLYPH_EM;
  }
  return Math.ceil(em * fontPx);
}

/** The state words a plate prints: a monitor tag's are whole words of a few characters or none. */
export function plateStateWords(c: Pick<NameplateContent, 'state'>, compact: boolean, now: number) {
  if (!c.state) return null;
  return isMonitorTag(compact) ? tagStateText(c.state, now) : stateText(c.state, now);
}

/** Widths of a plate's line-1 pieces at scale 1, CSS px. */
function line1Pieces(c: NameplateContent, compact: boolean, now: number) {
  const m = plateMetrics(c, compact);
  const alert = c.state?.kind === 'alert' ? c.state.alert : null;
  const words = plateStateWords(c, compact, now);
  const cmd = c.state?.kind === 'cmd';
  return {
    m,
    tab: alert ? pixelTextWidth(alertText(alert, now), m.stateFont) + 2 * PLATE_PAD_X_PX : 0,
    medal: c.medal ? m.medal : 0,
    name: c.name ? pixelTextWidth(c.name, m.nameFont) : 0,
    loop: c.loop ? pixelTextWidth('\u21BB', m.nameFont) : 0,
    // `· › words` and the command's cursor block.
    state: words
      ? pixelTextWidth(`\u00B7 ${cmd ? '\u203A ' : ''}${words}`, m.stateFont) +
        (cmd ? Math.ceil(0.6 * m.stateFont) : 0) +
        (c.state?.kind === 'done' ? 2 * 7 + 4 : 0)
      : 0,
  };
}

/** Sum of widths with the item gap between the non-empty ones. */
function row(widths: readonly number[]): number {
  const present = widths.filter((w) => w > 0);
  return present.reduce((a, b) => a + b, 0) + Math.max(0, present.length - 1) * PLATE_ITEM_GAP_PX;
}

/** A cut text keeps at least this much, so it still reads as a word and not a stray letter. */
function stub(fontPx: number): number {
  return Math.ceil(PLATE_STUB_EM * fontPx);
}

/** Width of the plate in CSS px at scale 1 (before the max-width cap), for the collision pass.
 *  `essential`: only what must stay whole (an agent's tab, medal and name; a helper's state
 *  beside a stub of its label). */
export function plateBoxWidth(
  c: NameplateContent,
  compact: boolean,
  now: number,
  essential = false,
): number {
  const p = line1Pieces(c, compact, now);
  const line1 = essential
    ? c.helper
      ? row([Math.min(p.name, stub(p.m.nameFont)), p.state])
      : row([p.tab, p.medal, p.name, p.loop])
    : row([p.tab, p.medal, p.name, p.loop, p.state]);
  const line2 =
    c.sub && hasLine2(c, compact) && !essential
      ? pixelTextWidth(c.sub.map((part) => part.text).join(' \u00B7 '), plateLine2Metrics().font)
      : 0;
  return Math.max(line1, line2) + 2 * PLATE_PAD_X_PX + 2 * p.m.border;
}

/** What a plate of a given width shows: its state words whole, cut, or not at all, and the
 *  parts of line 2 that fit (the branch cut to a stub before a later part is dropped). A monitor
 *  tag never cuts: its state is whole or gone. */
export interface PlateFit {
  state: 'full' | 'cut' | 'none';
  sub: readonly PlatePart[] | null;
}

/** Fit a plate's words into `width` CSS px at scale 1, so nothing ends in a stray letter. */
export function plateFit(
  c: NameplateContent,
  compact: boolean,
  now: number,
  width: number,
): PlateFit {
  const p = line1Pieces(c, compact, now);
  const room = width - 2 * PLATE_PAD_X_PX - 2 * p.m.border;
  let state: PlateFit['state'] = 'full';
  if (p.state > 0) {
    if (c.helper) {
      // A helper's verb is short and says what it does: its label gives way first.
      if (room - p.state - PLATE_ITEM_GAP_PX < Math.min(p.name, stub(p.m.nameFont))) state = 'none';
    } else {
      const base = row([p.tab, p.medal, p.name, p.loop]);
      const left = room - base - PLATE_ITEM_GAP_PX;
      const cutOk = !isMonitorTag(compact) && left >= stub(p.m.stateFont);
      state = left >= p.state ? 'full' : cutOk ? 'cut' : 'none';
    }
  }
  let sub: PlatePart[] | null = null;
  if (c.sub && hasLine2(c, compact)) {
    const font = plateLine2Metrics().font;
    const sep = pixelTextWidth(' \u00B7 ', font);
    const widths = c.sub.map((part, i) => pixelTextWidth(part.text, font) + (i > 0 ? sep : 0));
    // Only a leading session part (the branch) can be cut; the age and the counts are whole or gone.
    const first = c.sub[0].pv ? Math.min(widths[0], stub(font)) : widths[0];
    let used = first;
    sub = [c.sub[0]];
    for (let i = 1; i < c.sub.length; i++) {
      if (used + widths[i] > room) break;
      used += widths[i];
      sub.push(c.sub[i]);
    }
    if (first > room) sub = null;
  }
  return { state, sub };
}

/** Height of the tripwire chip in CSS px, 0 when there is no alarm. */
export function chipBoxHeight(c: NameplateContent): number {
  return c.pill ? NAMEPLATE_PILL_HEIGHT_PX : 0;
}

/** Height of the plate box in CSS px: the plate, plus the tripwire chip beside it and the gap
 *  between them. 0 when there is nothing to draw. */
export function nameplateHeight(c: NameplateContent): number {
  const plate = plateBoxHeight(c);
  const chip = chipBoxHeight(c);
  return plate + (plate > 0 && chip > 0 ? NAMEPLATE_PILL_GAP_PX : 0) + chip;
}

export interface NameplateStyle {
  bg: string;
  text: string;
  /** State words after the name. */
  state: string;
  /** Border and hard shadow: the same for every agent. */
  border: string;
  /** An idle plate: no shadow. */
  quiet: boolean;
  /** The selected plate is paper, every other one ink (the privacy mask differs). */
  paper: boolean;
}

/** Plate colors: the selected agent's plate is paper (the inspector holds its details), an idle
 *  one goes quiet, a compact one is a little see-through. A quiet monitor tag (`tag`) keeps the
 *  ink, opaque, and sets its words in TAG_QUIET_TEXT. The tier shows on the medal. */
export function nameplateStyle(
  look: { compact?: boolean; quiet?: boolean; selected?: boolean; tag?: boolean } = {},
): NameplateStyle {
  if (look.selected)
    return {
      bg: PLATE_SELECTED_BG,
      text: PLATE_SELECTED_TEXT,
      state: PLATE_SELECTED_STATE,
      border: NAMEPLATE_BORDER_COLOR,
      quiet: false,
      paper: true,
    };
  if (look.quiet && look.tag)
    return {
      bg: NAMEPLATE_BG,
      text: TAG_QUIET_TEXT,
      state: TAG_QUIET_TEXT,
      border: NAMEPLATE_BORDER_COLOR,
      quiet: true,
      paper: false,
    };
  return {
    bg: look.quiet ? PLATE_QUIET_BG : look.compact ? NAMEPLATE_COMPACT_BG : NAMEPLATE_BG,
    text: NAMEPLATE_TEXT_COLOR,
    state: PLATE_STATE_COLOR,
    border: look.quiet ? PLATE_QUIET_BORDER : NAMEPLATE_BORDER_COLOR,
    quiet: !!look.quiet,
    paper: false,
  };
}
