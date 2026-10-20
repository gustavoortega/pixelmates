/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
/** Ingress for the official usage limits a status line wrapper reads from its
 *  CLI (POST `${STATUSLINE_API_PREFIX}/:providerId`, same bearer token as hooks). */
export const STATUSLINE_API_PREFIX = '/api/statusline';
export const SERVER_JSON_DIR = '.pixelmates';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixelmates/hooks';

// ── Display ──────────────────────────────────────────────────

export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
/** Longest session title kept and sent to the webview. Titles come from user
 *  prompts, so the cap bounds both the message and the label. */
export const SESSION_TITLE_MAX_LENGTH = 200;

// ── Workflow crews ───────────────────────────────────────────

/** A workflow agent has no parent tool on its lead: its helper is keyed by a
 *  synthetic parentToolId with this prefix (`wf:<runId>:<agentId>`). The webview
 *  reads the prefix to tell a crew helper from a Task/Agent one. */
export const WORKFLOW_PARENT_TOOL_ID_PREFIX = 'wf:';
/** Code-point caps for SubagentToolStart.label / .group (asyncapi maxLength). */
export const WORKFLOW_LABEL_MAX_LENGTH = 60;
export const WORKFLOW_GROUP_MAX_LENGTH = 40;

// ── Session signals ──────────────────────────────────────────

/** Prompt-cache TTL classes (`AgentCache.ttlSeconds`). On a subscription the
 *  5 minute class means the session moved to usage credits. */
export const CACHE_TTL_5M_SECONDS = 300;
export const CACHE_TTL_1H_SECONDS = 3600;

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';
/** Terminal: the server refused this page's token, and retrying would send the same one. */
export const TRANSPORT_STATE_REJECTED = 'rejected';

// ── WebSocket close codes (application range 4000-4999) ────

/** The server refused the connection's token (embedded Bearer header or
 *  standalone `?token=`). Shared with the webview, which stops reconnecting on it. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
