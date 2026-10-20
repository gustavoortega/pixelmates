import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import type {
  AgentEvent,
  HookInstallOptions,
  HookProvider,
  LoopEvent,
  ModelTier,
  SessionMetaFacts,
  SignalHit,
  ToolVerdict,
  TurnSignal,
  TurnTraits,
} from '../../../../../core/src/provider.js';
import {
  SESSION_TITLE_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../../constants.js';
import { recordTimestampMs } from '../../../contextUsage.js';
import {
  areHooksInstalled as installerAreHooksInstalled,
  hasUpstreamHooks,
  installHooks as installerInstallHooks,
  uninstallHooks as installerUninstallHooks,
} from './claudeHookInstaller.js';
import { claudeTeamProvider } from './claudeTeamProvider.js';
import { createClaudeTranscriptUsage } from './claudeUsage.js';
import {
  CONSENT_DISCLOSURE,
  CONSENT_INSTALL_HEADLINE,
  LEGACY_REPLACE_LABEL,
} from './consentCopy.js';
import {
  CLAUDE_LARGE_CONTEXT_WINDOW,
  CLAUDE_MODEL_TIERS,
  CLAUDE_SMALL_CONTEXT_MODEL_PATTERN,
  CLAUDE_SMALL_CONTEXT_WINDOW,
  CLAUDE_TERMINAL_NAME_PREFIX,
} from './constants.js';
import { claudeSessionLiveness } from './sessionFiles.js';

// ── formatToolStatus: moved from src/transcriptParser.ts ──

/** Leading `VAR=value` assignments, with quoted or `$(...)` values. */
const LEADING_ASSIGNMENTS =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^)]*\)|\\[\s\S]|[^\s"'$;&|\\])*\s+)*/;

/** Programs whose first plain word after the name is a verb (`git commit`), not data. */
const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set([
  'git',
  'gh',
  'npm',
  'pnpm',
  'yarn',
  'docker',
  'cargo',
  'go',
  'kubectl',
  'terraform',
]);
/** A subcommand is a short lowercase word. A flag, path, URL, host or value never fits. */
const SUBCOMMAND_WORD = /^[a-z][a-z-]{0,23}$/;
/** Programs that set the scene for the command that follows: the work is the next stage. */
const SCENERY_PROGRAMS: ReadonlySet<string> = new Set([
  'cd',
  'export',
  'source',
  'set',
  'true',
  ':',
  'echo',
  'printf',
]);
/** Top-level command separators. A pipe splits a segment into stages, so it is not here. */
const SEGMENT_SEPARATORS = /\n|&&|\|\||;/;

/** The words of one pipe stage, leading `VAR=value` assignments dropped. */
function stageWords(stage: string): string[] {
  return stage.replace(LEADING_ASSIGNMENTS, '').trim().split(/\s+/);
}

/** What a shell command runs, for the status text: the program and, for a few known CLIs, its
 *  subcommand. The status is broadcast to every connected client and logged, and arguments
 *  routinely carry tokens, passwords and hostnames, so no other word may leave. Quotes,
 *  comments and heredoc bodies are blanked first. The command is walked segment by segment and
 *  stage by stage, and the first stage that is not scenery (`cd x && npm test`, `echo $X | gh
 *  pr create`) names the work; when every stage is scenery, the last segment's first stage does.
 *  Leading assignments are skipped for the same reason; when they don't parse cleanly
 *  (unbalanced quote, nested `$(`), the next word may be part of a secret, so a generic label
 *  is shown instead. */
function programName(command: string): string {
  const blanked = blankQuotesAndComments(stripHeredocs(command)).replace(/\\\n/g, ' ');
  let fallback: string | undefined;
  for (const segment of blanked.split(SEGMENT_SEPARATORS)) {
    const stages = segment.split('|').map(stageWords);
    for (const words of stages) {
      const word = words[0] ?? '';
      if (!word) continue;
      // A redirect target (`>/tmp/out cmd`) is a path, never a program name.
      const program = /["'`$()=<>&]/.test(word) ? 'command' : path.basename(word);
      if (!SCENERY_PROGRAMS.has(program)) {
        const sub = words[1] ?? '';
        return SUBCOMMAND_PROGRAMS.has(program) && SUBCOMMAND_WORD.test(sub)
          ? `${program} ${sub}`
          : program;
      }
    }
    const first = stages[0]?.[0];
    if (first) fallback = path.basename(first);
  }
  return fallback ?? '';
}

export function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
  switch (toolName) {
    case 'Read':
      return `Reading ${base(inp.file_path)}`;
    case 'Edit':
      return `Editing ${base(inp.file_path)}`;
    case 'Write':
      return `Writing ${base(inp.file_path)}`;
    case 'Bash':
      return `Running: ${programName(typeof inp.command === 'string' ? inp.command : '')}`;
    case 'Glob':
      return 'Searching files';
    case 'Grep':
      return 'Searching code';
    case 'WebFetch':
      return 'Fetching web content';
    case 'WebSearch':
      return 'Searching the web';
    case 'Task':
    case 'Agent': {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      return desc
        ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}`
        : 'Running subtask';
    }
    case 'AskUserQuestion':
      return 'Waiting for your answer';
    case 'EnterPlanMode':
      return 'Planning';
    case 'NotebookEdit':
      return 'Editing notebook';
    case 'TeamCreate': {
      const teamName = typeof inp.team_name === 'string' ? inp.team_name : '';
      return teamName ? `Creating team: ${teamName}` : 'Creating team';
    }
    case 'SendMessage': {
      const recipient = typeof inp.recipient === 'string' ? inp.recipient : '';
      return recipient ? `-> ${recipient}` : 'Sending message';
    }
    default:
      return `Using ${toolName}`;
  }
}

// ── Session dir + launch command ──

function getSessionDirs(workspacePath: string): string[] {
  // Claude stores sessions at ~/.claude/projects/<workspace-path-with-dashes>/.
  const dirName = normalizeProjectPath(workspacePath);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);

  // Try exact match first.
  if (fs.existsSync(projectDir)) return [projectDir];

  // Case-insensitive fallback for Windows: drive letter casing can differ
  // between what VS Code gives us (e.g. "c:\...") and Claude's encoding ("C:\...").
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    if (fs.existsSync(projectsRoot)) {
      const lowerDirName = dirName.toLowerCase();
      const match = fs.readdirSync(projectsRoot).find((c) => c.toLowerCase() === lowerDirName);
      if (match) return [path.join(projectsRoot, match)];
    }
  } catch {
    /* ignore scan errors */
  }

  // Return the expected path even if it doesn't exist yet (caller tolerates missing dirs).
  return [projectDir];
}

function buildLaunchCommand(
  sessionId: string,
  cwd: string,
  opts?: { bypassPermissions?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  const args = ['--session-id', sessionId];
  if (opts?.bypassPermissions) args.push('--dangerously-skip-permissions');
  return { command: 'claude', args, env: { PWD: cwd } };
}

/** Root that holds every Claude session across all workspaces. Used by the
 *  global session scanner ("Watch All Sessions"). */
function getAllSessionRoots(): string[] {
  return [path.join(os.homedir(), '.claude', 'projects')];
}

// ── normalizeHookEvent: the single Claude-specific normalization boundary ──
//
// All raw Claude hook payload fields (tool_name, tool_input, agent_type, etc.) are
// read HERE and HERE ONLY. Downstream (hookEventHandler.ts) sees only the normalized
// AgentEvent union.
//
// Sentinel 'current' toolIds are returned for PostToolUse/SubagentStop because the
// raw hook payload doesn't carry the id; the handler correlates using its own
// currentHookToolId state. Synthetic hook-* ids are returned for PreToolUse because
// the real tool id arrives later via JSONL polling.

/** Session lifecycle events. Fired inside a sub-agent (agent_id set) they say
 *  nothing about the session itself, and Stop would normalize to the same
 *  turnEnd as Notification(idle_prompt), which must keep its path, so the
 *  handler could no longer tell them apart. Dropped here instead. */
const SESSION_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'Stop',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreCompact',
]);

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent; agentId?: string } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;
  // Claude stamps agent_id on every hook that fires inside a sub-agent.
  const agentId =
    typeof raw.agent_id === 'string' && raw.agent_id.length > 0 ? raw.agent_id : undefined;
  if (agentId !== undefined && SESSION_ONLY_EVENTS.has(eventName)) return null;
  const normalized = normalizeSessionEvent(eventName, sessionId, raw);
  if (!normalized || agentId === undefined) return normalized;
  return { ...normalized, agentId };
}

/** The ended tool's name, when the payload carries one. */
function toolNameOf(raw: Record<string, unknown>): { toolName?: string } {
  return typeof raw.tool_name === 'string' && raw.tool_name ? { toolName: raw.tool_name } : {};
}

function normalizeSessionEvent(
  eventName: string,
  sessionId: string,
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  switch (eventName) {
    case 'PreToolUse': {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : '';
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: `hook-${Date.now()}`,
          toolName,
          input: toolInput,
          runInBackground: toolInput.run_in_background === true,
        },
      };
    }

    case 'PostToolUse':
      return { sessionId, event: { kind: 'toolEnd', toolId: 'current', ...toolNameOf(raw) } };

    case 'PostToolUseFailure':
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: 'current', ...toolNameOf(raw), failed: true },
      };

    case 'Stop':
      return { sessionId, event: { kind: 'turnEnd' } };

    case 'UserPromptSubmit':
      // No normalized kind for user prompts yet; silently ignore. No longer
      // installed (it forwarded the prompt text here only to be dropped), but a
      // stale install keeps POSTing it until its next install/uninstall runs,
      // so the drop must stay graceful.
      return null;

    case 'SubagentStart': {
      const agentType = typeof raw.agent_type === 'string' ? raw.agent_type : 'unknown';
      return {
        sessionId,
        event: {
          kind: 'subagentStart',
          parentToolId: 'current',
          toolId: `hook-sub-${agentType}-${Date.now()}`,
          toolName: agentType,
          input: raw,
          runInBackground: raw.run_in_background === true,
        },
      };
    }

    case 'SubagentStop':
      return {
        sessionId,
        event: {
          kind: 'subagentEnd',
          parentToolId: 'current',
          toolId: 'current',
          ...(typeof raw.agent_transcript_path === 'string'
            ? { transcriptPath: raw.agent_transcript_path }
            : {}),
        },
      };

    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };

    case 'Notification': {
      const notificationType =
        typeof raw.notification_type === 'string' ? raw.notification_type : '';
      if (notificationType === 'permission_prompt') {
        return { sessionId, event: { kind: 'permissionRequest' } };
      }
      if (notificationType === 'idle_prompt') {
        // idle_prompt fires after a finished turn sat idle, and equally while a question is
        // still unanswered. It says nothing about a question by itself: that is the
        // question tool's own PreToolUse, so this is only the quiet "finished, waiting".
        return { sessionId, event: { kind: 'turnEnd', idle: true } };
      }
      return null;
    }

    case 'SessionStart':
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          transcriptPath: typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case 'SessionEnd':
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    // Agent Teams: a teammate went idle / marked a task complete. Normalize as
    // `subagentTurnEnd` so the team handler can route by the provider's event-specific identity.
    // `reason` discriminates the two so handlers don't read raw eventName.
    case 'TeammateIdle':
      return {
        sessionId,
        event: { kind: 'subagentTurnEnd', parentToolId: 'current', reason: 'idle' },
      };
    case 'TaskCompleted':
      return {
        sessionId,
        event: { kind: 'subagentTurnEnd', parentToolId: 'current', reason: 'completed' },
      };

    // TaskCreated is informational; no AgentEvent shape fits it. Drop. No
    // longer installed for that reason, but stale installs still POST it —
    // keep tolerating it here.
    case 'TaskCreated':
    default:
      return null;
  }
}

// ── Installer wrappers: adapt sync signatures to async interface ──

/** Async so an installer throw (e.g. unparseable settings.json) always reaches
 *  callers as a rejection they can surface, never a sync throw. */
async function installHooks(
  _serverUrl: string,
  _authToken: string,
  options?: HookInstallOptions,
): Promise<void> {
  await installerInstallHooks(options);
}

function legacyReplaceLabel(): string | null {
  return hasUpstreamHooks() ? LEGACY_REPLACE_LABEL : null;
}

async function uninstallHooks(): Promise<void> {
  await installerUninstallHooks();
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(installerAreHooksInstalled());
}

/** This provider's first-run consent terms. The strings live in
 *  consentCopy.ts (Claude-specific facts: the event count, the settings
 *  path); the shared consent gate ships them verbatim to the Intro. */
function consentDisclosure(): { headline: string; disclosure: string } {
  return { headline: CONSENT_INSTALL_HEADLINE, disclosure: CONSENT_DISCLOSURE };
}

// ── Context windows ──

/**
 * Window a Claude model's context is measured against.
 *
 * Claude Code writes the model id on every assistant record but never the
 * limit, so this table is the only thing standing between the context gauge and a
 * wrong denominator -- assuming 200k for a 1M model reads five times too full.
 * Unknown ids return undefined so the runtime keeps whatever it already
 * assumed rather than adopting a fresh guess.
 */
export function contextWindowForModel(model: string | undefined): number | undefined {
  if (!model || model === '<synthetic>') return undefined;
  return CLAUDE_SMALL_CONTEXT_MODEL_PATTERN.test(model)
    ? CLAUDE_SMALL_CONTEXT_WINDOW
    : CLAUDE_LARGE_CONTEXT_WINDOW;
}

/**
 * Tier of a Claude model id, for the office's rarity look.
 *
 * Undefined means "can't place it", which the office draws as no flair at all:
 * `<synthetic>` and ids from a family we haven't met must not read as the
 * smallest model.
 */
export function modelTier(model: string): ModelTier | undefined {
  const id = model.toLowerCase();
  for (const [family, tier] of CLAUDE_MODEL_TIERS) {
    if (id.includes(family)) return tier;
  }
  return undefined;
}

/** A non-empty trimmed string capped at the title limit, or undefined. */
function titleField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, SESSION_TITLE_MAX_LENGTH) : undefined;
}

/**
 * Claude Code repeats `{type:'custom-title', customTitle}` (from /rename) and
 * `{type:'ai-title', aiTitle}` (auto-generated) throughout a transcript.
 */
export function extractSessionTitle(
  record: unknown,
): { customTitle?: string; aiTitle?: string } | null {
  const r = record as { type?: unknown; customTitle?: unknown; aiTitle?: unknown } | null;
  if (r?.type === 'custom-title') {
    const customTitle = titleField(r.customTitle);
    return customTitle ? { customTitle } : null;
  }
  if (r?.type === 'ai-title') {
    const aiTitle = titleField(r.aiTitle);
    return aiTitle ? { aiTitle } : null;
  }
  return null;
}

/**
 * Claude Code writes `{type:'permission-mode', permissionMode}` records and
 * stamps `permissionMode` on every user record. Both reach the transcript when a
 * prompt is submitted, which no installed hook beats (UserPromptSubmit is not
 * installed). The value goes out raw; the runtime keeps only the modes it knows.
 */
export function extractPermissionMode(record: unknown): string | undefined {
  const r = record as { type?: unknown; permissionMode?: unknown } | null;
  if (r?.type === 'permission-mode') {
    return typeof r.permissionMode === 'string' ? r.permissionMode : undefined;
  }
  if (r?.type === 'user' && typeof r.permissionMode === 'string') return r.permissionMode;
  return undefined;
}

/**
 * Claude Code stamps `gitBranch` and `cwd` on every user, assistant, attachment and system
 * record, and appends a `cost-state` row (no timestamp of its own) with the process's running
 * `totalCostUSD`. Values pass through raw; the runtime caps the branch before it leaves.
 */
export function extractSessionMeta(record: unknown): SessionMetaFacts | null {
  const r = record as {
    type?: unknown;
    gitBranch?: unknown;
    cwd?: unknown;
    totalCostUSD?: unknown;
  } | null;
  if (typeof r !== 'object' || r === null) return null;
  const facts: SessionMetaFacts = {};
  const timestampMs = recordTimestampMs(record);
  if (timestampMs !== undefined) facts.timestampMs = timestampMs;
  if (typeof r.gitBranch === 'string' && r.gitBranch) facts.branch = r.gitBranch;
  if (typeof r.cwd === 'string' && r.cwd) facts.cwd = r.cwd;
  if (
    r.type === 'cost-state' &&
    typeof r.totalCostUSD === 'number' &&
    Number.isFinite(r.totalCostUSD) &&
    r.totalCostUSD >= 0
  ) {
    facts.totalCostUsd = r.totalCostUSD;
  }
  return Object.keys(facts).length > 0 ? facts : null;
}

// ── Turn signals ──

/** Interrupt marker Claude writes as a user text record, with or without the
 *  "for tool use" suffix. */
const INTERRUPT_PREFIX = '[Request interrupted by user';

/** Prefixes of user records the CLI injects around slash commands. They carry
 *  no prompt: treating them as one marks an idle session as working. */
const META_TEXT_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
];

const TURN_TRAITS: TurnTraits = {
  longRunningTools: new Set(['Bash', 'Agent', 'Task', 'Monitor', 'WebFetch']),
  userQuestionTools: new Set(['AskUserQuestion']),
  shellTools: new Set(['Bash']),
  editTools: new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
  userInputTools: new Set(['AskUserQuestion', 'ExitPlanMode']),
};

/**
 * What one Claude transcript record says about the turn. The live parser and
 * the adoption-time tail walk both classify through this, so a record can't
 * mean one thing while an agent runs and another when it is adopted.
 */
export function turnSignal(record: unknown): TurnSignal {
  const r = (record ?? {}) as {
    type?: unknown;
    subtype?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
    message?: { content?: unknown };
    content?: unknown;
  };
  const timestampMs = recordTimestampMs(record);
  const stamp = (kind: TurnSignal['kind'], extra?: Partial<TurnSignal>): TurnSignal => ({
    kind,
    ...extra,
    ...(timestampMs === undefined ? {} : { timestampMs }),
  });
  const content = r.message?.content ?? r.content;

  if (r.type === 'system') {
    return stamp(r.subtype === 'turn_duration' ? 'turnEnd' : 'ignore');
  }

  if (r.type === 'assistant') {
    if (typeof content === 'string') return stamp(content.trim() ? 'textAnswer' : 'ignore');
    if (!Array.isArray(content) || content.length === 0) return stamp('ignore');
    const blocks = content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>;
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length > 0) {
      return stamp('toolUse', {
        toolUseIds: toolUses.flatMap((b) => (b.id ? [b.id] : [])),
        toolNames: toolUses.map((b) => b.name ?? ''),
        toolInputs: toolUses.map((b) => b.input),
      });
    }
    if (blocks.some((b) => b.type === 'text')) return stamp('textAnswer');
    if (blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
      return stamp('thinking');
    }
    return stamp('ignore');
  }

  if (r.type === 'user') {
    const injected = r.isMeta === true || r.isCompactSummary === true;
    let text: string | undefined;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const blocks = content as Array<{ type?: string; tool_use_id?: string; text?: unknown }>;
      // A result closes a tool call whatever flags the record carries.
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        return stamp('toolResult', {
          toolUseIds: results.flatMap((b) => (b.tool_use_id ? [b.tool_use_id] : [])),
        });
      }
      const first = blocks.find((b) => b.type === 'text' && typeof b.text === 'string');
      // Attachments without text (a pasted image) still start a turn.
      text = first ? (first.text as string) : blocks.length > 0 ? 'attachment' : '';
    }
    if (injected) return stamp('meta');
    const trimmed = (text ?? '').trim();
    if (!trimmed) return stamp('ignore');
    if (trimmed.startsWith(INTERRUPT_PREFIX)) return stamp('interrupted');
    if (META_TEXT_PREFIXES.some((p) => trimmed.startsWith(p))) return stamp('meta');
    return stamp('prompt');
  }

  // file-history-snapshot, queue-operation, custom-title, ai-title, agent-name,
  // summary, attachment, progress and anything newer: bookkeeping.
  return stamp('ignore');
}

// ── Real-work signals (what XP pays for) ──

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_RUNNERS: ReadonlySet<string> = new Set(['vitest', 'jest', 'pytest']);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** git options before the subcommand that take the next word as their value. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c']);
/** One segment is one simple command, cut once heredoc bodies, quoted spans and comments are
 *  blanked. They hold text such as a commit message or a PR body, and a merge pays on its exit
 *  code alone, so a command named in text must never read as one that ran. */
const SHELL_SEPARATORS = /\n|&&|\|\||;|\|/;
/** A heredoc operator and its delimiter: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<< "EOF"`, `<<\EOF`.
 *  A here-string (`<<<`) is not one. Read with matchAll only. */
const HEREDOC_START = /(?<!<)<<(?!<)(-?)[ \t]*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
/** A `#` that starts a word opens a comment, which can hold an apostrophe. */
const COMMENT_START = /[\s;&|()]/;
/** A help page runs nothing and exits 0. */
const HELP_FLAGS: ReadonlySet<string> = new Set(['-h', '--help']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PR_URL = /https?:\/\/[^\s/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
/** What git prints for a new commit: `[main abc1234]`, `[main (root-commit) abc1234]`,
 *  `[detached HEAD abc1234]`. Read with matchAll only, so the /g state never leaks. */
const COMMIT_LINE = /^\[[^\]\n]*\b([0-9a-f]{7,40})\]/gm;
const TESTS_LINE = /^\s*Tests:?\s+(.+)$/m;
const JS_FAILED_FILES = /^\s*Test (?:Files|Suites):?\s+.*\d+ failed/m;
const PYTEST_SUMMARY = /^=+ (.+?) in [\d.]+s.*=+$/gm;
const GO_OK = /^ok\s+\S+/m;
const GO_FAIL = /^(?:FAIL|--- FAIL:)/m;
/** A failed TAP test (node --test, tap, tape, mocha's TAP reporter). */
const TAP_NOT_OK = /^\s*not ok\b/m;
/** What gh prints, with exit code 0 and no terminal, for a PR that is merged already. */
const ALREADY_MERGED = /was already merged/;
const PASSED = /(\d+) passed/;
const FAILED = /(\d+) failed/;
const ERRORS = /(\d+) errors?/;

/** Hashed identity of a signal: dedupes without keeping repo names, PR numbers or shas. */
function signalKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** The command without its heredoc bodies. A body runs from the line after its operator through
 *  the line holding only its delimiter (leading tabs dropped for `<<-`), or to the end. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    kept.push(line);
    for (const [, dash, , word] of line.matchAll(HEREDOC_START)) {
      while (i < lines.length) {
        const body = lines[i++];
        if ((dash ? body.replace(/^\t+/, '') : body) === word) break;
      }
    }
  }
  return kept.join('\n');
}

/** The command with each quoted span reduced to an empty quoted word and each comment dropped.
 *  The empty word keeps option values in place (`git -c "user.name=A B" commit`). An unclosed
 *  quote runs to the end. */
function blankQuotesAndComments(command: string): string {
  let out = '';
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === '\\') {
      out += command.slice(i, i + 2);
      i += 2;
    } else if (c === "'" || c === '"') {
      // Only a plain single quote takes no escapes: `$'...'` does, like a double quote.
      const escapes = c === '"' || command[i - 1] === '$';
      let j = i + 1;
      while (j < command.length && command[j] !== c) j += escapes && command[j] === '\\' ? 2 : 1;
      out += "''";
      i = j + 1;
    } else if (c === '#' && (i === 0 || COMMENT_START.test(command[i - 1]))) {
      const end = command.indexOf('\n', i);
      i = end < 0 ? command.length : end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A shell segment's words, leading `VAR=value` assignments dropped. */
function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/);
  let first = 0;
  while (first < words.length && ENV_ASSIGNMENT.test(words[first])) first++;
  return words.slice(first);
}

/** The git subcommand, past global options such as `-C repo` or `-c key=value`. */
function gitSubcommand(words: string[]): string | undefined {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
  }
  return words[i];
}

