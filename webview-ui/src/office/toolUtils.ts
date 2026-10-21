import type { RosterEventSignal } from '../../../core/src/messages.js';
import {
  COMPACT_LABEL_GAP_PX,
  COMPACT_LABEL_MIN_WIDTH_PX,
  COMPACT_LABEL_SEAT_PITCH_TILES,
  HELPER_PLATE_LABEL_MAX_CODE_POINTS,
  TILE_SIZE,
  TRIPWIRE_COLOR_HIGH,
  TRIPWIRE_COLOR_LOW,
  TRIPWIRE_COLOR_MEDIUM,
} from '../constants.js';
import type { SubagentCharacter } from '../hooks/subagentMessages.js';
import type { OfficeState } from './engine/officeState.js';
import { Rarity } from './flair/modelFlair.js';
import type { MedalSpec } from './medal.js';
import { formatSpan, type PlateState } from './plateState.js';
import { CharacterState, IdlePose } from './types.js';

/** Map status prefixes back to tool names for animation selection */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  Searching: 'Grep',
  Globbing: 'Glob',
  Fetching: 'WebFetch',
  'Searching web': 'WebSearch',
  Writing: 'Write',
  Editing: 'Edit',
  Running: 'Bash',
  Task: 'Task',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

/** Text under the activity line: the session title, else the folder, else nothing. */
export function agentLabel(sessionTitle?: string, folderName?: string): string | null {
  return sessionTitle || folderName || null;
}

export type TripwireSeverity = 'high' | 'medium' | 'low';

export interface TripwireAlarm {
  ruleName: string;
  severity: TripwireSeverity;
  count: number;
}

const TRIPWIRE_SEVERITY_RANK: Record<TripwireSeverity, number> = { low: 1, medium: 2, high: 3 };

/** Beacon and overlay color for a severity. */
export function tripwireColor(severity: TripwireSeverity): string {
  if (severity === 'high') return TRIPWIRE_COLOR_HIGH;
  if (severity === 'medium') return TRIPWIRE_COLOR_MEDIUM;
  return TRIPWIRE_COLOR_LOW;
}

/** Overlay line for an agent's alarm; the count shows only once there is more than one hit. The
 *  warning sign before it is a pixel icon (PixelWarn): the font has no ⚠. */
export function tripwireLabel(ruleName: string, count: number): string {
  return count > 1 ? `${ruleName} \u00D7${count}` : ruleName;
}

/** The alarm sound plays for the first hit since an ack or a severity escalation, never on a plain count bump. */
export function shouldPlayTripwireSound(
  prev: TripwireAlarm | undefined,
  next: { severity: TripwireSeverity },
): boolean {
  return !prev || TRIPWIRE_SEVERITY_RANK[next.severity] > TRIPWIRE_SEVERITY_RANK[prev.severity];
}

export type AgentStatus = 'active' | 'idle' | 'waiting' | 'permission';

/** Status as exposed on the overlay (`data-status`), so e2e and styling need not read text. */
export function agentStatus(ch: {
  isActive: boolean;
  bubbleType: 'permission' | 'waiting' | null;
}): AgentStatus {
  if (ch.bubbleType === 'permission') return 'permission';
  if (ch.bubbleType === 'waiting') return 'waiting';
  return ch.isActive ? 'active' : 'idle';
}

/** The speech bubble rule: a bubble type, except the idle "waiting for input", which its plate says. */
export function drawsBubble(ch: {
  bubbleType: 'permission' | 'waiting' | null;
  waitingAwaitingInput?: boolean;
}): boolean {
  return !!ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput);
}

/**
 * Glyph drawn above an agent's head. Only an idle agent with nothing else in
 * the above-head slot gets one: a speech bubble, a tripwire beacon or a health
 * state owns that slot (a dead agent too: a z over its gray sprite would read
 * as a nap), and an active agent shows its typing animation instead. The idle
 * "waiting for input" state draws no bubble, so it counts as bubble-free.
 */
export function statusGlyph(
  ch: {
    isActive: boolean;
    bubbleType: 'permission' | 'waiting' | null;
    waitingAwaitingInput?: boolean;
    state?: string;
    pose?: string;
  },
  /** A tripwire beacon or a health state holds the slot, or the tag carries the agent's alert. */
  slotTaken = false,
): 'z' | null {
  if (ch.isActive || slotTaken) return null;
  // A seated reader or coffee drinker already shows "idle" with the book or mug; a z over it reads
  // as napping.
  if (
    ch.state === CharacterState.TYPE &&
    (ch.pose === IdlePose.READING || ch.pose === IdlePose.COFFEE)
  )
    return null;
  return drawsBubble(ch) ? null : 'z';
}

/** Max CSS width of a compact label: one seat's slot minus a gap. `/ dpr` matches overlayProjection. */
export function compactLabelMaxWidth(zoom: number, dpr: number): number {
  return Math.max(
    0,
    (COMPACT_LABEL_SEAT_PITCH_TILES * TILE_SIZE * zoom) / dpr - COMPACT_LABEL_GAP_PX,
  );
}

