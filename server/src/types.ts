import type * as vscode from 'vscode';

import type {
  AgentArtifacts,
  AgentHealth,
  AgentLoop,
  AgentSession,
  AgentTests,
  AwaitingReason,
  CacheTtlSeconds,
  PermissionMode,
} from '../../core/src/messages.js';
import type { ModelTier, ToolVerdict } from '../../core/src/provider.js';
import type { HookSubRow } from './hookSubRows.js';
import type { LeadWorkflowState } from './workflowRuns.js';

export interface AgentState {
  id: number;
  sessionId: string;
  /** Terminal reference — undefined for extension panel sessions */
  terminalRef?: vscode.Terminal;
  /** Whether this agent was detected from an external source (VS Code extension panel, etc.) */
  isExternal: boolean;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
  backgroundAgentToolIds: Set<string>; // tool IDs for run_in_background Agent calls (stay alive until queue-operation)
  isWaiting: boolean;
  /** Meaningful while `isWaiting`: true when the agent stopped on a question for
   *  the user ("Waiting for input"), false/absent when it finished ("Done"). */
  awaitingInput?: boolean;
  /** Why it awaits the user, set with `awaitingInput` (awaitingQuestion.ts): a pending
   *  question tool, or a finished turn that sat idle. */
  awaitingReason?: AwaitingReason;
  /** The question's text, memory only (never logged or persisted); see awaitingQuestion.ts. */
  question?: string;
  /** True when the transcript tail said the agent is mid-turn at adoption or
   *  restore, before any live event confirmed it. Cleared by the first live
   *  record or hook event. Lets a reconnecting client be told `active`. */
  derivedActive?: boolean;
  /** Counts hook events routed to this agent. A derived status is applied only
   *  if the count did not move while it was computed: a hook is fresher. */
  hookSeq?: number;
  permissionSent: boolean;
  /** Epoch ms the pending permission prompt went up (server clock). Meaningful only
   *  while `permissionSent`: set on its false -> true edge, so a stale value is never read. */
  permissionSince?: number;
  /** The status (with its awaitingInput) clients were last put in, and when it began
   *  (statusSince.ts). `statusSince` is undefined when the start is unknown. */
  statusKey?: string;
  statusSince?: number;
  hadToolsInTurn: boolean;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** Timestamp of last JSONL data received (ms since epoch) */
  lastDataAt: number;
  /** Total JSONL lines processed for this agent */
  linesProcessed: number;
  /** Set of record.type values we've already warned about (prevents log spam) */
  seenUnknownRecordTypes: Set<string>;
  /** Whether a hook event has been delivered for this agent (suppresses heuristic timers) */
  hookDelivered: boolean;
  /** True when agent has no transcript file (provider doesn't use JSONL). All state from hooks. */
  hooksOnly?: boolean;
  /** Provider that created this agent (defaults to 'claude') */
  providerId?: string;
  /** Set when SessionEnd(reason=clear) fires; cleared when SessionStart(source=clear) reassigns */
  pendingClear?: boolean;
  /** Hook-generated tool ID for PreToolUse/PostToolUse correlation */
  currentHookToolId?: string;
  /** Tool name from the most recent PreToolUse, used to correlate a later SubagentStart
   *  event with the parent tool that launched it. */
  currentHookToolName?: string;
  /** True if the CURRENT PreToolUse tool call is a teammate spawn (per the provider's
   *  `team.isTeammateSpawnCall`). Authoritative source for teammate vs basic-subagent
   *  routing in SubagentStart. Set in PreToolUse, NOT cleared in PostToolUse (survives
   *  the PostToolUse-before-SubagentStart race); overwritten on the next PreToolUse. */
  currentHookIsTeammateSpawn?: boolean;

  // -- Context window usage (server/src/contextUsage.ts) --
  /** Tokens in the agent's context as of its newest turn; 0 until one is seen.
   *  A snapshot, not a running total -- it falls on compaction and /clear. */
  contextTokens: number;
  /** Observational estimate of the window `contextTokens` fits in. Widens as
   *  larger contexts appear, never shrinks. */
  maxContextTokens: number;
  /** True once this transcript produced a main-chain turn, after which
   *  sidechain records belong to sub-agents and stop moving the gauge. */
  sawMainChainUsage?: boolean;

  // -- Model look (server/src/contextUsage.ts) --
  /** Model id of the newest main-chain turn; undefined until one is seen. */
  model?: string;
  /** The provider's tier for `model`; undefined when it cannot place it. */
  modelTier?: ModelTier;

