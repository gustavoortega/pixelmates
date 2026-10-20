import type { PermissionMode } from '../../core/src/messages.js';
import type { ColorValue } from './components/ui/types.js';

// ── Grid & Layout ────────────────────────────────────────────
export const TILE_SIZE = 16;
/** Height, in tiles, of the wall art above a room's top floor row. */
export const WALL_FACE_TILES = 2;
export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 11;
export const MAX_COLS = 64;
export const MAX_ROWS = 64;

// ── Character Animation ─────────────────────────────────────
export const WALK_SPEED_PX_PER_SEC = 48;
export const WALK_FRAME_DURATION_SEC = 0.15;
export const TYPE_FRAME_DURATION_SEC = 0.3;
export const WANDER_PAUSE_MIN_SEC = 2.0;
export const WANDER_PAUSE_MAX_SEC = 20.0;
export const WANDER_MOVES_BEFORE_REST_MIN = 3;
export const WANDER_MOVES_BEFORE_REST_MAX = 6;
export const SEAT_REST_MIN_SEC = 120.0;
export const SEAT_REST_MAX_SEC = 240.0;

// ── Idle life (iteration 3a) ─────────────────────────────────
/** A pose is re-evaluated this often even when the status did not change. */
export const POSE_TICK_SEC = 60;
/** A status other than active must hold this long before the pose follows it: a status that
 *  flips every couple of seconds never moves the pose (going active is always immediate). */
export const POSE_SETTLE_SEC = 4;
/** Reading turns to napping after this long idle, and never goes back within the idle span. */
export const NAP_AFTER_IDLE_SEC = 600;
/** One in this many agents (by seed) is a coffee drinker. */
export const COFFEE_SEED_MODULUS = 3;
export const COFFEE_MIN_IDLE_SEC = 120;
export const COFFEE_MIN_STAY_SEC = 60;
export const COFFEE_COOLDOWN_SEC = 600;
export const SOFA_MAX_OCCUPANTS = 2;
/** Seconds one page of the book stays up before the page-turn frame swaps. */
export const READING_PAGE_TURN_SEC = 2.5;
/** Rising "Zz" of a napping agent: one cycle, and how far (world px) a glyph climbs and drifts
 *  right over it before it has faded out. */
export const NAP_ZZ_PERIOD_MS = 2400;
export const NAP_ZZ_RISE_PX = 8;
export const NAP_ZZ_DRIFT_PX = 3;
/** A napper swaps head-down and head-down breathing in this often: slow, like sleep. */
export const NAP_BREATH_SEC = 1.8;
/** One frame of the mug's steam loop. */
export const IDLE_PROP_STEAM_FRAME_SEC = 0.35;

// ── Matrix Effect ────────────────────────────────────────────
export const MATRIX_EFFECT_DURATION_SEC = 0.3;
export const MATRIX_TRAIL_LENGTH = 6;
export const MATRIX_SPRITE_COLS = 16;
export const MATRIX_SPRITE_ROWS = 24;
export const MATRIX_FLICKER_FPS = 30;
export const MATRIX_FLICKER_VISIBILITY_THRESHOLD = 180;
export const MATRIX_COLUMN_STAGGER_RANGE = 0.3;
export const MATRIX_HEAD_COLOR = '#ccffcc';
export const matrixGreenBright = (a: number): string => `rgba(0, 255, 65, ${a})`;
export const matrixGreenMid = (a: number): string => `rgba(0, 170, 40, ${a})`;
export const matrixGreenDim = (a: number): string => `rgba(0, 85, 20, ${a})`;
export const MATRIX_TRAIL_OVERLAY_ALPHA = 0.6;
export const MATRIX_TRAIL_EMPTY_ALPHA = 0.5;
export const MATRIX_TRAIL_MID_THRESHOLD = 0.33;
export const MATRIX_TRAIL_DIM_THRESHOLD = 0.66;

// ── Rendering ────────────────────────────────────────────────
export const CHARACTER_SITTING_OFFSET_PX = 6;
/** A face-on desk seat sinks its sprite until the desk top hides this many px of the sprite's bottom
 *  (the desk sorts in front of a seated agent; the sink only makes the cover real). */
export const DESK_SEAT_COVER_PX = 12;
/** A couch's front part hides this many px of the sprite's bottom: the cut row is derived from it. */
export const SOFA_FRONT_COVER_PX = 10;
export const CHARACTER_Z_SORT_OFFSET = 0.5;
export const OUTLINE_Z_SORT_OFFSET = 0.001;
export const SELECTED_OUTLINE_ALPHA = 1.0;
export const HOVERED_OUTLINE_ALPHA = 0.5;
/** Headless agents (adopted, no terminal to focus) render slightly translucent. */
export const HEADLESS_CHARACTER_ALPHA = 0.5;
/** Helper look: an Adjust-mode shift applied to every non-skin pixel of the parent's sheet. */
export const HELPER_LOOK = { h: 0, s: -70, b: 10, c: 0 } as const;
/** Workflow crew helpers drawn per lead; the rest wait undrawn and count in "+N helpers". */
export const WORKFLOW_MAX_VISIBLE_HELPERS = 12;
/** A crew helper's plate shows this many code points of its label before an ellipsis. */
export const HELPER_PLATE_LABEL_MAX_CODE_POINTS = 24;
export const GHOST_PREVIEW_SPRITE_ALPHA = 0.5;
export const GHOST_PREVIEW_TINT_ALPHA = 0.25;
export const SELECTION_DASH_PATTERN: [number, number] = [4, 3];
export const BUTTON_MIN_RADIUS = 6;
export const BUTTON_RADIUS_ZOOM_FACTOR = 3;
export const BUTTON_ICON_SIZE_FACTOR = 0.45;
export const BUTTON_LINE_WIDTH_MIN = 1.5;
export const BUTTON_LINE_WIDTH_ZOOM_FACTOR = 0.5;
export const BUBBLE_FADE_DURATION_SEC = 0.5;
export const BUBBLE_SITTING_OFFSET_PX = 10;
export const BUBBLE_VERTICAL_OFFSET_PX = 24;
export const FALLBACK_FLOOR_COLOR = '#808080';

// ── Tripwire alarm ───────────────────────────────────────────
export const TRIPWIRE_COLOR_HIGH = '#e53935';
export const TRIPWIRE_COLOR_MEDIUM = '#ffb300';
export const TRIPWIRE_COLOR_LOW = '#fdd835';
/** Beacon flash period in ms. */
export const TRIPWIRE_FLASH_PERIOD_MS = 700;
/** Beacon radius in sprite pixels (scaled by zoom). */
export const TRIPWIRE_BEACON_RADIUS_PX = 3;

// ── Agent health marks (above the head, in the beacon's slot) ──
/** Smoke over a stuck or looping agent: grey, so it never reads as an alarm color. */
export const HEALTH_SMOKE_COLOR = '#a0a0a0';
/** One smoke cycle: each of the three puffs rises through the slot once per period. */
export const HEALTH_SMOKE_PERIOD_MS = 900;
/** Side of one smoke puff, in world px. */
export const HEALTH_SMOKE_PUFF_PX = 2;
/** Pause mark over a stalled agent: warm amber, distinct from the alarm yellows above. */
export const HEALTH_PAUSE_COLOR = '#e0b84a';
/** One pause bar, and the gap between the two, in world px. */
export const HEALTH_PAUSE_BAR_WIDTH_PX = 2;
export const HEALTH_PAUSE_BAR_HEIGHT_PX = 6;
export const HEALTH_PAUSE_BAR_GAP_PX = 2;
/** Puffs in the smoke, a third of a cycle apart. */
export const HEALTH_SMOKE_PUFFS = 3;
/** A dead agent's sprite: the canvas filter that grays it, and the fade used where the
 *  canvas has no filter. */
export const DEAD_CHARACTER_FILTER = 'grayscale(1)';
export const DEAD_CHARACTER_ALPHA = 0.55;