function isTestRun(words: string[]): boolean {
  if (words.some((w) => TEST_RUNNERS.has(w.slice(w.lastIndexOf('/') + 1)))) return true;
  if (words[0] === 'go' && words[1] === 'test') return true;
  return (
    PACKAGE_MANAGERS.has(words[0]) &&
    (words[1] === 'test' || (words[1] === 'run' && (words[2] ?? '').startsWith('test')))
  );
}

/** The PR a `gh pr merge` segment names: a URL gives repo and number, a bare number only the
 *  number. Undefined for a branch name or the current branch. */
function mergeKey(segment: string, words: string[]): string | undefined {
  const url = PR_URL.exec(segment);
  if (url) return signalKey(`merge:${url[1]}#${url[2]}`);
  const n = words.slice(3).find((w) => /^\d+$/.test(w));
  return n ? signalKey(`merge:#${n}`) : undefined;
}

/**
 * What a Claude tool call may prove. An edit is the change a later green test run must
 * follow; a Bash command is read segment by segment for commits, PRs and test runs. Only
 * verdicts and hashed keys leave this function, never the command text.
 */
export function toolVerdicts(name: string, input: unknown): ToolVerdict[] {
  if (EDIT_TOOLS.has(name)) return [{ kind: 'edit' }];
  if (name !== 'Bash') return [];
  const command = (input as { command?: unknown } | null)?.command;
  if (typeof command !== 'string') return [];
  const found = new Map<ToolVerdict['kind'], ToolVerdict>();
  const add = (verdict: ToolVerdict): void => {
    if (!found.has(verdict.kind)) found.set(verdict.kind, verdict);
  };
  for (const segment of blankQuotesAndComments(stripHeredocs(command)).split(SHELL_SEPARATORS)) {
    const words = commandWords(segment);
    if (words.some((w) => HELP_FLAGS.has(w))) continue;
    if (words[0] === 'git') {
      const sub = gitSubcommand(words);
      if (sub === 'commit') add({ kind: words.includes('--amend') ? 'commit-amend' : 'commit' });
      else if (sub === 'cherry-pick') add({ kind: 'commit' });
    } else if (words[0] === 'gh' && words[1] === 'pr') {
      if (words[2] === 'create') {
        add({ kind: 'pr-create' });
      } else if (
        words[2] === 'merge' &&
        // --auto only queues the merge on GitHub: nothing is merged when the command returns.
        !words.includes('--auto') &&
        !words.includes('--disable-auto')
      ) {
        const key = mergeKey(segment, words);
        add(key ? { kind: 'pr-merge', key } : { kind: 'pr-merge' });
      }
    } else if (isTestRun(words)) {
      add({ kind: 'test' });
    }
  }
  return [...found.values()];
}

