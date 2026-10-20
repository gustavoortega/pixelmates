// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;
/** Cap on one transcript read, so a huge JSONL dump never blocks the event
 *  loop; the rest is read on the next poll. */
export const TRANSCRIPT_READ_CHUNK_BYTES = 65_536;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Two scan ticks: a transcript born this recently is adopted from its start, and a record
 *  stamped this long before a read from the start began still counts as new. */
export const TRANSCRIPT_FRESHNESS_WINDOW_MS = EXTERNAL_SCAN_INTERVAL_MS * 2;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;

// ── Session meta (sessionMeta.ts) ───────────────────────────
/** How much of a transcript's head to read for the session's first timestamp. A line the window
 *  cuts is dropped unread, which also keeps a huge first line from being decoded. */
export const SESSION_META_HEAD_BYTES = 256 * 1024;
/** The branch is user text headed for one plate line: cut at this many code points. */
export const SESSION_BRANCH_MAX_LENGTH = 120;

// ── Session signals (sessionSignals.ts) ─────────────────────
/** Task notifications remembered without a matching running shell. One that
 *  lands before its launch's result is a few lines ahead of it, so a short
 *  memory covers it; the rest (sub-agent shells, other task kinds) age out. */
export const SHELL_DONE_MEMO_MAX = 32;

// ── Workflow crews (workflowRuns.ts) ────────────────────────
/** An untracked run is adopted only if its journal or one of its agent
 *  transcripts moved within this window; a tracked run with nobody live is
 *  dropped only once that same test would turn it away. */
export const WORKFLOW_RUN_MAX_AGE_MS = 7_200_000;
/** A started agent whose transcript has been quiet this long is torn down (it
 *  stays a candidate and comes back if the transcript moves again). */
export const WORKFLOW_AGENT_STALE_MS = 900_000;
/** On attach, a transcript up to this size is replayed from the start; a larger
 *  one is tailed (the helper appears on its next tool). */
export const WORKFLOW_ATTACH_TAIL_BYTES = 1_048_576;
/** Re-stat cadence for stale candidates, rejected-as-old run dirs, and a
 *  missing `subagents/workflows` dir (a Workflow launch resets the last one). */
export const WORKFLOW_STALE_RECHECK_MS = 10_000;
export const WORKFLOW_IGNORED_RECHECK_MS = 60_000;
export const WORKFLOW_DIR_MISSING_RECHECK_MS = 5_000;
/** Journals are read in chunks of this size, so memory stays bounded however
 *  much is unread: result lines carry an agent's whole output. */
export const WORKFLOW_JOURNAL_CHUNK_BYTES = 1_048_576;
/** A journal line longer than this is consumed without being parsed. Only a
 *  result gets near it, and its agent then ends with staleness or its run. */
export const WORKFLOW_JOURNAL_MAX_LINE_BYTES = 4 * 1_048_576;

// ── Derived turn state (turnState.ts) ──────────────────────
/** An agent whose last record says "working" but whose files have been quiet
 *  this long is shown idle: the process is gone or the turn was abandoned. */
export const TURN_ACTIVE_STALE_MS = 90_000;
/** Same, while a long-running tool (a shell command, a spawned agent) is pending:
 *  those write nothing for minutes while genuinely working. */
export const TURN_LONG_TOOL_STALE_MS = 15 * 60_000;
/** A finished turn older than this no longer deserves a "Done" bubble. */
export const TURN_WAITING_STALE_MS = 2 * 60 * 60_000;

// ── Agent health (health.ts, healthTick.ts) ────────────────
/** Liveness, stalls and dead removal are re-checked this often: a stall is counted in minutes. */
export const HEALTH_TICK_MS = 30_000;
/** An open turn with no transcript record and no hook for this long is stalled: far past any
 *  think time between tool calls. A long-running tool gets TURN_LONG_TOOL_STALE_MS instead. */
export const HEALTH_STALLED_MS = 600_000;
/** Red test runs with no successful edit between them that make an agent stuck: two can be a
 *  deliberate re-run to confirm a failure. */
export const HEALTH_STUCK_RUNS = 3;
/** Identical calls in a row that read as a loop: three can be a deliberate retry. */
export const HEALTH_LOOP_REPEATS = 4;
/** A dead external agent stays gray this long so the user sees it go, then it is removed. */
export const HEALTH_DEAD_REMOVE_MS = 300_000;
/** A stalled agent's count is whole minutes of silence. */
export const HEALTH_MINUTE_MS = 60_000;
/** Tool calls remembered per agent to name a later result. Results come back within a few
 *  calls; the cap keeps a long session's memory flat. */
export const HEALTH_TOOL_MEMORY = 64;
/** Lines from the end of a shell result searched for a test runner summary: runners print it
 *  last, and stack traces above it must not be read as one. */
export const TEST_SUMMARY_TAIL_LINES = 40;
/** History scan (historyScan.ts): wall clock and bytes one scan may spend reading an agent's
 *  transcript from 0 to its watch offset. A scan the budget stops sends `complete: false`. */
export const HISTORY_SCAN_WALL_MS = 2_000;
export const HISTORY_SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** Distinct artifact urls kept per agent; past it the oldest go and the count is a floor. */
export const MONITOR_ARTIFACTS_MAX = 200;
/** Artifacts a wire message lists, newest first (the contract's maxItems). */
export const MONITOR_ARTIFACT_ITEMS = 20;
/** Cap on an artifact title, in code points (the contract's maxLength). */
export const MONITOR_ARTIFACT_TITLE_MAX = 120;
/** Longest artifact url accepted. An access link is a few dozen characters; more is not one. */
export const MONITOR_ARTIFACT_URL_MAX = 2_048;
/** Tool calls remembered per agent to pair a later result with its call. */
export const MONITOR_CALL_MEMORY = 64;
/** A call's input keeps only scalars up to this long: a pair needs the action and flags, never a
 *  file's contents. */
