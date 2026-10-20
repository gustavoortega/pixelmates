import { useState } from 'react';

import { spriteWorldHeight, spriteWorldWidth } from '../../../../core/src/assets/artDensity.js';
import { WORKFLOW_PARENT_TOOL_ID_PREFIX } from '../../../../core/src/constants.js';
import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_HEAD_HEIGHT_PX,
  CHARACTER_HEAD_WIDTH_PX,
  CHARACTER_SPRITE_HEIGHT_PX,
  COMPACT_LABEL_FEET_GAP_PX,
  COMPACT_LABEL_MIN_WIDTH_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  CREW_BANNER_ROW_MIN_SCALE,
  CREW_BANNER_SHADOW_PX,
  CREW_BANNER_WALL_INSET_PX,
  CREW_BANNER_WALL_MIN_SCALE,
  CREW_BANNER_WALL_SCALE_STEP,
  DESK_HIGHLIGHT_GAP_PX,
  DESK_HIGHLIGHT_OUTLINE_PX,
  HELPER_TAG_PAD_X_PX,
  LABEL_LAYOUT_DIM_OPACITY,
  NAMEPLATE_PILL_GAP_PX,
  NAMEPLATE_PILL_HEIGHT_PX,
  OVERLAY_STACK_GAP_PX,
  PLAQUE_BORDER_PX,
  PLAQUE_LINE_GAP_PX,
  PLAQUE_PAD_X_PX,
  PLAQUE_PAD_Y_PX,
  PLAQUE_Z_INDEX,
  PLATE_CMD_COLOR,
  PLATE_DONE_COLOR,
  PLATE_FULL_LAYOUT_LINE_PX,
  PLATE_ITEM_GAP_PX,
  PLATE_PAD_X_PX,
  PLATE_SIDE_GAP_PX,
  PLATE_STUCK_BG,
  PLATE_STUCK_INK,
  PLATE_SUB_COLOR,
  PLATE_WAIT_BG,
  PLATE_WAIT_INK,
  RARITY_SHIMMER_SEC,
  STAGE_CHROME_SELECTORS,
  TAG_PAD_Y_PX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TILE_SIZE,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/subagentMessages.js';