/** The output a result carries. Both streams, since jest prints its summary to stderr. */
function resultText(toolUseResult: unknown, content: unknown): string {
  const out = toolUseResult as { stdout?: unknown; stderr?: unknown } | null;
  if (out !== null && typeof out === 'object' && typeof out.stdout === 'string') {
    return `${out.stdout}\n${typeof out.stderr === 'string' ? out.stderr : ''}`;
  }
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content as Array<{ type?: unknown; text?: unknown } | null>) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n');
}

/** The number a summary gives for one outcome, 0 when it names none. */
function summaryCount(summary: string, outcome: RegExp): number {
  const match = outcome.exec(summary);
  return match ? Number(match[1]) : 0;
}

type SuiteVerdict = 'green' | 'red' | undefined;

function jsSuite(text: string): SuiteVerdict {
  const line = TESTS_LINE.exec(text);
  const failedFiles = JS_FAILED_FILES.test(text);
  if (!line && !failedFiles) return undefined;
  return line &&
    summaryCount(line[1], PASSED) >= 1 &&
    summaryCount(line[1], FAILED) === 0 &&
    !failedFiles
    ? 'green'
    : 'red';
}

function pytestSuite(text: string): SuiteVerdict {
  const summary = [...text.matchAll(PYTEST_SUMMARY)].at(-1)?.[1];
  if (summary === undefined) return undefined;
  return summaryCount(summary, PASSED) >= 1 &&
    summaryCount(summary, FAILED) === 0 &&
    summaryCount(summary, ERRORS) === 0
    ? 'green'
    : 'red';
}