// ── Rendering - Overlay Colors (canvas, not CSS) ─────────────
export const SEAT_OWN_COLOR = 'rgba(0, 127, 212, 0.35)';
export const SEAT_AVAILABLE_COLOR = 'rgba(0, 200, 80, 0.35)';
export const SEAT_BUSY_COLOR = 'rgba(220, 50, 50, 0.35)';
export const GRID_LINE_COLOR = 'rgba(255,255,255,0.12)';
export const VOID_TILE_OUTLINE_COLOR = 'rgba(255,255,255,0.08)';
export const VOID_TILE_DASH_PATTERN: [number, number] = [2, 2];
export const GHOST_BORDER_HOVER_FILL = 'rgba(60, 130, 220, 0.25)';
export const GHOST_BORDER_HOVER_STROKE = 'rgba(60, 130, 220, 0.5)';
export const GHOST_BORDER_STROKE = 'rgba(255, 255, 255, 0.06)';
export const GHOST_VALID_TINT = '#00ff00';
export const GHOST_INVALID_TINT = '#ff0000';
export const SELECTION_HIGHLIGHT_COLOR = '#007fd4';
export const DELETE_BUTTON_BG = 'rgba(200, 50, 50, 0.85)';
export const ROTATE_BUTTON_BG = 'rgba(50, 120, 200, 0.85)';
export const BUTTON_ICON_COLOR = '#fff';
export const CANVAS_FALLBACK_TILE_COLOR = '#444';
export const CANVAS_ERROR_TILE_COLOR = '#FF00FF';
export const WALL_COLOR = '#3A3A5C';

// ── Camera ───────────────────────────────────────────────────
/** Share of the gap the follow closes per frame at CAMERA_FOLLOW_LERP_FPS (time-based at any rate). */
export const CAMERA_FOLLOW_LERP = 0.1;
export const CAMERA_FOLLOW_LERP_FPS = 60;
/** Device px: within this of its goal on both axes the follow lands on it and stops. */
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5;

// ── Zoom ─────────────────────────────────────────────────────
/** Zoom is device px per WORLD px. Art is ART_DENSITY art px per world px, so an art px is
 *  zoom / 2 device px: every even zoom keeps it whole. Two exceptions: 1, drawn from a 2x2
 *  downsample, for whole-map views on small panels; and 3 (art px 1.5 device px, nearest
 *  neighbour), because the 25x20 office beside the monitor rail on a 1080p screen fits at 3 and
 *  would otherwise drop to 2 and fill half the stage. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 20;
export const ZOOM_STEP = 2;
/** The one odd level above ZOOM_MIN. */
export const ZOOM_ODD_LEVEL = 3;
export const ZOOM_LEVELS: readonly number[] = [
  ZOOM_MIN,
  ...Array.from({ length: ZOOM_MAX / ZOOM_STEP }, (_, i) => (i + 1) * ZOOM_STEP),
  ZOOM_ODD_LEVEL,
].sort((a, b) => a - b);
export const ZOOM_DEFAULT_DPR_FACTOR = 2;
export const ZOOM_SCROLL_THRESHOLD = 50;

// ── Editor ───────────────────────────────────────────────────
export const UNDO_STACK_MAX_SIZE = 50;
export const LAYOUT_SAVE_DEBOUNCE_MS = 500;

// ── Layout Import/Export (browser-native, standalone) ────────
/** Suggested filename when exporting the office layout from the standalone browser. */
export const LAYOUT_EXPORT_FILENAME = 'pixelmates-layout.json';
/** MIME type for the exported layout Blob. */
export const LAYOUT_EXPORT_MIME = 'application/json';
export const DEFAULT_FLOOR_COLOR: ColorValue = { h: 35, s: 30, b: 15, c: 0 };
export const DEFAULT_WALL_COLOR: ColorValue = { h: 240, s: 25, b: 0, c: 0 };
export const DEFAULT_NEUTRAL_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

// ── Carpets ──────────────────────────────────────────────────
/** Main (lowest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_COLOR: ColorValue = { h: 0, s: 71, b: -32, c: 0, colorize: true };
/** Accent (highest-luminance) color applied to carpets when no per-tile override is set. */
export const CARPET_DEFAULT_ACCENT_COLOR: ColorValue = {
  h: 34,
  s: 64,
  b: 21,
  c: 0,
  colorize: true,
};
/** Keyboard key that switches from CARPET_PAINT to CARPET_PICK while editing. */
export const KEY_CARPET_PICK = 'p';

// ── Areas (named, colored workspace-folder zones) ────────────
/** Color palette assigned to new Areas in rotation (cycles when more areas exist). */
export const AREA_DEFAULT_COLORS: readonly string[] = [
  '#ff6b6b',
  '#feca57',
  '#48dbfb',
  '#1dd1a1',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#ffa502',
] as const;
/** Translucent overlay alpha for area tile fills. */
export const AREA_OVERLAY_ALPHA = 0.25;
/** Alpha multiplier applied to the actively-selected area's overlay. */
export const AREA_ACTIVE_ALPHA_MULTIPLIER = 1.6;
/** Base font size (pixel-pre-zoom) of a room plaque: with its border and shadow it fills one wall tile band. */
export const AREA_LABEL_FONT_SIZE_PX = 8;
/** Minimum on-screen label size to keep labels legible at low zoom. */
export const AREA_LABEL_MIN_FONT_SIZE_PX = 12;
/** Alpha of the area label text. */
export const AREA_LABEL_ALPHA = 1.0;
/** Fallback label color when an area has no color set (shouldn't happen in practice). */
export const AREA_LABEL_FALLBACK_COLOR = '#ffffff';
/** Drop-shadow color behind area labels for legibility on light backgrounds. */
export const AREA_LABEL_SHADOW_COLOR = '#000000';
/** Drop-shadow alpha behind area labels. */
export const AREA_LABEL_SHADOW_ALPHA = 0.6;

// ── VisualColorPicker (HSV wheel + brightness for carpets) ───
export const VISUAL_COLOR_PICKER_SV_SIZE_PX = 180;
export const VISUAL_COLOR_PICKER_HUE_WIDTH_PX = 20;
export const VISUAL_COLOR_PICKER_MARKER_RADIUS_PX = 6;
/**
 * The hue bar gradient is intrinsic to the color-picking interaction, not a
 * theme color — it must span the full hue circle. Centralized here so the
 * component body stays free of inline color literals. (The saturation/brightness
 * square is painted to a canvas from the carpet HSL model, not a CSS gradient.)
 */
export const VISUAL_COLOR_PICKER_HUE_GRADIENT =
  'linear-gradient(to bottom, ' +
  '#ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, ' +
  '#00ffff 50%, #0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)';
export const VISUAL_COLOR_PICKER_MARKER_BORDER = '2px solid #fff';
export const VISUAL_COLOR_PICKER_MARKER_SHADOW = '0 0 0 1px rgba(0,0,0,0.6)';
/** Width of the collapsed swatch + hex trigger row (compact mode). */
export const VISUAL_COLOR_PICKER_COMPACT_WIDTH_PX = 160;
/** Swatch square size shown in the collapsed trigger. */
export const VISUAL_COLOR_PICKER_SWATCH_PX = 22;
/** Gap (px) between the collapsed trigger and the expanded popup panel. */
export const VISUAL_COLOR_PICKER_POPUP_GAP_PX = 6;

// ── Notification Sound (done: ascending chime) ─────────────
export const NOTIFICATION_NOTE_1_HZ = 659.25; // E5
export const NOTIFICATION_NOTE_2_HZ = 1318.51; // E6 (octave up)
export const NOTIFICATION_NOTE_1_START_SEC = 0;
export const NOTIFICATION_NOTE_2_START_SEC = 0.1;
export const NOTIFICATION_NOTE_DURATION_SEC = 0.18;
export const NOTIFICATION_VOLUME = 0.14;

// ── Permission Sound (attention: descending double tap) ────
export const PERMISSION_NOTE_1_HZ = 880; // A5
export const PERMISSION_NOTE_2_HZ = 659.25; // E5 (down a fourth)
export const PERMISSION_NOTE_1_START_SEC = 0;
export const PERMISSION_NOTE_2_START_SEC = 0.12;
export const PERMISSION_NOTE_DURATION_SEC = 0.15;
export const PERMISSION_VOLUME = 0.12;

