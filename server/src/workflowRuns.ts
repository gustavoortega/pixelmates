/**
 * Workflow crews: the agents a lead's Workflow tool runs in the background.
 *
 * Claude Code writes each run under
 *   <projectDir>/<leadSessionId>/subagents/workflows/wf_<runId>/
 *     journal.jsonl           {type:"started", agentId, label, phase} | {type:"result", agentId}
 *     agent-<agentId>.jsonl   the agent's own transcript
 * The journal is appended only when an agent starts or returns, so it says who
 * runs; the transcripts say whether they still move. Sidecars (agent-*.meta.json)
 * carry no spawn tool id and an unreliable shape: they are never read here.
 *
 * Every live agent is watched in the SubagentWatch shadow store under a
 * synthetic parent tool id, `wf:<runId>:<agentId>`, so the webview draws one
 * helper per agent next to its lead. The whole run ends with the lead's
 * task-notification for its Workflow tool id (mapped to the run by the launch
 * result); without that mapping each agent still ends on its journal result or
 * on staleness.
 *
 * All state lives on the lead (`AgentState.workflow`) and is rebuilt from the
 * journal on every scan. Labels and the run's name are user script text: never
 * logged, never persisted.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  WORKFLOW_GROUP_MAX_LENGTH,
  WORKFLOW_LABEL_MAX_LENGTH,
  WORKFLOW_PARENT_TOOL_ID_PREFIX,
} from '../../core/src/constants.js';
import type { WorkflowRun } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  WORKFLOW_AGENT_STALE_MS,
  WORKFLOW_ATTACH_TAIL_BYTES,
  WORKFLOW_DIR_MISSING_RECHECK_MS,
  WORKFLOW_IGNORED_RECHECK_MS,
  WORKFLOW_JOURNAL_CHUNK_BYTES,
  WORKFLOW_JOURNAL_MAX_LINE_BYTES,
  WORKFLOW_RUN_MAX_AGE_MS,
  WORKFLOW_STALE_RECHECK_MS,
} from './constants.js';
import { releaseHookSubRow } from './hookSubRows.js';
import type { SubagentWatch } from './subagentWatch.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXELMATES_DEBUG !== '0';

const SUBAGENTS_DIR = 'subagents';
const WORKFLOWS_DIR = 'workflows';
const JOURNAL_FILE = 'journal.jsonl';
const RUN_DIR_PREFIX = 'wf_';
/** Ids end up in paths and in the synthetic id: anything else is skipped. */
const RUN_DIR_PATTERN = /^wf_[A-Za-z0-9._-]+$/;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const AGENT_TRANSCRIPT_PATTERN = /^agent-[A-Za-z0-9._-]+\.jsonl$/;
const WORKFLOW_PATH_SEGMENT = `/${SUBAGENTS_DIR}/${WORKFLOWS_DIR}/`;
/** Phases come from a user script: the `workflowRun` message stays bounded however many it names. */
const WORKFLOW_RUN_MAX_PHASES = 32;

interface WorkflowAgentEntry {
  /** Sanitized journal label and phase. */
  label?: string;
  group?: string;
  /** When its started line was parsed: the freshness clock while its transcript is missing. */
  startedSeenAtMs: number;
  /** Quiet past WORKFLOW_AGENT_STALE_MS: torn down, re-stat'ed every WORKFLOW_STALE_RECHECK_MS. */
  stale: boolean;
  nextStatAtMs: number;
}

interface WorkflowRunState {
  /** Journal bytes consumed, always just past a newline. */
  offset: number;
  /** Journal size at the last read (-1 before the first): read again only when it changes. */
  readSize: number;
  journalMtimeMs: number;
  started: Map<string, WorkflowAgentEntry>;
  /** Sticky: a later or replayed started line never revives a finished agent. */
  finished: Set<string>;
  completed: boolean;
  /** Its journal is past the age window but a transcript is not: when to look again. */
  ageRecheckAtMs: number;
  /** What clients were last sent for the run (`workflowRun` minus its envelope); absent
   *  until the first scan after the run is tracked. Replayed at every handshake. */
  view?: WorkflowRunView;
}

type WorkflowRunView = Omit<WorkflowRun, 'type' | 'id' | 'runId'>;