import { useFrame } from '../../hooks/useFrame.js';
import { fitZoomWholeMap } from '../camera.js';
import { officeNow } from '../clock.js';
import {
  type CrewBannerForm,
  crewBannerSize,
  crewBannerView,
  crewRunId,
  placeCrewBanner,
} from '../crewBanner.js';
import { separateFrames } from '../deskHighlight.js';
import type { OfficeState } from '../engine/officeState.js';
import { isShowModelFlairEnabled } from '../engine/renderer.js';
import { characterFlair, Rarity } from '../flair/modelFlair.js';
import { fullBoxRows, fullBoxTopOffsetPx } from '../fullBox.js';
import { fxTextBox } from '../fx/fxTextBox.js';
import { healthLabel } from '../health.js';
import {
  areaSignRect,
  clampPlate,
  fitPlateWidths,
  type LabelItem,
  type LabelPlacement,
  layoutLabels,
  type Rect,
  roomFloorRect,
  type TagObstacle,
  type TagPlacement,
  withTopWallFace,
} from '../labelLayout.js';
import { contextFraction, type MedalSpec } from '../medal.js';
import {
  FACE_WORLD_PX,
  headSlotTaken,
  HELPER_RANK,
  layoutMonitorTags,
  type MonitorTagInput,
  napHeadBobPx,
  type PlacedBanner,
  type PlacedPlaque,
  PLAQUE_TITLE_TRACKING_EM,
  roomPlaques,
  screenRect,
  wallBand,
} from '../monitorTags.js';
import {
  chipBoxHeight,
  currentMonitorType,
  fullPlateMaxWidth,
  isMonitorFullPlates,
  isMonitorTag,
  isSceneTwoLinePlates,
  monitorPlateScale,
  type MonitorType,
  type NameplateStyle,
  nameplateStyle,
  pixelTextWidth,
  plateAnchorAboveY,
  plateBoxHeight,
  plateBoxWidth,
  type PlateFit,
  plateFit,
  plateIsCompact,
  plateLine2Metrics,
  plateMetrics,
  plateScale,
  type PlateSide,
  plateSide,
  plateStateWords,
  SCENE_PLATE_LIFT_PX,
  setMonitorTagZoom,
  spriteHeadTopY,
} from '../nameplate.js';
import { stackAbove, weatherAnchorY } from '../overlayStack.js';
import {
  alertText,
  type PlateFacts,
  plateState,
  sceneTwoLinePlate,
  stateText,
} from '../plateState.js';
import { type OverlayProjection, overlayProjection } from '../projection.js';
import { seatedBubbleOffsetPx, seatedDrawOffsetPx } from '../seatDraw.js';
import { BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import {
  agentLabel,
  agentStatus,
  compactLabelMaxWidth,
  helperPlateInput,
  type NameplateContent,
  type OverlayContent,
  overlayContent,
  showOverlay,
  tripwireColor,
  tripwireLabel,
  type TripwireSeverity,
} from '../toolUtils.js';
import type { Character, ToolActivity } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import { CrewBanner } from './CrewBanner.js';
import { FullBoxRoster } from './FullBoxRoster.js';
import { FxText } from './FxText.js';
import { Medal } from './Medal.js';
import { PixelCheck, PixelWarn } from './PixelIcons.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';
/** Activity texts the overlay words itself (no session text in them): privacy leaves them. */
const FIXED_ACTIVITY_WORDS = new Set([
  'Needs approval',
  WAITING_INPUT_ACTIVITY_TEXT,
  'Idle',
  'Subtask',
]);

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  onAckTripwire: (id: number, count: number) => void;
  /** Room signs are drawn: plates keep clear of them. Hidden signs take no room. */
  showAreas?: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

// Above the compact labels (40) and the character-anchored sub-panels.
const FULL_BOX_Z_INDEX = 43;
const COMPACT_LABEL_Z_INDEX = 40;

/** The plate: line 1 (alert tab, medal, name, loop glyph, state words) and, on a full plate,
 *  line 2 (branch, age, artifacts). Session text carries `pv`, which privacy mode masks. */
function PlateBox({
  plate,
  style,
  compact,
  now,
  fit,
}: {
  plate: NameplateContent;
  style: NameplateStyle;
  compact: boolean;
  now: number;
  /** What the plate's width leaves room for (plateFit). */
  fit: PlateFit;
}) {
  const m = plateMetrics(plate, compact);
  const alert = plate.state?.kind === 'alert' ? plate.state.alert : null;
  const words = plateStateWords(plate, compact, now);
  const kind = plate.state?.kind;
  const stateColor =
    kind === 'done'
      ? PLATE_DONE_COLOR
      : kind === 'cmd' && !style.quiet
        ? PLATE_CMD_COLOR
        : style.state;
  const classes = [
    'nameplate relative flex flex-col max-w-full overflow-hidden',
    plate.rarity === Rarity.LEGENDARY ? 'rarity-shimmer' : '',
    style.quiet ? 'nameplate-quiet' : '',
    alert ? 'plate-alert' : '',
    isMonitorTag(compact) ? 'nameplate-tag' : '',
  ];
  return (
    <div
      className={classes.filter(Boolean).join(' ')}
      style={
        {
          '--plate-bg': style.bg,
          '--plate-text': style.text,
          '--plate-border': style.border,
          // Privacy mode masks `.pv` text; a plate is ink (paper when selected).
          ...(style.paper ? {} : { '--pv-mask': 'var(--mon-mask-on-ink)' }),
          padding: `${m.padY}px 0`,
          ...(plate.rarity === Rarity.LEGENDARY
            ? { '--rarity-shimmer-sec': `${RARITY_SHIMMER_SEC}s` }
            : {}),
        } as React.CSSProperties
      }
      data-plate-state={kind ?? 'none'}
    >
      <span
        className="flex items-center whitespace-nowrap leading-none min-w-0"
        style={{
          height: m.line1,
          gap: PLATE_ITEM_GAP_PX,
          paddingLeft: alert ? 0 : PLATE_PAD_X_PX,
          paddingRight: PLATE_PAD_X_PX,
        }}
      >
        {alert && (
          <span
            className="shrink-0 flex items-center"
            style={{
              height: m.line1 + 2 * m.padY,
              margin: `-${m.padY}px 0`,
              padding: `0 ${PLATE_PAD_X_PX}px`,
              background: alert.tone === 'stuck' ? PLATE_STUCK_BG : PLATE_WAIT_BG,
              color: alert.tone === 'stuck' ? PLATE_STUCK_INK : PLATE_WAIT_INK,
              borderRight: `${m.border}px solid var(--plate-border)`,
              fontSize: m.stateFont,
            }}
            data-testid="plate-alert"
            data-tone={alert.tone}
          >
            {alertText(alert, now)}
          </span>
        )}
        {plate.medal && <Medal spec={plate.medal} px={m.medal} />}
        {plate.name && (
          <span
            className={`overflow-hidden text-ellipsis${plate.namePv ? ' pv' : ''}`}
            style={{ fontSize: m.nameFont, flexShrink: plate.helper ? 1 : 0, minWidth: 0 }}
            data-testid="plate-name"
          >
            {plate.name}
          </span>
        )}
        {plate.loop && (
          <span className="shrink-0" style={{ fontSize: m.nameFont }} data-testid="plate-loop">
            {'\u21BB'}
          </span>
        )}
        {words && fit.state !== 'none' && (
          <span
            className={`flex items-center overflow-hidden${fit.state === 'cut' ? ' min-w-0' : ' shrink-0'}`}
            style={{ fontSize: m.stateFont, color: stateColor, gap: 4 }}
            data-testid="plate-state"
          >
            <span className="shrink-0">{kind === 'cmd' ? '\u00B7 \u203A' : '\u00B7'}</span>
            {kind === 'done' && <PixelCheck px={compact ? 1 : 2} color={PLATE_DONE_COLOR} />}
            <span className={`overflow-hidden text-ellipsis${kind === 'cmd' ? ' pv' : ''}`}>
              {words}
            </span>
            {kind === 'cmd' && <span className="plate-cursor shrink-0" />}
          </span>
        )}
      </span>
      {fit.sub && !compact && (
        <span
          className="flex items-center whitespace-nowrap leading-none overflow-hidden"
          style={{
            height: plateLine2Metrics().line,
            fontSize: plateLine2Metrics().font,
            color: style.quiet ? style.state : PLATE_SUB_COLOR,
            padding: `0 ${PLATE_PAD_X_PX}px`,
          }}
          data-testid="plate-line2"
        >
          {fit.sub.map((part, i) => (
            <span
              key={i}
              // Only the branch (session text, first) is ever cut; the rest are whole or left out.
              className={`flex overflow-hidden${part.pv && i === 0 ? ' min-w-0' : ' shrink-0'}`}
              style={{ whiteSpace: 'pre' }}
            >
              {i > 0 && <span className="shrink-0">{' \u00B7 '}</span>}
              <span className={`overflow-hidden text-ellipsis${part.pv ? ' pv' : ''}`}>
                {part.text}
              </span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function CompactLabel({
  id,
  status,
  plate,
  maxWidth,
  left,
  top,
  side,
  scale,
  compact,
  dx,
  dy,
  dim,
  tripwire,
  onAckTripwire,
  now,
  selected,
}: {
  id: number;
  status: string;
  /** Null renders an empty node: markers and agents with nothing to show keep their overlay element. */
  plate: NameplateContent | null;
  maxWidth: number;
  left: number;
  /** Anchor edge: the plate's top for `below`, its bottom for `above`. */
  top: number;
  side: PlateSide;
  /** Plate scale (see `plateScale`): the box is authored at 1 and scaled about its anchor edge. */
  scale: number;
  /** One-line plate (zoom level <= 3): no title, fixed size, a little see-through. */
  compact: boolean;
  /** Sideways shift that keeps the plate inside its room. */
  dx: number;
  dy: number;
  dim: boolean;
  tripwire: { count: number; severity: TripwireSeverity } | undefined;
  onAckTripwire: (id: number, count: number) => void;
  /** Office clock, epoch ms: the minutes and ages on the plate. */
  now: number;
  /** The inspector shows this agent: its plate turns paper. */
  selected: boolean;
}) {
  const hasPlate = !!plate && (plate.name || plate.state || plate.sub);
  const style = nameplateStyle({
    compact,
    selected,
    quiet: plate?.state?.kind === 'idle',
    tag: isMonitorTag(compact),
  });
  // The chip sits over the plate on an above-head label and under it on a below-feet one.
  const pillMargin = side === 'above' ? 'marginBottom' : 'marginTop';
  return (
    <div
      className="absolute flex flex-col items-center"
      style={{
        left,
        top,
        maxWidth,
        transform: `translate(calc(-50% + ${dx}px), ${side === 'above' ? `calc(-100% + ${dy}px)` : `${dy}px`}) scale(${scale})`,
        transformOrigin: side === 'above' ? 'bottom center' : 'top center',
        transition: 'transform 120ms',
        opacity: dim ? LABEL_LAYOUT_DIM_OPACITY : 1,
        pointerEvents: 'none',
        // Agents' plates over helpers', and a plate with no room of its own under the rest.
        zIndex: COMPACT_LABEL_Z_INDEX - (dim ? 2 : 0) - (plate?.helper ? 1 : 0),
      }}
      data-testid="agent-overlay"
      data-agent-id={id}
      data-status={status}
    >
      {side === 'above' ? (
        <>
          {plate?.pill && (
            <span
              className="overflow-hidden text-ellipsis block whitespace-nowrap leading-none text-2xs cursor-pointer max-w-full"
              // Plates ignore pointer events; the pill opts back in so one click acknowledges it.
              style={{
                height: NAMEPLATE_PILL_HEIGHT_PX,
                [pillMargin]: hasPlate ? NAMEPLATE_PILL_GAP_PX : 0,
                padding: '0 6px',
                lineHeight: `${NAMEPLATE_PILL_HEIGHT_PX - 4}px`,
                background: 'var(--brand-rust)',
                color: 'var(--brand-paper)',
                border: '2px solid var(--brand-ink)',
                pointerEvents: 'auto',
              }}
              title="Click to acknowledge"
              data-testid="tripwire-alarm"
              onClick={(e) => {
                e.stopPropagation();
                if (tripwire) onAckTripwire(id, tripwire.count);
              }}
            >
              <PixelWarn px={2} /> {plate.pill}
            </span>
          )}
          {plate && hasPlate && (
            <PlateBox
              plate={plate}
              style={style}
              compact={compact}
              now={now}
              fit={plateFit(plate, compact, now, maxWidth)}
            />
          )}
        </>
      ) : (
        <>
          {plate && hasPlate && (
            <PlateBox
              plate={plate}
              style={style}
              compact={compact}
              now={now}
              fit={plateFit(plate, compact, now, maxWidth)}
            />
          )}
          {plate?.pill && (
            <span
              className="overflow-hidden text-ellipsis block whitespace-nowrap leading-none text-2xs cursor-pointer max-w-full"
              // Plates ignore pointer events; the pill opts back in so one click acknowledges it.
              style={{
                height: NAMEPLATE_PILL_HEIGHT_PX,
                [pillMargin]: hasPlate ? NAMEPLATE_PILL_GAP_PX : 0,
                padding: '0 6px',
                lineHeight: `${NAMEPLATE_PILL_HEIGHT_PX - 4}px`,
                background: 'var(--brand-rust)',
                color: 'var(--brand-paper)',
                border: '2px solid var(--brand-ink)',
                pointerEvents: 'auto',
              }}
              title="Click to acknowledge"
              data-testid="tripwire-alarm"
              onClick={(e) => {
                e.stopPropagation();
                if (tripwire) onAckTripwire(id, tripwire.count);
              }}
            >
              <PixelWarn px={2} /> {plate.pill}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** An agent's medal: its tier and context. None while neither is known. */
function medalOf(officeState: OfficeState, ch: Character): MedalSpec | null {
  const tier = officeState.models.get(ch.id)?.tier ?? null;
  const fraction = contextFraction(ch.contextTokens, ch.maxContextTokens);
  return tier === null && fraction === null ? null : { tier, fraction };
}

/** The live (latest not done) row of a tool list. */
function liveRow(rows: readonly ToolActivity[] | undefined): ToolActivity | undefined {
  return rows ? [...rows].reverse().find((t) => !t.done) : undefined;
}

/** What the office says about an agent, for the plate's state. */
function plateFacts(
  officeState: OfficeState,
  ch: Character,
  agentTools: Record<number, ToolActivity[]>,
  helpers: readonly SubagentCharacter[],
  subagentTools: Record<number, Record<string, ToolActivity[]>>,
  now: number,
): PlateFacts {
  const id = ch.id;
  const loopNextAt = officeState.loops.get(id)?.nextAt;
  if (ch.isSubagent) {
    const sub = helpers.find((s) => s.id === id);
    const spawn = sub
      ? agentTools[sub.parentAgentId]?.find((t) => t.toolId === sub.parentToolId)
      : undefined;
    const row = sub ? liveRow(subagentTools[sub.parentAgentId]?.[sub.parentToolId]) : undefined;
    return {
      permission: ch.bubbleType === 'permission',
      question: false,
      stuck: false,
      // A sub-agent's task is over once its parent's spawn row is done.
      done: spawn?.done === true,
      active: ch.isActive,
      toolStatus: row?.status ?? null,
      now,
    };
  }
  const tools = agentTools[id];
  // The desk highlight reads the same facts, so the plate and the lit desk always agree.
  const attention = officeState.attentionFacts(ch);
  return {
    permission: attention.permission || !!tools?.some((t) => t.permissionWait && !t.done),
    permissionSince: officeState.permissionSince.get(id),
    question: attention.question,
    statusSince: officeState.statusSince.get(id),
    stuck: attention.stuck,
    stuckSince: officeState.healthSince.get(id) ?? officeState.tripwireSince.get(id),
    done: false,
    active: ch.isActive,
    toolStatus: liveRow(tools)?.status ?? null,
    loopNextAt,
    now,
  };
}

/**
 * One banner per running workflow run with drawn helpers. Beside the rail it hangs on the top wall
 * of the helpers' room when it fits there; otherwise (and always in a compact office) over the
 * helpers, inside their room. While the inspector shows the lead (or one of its helpers, whose
 * sheet is the lead's) the sheet says it all: no banner.
 */
function crewBanners(
  officeState: OfficeState,
  helpers: readonly SubagentCharacter[],
  project: OverlayProjection,
  scale: number,
  now: number,
  opts: {
    /** Beside the rail: try the wall band first. */
    wall: boolean;
    /** The lead whose sheet is open, if any. */
    sheetLeadId: number | null;
    /** Plates at their anchors and every face: a banner never hides one. */
    avoid: readonly Rect[];
    /** What a banner on a wall never covers (the plaques). */
    wallAvoid: readonly Rect[];
  },
): PlacedBanner[] {
  const out: PlacedBanner[] = [];
  const layout = officeState.getLayout();
  const mapRect = screenRect(project, {
    x: 0,
    y: 0,
    w: layout.cols * TILE_SIZE,
    h: layout.rows * TILE_SIZE,
  });
  for (const [leadId, runs] of officeState.workflowRuns) {
    const lead = officeState.characters.get(leadId);
    if (!lead || leadId === opts.sheetLeadId) continue;
    for (const [runId, run] of runs) {
      if (run.status === 'done') continue;
      const drawn = helpers
        .filter(
          (s) =>
            s.parentAgentId === leadId &&
            crewRunId(s.parentToolId, WORKFLOW_PARENT_TOOL_ID_PREFIX) === runId,
        )
        .map((s) => officeState.characters.get(s.id))
        .filter((c): c is Character => c !== undefined);
      if (drawn.length === 0) continue;
      const heads = drawn.map((c) => ({
        x: project.toScreenX(c.x),
        y: project.toScreenY(spriteHeadTopY(c.y, seatedDrawOffsetPx(c))),
      }));
      const leadName =
        officeState.rosters.get(leadId)?.name ||
        agentLabel(officeState.sessionTitles.get(leadId), lead.folderName) ||
        'agent';
      const view = crewBannerView(run, leadName, now);
      const floor = roomFloorRect(
        layout.areaTiles,
        layout.cols,
        layout.rows,
        officeState.roomOf(drawn[0]),
      );
      const bounds = screenRect(project, withTopWallFace(floor));
      // Its helpers' room's top wall, else its lead's (helpers in the lobby have none).
      const leadFloor = roomFloorRect(
        layout.areaTiles,
        layout.cols,
        layout.rows,
        officeState.roomOf(lead),
      );
      const bandWorld = opts.wall ? (wallBand(floor) ?? wallBand(leadFloor)) : null;
      const band = bandWorld ? screenRect(project, bandWorld) : null;
      // On a wall: two rows at the largest scale the band takes, never under the minimum; then one
      // row, shrinking to fit down to its own minimum.
      const wallTries: Array<{ form: CrewBannerForm; scale: number; w: number; h: number }> = [];
      if (band) {
        const forms: Array<[CrewBannerForm, number]> = [
          ['wall', CREW_BANNER_WALL_MIN_SCALE],
          ['row', CREW_BANNER_ROW_MIN_SCALE],
        ];
        for (const [form, min] of forms) {
          const size = crewBannerSize(view, form);
          const fit = Math.min(
            scale,
            (band.h - 2 * CREW_BANNER_WALL_INSET_PX) / (size.h + CREW_BANNER_SHADOW_PX),
            (band.w - 2 * CREW_BANNER_WALL_INSET_PX) / size.w,
          );
          for (let k = fit; k >= min; k -= CREW_BANNER_WALL_SCALE_STEP) {
            wallTries.push({
              form,
              scale: k,
              w: size.w * k,
              h: (size.h + CREW_BANNER_SHADOW_PX) * k,
            });
          }
        }
      }
      const size = crewBannerSize(view);
      const placed = placeCrewBanner({
        wall: band ? { band, sizes: wallTries } : null,
        free: { w: size.w * scale, h: (size.h + CREW_BANNER_SHADOW_PX) * scale },
        heads,
        room: bounds,
        map: mapRect,
        wallAvoid: [...opts.wallAvoid, ...out.map((b) => b.rect)],
        avoid: [...opts.avoid, ...out.map((b) => b.rect)],
      });
      if (placed) {
        out.push({
          leadId,
          runId,
          view,
          rect: placed.rect,
          onWall: placed.onWall,
          scale: placed.onWall ? wallTries[placed.size].scale : scale,
          form: placed.onWall ? wallTries[placed.size].form : 'free',
          band,
        });
      }
    }
  }
  return out;
}

/** A helper's tag beside the rail: one word on paper, no ink box, so the agents' tags lead. */
function helperTagWord(plate: NameplateContent, now: number): string {
  const s = plate.state;
  if (s?.kind === 'alert') return alertText(s.alert, now);
  return (s ? stateText(s, now) : null)?.split(' ')[0] ?? 'helper';
}

function helperTagBox(word: string, type: MonitorType): { w: number; h: number } {
  return {
    w: pixelTextWidth(word, type.helper) + 2 * HELPER_TAG_PAD_X_PX,
    h: type.helperLine + 2 * TAG_PAD_Y_PX,
  };
}

function HelperTag({
  plate,
  rect,
  type,
  now,
}: {
  plate: NameplateContent;
  rect: Rect;
  type: MonitorType;
  now: number;
}) {
  const alert = plate.state?.kind === 'alert' ? plate.state.alert : null;
  return (
    <div
      className="nameplate-tag helper-tag flex items-center justify-center whitespace-nowrap leading-none"
      style={{
        width: rect.w,
        height: rect.h,
        fontSize: type.helper,
        background: alert
          ? alert.tone === 'stuck'
            ? PLATE_STUCK_BG
            : PLATE_WAIT_BG
          : 'var(--brand-paper-2)',
        color: alert
          ? alert.tone === 'stuck'
            ? PLATE_STUCK_INK
            : PLATE_WAIT_INK
          : 'var(--mon-ink-2)',
      }}
      data-form="helper"
      data-plate-state={plate.state?.kind ?? 'none'}
    >
      {/* The word of a command is session text: privacy masks it. */}
      <span className={plate.state?.kind === 'cmd' ? 'pv' : undefined}>
        {helperTagWord(plate, now)}
      </span>
    </div>
  );
}

/** A room's plaque: its title in gold caps, the mapped folder under it, each line trimmed to the
 *  caps (FS Pixel Sans draws them 7/16 em tall) so the box hugs its type. */
function RoomPlaque({ plaque }: { plaque: PlacedPlaque }) {
  const trim = { textBoxTrim: 'trim-both', textBoxEdge: 'cap alphabetic' } as React.CSSProperties;
  return (
    <div
      className="absolute flex flex-col whitespace-nowrap leading-none"
      style={{
        left: plaque.rect.x,
        top: plaque.rect.y,
        width: plaque.rect.w,
        height: plaque.rect.h,
        boxSizing: 'border-box',
        padding: `${PLAQUE_PAD_Y_PX}px ${PLAQUE_PAD_X_PX}px`,
        gap: PLAQUE_LINE_GAP_PX,
        background: 'var(--brand-ink)',
        border: `${PLAQUE_BORDER_PX}px solid var(--mon-night)`,
        boxShadow: '2px 2px 0px var(--mon-night)',
        pointerEvents: 'none',
        zIndex: PLAQUE_Z_INDEX,
      }}
      data-testid="room-plaque"
      data-area={plaque.label}
    >
      <span
        style={{
          ...trim,
          display: 'block',
          height: plaque.title.line,
          fontSize: plaque.title.font,
          letterSpacing: `${PLAQUE_TITLE_TRACKING_EM}em`,
          textTransform: 'uppercase',
          color: 'var(--brand-gold)',
        }}
        data-testid="room-plaque-title"
      >
        {plaque.label}
      </span>
      {plaque.folder && plaque.sub && (
        <span
          className="pv"
          style={{
            display: 'block',
            height: plaque.sub.line,
            lineHeight: `${plaque.sub.line}px`,
            fontSize: plaque.sub.font,
            color: 'var(--brand-paper-2)',
            ['--pv-mask' as string]: 'var(--mon-mask-on-ink)',
          }}
        >
          {plaque.folder}
        </span>
      )}
    </div>
  );
}

/** The stage chrome drawn over the map (the clock), in the overlay's CSS px. */
function stageChromeRects(stage: HTMLElement, container: DOMRect): Rect[] {
  return STAGE_CHROME_SELECTORS.flatMap((sel) => {
    const el = stage.ownerDocument?.querySelector(sel);
    if (!el) return [];
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return [];
    return [{ x: r.left - container.left, y: r.top - container.top, w: r.width, h: r.height }];
  });
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  onAckTripwire,
  showAreas = true,
}: ToolOverlayProps) {
  // Re-render after every drawn canvas frame. The frame's wall-clock time drives the cache
  // countdown; it is taken here, outside render, and is 0 until the first frame.
  const [frameMs, setFrameMs] = useState(0);
  useFrame(() => setFrameMs(Date.now()));

  const el = containerRef.current;
  if (!el) return null;
  const dpr = window.devicePixelRatio || 1;
  const containerRect = el.getBoundingClientRect();
  const project = overlayProjection(
    officeState.getLayout(),
    containerRect,
    zoom,
    panRef.current,
    dpr,
  );
  // Beside the monitor's rail plates are full (line 2 included) at every zoom. Otherwise, up to
  // zoom level 3, plates are one-line and fixed size. Above that they keep their share of the
  // screen: scaled against the zoom at which the whole map fits.
  // The shell sets the rule from monitorLayout (setMonitorFullPlates).
  const monitorFull = isMonitorFullPlates();
  const compact = plateIsCompact(zoom);
  // Beside the rail every character carries a one-line tag, its type set by the map's CSS zoom.
  const tags = isMonitorTag(compact);
  setMonitorTagZoom(zoom / dpr);
  // A lit desk's frame and its tag's alert tab say it needs you: the canvas adds no bubble over it.
  // The scene's two-line plate carries the alert on line 2, so it hides the bubble the same way.
  officeState.hideLitBubbles = tags || isSceneTwoLinePlates();
  const type = currentMonitorType();
  const fitScale = plateScale(
    zoom,
    fitZoomWholeMap(
      { cols: officeState.getLayout().cols, rows: officeState.getLayout().rows },
      containerRect,
      dpr,
    ),
  );
  const scale = compact || tags ? 1 : monitorFull ? monitorPlateScale(zoom, dpr) : fitScale;
  const nowMs = officeNow().getTime();

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  // While the inspector sheet shows the selected agent, its full box would repeat it: its plate
  // stays (on paper), hovered or not, and so do its helpers'.
  const sheetOpen = officeState.monitorSheetOpen;
  const boxFor = (id: number | null): number | null =>
    sheetOpen && id !== null && id === selectedId ? null : id;
  const boxSelectedId = boxFor(selectedId);
  const boxHoveredId = boxFor(hoveredId);

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  // Pass 1: decide what each character gets. Compact labels are then laid out
  // together so they can avoid each other and the room signs; full boxes are
  // not part of that pass.
  const maxWidth = tags
    ? type.maxWidth
    : monitorFull
      ? fullPlateMaxWidth(zoom, dpr)
      : compactLabelMaxWidth(zoom, dpr);
  const plans = new Map<
    number,
    | { kind: 'full' }
    | { kind: 'compact'; content: Extract<OverlayContent, { mode: 'compact' | 'marker' }> }
  >();
  const labelItems: LabelItem[] = [];
  // Beside the rail: the tags for the solver, and the lit desks their owners' tags are pinned to.
  const tagInputs: MonitorTagInput[] = [];
  const lit = tags ? officeState.deskHighlights() : [];
  const officeLayout = officeState.getLayout();
  const roomSpan = (ch: Character): { x0: number; x1: number } => {
    const world = roomFloorRect(
      officeLayout.areaTiles,
      officeLayout.cols,
      officeLayout.rows,
      officeState.roomOf(ch),
    );
    return { x0: project.toScreenX(world.x), x1: project.toScreenX(world.x + world.w) };
  };
  for (const id of allIds) {
    const ch = officeState.characters.get(id);
    if (!ch) continue;
    const isSelected = boxSelectedId === id;
    const isHovered = boxHoveredId === id;
    const parentId = ch.isSubagent ? ch.parentAgentId : null;
    const shown = showOverlay({
      isSub: ch.isSubagent,
      isSelected,
      isHovered,
      parentSelected: parentId !== null && boxSelectedId === parentId,
      parentHovered: parentId !== null && boxHoveredId === parentId,
    });
    // A helper's tag shows only while its lead is selected or it is hovered itself: the crew lines
    // and the banner say who works for whom.
    const helperQuiet = tags && ch.isSubagent && parentId !== selectedId && id !== hoveredId;
    if (shown === 'compact' && helperQuiet) {
      plans.set(id, { kind: 'compact', content: { mode: 'compact', plate: null } });
    } else if (shown === 'full') {
      plans.set(id, { kind: 'full' });
    } else if (shown === 'compact') {
      const meta = officeState.sessionMeta.get(id);
      const arts = officeState.artifacts.get(id);
      const content = overlayContent({
        expanded: false,
        label: agentLabel(officeState.sessionTitles.get(id), ch.folderName),
        ...helperPlateInput(officeState, subagentCharacters, id),
        tripwire: officeState.tripwires.get(id),
        name: officeState.rosters.get(id)?.name,
        rarity: characterFlair(ch, officeState.models, isShowModelFlairEnabled()).rarity,
        maxWidth,
        medal: ch.isSubagent ? null : medalOf(officeState, ch),
        plateState: plateState(
          plateFacts(officeState, ch, agentTools, subagentCharacters, subagentTools, nowMs),
        ),
        loop: officeState.loops.has(id),
        branch: meta?.branch,
        ageMs: meta?.startedAt !== undefined ? nowMs - meta.startedAt : undefined,
        artifacts:
          arts?.count !== undefined
            ? { count: arts.count, complete: arts.complete !== false }
            : undefined,
      });
      if (content.mode === 'full') continue;
      if (content.mode === 'compact' && content.plate && isSceneTwoLinePlates() && !ch.isSubagent) {
        const facts = plateFacts(
          officeState,
          ch,
          agentTools,
          subagentCharacters,
          subagentTools,
          nowMs,
        );
        content.plate = sceneTwoLinePlate(
          content.plate,
          officeState.rosters.get(id)?.level,
          facts.toolStatus,
          nowMs,
        );
      }
      plans.set(id, { kind: 'compact', content });
      if (content.mode === 'compact' && content.plate && tags) {
        const plate = content.plate;
        const alert = plate.state?.kind === 'alert' ? plate.state.alert : null;
        // A lit agent's tag keeps its alert tab: it sits on its desk's frame, tab, medal and name.
        const box = ch.isSubagent
          ? helperTagBox(helperTagWord(plate, nowMs), type)
          : {
              w: Math.min(maxWidth, plateBoxWidth(plate, compact, nowMs)),
              h: plateBoxHeight(plate, compact),
            };
        tagInputs.push({
          id,
          // Who needs you is placed first, then the agents, then the helpers.
          rank: alert ? 0 : ch.isSubagent ? HELPER_RANK : 1,
          w: box.w,
          h: box.h,
        });
      } else if (content.mode === 'compact' && content.plate) {
        // Anchor on the tile centre, not the sprite, so plates do not reshuffle while agents walk.
        const sit = seatedDrawOffsetPx(ch);
        const plateH = plateBoxHeight(content.plate, compact) * scale;
        const chipH = chipBoxHeight(content.plate) * scale;
        const h = plateH + (plateH > 0 && chipH > 0 ? NAMEPLATE_PILL_GAP_PX : 0) + chipH;
        const side = plateSide(ch.dir);
        const tileMidY = (ch.tileRow + 0.5) * TILE_SIZE;
        labelItems.push({
          id,
          col: ch.tileCol,
          row: ch.tileRow,
          x: project.toScreenX((ch.tileCol + 0.5) * TILE_SIZE),
          y:
            side === 'below'
              ? project.toScreenY(tileMidY + sit) + COMPACT_LABEL_FEET_GAP_PX
              : project.toScreenY(
                  // The scene pins every plate to one baseline: a napper's lowered head does not drag its own.
                  isSceneTwoLinePlates()
                    ? plateAnchorAboveY(tileMidY, sit, false)
                    : plateAnchorAboveY(tileMidY, sit, false, napHeadBobPx(ch)),
                ) -
                h -
                (isSceneTwoLinePlates() ? SCENE_PLATE_LIFT_PX : 0),
          // The plate's own width (it hugs its words), never more than the cap.
          w: Math.min(maxWidth, plateBoxWidth(content.plate, compact, nowMs) * scale),
          minW: Math.min(maxWidth, plateBoxWidth(content.plate, compact, nowMs, true) * scale),
          span: roomSpan(ch),
          rank: ch.isSubagent ? 1 : 0,
          h,
          plateH,
          chipH,
          grow: side === 'below' ? 'down' : 'up',
        });
      }
    }
  }

  const layout = officeState.getLayout();
  const obstacles: TagObstacle[] = [];
  // Beside the rail every room has its plaque on the wall; elsewhere the canvas signs show when on.
  const plaques = tags ? roomPlaques(officeState, project, type) : [];
  // The lit desks' frames as the canvas draws them, in CSS px: neighbours keep their air, and each
  // owner's tag goes to its own.
  const litUnits = lit.map((h) => screenRect(project, h.rect));
  const litOutlines = separateFrames(litUnits, DESK_HIGHLIGHT_OUTLINE_PX, DESK_HIGHLIGHT_GAP_PX);
  const frames = lit.map((h, i) => ({
    id: h.id,
    unit: litUnits[i],
    outline: litOutlines[i].outline,
  }));
  for (const p of plaques) obstacles.push(p.rect);
  // The stage's own chrome over the map (the clock at its top right): no tag or banner under it.
  const chrome = tags ? stageChromeRects(el, containerRect) : [];
  obstacles.push(...chrome);
  for (const area of showAreas && !tags ? (layout.areas ?? []) : []) {
    const r = areaSignRect(layout.areaTiles, layout.cols, area.label, zoom);
    if (!r) continue;
    const x = project.toScreenX(r.x);
    const y = project.toScreenY(r.y);
    obstacles.push({
      x,
      y,
      w: project.toScreenX(r.x + r.w) - x,
      h: project.toScreenY(r.y + r.h) - y,
    });
  }
  // Side-by-side plates narrow to share their row before anything is pushed off its agent.
  const fitted = fitPlateWidths(labelItems, PLATE_SIDE_GAP_PX);
  for (const it of labelItems) it.w = fitted.get(it.id) ?? it.w;
  const plateWidth = new Map(labelItems.map((it) => [it.id, it.w] as const));

  // Each running workflow's banner hangs over its drawn helpers; plates keep clear of it.
  const zoomCss = 1 / project.toWorldLength(1);
  // Faces where the sprites are drawn now.
  const faces: Rect[] = [...officeState.characters.values()].map((c) => ({
    x: project.toScreenX(c.x) - (FACE_WORLD_PX * zoomCss) / 2,
    y: project.toScreenY(spriteHeadTopY(c.y, seatedDrawOffsetPx(c))),
    w: FACE_WORLD_PX * zoomCss,
    h: FACE_WORLD_PX * zoomCss,
  }));
  const plateRects = labelItems.map((it) => ({ x: it.x - it.w / 2, y: it.y, w: it.w, h: it.h }));
  // A compact office (a short VS Code panel) gets a smaller banner, and none where even the plates
  // are only markers.
  const bannerScale = compact
    ? Math.min(1, monitorPlateScale(zoom, dpr))
    : tags
      ? monitorPlateScale(zoom, dpr)
      : scale;
  const selectedCh = selectedId !== null ? officeState.characters.get(selectedId) : undefined;
  const placeBanners = (avoid: readonly Rect[], wallAvoid: readonly Rect[]): PlacedBanner[] =>
    maxWidth < COMPACT_LABEL_MIN_WIDTH_PX
      ? []
      : crewBanners(officeState, subagentCharacters, project, bannerScale, nowMs, {
          wall: tags,
          // The sheet shows a helper's lead, so either one selected hides the lead's banner.
          sheetLeadId:
            sheetOpen && selectedCh
              ? selectedCh.isSubagent
                ? selectedCh.parentAgentId
                : selectedCh.id
              : null,
          avoid: [...avoid, ...obstacles],
          wallAvoid: [...wallAvoid, ...plaques.map((p) => p.rect), ...chrome],
        });
  // Beside the rail the banner is placed between the agents' tags and the helpers' (the tag pass
  // calls placeBanners); elsewhere before every plate, clear of the plates at their anchors.
  const classicBanners = tags ? [] : placeBanners([...plateRects, ...faces], []);
  for (const b of classicBanners) obstacles.push(b.rect);
  // The classic pass (a VS Code panel, a window without the rail): plates pushed off each other,
  // then clamped into their rooms, and whatever still meets goes faint.
  const classic = () => {
    // No plate hides a face: each one, where the label pass anchors it (its tile), is in the way of
    // every plate but its own, which hangs above it or sits under the feet.
    const faceObstacles: Rect[] = [...officeState.characters.values()].map((c) => {
      const sit = seatedDrawOffsetPx(c);
      const w = FACE_WORLD_PX * zoomCss;
      return {
        x: project.toScreenX((c.tileCol + 0.5) * TILE_SIZE) - w / 2,
        y: project.toScreenY(spriteHeadTopY((c.tileRow + 0.5) * TILE_SIZE, sit, napHeadBobPx(c))),
        w,
        h: w,
      };
    });
    const placements = layoutLabels(
      labelItems,
      [...obstacles, ...faceObstacles],
      compact ? undefined : PLATE_FULL_LAYOUT_LINE_PX * scale,
    );
    // Last step: the stack above each head (plate, chip, bubble) never leaves the floor of its
    // room, so it cannot cross a wall or the top edge. Applied after the collision pass because the
    // wall wins over the nicest spot, and as a group so the order survives the clamp.
    const clamps = new Map<number, { dx: number; dy: number }>();
    officeState.bubbleLift.clear();
    // Weather defaults to just above the head; the stack loop below raises it to the stack's top.
    officeState.weatherAnchor.clear();
    for (const ch of officeState.characters.values()) {
      officeState.weatherAnchor.set(ch.id, spriteHeadTopY(ch.y, seatedDrawOffsetPx(ch)));
    }
    const fxSlots = new Map<number, Rect>();
    const fxBoxes = new Map<number, { w: number; h: number }>();
    for (const e of officeState.fx.active) {
      const box = fxTextBox(e, fitScale);
      const prev = fxBoxes.get(e.agentId);
      if (!prev || box.h > prev.h) fxBoxes.set(e.agentId, box);
    }
    const zoomPx = 1 / project.toWorldLength(1);
    const bubbleBox = {
      w: spriteWorldWidth(BUBBLE_WAITING_SPRITE) * (1 / project.toWorldLength(1)),
      h: spriteWorldHeight(BUBBLE_WAITING_SPRITE) * (1 / project.toWorldLength(1)),
    };
    for (const it of labelItems) {
      const ch = officeState.characters.get(it.id);
      if (!ch) continue;
      const world = withTopWallFace(
        roomFloorRect(layout.areaTiles, layout.cols, layout.rows, officeState.roomOf(ch)),
      );
      const x0 = project.toScreenX(world.x);
      const y0 = project.toScreenY(world.y);
      const floor: Rect = {
        x: x0,
        y: y0,
        w: project.toScreenX(world.x + world.w) - x0,
        h: project.toScreenY(world.y + world.h) - y0,
      };
      const pdy = placements.get(it.id)?.dy ?? 0;
      if (it.grow === 'up') {
        const hasCanvasItem = headSlotTaken(
          ch,
          officeState.tripwires.has(it.id),
          officeState.health.get(it.id),
          officeState,
        );
        const stack = stackAbove({
          x: it.x,
          headTop: it.y + it.h,
          plate: (it.plateH ?? 0) > 0 ? { w: it.w, h: it.plateH ?? 0 } : null,
          chip: (it.chipH ?? 0) > 0 ? { w: it.w, h: it.chipH ?? 0 } : null,
          fx: fxBoxes.get(it.id) ?? null,
          bubble: hasCanvasItem ? bubbleBox : null,
          dy: pdy,
          floor,
          head: {
            x: it.x - (CHARACTER_HEAD_WIDTH_PX * zoomPx) / 2,
            y: it.y + it.h,
            w: CHARACTER_HEAD_WIDTH_PX * zoomPx,
            h: CHARACTER_HEAD_HEIGHT_PX * zoomPx,
          },
          feetY: it.y + it.h + CHARACTER_SPRITE_HEIGHT_PX * zoomPx,
          noFlip:
            ch.seatId !== null && ch.state === CharacterState.TYPE && ch.dir === Direction.DOWN,
        });
        clamps.set(it.id, { dx: stack.shift.dx, dy: stack.shift.dy - pdy });
        if (stack.fx) fxSlots.set(it.id, stack.fx);
        const stackTop = Math.min(
          ...[stack.plate, stack.chip, stack.fx, stack.bubble]
            .filter((r): r is Rect => r !== null)
            .map((r) => r.y),
        );
        officeState.weatherAnchor.set(
          it.id,
          weatherAnchorY(
            Number.isFinite(stackTop)
              ? project.toWorldLength(stackTop - project.toScreenY(0))
              : null,
            spriteHeadTopY(ch.y, seatedDrawOffsetPx(ch)),
          ),
        );
        if (stack.bubble) {
          // World y of the bubble's bottom edge, against where the renderer draws it by default.
          const bottomWorld = project.toWorldLength(
            stack.bubble.y + stack.bubble.h - project.toScreenY(0),
          );
          const defaultBottom = ch.y + seatedBubbleOffsetPx(ch) - BUBBLE_VERTICAL_OFFSET_PX - 1;
          // Negative when the stack flipped below the feet: the bubble is drawn lower, not lifted.
          officeState.bubbleLift.set(it.id, defaultBottom - bottomWorld);
        }
        continue;
      }
      // Plate below the feet (back view): the FX text stands just above the head, the weather
      // already hangs from there.
      const fxBox = fxBoxes.get(it.id);
      if (fxBox) {
        const headTopY = project.toScreenY(spriteHeadTopY(ch.y, seatedDrawOffsetPx(ch)));
        fxSlots.set(it.id, {
          x: project.toScreenX(ch.x) - fxBox.w / 2,
          y: headTopY - OVERLAY_STACK_GAP_PX - fxBox.h,
          w: fxBox.w,
          h: fxBox.h,
        });
      }
      const plate: Rect = { x: it.x - it.w / 2, y: it.y + pdy, w: it.w, h: it.h };
      const fitted = clampPlate(plate, floor);
      clamps.set(it.id, { dx: fitted.x - plate.x, dy: fitted.y - plate.y });
    }

    // The walls had the last word (the clamp above), so two plates may meet again. Two opaque
    // plates never cover each other: the later one in the label order (helpers after agents) goes
    // faint and under, like a plate with no room.
    const faint = new Set<number>();
    const hidden = new Set<number>();
    const faceRects = [...officeState.characters.values()].map((c) => ({
      id: c.id,
      x: project.toScreenX(c.x) - (FACE_WORLD_PX * zoomCss) / 2,
      y: project.toScreenY(spriteHeadTopY(c.y, seatedDrawOffsetPx(c))),
      w: FACE_WORLD_PX * zoomCss,
      h: FACE_WORLD_PX * zoomCss,
    }));
    const intersects = (a: Rect, b: Rect): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    // The banners were placed in free space first; a plate pushed onto one gives way too.
    const settled: Rect[] = classicBanners.map((b) => b.rect);
    for (const it of [...labelItems].sort(
      (a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.row - b.row || a.col - b.col || a.id - b.id,
    )) {
      const dx = clamps.get(it.id)?.dx ?? 0;
      const dy = (placements.get(it.id)?.dy ?? 0) + (clamps.get(it.id)?.dy ?? 0);
      const r = { x: it.x - it.w / 2 + dx, y: it.y + dy, w: it.w, h: it.h };
      const hit = settled.some((o) => intersects(r, o));
      if (placements.get(it.id)?.dim || hit) {
        faint.add(it.id);
        // A faint plate over someone else's face would still hide it: that plate goes. Its crew
        // line and the banner still show the helper.
        if (faceRects.some((f) => f.id !== it.id && intersects(r, f))) hidden.add(it.id);
      } else settled.push(r);
    }
    return { placements, clamps, faint, hidden, fxSlots };
  };
  const { placements, clamps, faint, hidden, fxSlots, tagPlacements, leaders, banners } = tags
    ? {
        placements: new Map<number, LabelPlacement>(),
        clamps: new Map<number, { dx: number; dy: number }>(),
        faint: new Set<number>(),
        hidden: new Set<number>(),
        ...layoutMonitorTags({
          officeState,
          project,
          container: containerRect,
          items: tagInputs,
          obstacles,
          frames,
          placeBanners,
          plaques,
          fxScale: fitScale,
        }),
      }
    : {
        ...classic(),
        tagPlacements: new Map<number, TagPlacement | null>(),
        leaders: new Map<number, Rect>(),
        banners: classicBanners,
      };

  return (
    <>
      <FxText
        officeState={officeState}
        scale={fitScale}
        toScreenX={project.toScreenX}
        toScreenY={project.toScreenY}
        slots={fxSlots}
      />
      {banners.map((b) => (
        <CrewBanner
          key={`${b.leadId}:${b.runId}`}
          view={b.view}
          rect={b.rect}
          scale={b.scale}
          leadId={b.leadId}
          form={b.form}
        />
      ))}
      {plaques.map((p) => (
        <RoomPlaque key={p.label} plaque={p} />
      ))}
      {[...leaders].map(([id, r]) => (
        <div
          key={id}
          className="absolute"
          style={{
            left: r.x,
            top: r.y,
            width: r.w,
            height: r.h,
            background: 'var(--brand-ink)',
            pointerEvents: 'none',
            zIndex: COMPACT_LABEL_Z_INDEX - 3,
          }}
          data-testid="tag-leader"
          data-agent-id={id}
        />
      ))}
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        const plan = plans.get(id);
        if (!ch || !plan) return null;

        const isSelected = selectedId === id;
        const isSub = ch.isSubagent;
        const status = agentStatus(ch);

        if (plan.kind === 'compact' && tags) {
          const tag = tagPlacements.get(id)?.tag;
          const plate = plan.content.mode === 'compact' ? plan.content.plate : null;
          if (isSub && plate && tag) {
            return (
              <div
                key={id}
                className="absolute"
                style={{
                  left: tag.x,
                  top: tag.y,
                  pointerEvents: 'none',
                  zIndex: COMPACT_LABEL_Z_INDEX - 1,
                }}
                data-testid="agent-overlay"
                data-agent-id={id}
                data-status={status}
              >
                <HelperTag plate={plate} rect={tag} type={type} now={nowMs} />
              </div>
            );
          }
          return (
            <CompactLabel
              key={id}
              id={id}
              status={status}
              // One tag per character: the tripwire shows as its × tab, acknowledged in the sheet.
              plate={tag && plate ? { ...plate, pill: null } : null}
              maxWidth={tag?.w ?? maxWidth}
              left={tag ? tag.x + tag.w / 2 : project.toScreenX(ch.x)}
              top={tag ? tag.y : project.toScreenY(ch.y)}
              side="below"
              scale={1}
              compact={compact}
              dx={0}
              dy={0}
              dim={false}
              tripwire={officeState.tripwires.get(id)}
              onAckTripwire={onAckTripwire}
              now={nowMs}
              selected={sheetOpen && selectedId === id}
            />
          );
        }

        if (plan.kind === 'compact') {
          const sit = seatedDrawOffsetPx(ch);
          const placement = placements.get(id);
          const side = plateSide(ch.dir);
          return (
            <CompactLabel
              key={id}
              id={id}
              status={status}
              plate={plan.content.mode === 'compact' && !hidden.has(id) ? plan.content.plate : null}
              maxWidth={(plateWidth.get(id) ?? maxWidth) / scale}
              left={project.toScreenX(ch.x)}
              top={
                side === 'below'
                  ? project.toScreenY(ch.y + sit) + COMPACT_LABEL_FEET_GAP_PX
                  : project.toScreenY(
                      isSceneTwoLinePlates()
                        ? plateAnchorAboveY(ch.y, sit, false)
                        : plateAnchorAboveY(ch.y, sit, false, napHeadBobPx(ch)),
                    ) - (isSceneTwoLinePlates() ? SCENE_PLATE_LIFT_PX : 0)
              }
              side={side}
              scale={scale}
              compact={compact}
              dx={clamps.get(id)?.dx ?? 0}
              dy={(placement?.dy ?? 0) + (clamps.get(id)?.dy ?? 0)}
              dim={faint.has(id)}
              tripwire={officeState.tripwires.get(id)}
              onAckTripwire={onAckTripwire}
              now={nowMs}
              selected={sheetOpen && selectedId === id}
            />
          );
        }

        // Position above character
        const sittingOffset = seatedDrawOffsetPx(ch);
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        // A workflow helper has no parent tool row: everything it shows comes from its own entry.
        const sub = isSub ? subagentCharacters.find((s) => s.id === id) : undefined;
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title (a workflow helper's full label); SELECTING the sub
            // reveals its live tool activity (watched sub-agents stream it via subagentToolStart).
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.plateLabel || sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        const label = agentLabel(officeState.sessionTitles.get(id), ch.folderName);
        const tripwire = officeState.tripwires.get(id);
        const rosterRows = fullBoxRows({
          roster: officeState.rosters.get(id),
          model: {
            id: officeState.models.get(id)?.model ?? '',
            rarity: characterFlair(ch, officeState.models, isShowModelFlairEnabled()).rarity,
          },
          // Same gate as the context gauge: a sub-agent has no session of its own.
          signals:
            isSub || frameMs === 0
              ? undefined
              : {
                  cache: officeState.cacheByAgent.get(id),
                  mode: officeState.modeByAgent.get(id),
                  shells: officeState.shellsByAgent.get(id),
                  contextTokens: ch.contextTokens,
                  now: frameMs,
                },
        });
        const group = sub?.group;
        const health = officeState.health.get(id);
        const hasExtraLines = !!(label || teamRoleLabel || tripwire || group || health);

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        return (
          <div
            key={id}
            className="absolute flex flex-col items-center -translate-x-1/2"
            style={{
              left: screenX,
              top: screenY - fullBoxTopOffsetPx(rosterRows, hasExtraLines),
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: FULL_BOX_Z_INDEX,
            }}
            data-testid="agent-overlay"
            data-agent-id={id}
            data-status={status}
          >
            <div
              className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs"
              style={{ '--pv-mask': 'var(--mon-mask-on-ink)' } as React.CSSProperties}
            >
              {dotColor && (
                <span
                  className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                  style={{ background: dotColor }}
                />
              )}
              <div className="flex flex-col gap-0 overflow-hidden">
                {teamRoleLabel && (
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: '18px',
                      color: ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
                      fontWeight: ch.isTeamLead ? 'bold' : undefined,
                    }}
                  >
                    {teamRoleLabel}
                  </span>
                )}
                <span
                  // A command, a file name or a task description is session text, masked; the
                  // fixed state words are not.
                  className={`${FIXED_ACTIVITY_WORDS.has(activityText) ? '' : 'pv '}overflow-hidden text-ellipsis block leading-none`}
                  style={{
                    fontSize: isSub ? '20px' : '22px',
                    fontStyle: isSub ? 'italic' : undefined,
                  }}
                >
                  {activityText}
                </span>
                {group && (
                  <span className="pv text-2xs leading-none overflow-hidden text-ellipsis block">
                    {group}
                  </span>
                )}
                {tripwire && (
                  <span
                    className="overflow-hidden text-ellipsis block leading-none cursor-pointer"
                    // The panel ignores pointer events unless selected; the alarm line opts
                    // back in so one click acknowledges it.
                    style={{
                      fontSize: '18px',
                      color: tripwireColor(tripwire.severity),
                      pointerEvents: 'auto',
                    }}
                    title="Click to acknowledge"
                    data-testid="tripwire-alarm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAckTripwire(id, tripwire.count);
                    }}
                  >
                    <PixelWarn px={2} /> {tripwireLabel(tripwire.ruleName, tripwire.count)}
                  </span>
                )}
                {health && (
                  <span
                    className="text-2xs leading-none overflow-hidden text-ellipsis block"
                    data-testid="agent-health"
                  >
                    {healthLabel(health)}
                  </span>
                )}
                {label && (
                  <span className="pv text-2xs leading-none overflow-hidden text-ellipsis block">
                    {label}
                  </span>
                )}
                <FullBoxRoster rows={rosterRows} />
              </div>
              {isSelected && !isSub && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseAgent(id);
                  }}
                  title="Close agent"
                  className="ml-2 shrink-0 leading-none"
                >
                  ×
                </Button>
              )}
            </div>
            {showContextGauge && (
              <div
                style={{
                  width: CONTEXT_GAUGE_WIDTH_PX,
                  height: CONTEXT_GAUGE_HEIGHT_PX,
                  background: CONTEXT_GAUGE_BG,
                  marginTop: 2,
                }}
                title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                data-testid="context-gauge"
                data-context-pct={Math.round(contextRatio * 100)}
              >
                <div
                  style={{
                    width: `${Math.min(contextRatio * 100, 100)}%`,
                    height: '100%',
                    background: getFuelColor(contextRatio),
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