// Tripwire alarm: two quick alternating tones, harsher than the chimes above
export const ALARM_NOTE_1_HZ = 987.77; // B5
export const ALARM_NOTE_2_HZ = 740; // F#5
export const ALARM_NOTE_1_START_SEC = 0;
export const ALARM_NOTE_2_START_SEC = 0.14;
export const ALARM_NOTE_DURATION_SEC = 0.12;
export const ALARM_VOLUME = 0.14;

// ── Version Notice ──────────────────────────────────────────
export const WHATS_NEW_AUTO_CLOSE_MS = 20000;
export const WHATS_NEW_FADE_MS = 1000;

// ── Game Logic ───────────────────────────────────────────────
export const MAX_DELTA_TIME_SEC = 0.1;

// ── Render loop ──────────────────────────────────────────────
/** While anything moves the canvas draws at most this often: the art steps at 0.15 s at the fastest. */
export const ACTIVE_FPS_CAP = 30;
/** A frame this early still draws: animation-frame timestamps jitter around the display interval. */
export const ACTIVE_FRAME_SLACK_MS = 1;
/** Keep drawing every frame this long after the last activity or wake, so a short gap never drops to the timer. */
export const ACTIVE_LINGER_MS = 500;
/** Timer tick of a quiet office: the world steps every tick so every timer keeps wall time. */
export const IDLE_TICK_MS = 100;
/** One timer-tick step. Equal to the per-frame clamp, so a dt timer sees the same steps either way. */
export const IDLE_STEP_SEC = MAX_DELTA_TIME_SEC;
/** A late timer catches up at most this many steps at once. */
export const MAX_IDLE_SUBSTEPS = 10;
/** With nothing moving the canvas still redraws this often, for the light of the hour. */
export const IDLE_REDRAW_MS = 1000;

export const WAITING_BUBBLE_DURATION_SEC = 2.0;
export const DISMISS_BUBBLE_FAST_FADE_SEC = 0.3;
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0;
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0;
/** Default/fallback palette count (bundled characters). Actual count comes from getLoadedCharacterCount(). */
export const PALETTE_COUNT = 12;
export const AUTO_ON_FACING_DEPTH = 3;
export const CHARACTER_HIT_HALF_WIDTH = 8;
export const CHARACTER_HIT_HEIGHT = 24;
export const TOOL_OVERLAY_VERTICAL_OFFSET = 32;
/** Seat pitch in tiles: a nameplate may not be wider than one pod's slot minus a gap. The layout
 *  validator guarantees pods sit at least this far apart, so neighbouring plates never overlap. */
export const COMPACT_LABEL_SEAT_PITCH_TILES = 2.5;
export const COMPACT_LABEL_GAP_PX = 8;
/** Below this width a nameplate is just a marker (it would be a few letters of ellipsis). */
export const COMPACT_LABEL_MIN_WIDTH_PX = 90;
/** Unit of the label layout's displacement budget (LABEL_LAYOUT_MAX_DISPLACEMENT_LINES of these), CSS px. */
export const COMPACT_LABEL_LINE_HEIGHT_PX = 18;
/** Clear space between the character's feet and a plate placed below them, CSS px. */
export const COMPACT_LABEL_FEET_GAP_PX = 2;
/** World px between the head top and a plate placed above it. */
export const NAMEPLATE_HEAD_GAP_PX = 2;
/** Extra world px the plate rises when something else owns the slot right above the head: a speech
 *  bubble, the idle glyph, the napping Zz or the tripwire beacon, all drawn on the canvas. */
export const NAMEPLATE_SLOT_CLEARANCE_PX = 16;
/** Height of a character sprite frame, px: its head top row is measured from its top edge. */
export const CHARACTER_SPRITE_HEIGHT_PX = 32;
/** The head box overlay plates must keep clear of: the sprite's top rows, a little wider than the body. */
export const CHARACTER_HEAD_WIDTH_PX = 32;
export const CHARACTER_HEAD_HEIGHT_PX = 24;
/** Plates scale with the zoom relative to the zoom at which the whole map fits, between these. */
export const PLATE_SCALE_MIN = 0.6;
export const PLATE_SCALE_MAX = 1.5;
/** Plates scale against the whole-map fit, but never against less than this: at a fit of 1 every
 *  zoom would read as a big multiple and the plates would sit at their cap. */
export const PLATE_SCALE_FIT_FLOOR = 2;
/** Zoom level (the HUD's "Nx", zoom / ART_DENSITY) up to which plates are one-line compact. */
export const PLATE_COMPACT_MAX_LEVEL = 3;
/** Compact plate: one line (medal, name, state), fixed size (not scaled), a little see-through. */
export const NAMEPLATE_COMPACT_FONT_PX = 13;
export const NAMEPLATE_COMPACT_LINE_PX = 16;
export const NAMEPLATE_COMPACT_BG = 'rgba(59, 36, 18, 0.80)';
/** Nameplate box, CSS px (the line heights are PLATE_FULL_* and NAMEPLATE_COMPACT_LINE_PX). */
export const NAMEPLATE_PAD_Y_PX = 2;
export const NAMEPLATE_BORDER_PX = 3;
/** Hard shadow under the plate (`.nameplate` in index.css) and the gap before the tripwire pill. */
export const NAMEPLATE_SHADOW_PX = 3;
/** Plate colors. The border and shadow are the same for every tier; the medal shows the tier. */
export const NAMEPLATE_BG = '#3b2412';
export const NAMEPLATE_BORDER_COLOR = '#1e120a';
export const NAMEPLATE_TEXT_COLOR = '#fff4dc';
export const NAMEPLATE_PILL_HEIGHT_PX = 18;
export const NAMEPLATE_PILL_GAP_PX = 2;
/** Gap between neighbouring items of the overlay stack above a head (plate, chip, bubble), CSS px. */
export const OVERLAY_STACK_GAP_PX = 2;
/** Extra clearance a displaced label keeps from what it was pushed off, CSS px. */
export const LABEL_LAYOUT_PAD_PX = 2;
/** A label pushed further than this many lines stays put and dims instead. */
export const LABEL_LAYOUT_MAX_DISPLACEMENT_LINES = 3;
export const LABEL_LAYOUT_DIM_OPACITY = 0.35;
/** Room sign plate: padding and per-glyph width estimate (no measureText, so it stays pure). */
export const AREA_SIGN_PADDING_PX = 2;
export const AREA_SIGN_GLYPH_WIDTH_EM = 0.4;
/** Room plaque in the wall palette: plate, border (also the hard bottom shadow) and ink text. */
export const AREA_SIGN_PLATE_COLOR = '#d9b989';
export const AREA_SIGN_BORDER_COLOR = '#6b4128';
export const AREA_SIGN_TEXT_COLOR = '#3b2412';
/** Plaque border and bottom shadow thickness, in zoom px (world px, scaled by the zoom). */
export const AREA_SIGN_BORDER_PX = 3;
export const AREA_SIGN_SHADOW_PX = 2;
/** Thin usage bar along the bottom of a room sign: track colour and height in world px. */
export const AREA_SIGN_USAGE_TRACK_COLOR = 'rgba(255, 255, 255, 0.18)';
export const AREA_SIGN_USAGE_BAR_HEIGHT_PX = 1;
/** "z" glyph of an idle agent. */
export const IDLE_GLYPH_COLOR = '#b8c4e0';
export const IDLE_GLYPH_SHADOW_COLOR = 'rgba(0, 0, 0, 0.6)';

// ── Greeter + Intro bubble ──────────────────────────────────
/** Reserved character id for the Intro's greeter. Far outside both real agent
 *  ids (positive) and sub-agent ids (small negatives from -1 down). */
export const GREETER_ID = -1_000_000_000;
/** Stacking order for the Intro's bubble. Deliberately BELOW the modal stack
 *  (ui/Modal defaults to 50, ChangelogModal 51, the migration notice z-100): the
 *  Intro is diegetic furniture over the office, not a modal, so a modal opened
 *  on top of it must cover it rather than slide underneath. */