/** What this process saw of a run's launch. Never persisted: a restart shows neither. */
interface WorkflowLaunch {
  /** The launch result's `workflowName`, sanitized. */
  name?: string;
  /** When this server first saw the run launched. */
  sinceMs: number;
}

export interface LeadWorkflowState {
  /** Tracked runs by runId (the run dir name without `wf_`). */
  runs: Map<string, WorkflowRunState>;
  /** Synthetic ids currently watched in the shadow store. */
  watched: Set<string>;
  /** Workflow tool_use id -> runId, from the launch result. Persisted: the
   *  completion notification may land after a restart. Many-to-one: a resume
   *  launches again with the same runId. */
  runIdByToolId: Map<string, string>;
  /** Runs known completed, tracked or not yet discovered. Persisted. */
  completedRunIds: Set<string>;
  /** runId -> what the launch result in this process said. Memory only. */
  launches: Map<string, WorkflowLaunch>;
  /** Run dirs rejected as too old -> when to look at their mtimes again. */
  ignored: Map<string, number>;
  /** Set while `subagents/workflows` is missing: no readdir before then. */
  dirMissingRecheckAtMs?: number;
}

export interface WorkflowScanContext {
  store: AgentStateStore;
  watch: SubagentWatch;
}

type EndReason = 'result' | 'stale' | 'runCompleted' | 'runDropped' | 'leadGone';

interface LiveAgent {
  jsonlPath: string;
  size: number;
  label?: string;
  group?: string;
}

function newLeadWorkflowState(): LeadWorkflowState {
  return {
    runs: new Map(),
    watched: new Set(),
    runIdByToolId: new Map(),
    completedRunIds: new Set(),
    launches: new Map(),
    ignored: new Map(),
  };
}

function syntheticId(runId: string, agentId: string): string {
  return `${WORKFLOW_PARENT_TOOL_ID_PREFIX}${runId}:${agentId}`;
}

/** `wf:<runId>:` with the trailing colon, so run "a" never matches run "ab". */
function runPrefix(runId: string): string {
  return `${WORKFLOW_PARENT_TOOL_ID_PREFIX}${runId}:`;
}

function workflowsDirOf(lead: AgentState): string {
  return path.join(lead.projectDir, lead.sessionId, SUBAGENTS_DIR, WORKFLOWS_DIR);
}

function statOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * Journal text is user script output headed for a one-line plate: runs of
 * whitespace, control and format characters become one space, then the result
 * is cut at `max` code points. Empty means absent.
 */
export function sanitizeWorkflowText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Format characters are bidi overrides and isolates and zero-width marks: the
  // plate puts the label right before the lead's name, and an override would
  // render that name reversed.
  const flat = value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  if (!flat) return undefined;
  return Array.from(flat).slice(0, max).join('');
}

/** A SubagentStart/Stop transcript path inside a workflow run dir. */
export function isWorkflowTranscriptPath(transcriptPath: string | undefined): boolean {
  return (
    transcriptPath !== undefined &&
    transcriptPath.replace(/\\/g, '/').includes(WORKFLOW_PATH_SEGMENT)
  );
}

/** Has a run journal of this lead named `agentId`? Hook rows for these are not drawn. */
export function isKnownWorkflowAgent(lead: AgentState, agentId: string): boolean {
  for (const run of lead.workflow?.runs.values() ?? []) {
    if (run.started.has(agentId) || run.finished.has(agentId)) return true;
  }
  return false;
}

/** Is this one of the lead's Workflow tool ids, so its task-notification ends a run? */
export function hasWorkflowTool(lead: AgentState, toolUseId: string): boolean {
  return lead.workflow?.runIdByToolId.has(toolUseId) ?? false;
}

/**
 * Map a Workflow tool_use id to the run its result reported. The runId arrives
 * as the run dir name (`wf_<id>`); the canonical id drops the prefix, and the
 * result's transcriptDir, when present, must name that same dir. Returns false
 * (nothing recorded) for anything that cannot name a run dir. The result's
 * `workflowName` is kept in memory for the run's view, with the time of the first
 * launch seen; a resume's launch keeps that time and takes a newer name.
 */
