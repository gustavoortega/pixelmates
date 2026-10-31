/**
 * What the inspector sheet shows for one agent, as plain rows. Pure and DOM-free: the sheet only
 * lays out what this returns, and the table test reads it directly.
 *
 * Absent is never 0 (D3): a section, cell or line whose data is unknown is left out, and a 0 is
 * shown only when the server sent one. Text that came from the user's session (titles, folders,
 * branches, ids, commands, workflow names and labels, artifact titles and urls) is a `Text` with
 * `pv` set, so privacy mode can mask it; names, minutes, models and contexts are never masked.
 */

import { CACHE_TTL_5M_SECONDS } from '../../../../core/src/constants.js';
import type { HealthState, PermissionMode } from '../../../../core/src/messages.js';
import type { ModelTier } from '../../../../core/src/provider.js';
import {
  CACHE_ROW_MIN_CONTEXT_TOKENS,
  INSPECTOR_RING_WARM_FRACTION,
  MEDAL_HOT_FRACTION,
  PERMISSION_MODE_ROW_TEXT,
} from '../../constants.js';
import type {
  AgentArtifactsView,
  AgentLoopView,
  AgentSessionView,
  AgentTestsView,
  WorkflowRunView,
} from '../../office/engine/officeState.js';
import { type AgentHealthView, healthLabel } from '../../office/health.js';
import type { TripwireAlarm, TripwireSeverity } from '../../office/toolUtils.js';
import type { ToolActivity } from '../../office/types.js';
import { modelLabel } from '../attention.js';

const MIN_MS = 60_000;

/** A run of text; `pv` marks session text that privacy mode masks. */
export interface Text {
  text: string;
  pv?: boolean;
}

export type ChipTone = 'gold' | 'rust' | 'sage' | 'paper' | 'quiet';
/** The pixel mark before a chip's words: drawn, since the font has no check, pip or loop. */
export type ChipMark = '!' | '?' | '›' | 'loop' | 'check';

/** The state chip (E32): who needs you first, then what the agent is doing. */
export interface Chip {
  tone: ChipTone;
  mark?: ChipMark;
  parts: Text[];
}

/** The context ring's fill: gold under 70%, coral from 70%, rust from 85% (the medals' hot). */
export type RingTone = 'gold' | 'warm' | 'hot';

export function contextTone(fraction: number): RingTone {
  if (fraction >= MEDAL_HOT_FRACTION) return 'hot';
  if (fraction >= INSPECTOR_RING_WARM_FRACTION) return 'warm';
  return 'gold';
}

export type VitalCell =
  | {
      kind: 'context';
      tier?: ModelTier;
      pct: number;
      fraction: number;
      tone: RingTone;
      caption: string;
    }
  | { kind: 'model'; tier?: ModelTier; text: string; caption?: string }
  | { kind: 'session'; parts: DurationPart[]; caption: string }
  | { kind: 'cost'; text: string; caption?: string }
  | { kind: 'cache'; cold: boolean; parts: DurationPart[]; caption: string };

export interface DurationPart {
  n: string;
  unit: string;
}

export interface TreeRow {
  /** Stable key for React. */
  key: string;
  name: Text;
  /** Phase, sub-agent type or role, under the name. */
  sub?: string;
  /** A working helper's minutes since its start (`12m`); absent when the start is unknown. */
  minutes?: string;
  chip: Chip;
}

export interface TreeGroup {
  kind: 'lead' | 'team' | 'workflow' | 'sub';
  title: string;
  /** A workflow group's run name. */
  name?: Text;
  rows: TreeRow[];
}

export interface WorkflowPhaseView {
  name: string;
  started: number;
  done: number;
  /** The newest phase of a running run: gold. */
  current: boolean;
}

export interface WorkflowView {
  key: string;
  name: Text;
  done: boolean;
  /** `since 14:59 · 21m`, absent after a server restart (A18). */
  age?: string;
  phases: WorkflowPhaseView[];
  /** `4 started · 1 done`, each half only when sent. */
  counts?: string;
}

export interface ArtifactRow {
  key: string;
  title: Text;
  /** `1 publish`, `×2 publishes`: only when the server counted them (a cut scan does not). */
  publishes?: string;
  time?: string;
  /** Set only for an http(s) url: anything else is shown, never linked. */
  href?: string;
  /** The url as shown: host and path, no scheme. */
  urlText?: Text;
}