export const INTRO_BUBBLE_Z_INDEX = 45;
/** The greeter stands this many tiles in from the office's bottom-left corner
 *  (target tile (margin, rows-1-margin); nearest walkable tile if blocked). */
export const GREETER_TILE_MARGIN = 3;
/** World px above the greeter's anchor (feet) where the bubble's bottom sits.
 *  Kept well above the head target (INTRO_TAIL_TARGET_RISE_WORLD) so the
 *  tail squares have a visible run between bubble and head. */
export const INTRO_BUBBLE_ANCHOR_RISE_WORLD = 44;
/** World px right of the greeter's center where the bubble's left edge starts —
 *  just clear of the sprite so the tail points down-left at the head. */
export const INTRO_BUBBLE_OFFSET_X_WORLD = 10;
/** Bubble width cap (CSS px) and the margin kept from the container edges.
 *  Wide on purpose: the disclosure reads as three short paragraphs instead of
 *  a tall column (still clamped to the container on narrow panels). */
export const INTRO_BUBBLE_MAX_WIDTH_PX = 560;
export const INTRO_BUBBLE_EDGE_MARGIN_PX = 4;
/** Where the Intro's Claude Code step sends people who don't have it yet. */
export const CLAUDE_CODE_URL = 'https://claude.com/claude-code';
export const CLAUDE_CODE_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
/** Speech-tail squares: placed at fraction `t` along the segment from the
 *  bubble's nearest edge point to the greeter's head, shrinking toward the
 *  speaker. Recomputed every frame so the tail stays connected no matter where
 *  edge-clamping or panning puts the bubble relative to the character. */
export const INTRO_TAIL_STEPS = [
  { t: 0.25, size: 12 },
  { t: 0.55, size: 9 },
  { t: 0.82, size: 6 },
] as const;
/** World px above the greeter's anchor (feet) the tail points at — the head. */
export const INTRO_TAIL_TARGET_RISE_WORLD = 26;
/** Camera-offset caps while centering character + bubble. The ideal composition
 *  assumes the bubble fits beside/above the character; when it can't (narrow or
 *  short viewports clamp the bubble to the screen), uncapped offsets shove the
 *  greeter to the viewport edge. Horizontal offset is capped to this fraction
 *  of the viewport; vertical offset always keeps this many world px of the
 *  character visible above the bottom edge. */
export const INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION = 0.25;
export const INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD = 48;
/** Extra downward camera shift (CSS px) so the character+bubble composition
 *  sits a bit above the vertical center instead of dead-centered. */
export const INTRO_CAMERA_DOWN_SHIFT_PX = 50;

// ── Context Fuel Gauge ──────────────────────────────────────
/** Window assumed before the runtime reports one (it always does for agents
 *  that have taken a turn; this only covers characters created ahead of it). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
export const CONTEXT_WARN_THRESHOLD = 0.6;
export const CONTEXT_DANGER_THRESHOLD = 0.8;
export const CONTEXT_CRITICAL_THRESHOLD = 0.95;
export const CONTEXT_GAUGE_WIDTH_PX = 40;
export const CONTEXT_GAUGE_HEIGHT_PX = 4;
export const CONTEXT_GAUGE_COLOR_OK = '#44cc44';
export const CONTEXT_GAUGE_COLOR_WARN = '#ffcc00';
export const CONTEXT_GAUGE_COLOR_DANGER = '#ff8800';
export const CONTEXT_GAUGE_COLOR_CRITICAL = '#ff2222';
export const CONTEXT_GAUGE_BG = '#222';

// ── Agent Teams ─────────────────────────────────────────────
export const TEAM_LEAD_COLOR = '#ffd700';
export const TEAM_ROLE_COLOR = '#66aaff';

// ── Pets ────────────────────────────────────────────────────────
/** Walking speed in world pixels per second (matches character walk speed visually but slower). */
export const PET_WALK_SPEED_PX_PER_SEC = 32;
/** Time per WALK animation cycle step (4 cycle steps × 0.15s = 0.6s per loop). */
export const PET_WALK_FRAME_DURATION_SEC = 0.15;
/** Time per IDLE animation cycle step (4 cycle steps × 0.3s = 1.2s per loop). */
export const PET_IDLE_FRAME_DURATION_SEC = 0.3;
/** Walk cycle: 4-step lookup into the 3-frame walkDown/walkUp/walkRight arrays. */
export const PET_WALK_SEQUENCE = [0, 1, 0, 2] as const;
/** Idle cycle: 4-step lookup into the 3-frame idleDown/idleUp arrays. */
export const PET_IDLE_SEQUENCE = [0, 1, 2, 1] as const;
/** A sleeping pet holds this frame of its sitting row: the sheets have no curled pose, and frame
 *  1 is the blink (eyes shut). */
export const PET_SLEEP_FRAME = 1;
/** Minimum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MIN_SEC = 3.0;
/** Maximum seconds the pet stays in IDLE before making a new decision. */
export const PET_WANDER_PAUSE_MAX_SEC = 15.0;
/** Seconds between FOLLOW path re-computations. */
export const PET_FOLLOW_RECALC_INTERVAL_SEC = 1.0;
/** Probability that a pet enters FOLLOW (instead of WALK) when wanderTimer expires. */
export const PET_FOLLOW_CHANCE = 0.3;
/** Maximum Manhattan distance (tiles) at which a character can become a follow target. */
export const PET_FOLLOW_RADIUS_TILES = 3;
/** Minimum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MIN_SEC = 5.0;
/** Maximum seconds a FOLLOW episode lasts before timing out. */
export const PET_FOLLOW_DURATION_MAX_SEC = 15.0;
/** Hit-box half-width (world px) for pet click detection. */
export const PET_HIT_HALF_WIDTH = 8;
/** Hit-box height (world px) measured upward from the bottom-center anchor. */
export const PET_HIT_HEIGHT = 16;
/** Zoom factor used to draw pet thumbnails in the EditorToolbar Pets tab. */
export const PET_THUMB_ZOOM = 2;
/** Scale margin so the pet thumbnail fills the ItemSelect cell without touching the edges. */
export const PET_THUMB_SCALE_MARGIN = 0.85;
/** Fallback background fill for sprite-less thumbnail (used while pet sprites are loading). */
export const EMPTY_SPRITE_THUMBNAIL_BG = '#333';
/** Maximum string length for a PlacedPet.id (defends against pathologically-long layout entries). */
/** Id of the cozy layout's cat: it lives in the lobby. */
export const LOBBY_CAT_ID = 'cozy-lobby-cat';
export const MAX_PET_ID_LENGTH = 128;

// ── Model look (rarity, equipment, companion) ───────────────────
/** Rarity colors, the same four everywhere the look shows: label plate, outline, shimmer. */
export const RARITY_COLORS = {
  common: '#9d9d9d',
  rare: '#3d8bff',
  epic: '#a335ee',
  legendary: '#ff8000',
} as const;
/** Equipment in front of the body sorts just after it, so it is never hidden by it. */
export const ACCESSORY_FRONT_Z_OFFSET = 0.001;
/** A cape behind the body sorts between the rarity outline (-0.001) and the body. */
export const CAPE_BEHIND_Z_OFFSET = 0.0005;
/** A cape facing away from the camera (up) hangs over the body instead. */
export const CAPE_OVER_Z_OFFSET = 0.0005;
/** Sparkle twinkle cycle: alpha swings between the floor and 1 over this period. */
export const SPARKLE_PERIOD_MS = 1400;
export const SPARKLE_MIN_ALPHA = 0.2;
/** Companion hover height for flying kinds (bird, dragon), world px. */
export const COMPANION_HOVER_PX = 6;
/** Flying companions bob 1 px up every this many seconds. */
export const COMPANION_BOB_INTERVAL_SEC = 0.4;
/** Companion glide speed toward its tile, world px/s. Faster than the agent so it keeps up. */
export const COMPANION_SPEED_PX_PER_SEC = 64;
export const COMPANION_IDLE_FRAME_DURATION_SEC = 0.6;
export const COMPANION_MOVE_FRAME_DURATION_SEC = 0.15;
/** Gap between a companion's feet and the bottom of its tile, world px. */
export const COMPANION_FEET_INSET_PX = 2;
/** Tiles an agent has left behind that a companion remembers; it only ever uses the last one. */
export const COMPANION_TRAIL_LENGTH = 2;
/** A companion standing on a desk sorts this far in front of the desk's bottom edge, world px. */
export const COMPANION_DESK_Z_OFFSET = 0.01;
/** Outline of the legendary label plate shimmers once per this many seconds. */
export const RARITY_SHIMMER_SEC = 2.4;

