import { FX_BANNER_FONT_PX, FX_TEXT_FONT_PX } from '../../constants.js';
import { sceneFxMultiplier } from '../nameplate.js';
import { xpPopLabel } from '../toolUtils.js';
import type { ActiveFx } from './fxEngine.js';

/** Rough width of one glyph of the pixel font, as a share of its size. */
const GLYPH_WIDTH_EM = 0.7;

/** The box an FX text takes in the overlay stack, in CSS px at the plate scale. */
export function fxTextBox(e: ActiveFx, scale: number): { w: number; h: number } {
  const font = (e.kind === 'pop' ? FX_TEXT_FONT_PX : FX_BANNER_FONT_PX) * sceneFxMultiplier();
  const chars = (e.kind === 'pop' ? xpPopLabel(e) : `Level ${e.level}!`).length;
  return { w: chars * font * GLYPH_WIDTH_EM * scale, h: font * scale };
}
