import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import { clearAwaiting, setAwaitingQuestion } from './awaitingQuestion.js';
import { CONTEXT_SEED_TAIL_BYTES } from './constants.js';
import { seedHealth } from './health.js';
import { restampStatus } from './statusSince.js';
import { type DerivedTurnState, deriveTurnState } from './turnState.js';
import type { AgentState } from './types.js';
import { completeUtf8Length } from './utf8Boundary.js';

/** A derivation and the hook count it was computed against. */
export interface TurnDerivation {
  state: DerivedTurnState;
  hookSeq: number;
  /** Newest write to the transcript or its sub-agents' transcripts at the time. */
  clockMs: number;
}

/** mtimes of `<dir of the transcript>/<session>/subagents/*.jsonl`, [] when absent. */
function subagentMtimes(jsonlFile: string): number[] {
  const dir = path.join(path.dirname(jsonlFile), path.basename(jsonlFile, '.jsonl'), 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => {
        try {
          return [fs.statSync(path.join(dir, f)).mtimeMs];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * The newest write to an agent's transcript or one of its sub-agents' (0 when none can be
 * read). A lead blocked on a sub-agent writes nothing itself while the sub-agent works, so
 * its own mtime alone would read as silence.
 */
export function transcriptClockMs(jsonlFile: string): number {
  let lead = 0;
  try {
    lead = fs.statSync(jsonlFile).mtimeMs;
  } catch {
    // Unreadable: only the sub-agents speak for it.
  }
  return Math.max(lead, ...subagentMtimes(jsonlFile));
}

/**
 * Read the transcript tail once and derive the agent's state from it.
 *
 * Stats the file a single time and reads up to that size, then moves
 * `fileOffset` to that size: whatever lands after the stat is parsed live, so no
 * record is both derived and replayed or lost in between. A partial last line
 * goes to `lineBuffer` for the live reader to complete, and an incomplete last
 * character stays behind the offset.
 *
 * Returns null (offset untouched) when the provider can't classify turns or the
 * file can't be read; the agent then stays "unknown", which reads as idle.
 */
export function deriveAgentTurnState(
  agent: AgentState,
  provider: HookProvider | null,
  now = Date.now(),
): TurnDerivation | null {
  if (!provider?.turnSignal || !provider.turnTraits || !agent.jsonlFile) return null;
  const hookSeq = agent.hookSeq ?? 0;
  let size: number;
  let mtimeMs: number;
  let text: string;
  let heldBack: number;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
    const start = Math.max(0, size - CONTEXT_SEED_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    if (length > 0) {
      const fd = fs.openSync(agent.jsonlFile, 'r');
      try {
        fs.readSync(fd, buf, 0, length, start);
      } finally {
        fs.closeSync(fd);
      }
    }
    // A writer paused mid-character: leave those bytes, and the offset, to the
    // live reader, which decodes them once the character is whole.
    const complete = completeUtf8Length(buf);
    heldBack = length - complete;
    text = buf.toString('utf8', 0, complete);
    // A mid-file start lands inside a record: drop that leading fragment.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return null;
  }

  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  let partial = '';
  if (last) {
    // No trailing newline: a record the CLI is still writing, unless it parses.
    try {
      JSON.parse(last);
    } catch {
      partial = lines.pop() ?? '';
    }
  }

  agent.fileOffset = size - heldBack;
  agent.lineBuffer = partial;
  const subagentMtimesMs = subagentMtimes(agent.jsonlFile);
  const state = deriveTurnState(
    lines,
    now,
    { leadMtimeMs: mtimeMs, subagentMtimesMs },
    provider.turnSignal.bind(provider),
    provider.turnTraits,
  );
  return { state, hookSeq, clockMs: Math.max(mtimeMs, ...subagentMtimesMs) };
}

/**
 * Put a derived state on the agent, unless a hook event reached it meanwhile.
 * Hooks are exact where this is a guess, so they win. Returns whether it applied.
 */
export function applyTurnDerivation(agent: AgentState, derivation: TurnDerivation): boolean {
  if ((agent.hookSeq ?? 0) !== derivation.hookSeq) return false;
  const { state } = derivation;
  agent.isWaiting = state.kind === 'waiting' || state.kind === 'awaitingInput';
  if (state.kind === 'awaitingInput') setAwaitingQuestion(agent, state.question);
  else clearAwaiting(agent);
  agent.derivedActive = state.kind === 'active';
  // The status this file says, dated by the record that said it (none: unknown).
  if (state.kind === 'idle') restampStatus(agent, 'idle', false, undefined);
  else if (state.kind === 'active') restampStatus(agent, 'active', false, state.sinceMs);
  else restampStatus(agent, 'waiting', state.kind === 'awaitingInput', state.sinceMs);
  seedHealth(agent, {
    active: state.kind === 'active',
    atMs: state.kind === 'active' ? state.atMs : undefined,
    clockMs: derivation.clockMs,
    pendingTools:
      state.kind === 'active' || state.kind === 'awaitingInput' ? state.pendingTools : [],
  });
  return true;
}

/** Derive and apply in one step. Call BEFORE the agent is announced. */
export function seedTurnState(agent: AgentState, provider: HookProvider | null): void {
  const derivation = deriveAgentTurnState(agent, provider);
  if (derivation) applyTurnDerivation(agent, derivation);
}