// ── Cozy look: shadows ──────────────────────────────────────────
/** Oval under every character. Sub-agents and companions get the small one. */
export const SHADOW_COLOR = 'rgba(40, 20, 10, 0.28)';
export const SHADOW_SIZE_PX = { w: 12, h: 4 } as const;
export const SHADOW_SMALL_SIZE_PX = { w: 8, h: 3 } as const;
/** Sorts just under the rarity outline (-OUTLINE_Z_SORT_OFFSET), so the oval is never over a body. */
export const SHADOW_Z_SORT_OFFSET = 0.002;

// ── Cozy look: lighting ─────────────────────────────────────────
/** Local-time phases, in minutes after midnight. Dawn 06:00-06:59, golden hour 16:00-19:59,
 *  night 20:00-05:59, plain daylight otherwise. */
export const LIGHT_DAWN_START_MIN = 6 * 60;
export const LIGHT_DAY_START_MIN = 7 * 60;
export const LIGHT_GOLDEN_START_MIN = 16 * 60;
export const LIGHT_NIGHT_START_MIN = 20 * 60;
/** Tint over the map (DOM, soft-light) and the glow strengths, per phase. Strengths are 0..1
 *  multipliers on the cached glow sprites; 0 means that glow is not drawn in that phase. */
export const LIGHT_PHASES = {
  night: {
    // No DOM tint at night: the canvas darkening pass (NIGHT_DARKEN_*) is the only darkening.
    tint: null,
    monitorGlow: 0.75,
    lampGlow: 0.6,
  },
  dawn: {
    tint: { color: '#ffb0a0', alpha: 0.15 },
    monitorGlow: 0.4,
    lampGlow: 0.3,
  },
  day: { tint: null, monitorGlow: 0.3, lampGlow: 0 },
  golden: {
    tint: { color: '#ff9a3c', alpha: 0.28 },
    monitorGlow: 0.45,
    lampGlow: 0.35,
  },
} as const;
/** Glow radii in tiles, and how far below its anchor tile a monitor glow is centered so it
 *  lights the face or the desk without painting the wall row above. */
export const GLOW_MONITOR_RADIUS_TILES = 2;
export const GLOW_LAMP_RADIUS_TILES = 2.5;
export const GLOW_DOWN_OFFSET_TILES = 0.5;
/** Glow gradient stops per kind: [offset 0..1 from the centre (top, for the fairy band), color]. */
export const GLOW_COLORS = {
  monitor: {
    stops: [
      [0, 'rgba(207, 232, 255, 0.4)'],
      [1, 'rgba(207, 232, 255, 0)'],
    ],
  },
  lamp: {
    stops: [
      [0, 'rgba(255, 200, 110, 0.55)'],
      [1, 'rgba(255, 200, 110, 0)'],
    ],
  },
  lampPool: {
    stops: [
      [0, 'rgba(255, 200, 120, 0.38)'],
      [0.55, 'rgba(255, 200, 120, 0.16)'],
      [1, 'rgba(255, 200, 120, 0)'],
    ],
  },
  monitorPool: {
    stops: [
      [0, 'rgba(120, 255, 200, 0.3)'],
      [0.7, 'rgba(120, 255, 200, 0)'],
      [1, 'rgba(120, 255, 200, 0)'],
    ],
  },
  fairyBand: {
    stops: [
      [0, 'rgba(255, 220, 150, 0.3)'],
      [1, 'rgba(255, 220, 150, 0)'],
    ],
  },
  fairy: {
    stops: [
      [0, 'rgba(255, 224, 150, 0.8)'],
      [1, 'rgba(255, 224, 150, 0)'],
    ],
  },
} as const satisfies Record<string, { stops: ReadonlyArray<readonly [number, string]> }>;
/** The floor pools (lamp, monitor, fairy band) are laid on with this blend, so they lift the
 *  darkened scene toward their color instead of washing it out like `screen`. */
export const POOL_BLEND_MODE = 'soft-light';
/** Night pools on the floor: radius in tiles around a floor lamp's base and an active monitor. */
export const POOL_LAMP_RADIUS_TILES = 4;
/** A lamp pool is centered on the middle of the lamp's base tile, this many tiles below its top. */
export const POOL_LAMP_CENTER_ROWS = 1.5;
export const POOL_MONITOR_RADIUS_TILES = 2.5;
/** A monitor pool is centered this many tiles below the monitor's tile center (on the desk and the floor in front). */
export const POOL_MONITOR_DOWN_TILES = 1;
/** Fairy-light pool: a soft band along the wall under the string, as tall as this and as wide as the strand. */
export const POOL_FAIRY_BAND_HEIGHT_TILES = 1.5;
export const POOL_FAIRY_BAND_WIDTH_TILES = 4;
/** The band starts this far below the strand's top edge (under the sagging wire). */
export const POOL_FAIRY_BAND_TOP_TILES = 0.5;
/** Night darkening: the whole map is multiplied by this color at this alpha in the night phase,
 *  ramped linearly over NIGHT_RAMP_MIN before the phase starts and after it ends. */
export const NIGHT_DARKEN_COLOR = '#262c5c';
export const NIGHT_DARKEN_ALPHA = 0.42;
export const NIGHT_RAMP_MIN = 60;
/** Fairy-light bulb glow: radius in tiles, twinkle period, and the dimmest a bulb gets (share of
 *  full strength). Each bulb runs the same wave at its own phase. */
export const FAIRY_GLOW_RADIUS_TILES = 0.5;
export const FAIRY_TWINKLE_MS = 1800;
export const FAIRY_GLOW_MIN = 0.35;
/** Phase offset between neighbouring bulbs, in periods (the golden ratio, so no visible chase). */
export const FAIRY_PHASE_STEP = 0.618034;
/** Map vignette: lighter than the first pass so the corners stay readable. One string, so the
 *  DOM layer and anything that inspects it share a single source. */
export const VIGNETTE_COLOR = 'rgba(50, 20, 5, 0.22)';
export const VIGNETTE_CLEAR_RADIUS_PCT = 65;
export const VIGNETTE_CENTER = '50% 55%';
export const VIGNETTE_BACKGROUND = `radial-gradient(ellipse at ${VIGNETTE_CENTER}, transparent ${VIGNETTE_CLEAR_RADIUS_PCT}%, ${VIGNETTE_COLOR})`;

// ── Cozy look: window light shafts ──────────────────────────────
/** A shaft is a parallelogram on the floor below a window, centered on it: width at the sill and
 *  length in tiles, and the angle its sides lean from vertical. */
export const SHAFT_WIDTH_TILES = 3;
export const SHAFT_LENGTH_TILES = 4;
export const SHAFT_SKEW_DEG = 20;
/** Shaft color at the two keyframe times (minutes after midnight). Before the first keyframe
 *  the morning color holds, after the last the evening color holds; the shaft is off from
 *  SHAFT_OFF_START_MIN to LIGHT_DAY_START_MIN. */
export const SHAFT_MORNING = { minute: 9 * 60, r: 255, g: 236, b: 190, alpha: 0.3 } as const;
export const SHAFT_EVENING = { minute: 18 * 60, r: 255, g: 170, b: 110, alpha: 0.19 } as const;
/** The 1 art px rim on the shaft's left side, at full strength (scaled with the shaft's alpha). */
export const SHAFT_EDGE_COLOR = '#ffffff';
export const SHAFT_EDGE_ALPHA = 0.18;
/** Window light ends here (the cat's nap may start); it is back at LIGHT_DAY_START_MIN. An hour
 *  before the night phase, so 19:00-19:59 is dusk: no shafts, but day windows and no night lights. */