export function noteWorkflowRun(
  store: AgentStateStore,
  lead: AgentState,
  toolUseId: string,
  reportedRunId: string,
  transcriptDir: string | undefined,
  workflowName?: unknown,
): boolean {
  const runId = reportedRunId.startsWith(RUN_DIR_PREFIX)
    ? reportedRunId.slice(RUN_DIR_PREFIX.length)
    : reportedRunId;
  if (!ID_PATTERN.test(runId)) return false;
  if (transcriptDir !== undefined) {
    const dirName = path.posix.basename(transcriptDir.replace(/\\/g, '/').replace(/\/+$/, ''));
    if (dirName !== RUN_DIR_PREFIX + runId) return false;
  }
  const ended = lead.workflowEnded?.sessionId === lead.sessionId ? lead.workflowEnded : undefined;
  lead.workflowEnded = undefined;
  const state = (lead.workflow ??= newLeadWorkflowState());
  // A launch in a session that ended is a resume under the same id (the CLI's
  // default): the runs that session knew ended with it, but the one launched.
  for (const id of ended?.runIds ?? []) if (id !== runId) state.completedRunIds.add(id);
  state.runIdByToolId.set(toolUseId, runId);
  const prior = state.launches.get(runId);
  state.launches.set(runId, {
    name: sanitizeWorkflowText(workflowName, WORKFLOW_LABEL_MAX_LENGTH) ?? prior?.name,
    sinceMs: prior?.sinceMs ?? Date.now(),
  });
  // The first run of a session creates `workflows/`: look now, not in 5 s.
  state.dirMissingRecheckAtMs = undefined;
  store.persist();
  return true;
}

let reconciling = false;

/**
 * One pass over the lead's workflow runs: discover, read the journals, then
 * watch exactly the live agents. Synchronous from start to end, so the 1 s
 * timer scan and a scan kicked by a launch result can never interleave; a scan
 * re-entered from inside a watch is dropped, the outer one finishes the job.
 */
export function scanWorkflowRuns(
  leadId: number,
  lead: AgentState,
  ctx: WorkflowScanContext,
  now = Date.now(),
): void {
  if (reconciling || !lead.sessionId || !lead.projectDir) return;
  // A session that ended stays unscanned until a launch in it (endWorkflowSession);
  // a lead that /clear moved to another session is scanned as usual.
  if (lead.workflowEnded?.sessionId === lead.sessionId) return;
  reconciling = true;
  try {
    reconcile(leadId, lead, ctx, now);
  } catch (e) {
    // The scan runs on the shared project timer: nothing here may throw out of it.
    console.log(`[pixelmates] Workflow scan for Agent ${leadId} failed: ${e}`);
  } finally {
    reconciling = false;
  }
}