function goSuite(text: string): SuiteVerdict {
  const ok = GO_OK.test(text);
  const failed = GO_FAIL.test(text);
  if (!ok && !failed) return undefined;
  return ok && !failed ? 'green' : 'red';
}

/** TAP's `ok` lines read as a green go summary, so its failures must read red. */
function tapSuite(text: string): SuiteVerdict {
  return TAP_NOT_OK.test(text) ? 'red' : undefined;
}

/** A runner's own summary says the suite passed, and no other runner's says it failed. No
 *  summary pays nothing: a background start, a quiet run and a truncated log all exit 0. */
function testsGreen(text: string): boolean {
  const suites = [jsSuite(text), pytestSuite(text), goSuite(text), tapSuite(text)];
  return suites.includes('green') && !suites.includes('red');
}

/**
 * The work a Claude tool result proves for its tool_use's verdicts. A failed result proves
 * nothing, an edit included. Commits, PRs and test runs are read from the command's own
 * output; a merge is proven by the command succeeding, since gh prints nothing on a merge
 * without a terminal, unless it says the PR was merged already.
 */
export function resultSignals(verdicts: ToolVerdict[], record: unknown): SignalHit[] {
  const r = (record ?? {}) as {
    message?: { content?: unknown };
    content?: unknown;
    toolUseResult?: unknown;
  };
  const content = r.message?.content ?? r.content;
  if (!Array.isArray(content)) return [];
  const block = (
    content as Array<{
      type?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
      content?: unknown;
    } | null>
  ).find((b) => b?.type === 'tool_result');
  if (!block || block.is_error === true) return [];
  const text = resultText(r.toolUseResult, block.content);
  const hits: SignalHit[] = [];
  for (const verdict of verdicts) {
    switch (verdict.kind) {
      case 'edit':
        hits.push({ kind: 'edit' });
        break;
      case 'commit':
        // An amend in the same command prints a line too, and no line says which one it is.
        if (verdicts.some((v) => v.kind === 'commit-amend')) break;
        for (const match of text.matchAll(COMMIT_LINE)) {
          hits.push({ kind: 'commit', key: signalKey(`commit:${match[1]}`) });
        }
        break;
      case 'commit-amend':
        // An amend rewrites a commit that already paid.
        break;
      case 'pr-create': {
        const url = PR_URL.exec(text);
        if (url) hits.push({ kind: 'pr', key: signalKey(`pr:${url[1]}#${url[2]}`) });
        break;
      }
      case 'pr-merge':
        // Its success is the only proof, and a re-run on a merged PR succeeds too.
        if (ALREADY_MERGED.test(text)) break;
        hits.push({
          kind: 'merge',
          key: verdict.key ?? signalKey(`merge:${String(block.tool_use_id)}`),
        });
        break;
      case 'test':
        if (testsGreen(text)) hits.push({ kind: 'tests' });
        break;
    }
  }
  return hits;
}