export const SHAFT_OFF_START_MIN = 19 * 60;
/** Cells sampled per side when measuring how much of a floor cell a shaft covers. */
export const SHAFT_COVERAGE_SAMPLES = 4;
/** CSS color for a shaft's rgb channels (alpha is applied through globalAlpha). */
export const shaftCss = (r: number, g: number, b: number): string => `rgb(${r}, ${g}, ${b})`;
/** Shafts are painted in their own composite pass with this blend, never `screen`. */
export const SHAFT_BLEND_MODE = 'soft-light';

// ── Cozy look: CRT monitors ─────────────────────────────────────
/** Furniture id prefix of a PC drawn with its screen on. */
export const MONITOR_ON_TYPE_PREFIX = 'PC_FRONT_ON';
/** Screen interior in the PC_FRONT sprites, in sprite px. */
export const MONITOR_SCREEN_RECT = { x: 4, y: 3, w: 8, h: 6 } as const;
/** Flicker tick, the number of ON frames it cycles, and the share of ticks a screen dims. */
export const MONITOR_FLICKER_TICK_MS = 300;
export const MONITOR_ON_FRAME_COUNT = 3;
export const MONITOR_DIM_ONE_IN = 4;
/** Overlays painted on the screen pixels only. */
export const MONITOR_GLOW_COLOR = '#cfe8ff';
export const MONITOR_GLOW_ALPHA = 0.1;
export const MONITOR_DIM_COLOR = '#000000';
export const MONITOR_DIM_ALPHA = 0.35;
export const MONITOR_SCANLINE_COLOR = '#000000';
export const MONITOR_SCANLINE_ALPHA = 0.1;
/** Scanlines are 1 device px every 2; below this many device px per sprite px they would
 *  swallow the screen, so they are not drawn. The renderer's zoom is already in device px. */
export const MONITOR_SCANLINE_MIN_ZOOM = 8;
/** A PC at a seat nobody holds: its screen glass, in art px of the PC_FRONT sprites, painted
 *  this flat dark color (no glare). */
export const MONITOR_SCREEN_ART_RECT = { x: 5, y: 4, w: 21, h: 13 } as const;
export const MONITOR_DARK_SCREEN_COLOR = '#4A4F5A';
/** A face-on chair at a seat nobody holds is pushed this many world px under the desk edge. */
export const CHAIR_TUCK_PX = 4;
/** Furniture ids that emit light. */
export const LIGHT_FIXTURE_WINDOW = 'WINDOW';
export const LIGHT_FIXTURE_LAMP = 'FLOOR_LAMP';
export const LIGHT_FIXTURE_FAIRY = 'FAIRY_LIGHTS';
/** Footprint of the window (tiles) and the lamp head's height above the lamp's top tile, world px. */
export const WINDOW_FOOTPRINT_W_TILES = 2;
export const WINDOW_FOOTPRINT_H_TILES = 2;
export const LAMP_HEAD_OFFSET_PX = 6;
/** Stage clock refresh, ms. */
export const HUD_CLOCK_REFRESH_MS = 15_000;
/** Stage clock active-agent count refresh, ms (reads the characters' status, which is not React state). */
export const HUD_ACTIVE_REFRESH_MS = 500;
/** The bottom bar fades out after this long without the pointer moving over the stage. */
export const BOTTOM_BAR_IDLE_HIDE_MS = 3_000;

// ── Official usage limits (status line wrapper) ─────────────────
/** Hook provider ids the Settings checkboxes toggle (HookProvider.id on the server). */
export const CLAUDE_HOOKS_PROVIDER_ID = 'claude';
export const CLAUDE_STATUSLINE_PROVIDER_ID = 'claude-statusline';
/** Refresh of the "resets in" countdowns and the staleness label, ms. */
export const USAGE_LIMITS_TICK_MS = 30_000;

// ── Cozy look: camera fit ───────────────────────────────────────
/** Canvas left free around the framed rooms (or the whole map), in CSS px: a fixed length, not a tile count. */
export const FIT_PADDING_CSS_PX = 8;
/** Furniture type that marks the lounge: the Area holding it is the lounge room. */
export const LOUNGE_FURNITURE_TYPE = 'COFFEE_TABLE';
/** The fit frames at least this many rooms (or the whole map when it has fewer). */
export const FIT_MIN_ROOMS = 2;
export const FIT_CENTER_EASE_MS = 300;

// ── Cozy FX: XP pops, level-ups, mood weather ───────────────────
/** At most this many pops and level-ups play at once, office-wide. Weather is outside this budget. */
export const FX_MAX_CONCURRENT = 3;
/** Level-ups over the budget wait here; the oldest is dropped past this. */
export const FX_LEVEL_UP_QUEUE_MAX = 6;
/** An XP pop ("+60 commit") lives this long: one DOM element that rises FX_POP_RISE_PX over it. */
export const FX_POP_MS = 2400;
export const FX_SPARKLE_MS = 600;
export const FX_SPARKLE_PARTICLES = 6;
export const FX_LEVEL_UP_MS = 2500;
export const FX_PILLAR_MS = 1200;
export const FX_CONFETTI_MS = 1600;
export const FX_CONFETTI_PARTICLES = 16;
/** Confetti gravity, world px/s^2. */
export const FX_CONFETTI_GRAVITY = 90;
export const FX_PILLAR_HEIGHT_PX = 56;
export const FX_PILLAR_WIDTH_PX = 14;
export const FX_PILLAR_TOP_COLOR = 'rgba(255, 240, 150, 0)';
export const FX_PILLAR_BOTTOM_COLOR = 'rgba(255, 230, 110, 0.75)';
export const FX_SPARKLE_COLORS = ['#fff2b0', '#ffd65a'] as const;
export const FX_CONFETTI_COLORS = ['#ffe066', '#5fb85a', '#3d8bff', '#ff6b6b', '#fff4dc'] as const;
export const FX_TEXT_COLOR = '#ffe066';
export const FX_TEXT_OUTLINE = '#3b2412';
export const FX_POP_RISE_PX = 70;
/** FX text outline thickness, CSS px (four-direction text-shadow). */
export const FX_TEXT_OUTLINE_PX = 2;
export const FX_TEXT_FONT_PX = 22;
export const FX_BANNER_FONT_PX = 26;
/** Storm clouds last this long after the frustrated mood starts, fading over the last part. */
export const FX_STORM_MS = 20_000;
export const FX_STORM_FADE_MS = 2000;
export const FX_STORM_MAX = 2;
export const FX_STORM_CLOUD_COLOR = '#b9bfcc';
export const FX_STORM_CLOUD_SHADE = '#8a90a0';
export const FX_STORM_BOLT_COLOR = '#ffe066';
export const FX_RAIN_COLOR = '#8fc6ff';
export const FX_RAIN_DROPS = 3;
export const FX_RAIN_PERIOD_MS = 700;
export const FX_HEART_COLOR = '#ff6b8a';
export const FX_HEART_MS = 1500;
export const FX_HEART_RISE_PX = 10;
export const FX_HEART_REPEAT_MS = 30_000;
/** Office-wide: no second heart inside this window. */
export const FX_HEART_GLOBAL_GAP_MS = 10_000;
/** Weather floats this far above the bubble anchor, world px. */
export const FX_WEATHER_RISE_PX = 4;

// ── Cozy FX: desk props unlocked by level ───────────────────────
export const DESK_PROP_SLOTS_MAX = 2;
/** How many desk tiles either side of the monitor a prop slot may be. */
export const DESK_PROP_REACH_TILES = 3;
export const DESK_PROP_Z_OFFSET = 0.01;
/** Gap between a prop's base and the bottom of its desk tile, world px. */
export const DESK_PROP_FEET_INSET_PX = 5;

// ── Cozy FX: full box ───────────────────────────────────────────
/** Height one roster row adds to the full box, CSS px. */
export const FULL_BOX_ROW_PX = 14;
/** How far the full box's top sits above the character before any row, CSS px:
 *  one activity line, or the taller box with team, title, alarm or group lines. */