/** One part of a plate's second line; session text (a branch, a title) is masked in privacy mode. */
export interface PlatePart {
  text: string;
  pv: boolean;
}

/**
 * What a permanent nameplate shows. Line 1: the alert tab or nothing, the medal (model tier and
 * context), the name, the loop glyph, then the state words. Line 2 (full plates only): the
 * branch, the transcript's age and the artifacts. A helper's plate is one line: its run label (or
 * task description) and what it does. The tripwire is a pill beside the plate.
 */
export interface NameplateContent {
  /** Roster name; else the session label (then `namePv`); a helper: its label. */
  name: string;
  /** The name is session text (title, folder, a helper's label): privacy masks it. */
  namePv: boolean;
  medal: MedalSpec | null;
  state: PlateState | null;
  /** The agent runs as a loop (`↻` after the name). */
  loop: boolean;
  /** Line 2; null when nothing is known. */
  sub: readonly PlatePart[] | null;
  /** A helper's one-line plate. */
  helper: boolean;
  /** Tiers 2-4 only: a legendary plate shimmers. */
  rarity: Rarity | null;
  pill: string | null;
}

/** The roster member an agent plays, as last sent by the server. */
export interface AgentRosterInfo {
  memberId: string;
  name: string;
  level: number;
  /** XP earned inside the current level; the bar fraction is xp / xpToNext. */
  xp: number;
  xpToNext: number;
  streak: number;
  mood: 'alarmed' | 'frustrated' | 'happy' | 'neutral';
}

export interface RosterEventInfo {
  kind: 'xp' | 'levelUp';
  amount?: number;
  signal?: RosterEventSignal;
}

/** Short enough that a commit and the PR opened right after it each get their pop. */
export const XP_POP_COOLDOWN_MS = 1_500;

/** Every award is real work, so each one pops, at most once per cooldown per agent. */
export function shouldShowXpPop(
  event: RosterEventInfo,
  lastShownAt: number | undefined,
  now: number,
): boolean {
  const worthy = event.kind === 'levelUp' || (event.amount !== undefined && event.amount > 0);
  return worthy && (lastShownAt === undefined || now - lastShownAt >= XP_POP_COOLDOWN_MS);
}

const XP_POP_WORK: Record<RosterEventSignal, string> = {
  commit: 'commit',
  pr: 'PR',
  merge: 'merged',
  tests: 'tests green',
};

/** The pop names the work the XP paid for. One string for the text and the box it is sized in. */
export function xpPopLabel(e: { amount: number; signal?: RosterEventSignal }): string {
  // A signal this build does not know still pops, as plain XP.
  const work = e.signal ? XP_POP_WORK[e.signal] : undefined;
  return `+${e.amount} ${work ?? 'XP'}`;
}

/** The level-up banner: `Level 13!`, or with a name (the story scene's `&banner=1`) `Ada Lv13`. */
export function levelBannerLabel(level: number, name?: string): string {
  return name ? `${name} Lv${level}` : `Level ${level}!`;
}

