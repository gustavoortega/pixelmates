/**
 * Who needs the user, as the attention rail lists them. Pure: the rail and the arrow keys lay
 * out what these return, and every rule is a table test.
 *
 * - Needs you: a permission prompt (an open tool row waiting on permission), a question (the
 *   agent stopped on a question for the user) or an idle wait (it finished and sits at its
 *   prompt). Stuck: an unacknowledged tripwire, or a health mark that says the agent spins
 *   (stuck, looping, stalled; a dead process is not something to answer).
 * - One ticket per agent, in its most urgent kind: permission, then question, then idle, then
 *   stuck; a tripwire outranks a health mark, since it waits on an acknowledgement.
 * - Oldest first by the server's `since` (a ticket whose start is unknown goes after the dated
 *   ones, by id), except that idle waits come after every permission and question ticket: a
 *   finished session never outranks one that is blocked.
 * - No session text reaches a reason except the program (and allowlisted subcommand) the server
 *   already put in a Bash status, a tripwire's rule name, and the question the agent asked: the
 *   server redacted and cut it, and the rail's reason line is masked by privacy mode.
 */

import type { HealthState } from '../../../core/src/messages.js';
import type { AgentHealthView } from '../office/health.js';
import type { ToolActivity } from '../office/types.js';
import { formatDuration } from './limitsPace.js';

export type TicketKind = 'permission' | 'question' | 'idle' | 'stuck';

/** What the rail reads about one top-level agent. Absent fields are unknown, never 0. */
export interface AttentionAgent {
  id: number;
  /** The tool rows as the webview holds them. */
  tools?: readonly ToolActivity[];
  /** The last agentStatus; absent means active. */
  status?: string;
  /** The waiting status asks something of the user (a question, or an idle wait). */
  awaitingInput?: boolean;
  /** Why it waits, from the server; absent (an older server) reads as a question. */
  awaitingReason?: 'question' | 'idle';
  /** What the agent asked, when the server could read it. */
  question?: string;
  /** The last tool the agent started, by its provider-agnostic name. */
  currentTool?: string | null;
  health?: AgentHealthView;
  tripwire?: { ruleName: string; count: number };
  statusSince?: number;
  permissionSince?: number;
  healthSince?: number;
  tripwireSince?: number;
}

export interface Ticket {
  id: number;
  kind: TicketKind;
  /** The corner badge: `!` permission, `?` question, `–` idle wait, `×` stuck. */
  glyph: '!' | '?' | '–' | '×';
  /** The line to read from 2 m. */
  reason: string;
  /** Epoch ms (server clock) the state began; absent when the server did not say. */
  since?: number;
}

export interface Attention {
  needs: Ticket[];
  stuck: Ticket[];
}

const BASH_STATUS_PREFIX = 'Running: ';
const SPINNING: ReadonlySet<HealthState> = new Set(['stuck', 'looping', 'stalled']);

/**
 * `Allow git push?` for a shell call: the program and subcommand the server already reduced the
 * command to. Any other tool is named, never described: a status like `Reading secrets.env`
 * carries a file name.
 */
export function permissionReason(status: string, currentTool: string | null | undefined): string {
  if (status.startsWith(BASH_STATUS_PREFIX)) {
    const program = status.slice(BASH_STATUS_PREFIX.length).trim();
    return `Allow ${program || 'Bash'}?`;
  }
  return currentTool ? `Allow ${currentTool}?` : 'Allow this tool?';
}

/** The health mark as a reason, from its enum and count only. */
export function healthReason(health: AgentHealthView): string {
  switch (health.reason) {
    case 'tests_failing_no_edits':
      return `tests failing ×${health.count} · no edits`;
    case 'same_call_repeated':
      return `same call ×${health.count}`;
    case 'no_progress':
      return `no progress ${formatDuration(health.count * 60_000)}`;
    default:
      return health.state;
  }
}