export const FULL_BOX_BASE_LIFT_PX = 28;
export const FULL_BOX_EXTRA_LINES_LIFT_PX = 34;
/** Below this many context tokens a cold cache costs nothing worth protecting, so
 *  the cache row stays hidden (the statusline's rule). */
export const CACHE_ROW_MIN_CONTEXT_TOKENS = 20_000;
/** Full box row per permission mode, worded like Claude Code's statusline. The
 *  default mode is the absence of a mode worth showing: no row. */
export const PERMISSION_MODE_ROW_TEXT: Record<PermissionMode, string | null> = {
  default: null,
  acceptEdits: 'accept edits on',
  plan: 'plan mode on',
  auto: 'auto mode on',
  bypassPermissions: 'bypass permissions on',
  dontAsk: "don't ask on",
};
export const FULL_BOX_XP_BAR_BG = '#e9d2a8';
export const FULL_BOX_XP_BAR_FILL = '#5fb85a';
export const FULL_BOX_STREAK_COLOR = '#ff8a2a';
export const FULL_BOX_MOOD_COLORS = {
  happy: '#5fb85a',
  neutral: '#9d9d9d',
  frustrated: '#8fc6ff',
  alarmed: '#ff4d4d',
} as const;

// ── Monitor layout (attention rail, inspector sheet) ────────────
/** Window width (CSS px) from which the rail is wide and the sheet takes layout space. */
export const MONITOR_WIDE_MIN_WIDTH_PX = 1600;
/** Window width from which the rail is mid; below it the rail is slim. */
export const MONITOR_RAIL_MID_MIN_WIDTH_PX = 1100;
/** Below this window height (a VS Code panel) the rail is slim and plates stay compact. */
export const MONITOR_MIN_FULL_HEIGHT_PX = 420;
export const MONITOR_RAIL_WIDE_PX = 360;
export const MONITOR_RAIL_MID_PX = 300;
export const MONITOR_RAIL_SLIM_PX = 76;
/** The inspector sheet's width: 420 px, or 380 px in a window up to 1440 wide, where it overlays a
 *  stage that is already narrow (the office re-fits into what it leaves uncovered). */
export const MONITOR_SHEET_PX = 420;
export const MONITOR_SHEET_NARROW_PX = 380;
export const MONITOR_SHEET_NARROW_MAX_WIDTH_PX = 1440;
/** The rail and sheet re-read their clocks this often: their ages are whole minutes. */
export const MONITOR_CLOCK_TICK_MS = 30_000;
/** localStorage key of privacy mode (P), a per-browser preference: '1' on, anything else off. */
export const MONITOR_PRIVACY_STORAGE_KEY = 'pixelmates.monitor.privacy';
/** Context share (%) at which a medal or context ring turns hot. */
export const MONITOR_RING_HOT_PCT = 85;

// ── Monitor plates, medals, crew banner and lines ───────────────
/** Full plates (the monitor): line 1 holds the alert tab, medal, name and state; line 2 the
 *  branch, the transcript's age and the artifacts. CSS px at plate scale 1. */
export const PLATE_FULL_LINE1_PX = 28;
export const PLATE_FULL_LINE2_PX = 20;
export const PLATE_FULL_NAME_FONT_PX = 20;
export const PLATE_FULL_STATE_FONT_PX = 16;
export const PLATE_FULL_SUB_FONT_PX = 14;
/** A helper's one-line plate: its run label and what it does. */
export const PLATE_HELPER_LINE_PX = 22;
export const PLATE_HELPER_FONT_PX = 16;
/** Horizontal padding inside a plate and the gap between its line-1 items. */
export const PLATE_PAD_X_PX = 6;
export const PLATE_ITEM_GAP_PX = 5;
/** Medal art: a 12 px grid, drawn at a whole multiple so its pixels stay square. */
export const MEDAL_GRID = 12;
export const MEDAL_FULL_PX = 24;
export const MEDAL_COMPACT_PX = 12;
/** Ring radii on the 12 px grid (outer, inner: two pixels thick) and where it turns hot. */
export const MEDAL_RING_OUTER = 6.0;
export const MEDAL_RING_INNER = 3.9;
export const MEDAL_HOT_FRACTION = 0.85;
export const MEDAL_HOLE_COLOR = '#22140a';
export const MEDAL_RING_FILL_COLOR = '#f6e3bd';
export const MEDAL_RING_HOT_COLOR = '#ec9277';
export const MEDAL_RING_TRACK_COLOR = '#5a3d27';
/** Tier glyph fill and highlight, tier 1 (dot) to 4 (cross). */
export const MEDAL_TIER_FILL = { 1: '#9ec99b', 2: '#8fb0e0', 3: '#ab9ce6', 4: '#ec9fd2' } as const;
export const MEDAL_TIER_HI = { 1: '#e2f3dc', 2: '#e0ebfb', 3: '#ece6ff', 4: '#ffe6f5' } as const;
/** Plate tones: the alert tab (gold waits on you, rust is stuck), state words, line 2, done. */
export const PLATE_WAIT_BG = '#f6c64a';
export const PLATE_WAIT_INK = '#3b2412';
export const PLATE_STUCK_BG = '#c0563f';
export const PLATE_STUCK_INK = '#fff4dc';
export const PLATE_STATE_COLOR = '#e9d2a8';
export const PLATE_CMD_COLOR = '#f2dcae';
export const PLATE_SUB_COLOR = '#d9c29b';
export const PLATE_DONE_COLOR = '#8fb09a';
/** An idle plate goes quiet: see-through, a fainter edge, no shadow. A monitor tag never dims by
 *  alpha (the office shows through it): it keeps the ink and says quiet in TAG_QUIET_TEXT. */
export const PLATE_QUIET_BG = 'rgba(59, 36, 18, 0.56)';
export const PLATE_QUIET_BORDER = 'rgba(30, 18, 10, 0.5)';
export const TAG_QUIET_TEXT = 'var(--mon-cream-3)';
/** The selected agent's plate while the inspector holds its details: paper and ink. */
export const PLATE_SELECTED_BG = '#f6e3bd';
export const PLATE_SELECTED_TEXT = '#3b2412';
export const PLATE_SELECTED_STATE = '#5a3a22';
/** Full plates may be wider than one seat: about two desk pitches, so neighbours alternate rows. */
export const PLATE_FULL_PITCH_TILES = 4;
export const PLATE_FULL_MIN_WIDTH_PX = 170;
export const PLATE_FULL_MAX_WIDTH_PX = 300;
/** The collision budget's line for full plates: one plate height moves a neighbour by one step. */
export const PLATE_FULL_LAYOUT_LINE_PX = 30;
/** Text width estimate for FS Pixel Sans, in em (measured: most glyphs 0.375, narrow ones less). */
export const PIXEL_FONT_GLYPH_EM = 0.375;
export const PIXEL_FONT_NARROW_EM = 0.16;
export const PIXEL_FONT_WIDE_EM = 0.5625;
/** The crew banner over a running workflow's helpers. */
export const CREW_BANNER_LABEL_FONT_PX = 12;
export const CREW_BANNER_NAME_FONT_PX = 20;
export const CREW_BANNER_CHIP_FONT_PX = 16;
export const CREW_BANNER_COUNT_FONT_PX = 16;
export const CREW_BANNER_ROW1_PX = 27;
export const CREW_BANNER_ROW2_PX = 25;
export const CREW_BANNER_ROW3_PX = 20;
export const CREW_BANNER_PAD_X_PX = 8;
export const CREW_BANNER_PAD_Y_PX = 4;
export const CREW_BANNER_BORDER_PX = 3;
export const CREW_BANNER_SHADOW_PX = 4;
export const CREW_BANNER_PIP_PX = 7;
export const CREW_BANNER_MAX_PIPS = 6;
/** Clear space between the banner's bottom and the helpers' heads, CSS px. */
export const CREW_BANNER_GAP_PX = 6;
/** Under every plate (40, helpers 39, plates with no room 37-38). */
export const CREW_BANNER_Z_INDEX = 36;
/** Crew lines on the office floor: ink with a paper edge, solid to crew helpers, dashed to sub-agents. */
export const CREW_LINE_COLOR = 'rgba(59, 36, 18, 0.9)';
export const CREW_LINE_EDGE_COLOR = 'rgba(246, 227, 189, 0.55)';
export const CREW_LINE_DASH = [4, 3] as const;
/** Secondary and tertiary ink on the banner's paper. */
export const CREW_BANNER_INK_2 = '#5a3a22';
export const CREW_BANNER_INK_3 = '#7a5a3c';
/** Full plates beside the rail scale with the map's CSS size (zoom / dpr): 1 at this many CSS px
 *  per world px, so a plate keeps its share of the map on a 1x and a 2x screen alike. */