// ── Artifacts and loops ──

const ARTIFACT_TOOL = 'Artifact';
const WAKEUP_TOOL = 'ScheduleWakeup';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The page an Artifact call published. A publish has no action or `publish`, and its result
 * carries the page's `url`; a redeploy returns the same url. Everything else the tool does
 * (read, list, open, quickstart, an asset upload, a page created from a template) either
 * names another action or carries no top-level url, and a failed call has no result object.
 */
function extractArtifact(
  call: { name: string; input: unknown },
  result: { isError: boolean; record: unknown },
): { url: string; title?: string } | undefined {
  if (call.name !== ARTIFACT_TOOL || result.isError) return undefined;
  const input = asRecord(call.input);
  const action = input?.action;
  if (action !== undefined && action !== 'publish') return undefined;
  if (input?.asset === true || input?.type_url !== undefined) return undefined;
  const out = asRecord(asRecord(result.record)?.toolUseResult);
  if (typeof out?.url !== 'string' || out.created_from_type === true) return undefined;
  return { url: out.url, title: typeof out.title === 'string' ? out.title : undefined };
}

/**
 * A self-scheduled wake-up in one record: the tool call that stops the loop, the result that
 * schedules (or, with a time of 0, cancels) the next wake, and the system record a wake leaves
 * when it fires. Only wake-ups of the loop kind count; a cron job's fire has no `taskKind`.
 */