  // -- Session title (server/src/sessionTitle.ts) --
  /** Title the user chose for the session; the newest record wins. */
  customTitle?: string;
  /** Title the CLI generated; used only while there is no customTitle. */
  aiTitle?: string;
  /** The jsonlFile the titles above were read from. A different file (switch,
   *  /clear) means they belong to another session and must be dropped. */
  titleSourceFile?: string;

  // -- Session signals (server/src/contextUsage.ts, server/src/sessionSignals.ts) --
  // None is persisted: a restart rebuilds the cache clock and the mode from the
  // transcript tail, and shells read 0 until the next launch.
  /** TTL class of the newest prompt-cache write; undefined until one is seen. */
  cacheTtlSeconds?: CacheTtlSeconds;
  /** Epoch ms the cache expires: the newest turn's first line plus the TTL. */
  cacheExpiresAt?: number;
  /** message.id of the turn that last moved the clock. Claude Code writes one
   *  message over several lines, and only the first one counts. */
  cacheMessageId?: string;
  /** Permission mode the newest carrier record stated; undefined while unknown. */
  permissionMode?: PermissionMode;
  /** Background shells not yet finished: the Bash tool_use id, mapped to the
   *  background task id a TaskStop result names. */
  runningShellIds?: Map<string, string>;
  /** Task notification ids that matched no running shell, newest last. A
   *  notification can land before its launch's result; the launch then counts
   *  as already finished. Capped at SHELL_DONE_MEMO_MAX. */
  shellDoneBeforeLaunch?: Set<string>;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  /** True when teamName was read from the session's own record tags (tmux/
   *  inline teams, teammate sessions). Tag identity is authoritative: spawn-
   *  result re-latching (implicit-team generations on resume) only applies to
   *  tag-less leads. Transient — not persisted. */
  teamNameFromTags?: boolean;
  isTeamLead?: boolean;
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;
  /** For a promoted anonymous background agent (teams OFF): the lead's Agent
   *  tool_use id that spawned it. Links this character to the lead's
   *  backgroundAgentToolIds entry so the queue-operation completion removes it. */
  spawnToolUseId?: string;
  /** Tool ids of spawn calls whose input carried a `name` — teammates-to-be.
   *  Every agentToolStart (re-)broadcast for these carries isTeammateSpawn so
   *  the webview never creates a Subtask ghost for them. Transient, lazily
   *  created, never persisted. */
  teammateSpawnToolIds?: Set<string>;
  /** Rows SubagentStart drew under an open Task/Agent tool, by the hook's
   *  agent_id (hookSubRows.ts). Transient, never persisted. */
  hookSubRows?: Map<string, HookSubRow>;

  // -- Workflow crews (server/src/workflowRuns.ts) --
  /** A lead's workflow runs, watched helpers and Workflow tool mappings. Only
   *  the mappings are persisted; the rest is re-read from the run journals. */
  workflow?: LeadWorkflowState;
  /** The session whose end disposed `workflow`, with the runs it knew. Not
   *  scanned while the lead is still on it; a Workflow launch there (a resume
   *  under the same id) scans again, those runs taken as completed. Transient. */
  workflowEnded?: { sessionId: string; runIds: Set<string> };

  // -- Tripwires (server/src/tripwires.ts) --
  /** Alarm raised by a detection rule over this agent's tool calls. `count` is every
   *  hit since the last ack; the rule shown is the highest severity seen since then.
   *  Holds ids and labels only, never the matched text. Transient, not persisted. */
  tripwire?: {
    ruleId: string;
    ruleName: string;
    severity: 'high' | 'medium' | 'low';
    count: number;
    /** Epoch ms of the first hit since the last ack. */
    since: number;
  };

  // -- Health (server/src/health.ts) --
  /** Stuck, stalled, looping and dead detection for this agent. Transient: never persisted,
   *  rebuilt at restore and when the character moves to a new session. */
  health?: HealthTracking;

  // -- Monitor (filled by the session-meta, history and workflow pieces) --
  // What clients are shown, minus the envelope. Absent means unknown and is sent as the
  // clear form. None is persisted.
  sessionMeta?: MonitorView<AgentSession>;
  /** What `sessionMeta` is folded from, for the transcript it was read from (sessionMeta.ts).
   *  Kept apart from the wire view: the resend spreads that into a message. */
  sessionMetaTrack?: SessionMetaTrack;
  artifacts?: MonitorView<AgentArtifacts>;
  loop?: MonitorView<AgentLoop>;
  tests?: MonitorView<AgentTests>;

  // -- Avatar customization --
  /** Preferred character palette (0-11). If undefined, auto-assigned for diversity. */
  palette?: number;
  /** Hue shift in degrees (0-360). Rotates the base palette colors. */
  hueShift?: number;