export const MONITOR_CALL_INPUT_VALUE_MAX = 256;
/** A hung `ps` must not hold the health tick: past this its answer is dropped and every pid
 *  stays alive. */
export const HEALTH_PS_TIMEOUT_MS = 2_000;
/** Shadow store ids (subagentWatch.ts) start far above any real agent id, so a shadow agent is
 *  told apart by id alone: the parser's module-level callbacks miss the main store, and the
 *  health detectors skip it. */
export const SHADOW_ID_BASE = 1_000_000;

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Display Truncation + pixelmates Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  SESSION_TITLE_MAX_LENGTH,
  STATUSLINE_API_PREFIX,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (under SERVER_JSON_DIR) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

// ── WebSocket close codes (application range 4000-4999) ────
// The unauthorized code lives in core: the webview stops reconnecting on it.
export { WS_CLOSE_UNAUTHORIZED } from '../../core/src/constants.js';
/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the privileged client-message channel. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
/** Hook bodies carry whole Write and Edit payloads: at 64 KB a big write got a
 *  413 and its tool start was lost. 1 MiB is also Fastify's own default. */
export const MAX_HOOK_BODY_SIZE = 1_048_576; // 1 MiB

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixelmates';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';
export const TRIPWIRES_FILE_NAME = 'tripwires.json';

// ── One-time copy from Pixel Agents' data dir ───────────────
/** Upstream Pixel Agents' data dir. Read once by migrateDataDir, never written. */
export const LEGACY_DATA_DIR = '.pixel-agents';
/** Copied by name. Everything else under the legacy dir (token, port, server
 *  registry, hook scripts, ledger cache, backups) belongs to the other app. */
export const MIGRATED_FILE_NAMES = ['layout.json', 'roster.json'] as const;
/** `standalone-state.json`, `vscode-state.json`: the FileStateAdapter namespaces. */
export const MIGRATED_STATE_FILE_PATTERN = /^[a-z][a-z0-9]*-state\.json$/;
export const DATA_DIR_MODE = 0o700;
export const DATA_FILE_MODE = 0o600;

// ── Standalone server token ────────────────────────────────
/** Under LAYOUT_FILE_DIR: the standalone server's token, kept across restarts so
 *  the URL the CLI printed still opens, and an open tab still reconnects. */
export const SERVER_TOKEN_FILE_NAME = 'server-token';
/** What `--token` and the token file must hold: URL-safe, never shorter than 16. */
export const SERVER_TOKEN_PATTERN = /^[A-Za-z0-9._-]{16,128}$/;
/** Under LAYOUT_FILE_DIR: the port the standalone server last picked for itself,
 *  tried first on the next start so the printed URL keeps its port too. */
export const SERVER_PORT_FILE_NAME = 'server-port';
/** Lowest saved port tried: below it a bind can need privileges. */
export const SAVED_PORT_MIN = 1024;

// ── Roster ─────────────────────────────────────────────────
export const ROSTER_FILE_NAME = 'roster.json';
/** XP and counters are batched; claims and releases write immediately. */
export const ROSTER_FLUSH_DEBOUNCE_MS = 2000;
export const ROSTER_LOCK_RETRIES = 20;
export const ROSTER_LOCK_RETRY_MS = 50;
/** Only an unreadable lockfile is broken by age; a readable one is broken when its owner pid is dead. */
export const ROSTER_LOCK_STALE_MS = 5000;

// ── Avatar Customization ────────────────────────────────────
/** Number of pre-colored bundled character palettes (char_0.png–char_11.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 12;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;

// ── Token ledger ──
/** Transcripts untouched for longer than this are never read, and cached records older than this are pruned. */
export const TOKEN_LEDGER_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
export const TOKEN_LEDGER_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const TOKEN_LEDGER_BLOCK_MS = 5 * 60 * 60 * 1000;
/** Incremental re-read cadence, and the floor between two `tokenUsage` broadcasts. */
export const TOKEN_LEDGER_TICK_MS = 30_000;
/** Cache flush cadence while running (shutdown flushes synchronously). */
export const TOKEN_LEDGER_CACHE_FLUSH_MS = 10 * 60 * 1000;
export const TOKEN_LEDGER_READ_HIGH_WATER_MARK = 1024 * 1024;
export const TOKEN_LEDGER_TOP_SESSIONS = 15;
export const TOKEN_LEDGER_CACHE_FILE = 'ledger-cache.json';

// ── XP signals ──
/** Paid signal keys remembered per agent. A key only has to outlive re-reads of its own
 *  record, so the oldest are dropped past this. */
export const SIGNAL_KEYS_MAX = 500;

// ── Official usage limits (POST /api/statusline/:providerId) ──
/** Highest used percentage accepted. Claude Code reports more than 100 once a
 *  window is overdrawn; the wrapper script it was modelled on caps at 1000. */
export const USAGE_LIMIT_MAX_PCT = 1000;
/** resetsAt arrives in epoch SECONDS: anything outside [1e9, 1e11) is a unit
 *  mix-up (milliseconds) or junk, never a reset time. */
export const USAGE_LIMIT_RESETS_AT_MIN_S = 1e9;
export const USAGE_LIMIT_RESETS_AT_MAX_S = 1e11;
