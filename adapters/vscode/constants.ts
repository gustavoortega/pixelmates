// ── User-Level Layout Persistence (re-exports from server/) ──
// The user-level persistence contract, surfaced as one adapter-facing barrel so
// VS Code code never reaches into server/src/constants.js directly. Only
// LAYOUT_REVISION_KEY has an adapter consumer today (PixelAgentsViewProvider);
// the rest travel with it because they describe the same ~/.pixelmates
// file layout, and splitting the set would leave the next caller guessing which
// half to import from where.
/** @public */
export {
  CONFIG_FILE_NAME,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
} from '../../server/src/constants.js';

// ── Settings Persistence (VS Code globalState keys) ─────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
export const GLOBAL_KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
export const GLOBAL_KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
export const GLOBAL_KEY_SHOW_MODEL_FLAIR = 'pixel-agents.showModelFlair';
export const GLOBAL_KEY_COZY_LIGHTING = 'pixel-agents.cozyLighting';
export const GLOBAL_KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
export const GLOBAL_KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
export const GLOBAL_KEY_SHOW_AREAS = 'pixel-agents.showAreas';

/**
 * Folder→Area mappings live inside the shared ~/.pixelmates/config.json
 * (vscode.areaMappings), not in VS Code globalState. Kept here as a key
 * constant for callers that need to reference it symbolically.
 *
 * @public
 */
export const SETTING_KEY_AREA_MAPPINGS = 'pixel-agents.areaMappings';

// ── VS Code Settings (contributes.configuration keys) ───────
export const CONFIG_KEY_AUTO_SHOW_PANEL = 'pixel-agents.autoShowPanel';
export const CONFIG_KEY_AUTO_SPAWN_AGENT = 'pixel-agents.autoSpawnAgent';
/** Token budgets in cost-weighted tokens. Unset / non-positive = no budget. The Usage panel writes them here. */
export const CONFIG_KEY_TOKEN_BUDGET_5H = 'pixel-agents.tokenBudget5h';
export const CONFIG_KEY_TOKEN_BUDGET_WEEK = 'pixel-agents.tokenBudgetWeek';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'pixel-agents.exportDefaultLayout';