function reconcile(leadId: number, lead: AgentState, ctx: WorkflowScanContext, now: number): void {
  const state = (lead.workflow ??= newLeadWorkflowState());
  const workflowsDir = workflowsDirOf(lead);
  let mapsChanged = false;

  const listed = listRunIds(state, workflowsDir, now);
  if (listed) {
    for (const runId of listed) {
      if (state.runs.has(runId)) continue;
      adoptIfFresh(state, path.join(workflowsDir, RUN_DIR_PREFIX + runId), runId, now);
    }
    // A run dir that disappeared (deleted, or the lead moved to a new session
    // by /clear) takes its state and its persisted mappings with it.
    for (const runId of [...state.runs.keys()]) {
      if (!listed.has(runId)) mapsChanged = dropRun(lead, leadId, state, runId, ctx) || mapsChanged;
    }
    for (const [toolId, runId] of state.runIdByToolId) {
      if (!listed.has(runId)) {
        state.runIdByToolId.delete(toolId);
        mapsChanged = true;
      }
    }
    for (const runId of state.completedRunIds) {
      if (!listed.has(runId)) {
        state.completedRunIds.delete(runId);
        mapsChanged = true;
      }
    }
    for (const runId of state.ignored.keys()) {
      if (!listed.has(runId)) state.ignored.delete(runId);
    }
    for (const runId of state.launches.keys()) {
      if (!listed.has(runId)) state.launches.delete(runId);
    }
  }

  // Every journal is read before anything is decided, so an agent whose
  // started and result lines land in the same tick is never watched.
  for (const runId of [...state.runs.keys()]) {
    const read = refreshJournal(lead, leadId, state, runId, ctx, now);
    if (read === 'gone') mapsChanged = dropRun(lead, leadId, state, runId, ctx) || mapsChanged;
    else if (read === 'reopened') mapsChanged = true;
  }

  const live = new Map<string, LiveAgent>();
  const runsWithLive = new Set<string>();
  for (const [runId, run] of state.runs) {
    if (run.completed) continue;
    const runDir = path.join(workflowsDir, RUN_DIR_PREFIX + runId);
    for (const [agentId, entry] of run.started) {
      if (run.finished.has(agentId)) continue;
      const found = liveTranscript(runDir, agentId, entry, now);
      if (!found) continue;
      live.set(syntheticId(runId, agentId), { ...found, label: entry.label, group: entry.group });
      runsWithLive.add(runId);
    }
  }

  // A run with nobody live is forgotten only once adoption would turn it away
  // too. Dropped on its journal's age alone, a run whose transcripts are newer
  // would be adopted again on the next tick: its completion forgotten, its
  // agents drawn again, its whole journal read again.
  for (const [runId, run] of [...state.runs]) {
    if (runsWithLive.has(runId) || now - run.journalMtimeMs <= WORKFLOW_RUN_MAX_AGE_MS) continue;
    if (!agedOut(path.join(workflowsDir, RUN_DIR_PREFIX + runId), run, now)) continue;
    mapsChanged = dropRun(lead, leadId, state, runId, ctx) || mapsChanged;
    state.ignored.set(runId, now + WORKFLOW_IGNORED_RECHECK_MS);
  }

  for (const id of [...state.watched]) {
    if (!live.has(id)) endWorkflowAgent(lead, leadId, id, endReason(state, id), ctx);
  }
  for (const [id, agent] of live) {
    const attaching = !state.watched.has(id);
    // Idempotent: an agent already watched keeps its shadow and its stream.
    ctx.watch.watch(lead, leadId, {
      jsonlPath: agent.jsonlPath,
      toolUseId: id,
      label: agent.label,
      group: agent.group,
      startOffset: agent.size <= WORKFLOW_ATTACH_TAIL_BYTES ? 0 : agent.size,
    });
    state.watched.add(id);
    // A helper otherwise appears only on a tool call the stream reads: never for
    // an agent that only thinks, nor for one tailed past its earlier tools.
    if (attaching) ctx.store.broadcast(presenceMessage(leadId, id, agent.label, agent.group));
  }

  refreshRunViews(leadId, state, ctx);
  if (mapsChanged) ctx.store.persist();
}

/** Run ids under `workflows/`, or null when the dir is missing (and not re-read for a while). */
function listRunIds(
  state: LeadWorkflowState,
  workflowsDir: string,
  now: number,
): Set<string> | null {
  if (state.dirMissingRecheckAtMs !== undefined && now < state.dirMissingRecheckAtMs) return null;
  let names: string[];
  try {
    names = fs.readdirSync(workflowsDir);
  } catch {
    state.dirMissingRecheckAtMs = now + WORKFLOW_DIR_MISSING_RECHECK_MS;
    return null;
  }
  state.dirMissingRecheckAtMs = undefined;
  const ids = new Set<string>();
  for (const name of names) {
    if (RUN_DIR_PATTERN.test(name)) ids.add(name.slice(RUN_DIR_PREFIX.length));
  }
  return ids;
}

/** Newest of the journal and the agent transcripts directly in the run dir;
 *  undefined while the journal does not exist. */