export interface InspectorView {
  id: number;
  hero: {
    /** The roster or teammate name; a folder standing in for one is session text. */
    name: Text;
    lead: boolean;
    chip: Chip;
    title?: Text;
    /** The pending question in full; session text, so masked in privacy mode. */
    question?: Text;
    meta: Array<{ kind: 'folder' | 'branch' | 'id'; text: Text }>;
    tags: Array<{ kind: 'mode' | 'shells'; text: string }>;
  };
  vitals: VitalCell[];
  coldNote?: string;
  /** The open tool (a command with its prompt mark) or `thinking`, and since when. */
  now?: { command: boolean; text: Text; waiting: boolean; since?: string };
  workflows: WorkflowView[];
  loop?: { next?: string; wakes?: string };
  tree: TreeGroup[];
  artifacts?: { count: string; rows: ArtifactRow[] };
  tests?: { passed?: number; failed?: number; at?: string };
  health?: { state: HealthState; label: string; since?: string };
  tripwire?: { ruleName: string; count: number; countText?: string; severity: TripwireSeverity };
}

/** What a helper (crew agent or sub-agent) of this agent looks like to the sheet. */
export interface HelperInput {
  id: number;
  /** `wf:<runId>:<agentId>` for a crew helper, the spawning tool id for a sub-agent. */
  parentToolId: string;
  /** Workflow label or the sub-agent's task. */
  label: string;
  /** The workflow phase. */
  group?: string;
  /** Its live tool rows. */
  tools: readonly ToolActivity[];
  bubbleType: 'permission' | 'waiting' | null;
  /** Its task is over: a sub-agent whose spawn row on the lead is done. */
  done: boolean;
  /** Epoch ms it started, when this page saw the spawn. */
  startedAt?: number;
}

/** The parts of an agent the chip reads, for the agent itself and for teammates. */
export interface AgentStateInput {
  isActive: boolean;
  bubbleType: 'permission' | 'waiting' | null;
  waitingAwaitingInput?: boolean;
  /** The wire text of a pending question; outlives the bubble, which fades after 2 s. */
  question?: string;
  tools: readonly ToolActivity[];
  health?: AgentHealthView;
  loop?: AgentLoopView;
  statusSince?: number;
}

export interface InspectorInput extends AgentStateInput {
  id: number;
  name: Text;
  folder?: string;
  isTeamLead?: boolean;
  contextTokens: number;
  maxContextTokens: number;
  title?: string;
  model?: { model: string; tier?: ModelTier };
  session?: AgentSessionView;
  artifacts?: AgentArtifactsView;
  tests?: AgentTestsView;
  runs?: ReadonlyMap<string, WorkflowRunView>;
  permissionSince?: number;
  healthSince?: number;
  tripwire?: TripwireAlarm;
  cache?: { ttlSeconds: number; expiresAt: number };
  mode?: PermissionMode;
  shells?: number;
  helpers: readonly HelperInput[];
  /** The agent this one reports to (a teammate's lead). */
  lead?: { id: number; name: Text } & AgentStateInput;
  /** Teammates that report to this agent. */
  mates: ReadonlyArray<{ id: number; name: Text } & AgentStateInput>;
  /** Epoch ms of this render (officeNow). */
  now: number;
}

// ── Formatting ───────────────────────────────────────────────────────────