function ticketFor(agent: AttentionAgent): Ticket | null {
  const waiting = agent.tools?.find((t) => !t.done && t.permissionWait);
  if (waiting) {
    return {
      id: agent.id,
      kind: 'permission',
      glyph: '!',
      reason: permissionReason(waiting.status, agent.currentTool),
      since: agent.permissionSince,
    };
  }
  if (agent.status === 'waiting' && agent.awaitingInput) {
    if (agent.awaitingReason === 'idle') {
      return {
        id: agent.id,
        kind: 'idle',
        glyph: '–',
        reason: 'Finished, waiting for you',
        since: agent.statusSince,
      };
    }
    return {
      id: agent.id,
      kind: 'question',
      glyph: '?',
      reason: agent.question ?? 'Has a question',
      since: agent.statusSince,
    };
  }
  if (agent.tripwire) {
    return {
      id: agent.id,
      kind: 'stuck',
      glyph: '×',
      reason: agent.tripwire.ruleName,
      since: agent.tripwireSince,
    };
  }
  if (agent.health && SPINNING.has(agent.health.state)) {
    return {
      id: agent.id,
      kind: 'stuck',
      glyph: '×',
      reason: healthReason(agent.health),
      since: agent.healthSince,
    };
  }
  return null;
}

function oldestFirst(a: Ticket, b: Ticket): number {
  if ((a.kind === 'idle') !== (b.kind === 'idle')) return a.kind === 'idle' ? 1 : -1;
  if (a.since !== undefined && b.since !== undefined && a.since !== b.since) {
    return a.since - b.since;
  }
  if (a.since !== undefined && b.since === undefined) return -1;
  if (a.since === undefined && b.since !== undefined) return 1;
  return a.id - b.id;
}

export function attentionTickets(agents: Iterable<AttentionAgent>): Attention {
  const needs: Ticket[] = [];
  const stuck: Ticket[] = [];
  for (const agent of agents) {
    const ticket = ticketFor(agent);
    if (!ticket) continue;
    (ticket.kind === 'stuck' ? stuck : needs).push(ticket);
  }
  needs.sort(oldestFirst);
  stuck.sort(oldestFirst);
  return { needs, stuck };
}

/** The order ←/→ walk: the rail's tickets top to bottom, then everyone else by id. */
export function cycleOrder(attention: Attention, sessionIds: Iterable<number>): number[] {
  const first = [...attention.needs, ...attention.stuck].map((t) => t.id);
  const listed = new Set(first);
  const rest = [...sessionIds].filter((id) => !listed.has(id)).sort((a, b) => a - b);
  return [...first, ...rest];
}

/** The session one step from `current` (wrapping); from nothing, → takes the first, ← the last. */
export function stepSession(
  order: readonly number[],
  current: number | null,
  step: 1 | -1,
): number | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return step === 1 ? order[0] : order[order.length - 1];
  return order[(at + step + order.length) % order.length];
}

/** The minutes block: `12` + `MIN`; from 100 minutes `1h40` (no unit line); unknown `–`. */
export function minutesBlock(
  since: number | undefined,
  now: number,
): { value: string; unit: string | null } {
  if (since === undefined) return { value: '–', unit: null };
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 100) return { value: String(minutes), unit: 'MIN' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h${String(minutes % 60).padStart(2, '0')}`, unit: null };
  return { value: `${Math.floor(hours / 24)}d${hours % 24}h`, unit: null };
}

/** Context used, whole percent, or absent when either side is unknown. */
export function contextPercent(
  contextTokens: number | undefined,
  maxContextTokens: number | undefined,
): number | undefined {
  if (!contextTokens || !maxContextTokens || maxContextTokens <= 0) return undefined;
  return Math.min(100, Math.round((contextTokens / maxContextTokens) * 100));
}

const TIER_NAMES = ['Haiku', 'Sonnet', 'Opus', 'Fable'] as const;
const MODEL_ID = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

/**
 * `claude-opus-5-5` reads `Opus 5.5`. An id that does not read that way falls back to the
 * tier's family name, the one the medal's glyph stands for; neither known, nothing.
 */
export function modelLabel(model: string | undefined, tier: number | undefined): string | null {
  const m = model ? MODEL_ID.exec(model.toLowerCase()) : null;
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return m[3] === undefined ? `${family} ${m[2]}` : `${family} ${m[2]}.${m[3]}`;
  }
  return tier !== undefined && tier >= 1 && tier <= 4 ? TIER_NAMES[tier - 1] : null;
}
