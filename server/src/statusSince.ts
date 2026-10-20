import type { AgentActivityStatus } from '../../core/src/messages.js';
import type { AgentState } from './types.js';

/**
 * When each agent's status began, for the monitor's "waiting 4 min" and "idle 1h08m".
 *
 * Stamped only when the status a client sees changes: the parser and PreToolUse repeat
 * `active` on every tool call, and restamping there would date a long turn to its last
 * call. A waiting agent on a question and one that finished are two statuses; one that sat
 * idle after finishing is the second, so the idle prompt never restamps. The time is
 * the server clock for hooks and timers, and the record's own timestamp for a status read
 * from the transcript, so a replayed history is not dated to the moment it was read.
 */

function statusKey(status: AgentActivityStatus, awaitingInput: boolean): string {
  if (status !== 'waiting') return status;
  return awaitingInput ? 'waiting:input' : 'waiting:done';
}

/** Note the status the agent is now in. `at` undefined means its start is unknown. */
export function stampStatus(
  agent: AgentState,
  status: AgentActivityStatus,
  awaitingInput: boolean,
  at: number | undefined,
): void {
  const key = statusKey(status, awaitingInput);
  if (agent.statusKey === key) return;
  agent.statusKey = key;
  agent.statusSince = at;
}

/** The `awaitingInput` the stamp keys on: a pending question only. An idle wait is `Done` that
 *  went quiet, the same status and the same start. */
export function isQuestion(agent: AgentState | undefined, awaitingInput: boolean): boolean {
  return awaitingInput && agent?.awaitingReason !== 'idle';
}

/** The wire fields that say why a waiting agent awaits the user. Only for awaitingInput. */
export function awaitingFields(agent: AgentState): { awaitingReason?: string; question?: string } {
  if (agent.awaitingInput !== true || agent.awaitingReason === undefined) return {};
  return {
    awaitingReason: agent.awaitingReason,
    ...(agent.awaitingReason === 'question' && agent.question ? { question: agent.question } : {}),
  };
}

/** Replace the stamp outright: a status derived from a transcript read anew (adoption, a
 *  file switch) is that file's, whatever the agent showed before. */
export function restampStatus(
  agent: AgentState,
  status: AgentActivityStatus,
  awaitingInput: boolean,
  at: number | undefined,
): void {
  agent.statusKey = statusKey(status, awaitingInput);
  agent.statusSince = at;
}

/** When the given status began, or undefined when it is not the one stamped. */
export function statusSince(
  agent: AgentState,
  status: AgentActivityStatus,
  awaitingInput: boolean,
): number | undefined {
  return agent.statusKey === statusKey(status, awaitingInput) ? agent.statusSince : undefined;
}

/**
 * Stamp the status and build its `agentStatus` message. `awaitingInput` goes on the wire
 * only for `waiting`, as before. An agent the store no longer holds gets no `since`.
 */
export function statusBroadcast(
  id: number,
  agent: AgentState | undefined,
  status: AgentActivityStatus,
  at: number | undefined,
  awaitingInput = false,
): Record<string, unknown> {
  const message: Record<string, unknown> = { type: 'agentStatus', id, status };
  if (status === 'waiting') {
    message.awaitingInput = awaitingInput;
    if (awaitingInput && agent) Object.assign(message, awaitingFields(agent));
  }
  if (agent) {
    const question = isQuestion(agent, awaitingInput);
    stampStatus(agent, status, question, at);
    const since = statusSince(agent, status, question);
    if (since !== undefined) message.since = since;
  }
  return message;
}

/** Permission prompts: the edge into pending stamps the time; a repeat keeps it. */
export function notePermissionPending(agent: AgentState, at = Date.now()): void {
  if (!agent.permissionSent) agent.permissionSince = at;
  agent.permissionSent = true;
}

/** When the pending prompt went up, or undefined when none is pending. */
export function permissionSince(agent: AgentState): number | undefined {
  return agent.permissionSent ? agent.permissionSince : undefined;
}
