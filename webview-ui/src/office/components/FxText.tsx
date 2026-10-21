import {
  FX_BANNER_FONT_PX,
  FX_LEVEL_UP_MS,
  FX_POP_MS,
  FX_POP_RISE_PX,
  FX_TEXT_COLOR,
  FX_TEXT_FONT_PX,
  FX_TEXT_OUTLINE,
  FX_TEXT_OUTLINE_PX,
  NAMEPLATE_BG,
  NAMEPLATE_BORDER_COLOR,
  NAMEPLATE_BORDER_PX,
} from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import type { Rect } from '../labelLayout.js';
import { isSceneBanner, sceneFxMultiplier, spriteHeadTopY } from '../nameplate.js';
import { seatedDrawOffsetPx } from '../seatDraw.js';
import { levelBannerLabel, xpPopLabel } from '../toolUtils.js';

const FX_TEXT_Z_INDEX = 41;
/** The staged scene's pop rises this far at most, so it tops out over the plate and not on the wall. */
const SCENE_POP_RISE_PX = 40;
const OUTLINE = [
  `${FX_TEXT_OUTLINE_PX}px ${FX_TEXT_OUTLINE_PX}px 0 ${FX_TEXT_OUTLINE}`,
  `-${FX_TEXT_OUTLINE_PX}px ${FX_TEXT_OUTLINE_PX}px 0 ${FX_TEXT_OUTLINE}`,
  `${FX_TEXT_OUTLINE_PX}px -${FX_TEXT_OUTLINE_PX}px 0 ${FX_TEXT_OUTLINE}`,
  `-${FX_TEXT_OUTLINE_PX}px -${FX_TEXT_OUTLINE_PX}px 0 ${FX_TEXT_OUTLINE}`,
].join(', ');

/**
 * "+60 commit" and "Level N!" as DOM text in the plate layer: they take the plates' scale, not the
 * canvas zoom. Positions and fades are computed from the effect's age on every overlay tick.
 */
export function FxText({
  officeState,
  scale,
  toScreenX,
  toScreenY,
  slots,
}: {
  officeState: OfficeState;
  /** The plate layer's scale: FX text grows and shrinks with the nameplates. */
  scale: number;
  toScreenX: (worldX: number) => number;
  toScreenY: (worldY: number) => number;
  /** Screen box each agent's FX text takes in its overlay stack (above the plate). Without one the
   *  text stands on the head top. */
  slots?: ReadonlyMap<number, Rect>;
}) {
  const now = officeState.fx.now;
  return (
    <>
      {officeState.fx.active.map((e) => {
        const ch = officeState.characters.get(e.agentId);
        if (!ch) return null;
        const age = now - e.startedAt;
        const slot = slots?.get(e.agentId);
        const x = slot ? slot.x + slot.w / 2 : toScreenX(ch.x);
        // The text's bottom edge: the slot's, or the head top when the agent has no stack.
        const headY = slot
          ? slot.y + slot.h
          : toScreenY(spriteHeadTopY(ch.y, seatedDrawOffsetPx(ch)));
        if (e.kind === 'pop') {
          const t = Math.min(1, age / FX_POP_MS);
          // The staged scene sets the label on an ink box like the plates: gold on the cream wall
          // and the window is too faint for a 880 px GIF.
          const staged = sceneFxMultiplier() > 1;
          const rise = staged ? Math.min(FX_POP_RISE_PX, SCENE_POP_RISE_PX) : FX_POP_RISE_PX;
          return (
            <div
              key={`pop-${e.agentId}-${e.startedAt}`}
              className="absolute whitespace-nowrap leading-none"
              style={{
                left: x,
                top: headY,
                transform: `translate(-50%, calc(-100% - ${t * rise}px)) scale(${scale})`,
                opacity: Math.min(1, (1 - t) * 3),
                fontSize: FX_TEXT_FONT_PX * sceneFxMultiplier(),
                color: FX_TEXT_COLOR,
                textShadow: staged ? undefined : OUTLINE,
                ...(staged
                  ? {
                      background: NAMEPLATE_BG,
                      border: `${NAMEPLATE_BORDER_PX}px solid ${NAMEPLATE_BORDER_COLOR}`,
                      padding: '6px 10px',
                    }
                  : {}),
                pointerEvents: 'none',
                zIndex: FX_TEXT_Z_INDEX,
              }}
              data-testid="fx-xp-pop"
            >
              {xpPopLabel(e)}
            </div>
          );
        }
        const t = Math.min(1, age / FX_LEVEL_UP_MS);
        // Pops in over the first tenth, holds, shrinks away over the last tenth.
        const grow = Math.min(1, t / 0.1, (1 - t) / 0.1);
        // The story scene names who levelled, on the ink box of its pops: the wall and the
        // pillar are too busy under a bare yellow word at GIF size.
        const named = isSceneBanner();
        return (
          <div
            key={`lvl-${e.agentId}-${e.startedAt}`}
            className="absolute whitespace-nowrap leading-none"
            style={{
              left: x,
              top: headY,
              transform: `translate(-50%, -100%) scale(${scale * grow})`,
              fontSize: FX_BANNER_FONT_PX * sceneFxMultiplier(),
              color: FX_TEXT_COLOR,
              textShadow: named ? undefined : OUTLINE,
              ...(named
                ? {
                    background: NAMEPLATE_BG,
                    border: `${NAMEPLATE_BORDER_PX}px solid ${NAMEPLATE_BORDER_COLOR}`,
                    padding: '6px 10px',
                  }
                : {}),
              pointerEvents: 'none',
              zIndex: FX_TEXT_Z_INDEX,
            }}
            data-testid="fx-level-up"
          >
            {levelBannerLabel(
              e.level,
              named ? officeState.rosters.get(e.agentId)?.name : undefined,
            )}
          </div>
        );
      })}
    </>
  );
}