/** `text` cut to `max` code points with an ellipsis; a surrogate pair is never split. */
function ellipsize(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join('')}\u2026` : text;
}

/** The parent's count of live helpers, e.g. `+2 helpers`. */
export function helpersLabel(n: number): string {
  return `+${n} ${n === 1 ? 'helper' : 'helpers'}`;
}

export type OverlayContent =
  { mode: 'full' } | { mode: 'marker' } | { mode: 'compact'; plate: NameplateContent | null };

/** `N artifacts`, `1 artifact`, `N+ artifacts` when the history scan was cut short. */
export function artifactsLabel(count: number, complete: boolean): string {
  return `${count}${complete ? '' : '+'} ${count === 1 && complete ? 'artifact' : 'artifacts'}`;
}

/**
 * What an agent's overlay shows. Hovered or selected -> the full box. Otherwise the permanent
 * nameplate (null when the agent has nothing to show yet), or just a marker when there is no room.
 */
export function overlayContent(state: {
  expanded: boolean;
  /** Session title or folder. */
  label: string | null;
  subCount: number;
  /** How many of those helpers have a character: the crew lines show them, so the count shows
   *  only while some wait without one. */
  drawnSubCount?: number;
  tripwire?: { ruleName: string; count: number } | null;
  /** Roster member name. */
  name?: string;
  rarity?: Rarity;
  maxWidth: number;
  /** Set for a helper (sub-agent): its parent's name. */
  helperOf?: string;
  /** A workflow helper's run label, or a sub-agent's task description. */
  helperLabel?: string;
  medal?: MedalSpec | null;
  plateState?: PlateState | null;
  loop?: boolean;
  /** Line 2: the session's branch, the transcript's age (ms), its artifacts. */
  branch?: string;
  ageMs?: number;
  artifacts?: { count: number; complete: boolean };
}): OverlayContent {
  if (state.expanded) return { mode: 'full' };
  if (state.maxWidth < COMPACT_LABEL_MIN_WIDTH_PX) return { mode: 'marker' };
  const pill = state.tripwire ? tripwireLabel(state.tripwire.ruleName, state.tripwire.count) : null;
  if (state.helperOf !== undefined) {
    // The label is script text: isolated (FSI ... PDI), its right-to-left runs can never reorder
    // the words that follow it.
    const label = state.helperLabel
      ? `\u2068${ellipsize(state.helperLabel, HELPER_PLATE_LABEL_MAX_CODE_POINTS)}\u2069`
      : 'helper';
    return {
      mode: 'compact',
      plate: {
        name: label,
        namePv: !!state.helperLabel,
        medal: null,
        state: state.plateState ?? null,
        loop: false,
        sub: null,
        helper: true,
        rarity: null,
        pill,
      },
    };
  }
  let name = state.name ?? '';
  let namePv = false;
  let label = state.label;
  // No roster member yet: the session label takes the name line.
  if (!name && label) {
    name = label;
    namePv = true;
    label = null;
  }
  const parts: PlatePart[] = [];
  const where = state.branch || label;
  if (where) parts.push({ text: where, pv: true });
  if (state.ageMs !== undefined) parts.push({ text: formatSpan(state.ageMs), pv: false });
  if (state.artifacts && state.artifacts.count > 0)
    parts.push({
      text: artifactsLabel(state.artifacts.count, state.artifacts.complete),
      pv: false,
    });
  if (state.subCount > (state.drawnSubCount ?? 0))
    parts.push({ text: helpersLabel(state.subCount), pv: false });
  if (!name && parts.length === 0 && !pill) return { mode: 'compact', plate: null };
  // Nothing names the agent yet: the first part of line 2 moves up.
  if (!name && parts.length > 0) {
    const first = parts.shift()!;
    name = first.text;
    namePv = first.pv;
  }
  return {
    mode: 'compact',
    plate: {
      name,
      namePv,
      medal: state.medal ?? null,
      state: state.plateState ?? null,
      loop: !!state.loop,
      sub: parts.length > 0 ? parts : null,
      helper: false,
      rarity: state.rarity && state.rarity !== Rarity.COMMON ? state.rarity : null,
      pill,
    },
  };
}

/**
 * The helper fields of a character's plate input, read off the office and the
 * helper list the overlay renders: a lead's count of live helpers (undrawn
 * crew helpers included), and for a helper its parent's name and its workflow
 * label.
 */
export function helperPlateInput(
  officeState: OfficeState,
  helpers: readonly SubagentCharacter[],
  id: number,
): { subCount: number; drawnSubCount: number; helperOf?: string; helperLabel?: string } {
  const mine = helpers.filter((s) => s.parentAgentId === id);
  const subCount = mine.length;
  const drawnSubCount = mine.filter((s) => officeState.characters.has(s.id)).length;
  const ch = officeState.characters.get(id);
  const parentId = ch?.isSubagent ? ch.parentAgentId : null;
  if (parentId === null) return { subCount, drawnSubCount };
  return {
    subCount,
    drawnSubCount,
    helperOf: parentName(officeState, parentId),
    helperLabel: helperLabelOf(helpers.find((s) => s.id === id)),
  };
}

/** A crew helper's run label, else a sub-agent's task description. */
function helperLabelOf(s: SubagentCharacter | undefined): string | undefined {
  return s?.plateLabel || s?.label || undefined;
}

/** A helper's parent as its plate names it: roster name, else session title or folder. */
function parentName(officeState: OfficeState, parentId: number): string {
  const parent = officeState.characters.get(parentId);
  return (
    officeState.rosters.get(parentId)?.name ||
    agentLabel(officeState.sessionTitles.get(parentId), parent?.folderName) ||
    'agent'
  );
}

/**
 * Which element an agent gets: the full box, the nameplate, or none.
 * Helpers (sub-agents) get a one-line plate naming their parent, and the full box when they or
 * their parent are hovered or selected. Agents always have a plate.
 */
export function showOverlay(s: {
  isSub: boolean;
  isSelected: boolean;
  isHovered: boolean;
  parentSelected: boolean;
  parentHovered: boolean;
}): 'full' | 'compact' | null {
  const self = s.isSelected || s.isHovered;
  if (s.isSub && (s.parentSelected || s.parentHovered)) return 'full';
  return self ? 'full' : 'compact';
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

const providerCaps: {
  readingTools: Set<string>;
  subagentToolNames: Set<string>;
} = {
  readingTools: new Set(),
  subagentToolNames: new Set(),
};

export function setProviderCapabilities(caps: {
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCaps.readingTools = new Set(caps.readingTools);
  providerCaps.subagentToolNames = new Set(caps.subagentToolNames);
}

export function isReadingToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.readingTools.has(name);
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.subagentToolNames.has(name);
}