/** `14:07`, local time. */
export function clockText(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whole minutes as `12m`, `1h08m`; a span under a minute is `0m`. */
export function minutesText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MIN_MS));
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m`;
}

/** The same span as number and unit pairs, for a big value with small units. */
export function durationParts(ms: number): DurationPart[] {
  const total = Math.max(0, Math.floor(ms / MIN_MS));
  if (total < 60) return [{ n: String(total), unit: 'm' }];
  return [
    { n: String(Math.floor(total / 60)), unit: 'h' },
    { n: String(total % 60).padStart(2, '0'), unit: 'm' },
  ];
}

/** `910k`, `1M`, `1.5M`, `640`. */
export function tokensText(n: number): string {
  if (n >= 1_000_000) {
    const m = Math.round(n / 100_000) / 10;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** An artifact url as a link target: only http and https, so a `javascript:` url is never one. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** What a url shows: host and path for an http(s) url (no scheme, no trailing slash), else as sent. */
function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

// ── The state chip ───────────────────────────────────────────────────────

const RUNNING_PREFIX = 'Running: ';

/** The open tool: the newest row not done. */
function openTool(tools: readonly ToolActivity[]): ToolActivity | undefined {
  for (let i = tools.length - 1; i >= 0; i--) if (!tools[i].done) return tools[i];
  return undefined;
}

/** The program (and allowlisted subcommand) of a shell status, else undefined. */
function commandOf(status: string): string | undefined {
  return status.startsWith(RUNNING_PREFIX) ? status.slice(RUNNING_PREFIX.length) : undefined;
}

/** The tool a status names, for `writing · Edit` and `allow Read?`. */
function toolOf(status: string): string | undefined {
  const using = /^Using (\S+)/.exec(status);
  if (using) return using[1];
  const prefixes: Array<[string, string]> = [
    ['Reading', 'Read'],
    ['Editing notebook', 'NotebookEdit'],
    ['Editing', 'Edit'],
    ['Writing', 'Write'],
    ['Searching files', 'Glob'],
    ['Searching code', 'Grep'],
    ['Searching the web', 'WebSearch'],
    ['Fetching', 'WebFetch'],
  ];
  for (const [prefix, tool] of prefixes) if (status.startsWith(prefix)) return tool;
  return undefined;
}

function verbOf(status: string): string {
  if (/^(Reading|Searching|Fetching)/.test(status)) return 'reading';
  if (/^(Editing|Writing)/.test(status)) return 'writing';
  if (status.startsWith('Planning')) return 'planning';
  if (status.startsWith('Subtask:')) return 'delegating';
  if (status.startsWith('Waiting for your answer')) return 'asking';
  return 'working';
}

/** The agent's state chip: needs you > health > command > verb > asleep > idle. */
export function stateChip(a: AgentStateInput, now: number): Chip {
  const open = openTool(a.tools);
  if (a.bubbleType === 'permission' || open?.permissionWait) {
    const what = open ? (commandOf(open.status) ?? toolOf(open.status)) : undefined;
    return {
      tone: 'gold',
      mark: '!',
      parts: what
        ? [
            { text: 'allow ' },
            { text: what, pv: commandOf(open!.status) !== undefined },
            { text: '?' },
          ]
        : [{ text: 'needs approval' }],
    };
  }
  if ((a.bubbleType === 'waiting' && a.waitingAwaitingInput) || a.question !== undefined) {
    return { tone: 'gold', mark: '?', parts: [{ text: 'has a question' }] };
  }
  if (a.health) {
    const { state, count } = a.health;
    if (state === 'dead') return { tone: 'rust', parts: [{ text: 'process gone' }] };
    if (state === 'stalled') return { tone: 'rust', parts: [{ text: `stalled ${count}m` }] };
    return { tone: 'rust', parts: [{ text: `\u00D7${count} ${state}` }] };
  }
  if (open) {
    const cmd = commandOf(open.status);
    if (cmd !== undefined) return { tone: 'paper', mark: '›', parts: [{ text: cmd, pv: true }] };
    const tool = toolOf(open.status);
    return {
      tone: 'paper',
      parts: [{ text: tool ? `${verbOf(open.status)} · ${tool}` : verbOf(open.status) }],
    };
  }
  if (a.isActive) return { tone: 'paper', parts: [{ text: 'thinking' }] };
  const next = a.loop?.nextAt;
  if (next !== undefined && next > now) {
    return { tone: 'quiet', mark: 'loop', parts: [{ text: `asleep · ${clockText(next)}` }] };
  }
  const idle = a.statusSince !== undefined ? ` ${minutesText(now - a.statusSince)}` : '';
  return { tone: 'quiet', parts: [{ text: `idle${idle}` }] };
}

// ── Sections ─────────────────────────────────────────────────────────────

function vitals(i: InspectorInput): { cells: VitalCell[]; coldNote?: string } {
  const cells: VitalCell[] = [];
  if (i.contextTokens > 0 && i.maxContextTokens > 0) {
    const fraction = Math.min(1, i.contextTokens / i.maxContextTokens);
    cells.push({
      kind: 'context',
      tier: i.model?.tier,
      pct: Math.round(fraction * 100),
      fraction,
      tone: contextTone(fraction),
      caption: `${tokensText(i.contextTokens)} of ${tokensText(i.maxContextTokens)}`,
    });
  }
  if (i.model) {
    // The rail's words for a model (`Opus 5.5`, else the tier's family), the id under it.
    const label = modelLabel(i.model.model, i.model.tier) ?? i.model.model;
    cells.push({
      kind: 'model',
      tier: i.model.tier,
      text: label,
      caption: label === i.model.model ? undefined : i.model.model,
    });
  }
  const s = i.session;
  if (s?.startedAt !== undefined) {
    cells.push({
      kind: 'session',
      parts: durationParts(i.now - s.startedAt),
      caption: `transcript since ${clockText(s.startedAt)}`,
    });
  }
  if (s?.costUsd !== undefined) {
    cells.push({
      kind: 'cost',
      text: `$${s.costUsd.toFixed(2)}`,
      caption: s.costAt !== undefined ? `as of ${clockText(s.costAt)}` : undefined,
    });
  }
  let coldNote: string | undefined;
  // The full box's rule: under 20k of context the cache is not worth a line.
  if (i.cache && i.contextTokens >= CACHE_ROW_MIN_CONTEXT_TOKENS) {
    const ttl = i.cache.ttlSeconds === CACHE_TTL_5M_SECONDS ? '5m TTL' : '1h TTL';
    const left = i.cache.expiresAt - i.now;
    if (left > 0) {
      cells.push({
        kind: 'cache',
        cold: false,
        parts: durationParts(left),
        caption: `left · ${ttl}`,
      });
    } else {
      cells.push({
        kind: 'cache',
        cold: true,
        parts: [],
        caption: `since ${clockText(i.cache.expiresAt)} · ${ttl}`,
      });
      coldNote = `Cold since ${clockText(i.cache.expiresAt)}: the next turn re-reads ${tokensText(i.contextTokens)}.`;
    }
  }
  return { cells, coldNote };
}

function nowSection(i: InspectorInput): InspectorView['now'] {
  const open = openTool(i.tools);
  const permission = i.bubbleType === 'permission' || open?.permissionWait === true;
  if (!open && !i.isActive && !permission) return undefined;
  const cmd = open ? commandOf(open.status) : undefined;
  const text: Text = open
    ? { text: cmd ?? open.status, pv: true }
    : { text: permission ? 'a permission prompt' : 'thinking' };
  const from = permission ? i.permissionSince : i.statusSince;
  const since =
    from === undefined
      ? undefined
      : `${permission ? 'waiting on you since' : `${i.isActive ? 'active' : 'status'} since`} ${clockText(from)} · ${minutesText(i.now - from)}`;
  return { command: cmd !== undefined, text, waiting: permission, since };
}

function workflows(i: InspectorInput): WorkflowView[] {
  const out: WorkflowView[] = [];
  for (const [runId, run] of i.runs ?? []) {
    const done = run.status === 'done';
    const phases = (run.phases ?? []).map((p, n, all) => ({
      name: p.name ?? 'phase',
      started: p.started ?? 0,
      done: p.done ?? 0,
      current: !done && n === all.length - 1,
    }));
    const counts = [
      run.started !== undefined ? `${run.started} started` : '',
      run.done !== undefined ? `${run.done} done` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    out.push({
      key: runId,
      name: run.name ? { text: run.name, pv: true } : { text: 'Workflow' },
      done,
      age:
        run.since !== undefined
          ? `since ${clockText(run.since)} · ${minutesText(i.now - run.since)}`
          : undefined,
      phases,
      counts: counts || undefined,
    });
  }
  return out;
}

const CREW_PREFIX = 'wf:';

/** A crew helper's run id, from `wf:<runId>:<agentId>`. */
function runOf(parentToolId: string): string | undefined {
  if (!parentToolId.startsWith(CREW_PREFIX)) return undefined;
  const rest = parentToolId.slice(CREW_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  return cut > 0 ? rest.slice(0, cut) : rest;
}

function helperChip(h: HelperInput, now: number): Chip {
  if (h.done && h.bubbleType !== 'permission') {
    return { tone: 'sage', mark: 'check', parts: [{ text: 'done' }] };
  }
  // No tool call yet reads `thinking`, as on the helper's plate.
  return stateChip({ isActive: true, bubbleType: h.bubbleType, tools: h.tools }, now);
}

/** A working helper's age; none once done (the wire has no end time) or with no known start. */
function helperMinutes(h: HelperInput, now: number): string | undefined {
  return h.done || h.startedAt === undefined ? undefined : minutesText(now - h.startedAt);
}

function tree(i: InspectorInput): TreeGroup[] {
  const groups: TreeGroup[] = [];
  if (i.lead) {
    groups.push({
      kind: 'lead',
      title: 'Reports to',
      rows: [
        {
          key: `lead-${i.lead.id}`,
          name: i.lead.name,
          sub: 'lead',
          chip: stateChip(i.lead, i.now),
        },
      ],
    });
  }
  if (i.mates.length > 0) {
    groups.push({
      kind: 'team',
      title: 'Team',
      rows: i.mates.map((m) => ({
        key: `mate-${m.id}`,
        name: m.name,
        sub: 'teammate',
        chip: stateChip(m, i.now),
      })),
    });
  }
  const crewByRun = new Map<string, HelperInput[]>();
  const subs: HelperInput[] = [];
  for (const h of i.helpers) {
    const run = runOf(h.parentToolId);
    if (run === undefined) subs.push(h);
    else crewByRun.set(run, [...(crewByRun.get(run) ?? []), h]);
  }
  for (const [run, helpers] of crewByRun) {
    const name = i.runs?.get(run)?.name;
    groups.push({
      kind: 'workflow',
      title: 'Workflow',
      name: name ? { text: name, pv: true } : undefined,
      rows: helpers.map((h) => ({
        key: `helper-${h.id}`,
        name: { text: h.label || 'helper', pv: Boolean(h.label) },
        sub: h.group,
        minutes: helperMinutes(h, i.now),
        chip: helperChip(h, i.now),
      })),
    });
  }
  if (subs.length > 0) {
    groups.push({
      kind: 'sub',
      title: 'Sub-agents',
      rows: subs.map((h) => ({
        key: `sub-${h.id}`,
        name: { text: h.label || 'sub-agent', pv: Boolean(h.label) },
        minutes: helperMinutes(h, i.now),
        chip: helperChip(h, i.now),
      })),
    });
  }
  return groups;
}

function artifacts(a: AgentArtifactsView | undefined): InspectorView['artifacts'] {
  const items = a?.items ?? [];
  if (!a || (items.length === 0 && !a.count)) return undefined;
  const n = a.count ?? items.length;
  const rows = items.map((it, k): ArtifactRow => {
    const href = safeHref(it.url);
    return {
      key: `${k}-${it.url ?? it.title ?? ''}`,
      title: { text: it.title || (it.url ? urlLabel(it.url) : 'Untitled'), pv: true },
      publishes:
        it.publishes === undefined
          ? undefined
          : it.publishes === 1
            ? '1 publish'
            : `×${it.publishes} publishes`,
      time: it.at !== undefined ? clockText(it.at) : undefined,
      href,
      urlText: it.url ? { text: urlLabel(it.url), pv: true } : undefined,
    };
  });
  return { count: `${n}${a.complete === false ? '+' : ''}`, rows };
}

/** The inspector for one agent. */
export function inspectorView(i: InspectorInput): InspectorView {
  const meta: InspectorView['hero']['meta'] = [];
  if (i.folder) meta.push({ kind: 'folder', text: { text: i.folder, pv: true } });
  if (i.session?.branch) meta.push({ kind: 'branch', text: { text: i.session.branch, pv: true } });
  if (i.session?.sessionId8)
    meta.push({ kind: 'id', text: { text: i.session.sessionId8, pv: true } });
  const tags: InspectorView['hero']['tags'] = [];
  const modeText = i.mode ? PERMISSION_MODE_ROW_TEXT[i.mode] : null;
  if (modeText) tags.push({ kind: 'mode', text: modeText });
  if (i.shells !== undefined && i.shells > 0) {
    tags.push({ kind: 'shells', text: i.shells === 1 ? '1 shell' : `${i.shells} shells` });
  }
  const { cells, coldNote } = vitals(i);
  const runs = workflows(i);
  const loop = i.loop
    ? {
        next:
          i.loop.nextAt !== undefined
            ? i.loop.nextAt > i.now
              ? `next ${clockText(i.loop.nextAt)} · in ${minutesText(i.loop.nextAt - i.now)}`
              : `due ${clockText(i.loop.nextAt)}`
            : 'awake',
        wakes:
          i.loop.wakes !== undefined
            ? `${i.loop.wakes} ${i.loop.wakes === 1 ? 'wake' : 'wakes'}`
            : undefined,
      }
    : undefined;
  const t = i.tests;
  return {
    id: i.id,
    hero: {
      name: i.name,
      lead: Boolean(i.isTeamLead) || runs.length > 0 || i.mates.length > 0,
      chip: stateChip(i, i.now),
      title: i.title ? { text: i.title, pv: true } : undefined,
      question: i.question ? { text: i.question, pv: true } : undefined,
      meta,
      tags,
    },
    vitals: cells,
    coldNote,
    now: nowSection(i),
    workflows: runs,
    loop,
    tree: tree(i),
    artifacts: artifacts(i.artifacts),
    tests:
      t && (t.passed !== undefined || t.failed !== undefined)
        ? {
            passed: t.passed,
            failed: t.failed,
            at: t.at !== undefined ? clockText(t.at) : undefined,
          }
        : undefined,
    health: i.health
      ? {
          state: i.health.state,
          label: healthLabel(i.health),
          since: i.healthSince !== undefined ? minutesText(i.now - i.healthSince) : undefined,
        }
      : undefined,
    tripwire: i.tripwire
      ? {
          ruleName: i.tripwire.ruleName,
          count: i.tripwire.count,
          countText: i.tripwire.count > 1 ? `×${i.tripwire.count}` : undefined,
          severity: i.tripwire.severity,
        }
      : undefined,
  };
}