function adoptionMtime(runDir: string, now: number): number | undefined {
  const journal = statOrUndefined(path.join(runDir, JOURNAL_FILE));
  if (!journal) return undefined;
  let newest = journal.mtimeMs;
  // A journal is written only at start and result, so a long agent can leave it
  // hours old while its transcript moves: count the transcripts too.
  if (now - newest <= WORKFLOW_RUN_MAX_AGE_MS) return newest;
  let names: string[] = [];
  try {
    names = fs.readdirSync(runDir);
  } catch {
    return newest;
  }
  for (const name of names) {
    if (!AGENT_TRANSCRIPT_PATTERN.test(name)) continue;
    const st = statOrUndefined(path.join(runDir, name));
    if (st && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest;
}

/** Would adoption turn this tracked run away now? Its transcripts are listed at
 *  most every WORKFLOW_IGNORED_RECHECK_MS, as a rejected dir's are. */
function agedOut(runDir: string, run: WorkflowRunState, now: number): boolean {
  if (now < run.ageRecheckAtMs) return false;
  const mtime = adoptionMtime(runDir, now);
  if (mtime !== undefined && now - mtime <= WORKFLOW_RUN_MAX_AGE_MS) {
    run.ageRecheckAtMs = now + WORKFLOW_IGNORED_RECHECK_MS;
    return false;
  }
  return true;
}

/** The age gate for runs not yet tracked. */
function adoptIfFresh(state: LeadWorkflowState, runDir: string, runId: string, now: number): void {
  const recheckAtMs = state.ignored.get(runId);
  if (recheckAtMs !== undefined && now < recheckAtMs) return;
  const mtime = adoptionMtime(runDir, now);
  if (mtime === undefined) return;
  if (now - mtime > WORKFLOW_RUN_MAX_AGE_MS) {
    state.ignored.set(runId, now + WORKFLOW_IGNORED_RECHECK_MS);
    return;
  }
  state.ignored.delete(runId);
  state.runs.set(runId, {
    offset: 0,
    readSize: -1,
    journalMtimeMs: mtime,
    started: new Map(),
    finished: new Set(),
    // The completion can land before discovery: the run is adopted finished.
    completed: state.completedRunIds.has(runId),
    ageRecheckAtMs: 0,
  });
}

/**
 * Stat the journal and parse its new complete lines. Only bytes through the
 * last newline are consumed: a line still being written is left for the next
 * read, never parsed in halves. 'reopened' when a resume un-completed the run.
 */
function refreshJournal(
  lead: AgentState,
  leadId: number,
  state: LeadWorkflowState,
  runId: string,
  ctx: WorkflowScanContext,
  now: number,
): 'gone' | 'read' | 'reopened' {
  const run = state.runs.get(runId);
  if (!run) return 'gone';
  const journalPath = path.join(workflowsDirOf(lead), RUN_DIR_PREFIX + runId, JOURNAL_FILE);
  const st = statOrUndefined(journalPath);
  if (!st) return 'gone';
  run.journalMtimeMs = st.mtimeMs;
  if (st.size === run.readSize) return 'read';
  const initial = run.readSize < 0;
  // Rewritten shorter: parse it again. Started, finished and completed are
  // sticky, so a replayed line changes nothing.
  if (st.size < run.offset) run.offset = 0;

  const fresh: string[] = [];
  const readAll = readJournalLines(journalPath, run, st.size, (line) => {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== 'object') return;
    const { type, agentId, label, phase } = record as Record<string, unknown>;
    if (typeof agentId !== 'string' || !ID_PATTERN.test(agentId)) return;
    if (type === 'result') {
      run.finished.add(agentId);
    } else if (type === 'started' && !run.started.has(agentId) && !run.finished.has(agentId)) {
      run.started.set(agentId, {
        label: sanitizeWorkflowText(label, WORKFLOW_LABEL_MAX_LENGTH),
        group: sanitizeWorkflowText(phase, WORKFLOW_GROUP_MAX_LENGTH),
        startedSeenAtMs: now,
        stale: false,
        nextStatAtMs: 0,
      });
      fresh.push(agentId);
    }
  });
  // A failed read keeps the old size: the next scan reads on from the offset.
  if (readAll) run.readSize = st.size;

  // A Start hook that slipped in before this line drew a row under some
  // Task/Agent tool: the journal now owns this agent, so the row goes.
  for (const agentId of fresh) releaseHookSubRow(ctx.store, lead, leadId, agentId, false);

  // A resume reuses wf_<runId>: new agents reopen a completed run. Late result
  // lines (the journal flush racing the notification) never do.
  if (run.completed && !initial && fresh.some((id) => !run.finished.has(id))) {
    run.completed = false;
    state.completedRunIds.delete(runId);
    return 'reopened';
  }
  return 'read';
}

/**
 * Hand every complete line between the run's offset and `size` to `onLine`,
 * reading WORKFLOW_JOURNAL_CHUNK_BYTES at a time but all within this call: the
 * live set still sees every line, and memory stays bounded by a chunk plus one
 * line however much is unread. The offset moves past a line only once it is
 * decoded; a last line without its newline is left for the next read. A line
 * over WORKFLOW_JOURNAL_MAX_LINE_BYTES is consumed without being decoded.
 * False when a read failed: whatever was not consumed is read by a later scan.
 */
function readJournalLines(
  journalPath: string,
  run: WorkflowRunState,
  size: number,
  onLine: (line: string) => void,
): boolean {
  if (size <= run.offset) return true;
  let fd: number;
  try {
    fd = fs.openSync(journalPath, 'r');
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(Math.min(WORKFLOW_JOURNAL_CHUNK_BYTES, size - run.offset));
    /** The start of a line still open at the end of the last chunk. */
    let carry: Buffer[] = [];
    let carryBytes = 0;
    /** Inside a line already over the ceiling: dropped up to its newline. */
    let skipping = false;
    let pos = run.offset;
    while (pos < size) {
      const got = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (got <= 0) break;
      const chunk = buf.subarray(0, got);
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
        if (!skipping && carryBytes + end - start <= WORKFLOW_JOURNAL_MAX_LINE_BYTES) {
          const line =
            carry.length > 0
              ? Buffer.concat([...carry, chunk.subarray(start, end)])
              : chunk.subarray(start, end);
          onLine(line.toString('utf-8'));
        }
        carry = [];
        carryBytes = 0;
        skipping = false;
        start = end + 1;
        run.offset = pos + start;
      }
      const rest = got - start;
      if (skipping || carryBytes + rest > WORKFLOW_JOURNAL_MAX_LINE_BYTES) {
        // Never held whole: what was read of it is consumed now.
        carry = [];
        carryBytes = 0;
        skipping = true;
        run.offset = pos + got;
      } else if (rest > 0) {
        // A copy: the next read reuses the buffer.
        carry.push(Buffer.from(chunk.subarray(start)));
        carryBytes += rest;
      }
      pos += got;
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The agent's transcript when it is live: on disk and moved within the stale
 * window. A missing transcript is a candidate on the clock of its started line;
 * a stale one is looked at again only every WORKFLOW_STALE_RECHECK_MS.
 */
function liveTranscript(
  runDir: string,
  agentId: string,
  entry: WorkflowAgentEntry,
  now: number,
): { jsonlPath: string; size: number } | null {
  if (entry.stale && now < entry.nextStatAtMs) return null;
  const jsonlPath = path.join(runDir, `agent-${agentId}.jsonl`);
  const st = statOrUndefined(jsonlPath);
  const lastMoveMs = st ? st.mtimeMs : entry.startedSeenAtMs;
  if (now - lastMoveMs > WORKFLOW_AGENT_STALE_MS) {
    entry.stale = true;
    entry.nextStatAtMs = now + WORKFLOW_STALE_RECHECK_MS;
    return null;
  }
  entry.stale = false;
  return st ? { jsonlPath, size: st.size } : null;
}

function endReason(state: LeadWorkflowState, id: string): EndReason {
  const [runId, agentId] = id.slice(WORKFLOW_PARENT_TOOL_ID_PREFIX.length).split(':');
  const run = state.runs.get(runId);
  if (!run) return 'runDropped';
  if (run.completed) return 'runCompleted';
  return run.finished.has(agentId) ? 'result' : 'stale';
}

/** The one teardown path for a workflow helper. */
function endWorkflowAgent(
  lead: AgentState,
  leadId: number,
  id: string,
  reason: EndReason,
  ctx: WorkflowScanContext,
): void {
  ctx.watch.removeBySpawn(leadId, id);
  ctx.store.broadcast({ type: 'subagentClear', id: leadId, parentToolId: id });
  lead.workflow?.watched.delete(id);
  if (debug) console.log(`[pixelmates] Workflow agent ${id} of Agent ${leadId} ended (${reason})`);
}

function endRunAgents(
  lead: AgentState,
  leadId: number,
  state: LeadWorkflowState,
  runId: string,
  reason: EndReason,
  ctx: WorkflowScanContext,
): void {
  const prefix = runPrefix(runId);
  for (const id of [...state.watched]) {
    if (id.startsWith(prefix)) endWorkflowAgent(lead, leadId, id, reason, ctx);
  }
}

/** Forget a run. Returns whether a persisted mapping went with it. */
function dropRun(
  lead: AgentState,
  leadId: number,
  state: LeadWorkflowState,
  runId: string,
  ctx: WorkflowScanContext,
): boolean {
  endRunAgents(lead, leadId, state, runId, 'runDropped', ctx);
  if (state.runs.get(runId)?.view) ctx.store.broadcast(runClearMessage(leadId, runId));
  state.runs.delete(runId);
  state.launches.delete(runId);
  let changed = state.completedRunIds.delete(runId);
  for (const [toolId, mapped] of state.runIdByToolId) {
    if (mapped === runId) {
      state.runIdByToolId.delete(toolId);
      changed = true;
    }
  }
  return changed;
}

/**
 * The lead's task-notification for a Workflow tool (completed, failed or
 * killed alike), or a foreground run's own result: the run is over and every
 * helper of it goes. Returns false when the tool id maps to no run.
 */
export function completeWorkflowRunForTool(
  lead: AgentState,
  leadId: number,
  toolUseId: string,
  ctx: WorkflowScanContext,
): boolean {
  const state = lead.workflow;
  const runId = state?.runIdByToolId.get(toolUseId);
  if (!state || runId === undefined) return false;
  state.runIdByToolId.delete(toolUseId);
  state.completedRunIds.add(runId);
  const run = state.runs.get(runId);
  if (run) {
    // Lines already written belong to the run that just ended: read them now,
    // or the next scan would take them for a resume and reopen the run.
    refreshJournal(lead, leadId, state, runId, ctx, Date.now());
    run.completed = true;
    endRunAgents(lead, leadId, state, runId, 'runCompleted', ctx);
    refreshRunViews(leadId, state, ctx);
  }
  ctx.store.persist();
  return true;
}

/** The lead is gone: every helper and every scan state of it goes too. */
export function disposeWorkflowState(
  lead: AgentState,
  leadId: number,
  ctx: WorkflowScanContext,
): void {
  const state = lead.workflow;
  if (!state) return;
  for (const id of [...state.watched]) endWorkflowAgent(lead, leadId, id, 'leadGone', ctx);
  lead.workflow = undefined;
}

/**
 * The lead's session ended, and the lead may stay (a terminal agent): its
 * helpers go, and the scan leaves that session alone until the lead moves to
 * another session or launches a Workflow in it again. A state rebuilt by the
 * next scan would not know which runs completed and would draw a killed run's
 * agents again; a launch after a resume takes them all as completed.
 */
export function endWorkflowSession(
  lead: AgentState,
  leadId: number,
  ctx: WorkflowScanContext,
): void {
  const state = lead.workflow;
  const runIds = new Set([...(state?.runs.keys() ?? []), ...(state?.completedRunIds ?? [])]);
  // The lead stays (or leaves right after, with its character): its runs go from the clients first.
  for (const [runId, run] of state?.runs ?? []) {
    if (run.view) ctx.store.broadcast(runClearMessage(leadId, runId));
  }
  disposeWorkflowState(lead, leadId, ctx);
  lead.workflowEnded = { sessionId: lead.sessionId, runIds };
}

function runClearMessage(leadId: number, runId: string): Record<string, unknown> {
  return { type: 'workflowRun', id: leadId, runId };
}

/**
 * What clients are shown for a run, from its sticky journal state: `started` and
 * `finished` outlive the helpers and a resume's reopening, so the counts never
 * fall when a helper is torn down. A count is sent only once an agent has
 * started; phases are in first-seen order (journal order), each with its own
 * counts. `name` and `since` exist only if this process saw the launch.
 */
function buildRunView(launch: WorkflowLaunch | undefined, run: WorkflowRunState): WorkflowRunView {
  const phases = new Map<string, { name: string; started: number; done: number }>();
  for (const [agentId, entry] of run.started) {
    if (entry.group === undefined) continue;
    let phase = phases.get(entry.group);
    if (!phase) {
      if (phases.size >= WORKFLOW_RUN_MAX_PHASES) continue;
      phase = { name: entry.group, started: 0, done: 0 };
      phases.set(entry.group, phase);
    }
    phase.started += 1;
    if (run.finished.has(agentId)) phase.done += 1;
  }
  // An agent can have a result line and no started line: it still counts, as done.
  let started = run.started.size;
  for (const agentId of run.finished) if (!run.started.has(agentId)) started += 1;

  return {
    status: run.completed ? 'done' : 'running',
    ...(launch?.name !== undefined ? { name: launch.name } : {}),
    ...(phases.size > 0 ? { phases: [...phases.values()] } : {}),
    ...(started > 0 ? { started, done: run.finished.size } : {}),
    ...(launch ? { since: launch.sinceMs } : {}),
  };
}

/** Broadcast `workflowRun` for every tracked run whose view changed. */
function refreshRunViews(leadId: number, state: LeadWorkflowState, ctx: WorkflowScanContext): void {
  for (const [runId, run] of state.runs) {
    const view = buildRunView(state.launches.get(runId), run);
    if (run.view && JSON.stringify(run.view) === JSON.stringify(view)) continue;
    run.view = view;
    ctx.store.broadcast({ type: 'workflowRun', id: leadId, runId, ...view });
  }
}

function presenceMessage(
  leadId: number,
  id: string,
  label: string | undefined,
  group: string | undefined,
): Record<string, unknown> {
  return {
    type: 'subagentPresent',
    id: leadId,
    parentToolId: id,
    ...(label !== undefined ? { label } : {}),
    ...(group !== undefined ? { group } : {}),
  };
}

/** One `subagentPresent` per watched workflow agent of the lead, then one
 *  `workflowRun` per tracked run that has a view, for a client doing the handshake
 *  (a page load or panel reload): its helpers and their run come back before their
 *  next tool call. */
export function workflowPresenceMessages(
  leadId: number,
  lead: AgentState,
): Record<string, unknown>[] {
  const state = lead.workflow;
  if (!state) return [];
  const out: Record<string, unknown>[] = [];
  for (const id of state.watched) {
    const [runId, agentId] = id.slice(WORKFLOW_PARENT_TOOL_ID_PREFIX.length).split(':');
    const entry = state.runs.get(runId)?.started.get(agentId);
    out.push(presenceMessage(leadId, id, entry?.label, entry?.group));
  }
  for (const [runId, run] of state.runs) {
    if (run.view) out.push({ type: 'workflowRun', id: leadId, runId, ...run.view });
  }
  return out;
}

/** What survives a restart: the tool -> run mappings and the completed runs.
 *  Labels and journal state are re-derived from disk. */
export function workflowPersistFields(lead: AgentState): {
  workflowRuns?: Record<string, string>;
  completedWorkflowRunIds?: string[];
} {
  const state = lead.workflow;
  return {
    workflowRuns:
      state && state.runIdByToolId.size > 0 ? Object.fromEntries(state.runIdByToolId) : undefined,
    completedWorkflowRunIds:
      state && state.completedRunIds.size > 0 ? [...state.completedRunIds] : undefined,
  };
}

/** Rebuild the persisted part of a lead's workflow state. The state file can
 *  be edited by hand, so every id is checked as strictly as a live one. */
export function restoreWorkflowState(persisted: {
  workflowRuns?: unknown;
  completedWorkflowRunIds?: unknown;
}): LeadWorkflowState | undefined {
  const state = newLeadWorkflowState();
  const runs = persisted.workflowRuns;
  if (runs && typeof runs === 'object' && !Array.isArray(runs)) {
    for (const [toolId, runId] of Object.entries(runs as Record<string, unknown>)) {
      if (toolId && typeof runId === 'string' && ID_PATTERN.test(runId)) {
        state.runIdByToolId.set(toolId, runId);
      }
    }
  }
  const completed = persisted.completedWorkflowRunIds;
  if (Array.isArray(completed)) {
    for (const runId of completed) {
      if (typeof runId === 'string' && ID_PATTERN.test(runId)) state.completedRunIds.add(runId);
    }
  }
  return state.runIdByToolId.size > 0 || state.completedRunIds.size > 0 ? state : undefined;
}