  // -- Roster + XP (server/src/roster.ts, server/src/xp.ts) --
  /** Roster member this agent holds. Palette and hueShift come from the member. */
  rosterId?: string;
  /** Real-work signals read from this agent's own transcript (transcriptParser.ts). `keys` are
   *  hashed identities already paid (capped, oldest dropped); the turn counters reset on each
   *  user prompt. Transient, never persisted: nothing re-appends a paid signal. */
  signals?: {
    keys: Set<string>;
    editSinceGreen: boolean;
    turnCommits: number;
    turnTests: number;
  };
  /** What each tool call in flight may prove, from its tool_use to its tool_result. Holds
   *  verdicts only, never the command text. Transient. */
  toolVerdicts?: Map<string, ToolVerdict[]>;
  /** Set when the reader starts this transcript from offset 0, to that moment less
   *  TRANSCRIPT_FRESHNESS_WINDOW_MS. A tool result stamped earlier was written before the agent
   *  was watched and pays no XP: a young file can open with copied history. Transient. */
  historyBefore?: number;
}

/**
 * A CLI process's cost counter, folded across processes: the counter restarts when a session
 * is resumed, so the total is what finished processes reached plus where the current one is.
 */
export interface CostTrack {
  /** Sum of the last value of every process that has since been replaced. */
  settled: number;
  /** The current process's latest counter; undefined until a cost row was seen. */
  last?: number;
  /** The first counter folded: it says whether a stream continues the process before it. */
  first?: number;
  /** Epoch ms of the newest cost row. */
  at?: number;
  /** Newest record timestamp folded so far: cost rows carry none of their own. */
  clock?: number;
}

/** The fold behind an agent's `sessionMeta`, tied to the one transcript it was read from. */
export interface SessionMetaTrack {
  file: string;
  /** First timestamp of the file; undefined while unknown. */
  startedAt?: number;
  /** The file's head was read, so the live stream must not guess a start from mid-file. */
  headRead: boolean;
  branch?: string;
  cost: CostTrack;
  /** While the history scan reads the rows before the watch offset: what it has folded. The
   *  live `cost` then holds only later rows, so no total is shown until the two are joined. */
  costHold?: CostTrack;
  /** The scan's cost is already in `cost`: a second scan of this file must not add it again. */
  costMerged?: boolean;
}

/** A per-agent monitor message minus its envelope: what the agent state keeps. */
export type MonitorView<M extends { type: string; id: number }> = Omit<M, 'type' | 'id'>;

/** What a client is shown for an agent's health: the wire message minus its envelope. */
export type HealthView = Pick<AgentHealth, 'state' | 'reason' | 'count'>;

/** The detectors' per-agent state. Holds counters, clocks and a hash, never session text. */
export interface HealthTracking {
  /** Red test runs since the last green run, successful edit or prompt. */
  redRuns: number;
  /** The newest tool call, as a hash of its input, and how many times in a row it was made. */
  lastCall: { name: string; hash: string; repeats: number } | null;
  /** Epoch ms the current turn opened; null between turns. Stalls are only judged inside one. */
  turnOpenAt: number | null;
  /** Epoch ms of the newest transcript line, hook or file write seen for the agent. */
  progressAt: number;
  /** Epoch ms a permission prompt went up and has not been answered; silence there is the user's. */
  permissionPendingAt: number | null;
  /** Epoch ms the tick first found the session's process gone; null while it runs. */
  deadAt: number | null;
  /** What clients were last told, so only a change goes on the wire. */
  lastSent: HealthView | null;
  /** Epoch ms `lastSent` entered its state and reason; a growing count keeps it. */
  lastSentSince?: number;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  /** Terminal name — empty string for extension panel sessions */
  terminalName: string;
  /** Whether this agent was detected from an external source */
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
  /** Live background-spawn tool ids on a lead. Persisted so the spawns'
   *  transcripts are re-adopted after a reload; the spawned children
   *  themselves are derived state and never persisted. */
  backgroundAgentToolIds?: string[];
  /** Workflow tool_use id -> runId on a lead, so a run's completion
   *  notification still ends its helpers after a restart. */
  workflowRuns?: Record<string, string>;
  /** Workflow runs a lead knows finished, so a restart does not revive their
   *  unfinished agents. Pruned with the run dirs. */
  completedWorkflowRunIds?: string[];
  /** Preferred character palette (0-11). Persisted so colors stay stable
   *  across server restarts; assignPaletteIfNeeded is a no-op on restore. */
  palette?: number;
  /** Hue shift in degrees (0-360). Persisted alongside palette. */
  hueShift?: number;
  /** Roster member this agent held (server/src/roster.ts). Reclaimed on restore. */
  rosterId?: string;
}