function extractLoop(record: unknown): LoopEvent | undefined {
  const r = asRecord(record);
  if (!r) return undefined;
  if (r.type === 'system') {
    return r.subtype === 'scheduled_task_fire' && r.taskKind === 'loop'
      ? { kind: 'fire' }
      : undefined;
  }
  if (r.type === 'assistant') {
    const content = asRecord(r.message)?.content ?? r.content;
    if (!Array.isArray(content)) return undefined;
    for (const block of content as unknown[]) {
      const b = asRecord(block);
      if (b?.type === 'tool_use' && b.name === WAKEUP_TOOL && asRecord(b.input)?.stop === true) {
        return { kind: 'stop' };
      }
    }
    return undefined;
  }
  if (r.type === 'user') {
    const out = asRecord(r.toolUseResult);
    const scheduledFor = out?.scheduledFor;
    // The shape of the wake-up tool's result: a cron job's has no `scheduledFor`.
    if (typeof scheduledFor !== 'number' || !Number.isFinite(scheduledFor)) return undefined;
    if (typeof out?.clampedDelaySeconds !== 'number' && out?.stopped !== true) return undefined;
    return scheduledFor > 0 ? { kind: 'schedule', nextAt: scheduledFor } : { kind: 'stop' };
  }
  return undefined;
}

// ── The provider ──

export const claudeProvider: HookProvider = {
  kind: 'hook',
  id: 'claude',
  displayName: 'Claude Code',
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,
  legacyReplaceLabel,

  formatToolStatus,
  permissionExemptTools: new Set(['Task', 'Agent', 'AskUserQuestion']),
  subagentToolNames: new Set(['Task', 'Agent']),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),
  terminalNamePrefix: CLAUDE_TERMINAL_NAME_PREFIX,
  contextWindowForModel,
  modelTier,
  extractSessionTitle,
  extractPermissionMode,
  extractSessionMeta,
  turnSignal,
  turnTraits: TURN_TRAITS,
  toolVerdicts,
  resultSignals,
  extractArtifact,
  extractLoop,
  liveness: claudeSessionLiveness,
  transcriptUsage: createClaudeTranscriptUsage(extractSessionTitle),

  getSessionDirs,
  getAllSessionRoots,
  sessionFilePattern: '*.jsonl',
  buildLaunchCommand,

  team: claudeTeamProvider,
};