export const PLATE_FULL_REF_CSS_ZOOM = 2.5;
/** Smallest line-1 text a full plate beside the rail may draw, CSS px: read from two metres on a
 *  1080p screen. It floors the plates' scale at the smallest line-1 font. */
export const PLATE_FULL_MIN_TEXT_PX = 14;
/** Side-by-side plates keep this much air between them. */
export const PLATE_SIDE_GAP_PX = 6;
/** A cut text on a plate (a branch, the state words) keeps at least this much (em), so it still
 *  reads as a word and not a stray letter; with less room it is left out. */
export const PLATE_STUB_EM = 3;

// ── Inspector sheet ──────────────────────────────────────────────
/** The hero portrait's face box, CSS px: 32 art px at 2x on a 1x screen. */
export const INSPECTOR_FACE_PX = 64;
/** z-index of the sheet over the stage: above the full box (43), under modals (50). */
export const INSPECTOR_OVERLAY_Z_INDEX = 45;
/** With the inspector sheet open the office keeps its size over showing every wall pixel: a zoom
 *  level still counts as fitting when the map overflows the view by at most this share of its
 *  width per side (only the outer wall is cut). */
export const SHEET_FIT_EDGE_CUT = 0.05;
/** Opening the sheet never leaves the office under this zoom level (1x on the badge). */
export const SHEET_MIN_ZOOM = 2;
/** Context share from which the inspector's context ring is warm (coral); hot (rust) from
 *  MEDAL_HOT_FRACTION, as the medals. */
export const INSPECTOR_RING_WARM_FRACTION = 0.7;

// ── Monitor office: desk highlight, tags, plaques, wall banner ───
/** The desk of an agent that needs you: an outline in the rail tile's color with an ink line inside
 *  it, a faint fill of the same color on the carpet, and a hard halo outside the outline on every
 *  other half second. CSS px (times the device pixel ratio, whole device px). */
export const DESK_HIGHLIGHT_OUTLINE_PX = 4;
export const DESK_HIGHLIGHT_INSET_PX = 1;
export const DESK_HIGHLIGHT_HALO_PX = 4;
export const DESK_HIGHLIGHT_INK = '#3b2412';
export const DESK_HIGHLIGHT_WAIT_COLOR = '#f6c64a';
export const DESK_HIGHLIGHT_WAIT_FILL = 'rgba(246, 198, 74, 0.12)';
export const DESK_HIGHLIGHT_WAIT_HALO = 'rgba(246, 198, 74, 0.45)';
export const DESK_HIGHLIGHT_STUCK_COLOR = '#c0563f';
export const DESK_HIGHLIGHT_STUCK_FILL = 'rgba(192, 86, 63, 0.12)';
export const DESK_HIGHLIGHT_STUCK_HALO = 'rgba(192, 86, 63, 0.45)';
/** Two frames a second apart from each other: the halo shows on one, the outline alone on the other. */
export const DESK_HIGHLIGHT_BLINK_MS = 500;
/** Two lit desks keep at least this much air between their outlines, CSS px (times the device
 *  pixel ratio): the facing sides move to the midline and draw no halo. */
export const DESK_HIGHLIGHT_GAP_PX = 8;
/**
 * Beside the rail every character carries one tag: one line, sized by how tall the type reads.
 * FS Pixel Sans draws caps 7/16 em tall, about 0.6 of what a common font shows at the same size,
 * so a CSS size is the size the eye should read times 1.6 (as the rail's type). At 1920 (the map
 * at 3 CSS px per world px) the name reads 14 px and the state 12; a smaller map (1280, zoom 2)
 * takes the small set, or the tags would be wider than a desk.
 */
export const MONITOR_TYPE_LARGE_MIN_CSS_ZOOM = 3;
export const TAG_LARGE = {
  name: 24,
  state: 20,
  line: 26,
  medal: 24,
  maxWidth: 184,
  helper: 18,
  helperLine: 20,
  plaqueTitle: 24,
  plaqueFolder: 18,
} as const;
export const TAG_SMALL = {
  name: 16,
  state: 14,
  line: 18,
  medal: 12,
  maxWidth: 124,
  helper: 13,
  helperLine: 15,
  plaqueTitle: 16,
  plaqueFolder: 13,
} as const;
/** Clear space between the head (or the bubble over it) and a tag above it, and between a desk
 *  and a tag under it, CSS px. */
export const TAG_HEAD_GAP_PX = 6;
export const TAG_DESK_GAP_PX = 6;
/** The tag solver moves a tag this far per step, at most TAG_REACH_PX from its slot (under the
 *  desk, else above the head); one moved more than TAG_LEADER_AT_PX, or farther than
 *  TAG_REACH_PX from its desk or sprite, hangs from a TAG_LEADER_PX ink leader. Past the reach
 *  the solver looks as far as TAG_FAR_REACH_PX before it leaves a tag out. */
export const TAG_STEP_PX = 8;
export const TAG_REACH_PX = 24;
export const TAG_FAR_REACH_PX = 64;
export const TAG_LEADER_AT_PX = 8;
export const TAG_LEADER_PX = 2;
/** A helper's tag: one word on paper, no ink box, so the agents' tags lead. */
export const HELPER_TAG_PAD_X_PX = 5;
/** A monitor tag's state is a whole word of at most this many characters, or it is left out. */
export const TAG_STATE_MAX_CHARS = 10;
/** Air a tag keeps from what it avoids. */
export const TAG_PAD_PX = 3;
/** A room plaque on the top wall: ink box, gold title, the mapped folder under it. */
export const PLAQUE_PAD_X_PX = 8;
export const PLAQUE_PAD_Y_PX = 1;
export const PLAQUE_LINE_GAP_PX = 3;
/** FS Pixel Sans caps and descenders, in em: a plaque's lines are trimmed to the caps (as the
 *  rail's numerals), the folder's descenders kept inside the box. */
export const PIXEL_FONT_CAP_EM = 7 / 16;
export const PIXEL_FONT_DESCENT_EM = 3 / 16;
export const PLAQUE_BORDER_PX = 2;
export const PLAQUE_Z_INDEX = 35;
/** The crew banner on a wall keeps this inset from the band's edges, CSS px. Its two rows are never
 *  drawn smaller than CREW_BANNER_WALL_MIN_SCALE; below that it folds into one row, which shrinks
 *  to fit down to CREW_BANNER_ROW_MIN_SCALE before the banner leaves the wall. */
export const CREW_BANNER_WALL_INSET_PX = 2;
export const CREW_BANNER_WALL_MIN_SCALE = 0.75;
export const CREW_BANNER_ROW_MIN_SCALE = 0.5;
export const TAG_BORDER_PX = 2;
export const TAG_PAD_Y_PX = 1;
export const TAG_SHADOW_PX = 2;
/** The solver's price of one sideways step, in vertical steps: a tag moves up or down before it
 *  slides. */
export const TAG_SIDE_COST = 1.5;
/** Stage chrome drawn over the map (the clock) that no tag or banner goes under. */
export const STAGE_CHROME_SELECTORS: readonly string[] = ['[data-testid="stage-clock"]'];
/** Wall furniture a tag never covers. */
export const WINDOW_TYPE_PREFIX = 'WINDOW';
/** A wall banner that does not fit the band at its scale tries again this much smaller. */
export const CREW_BANNER_WALL_SCALE_STEP = 0.05;
