import type { AgentStateStore } from './agentStateStore.js';
import { cacheMessage } from './contextUsage.js';
import { healthResendMessage } from './health.js';
import { rosterMessage } from './rosterAgent.js';
import { modeMessage, shellsMessage } from './sessionSignals.js';
import { derivedTitle } from './sessionTitle.js';
import { awaitingFields, isQuestion, permissionSince, statusSince } from './statusSince.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';
import { tripwireResendMessage } from './tripwires.js';
import type { AgentState } from './types.js';
import { workflowPresenceMessages } from './workflowRuns.js';

/**
 * The agentStatus an agent should be shown with, read from its state right now.
 *
 * Always explicit: a client that guessed a default would show an idle session as
 * working. `active` means tools in flight, a turn the server saw start and not
 * finish, or one the transcript tail said was mid-turn at adoption.
 */
export function agentStatusMessage(id: number, agent: AgentState): Record<string, unknown> {
  if (agent.isWaiting) {
    const awaitingInput = agent.awaitingInput === true;
    return {
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput,
      ...(awaitingInput ? awaitingFields(agent) : {}),
      since: statusSince(agent, 'waiting', isQuestion(agent, awaitingInput)),
    };
  }
  const working =
    agent.activeToolStatuses.size > 0 || agent.hadToolsInTurn || agent.derivedActive === true;
  const status = working ? 'active' : 'idle';
  return { type: 'agentStatus', id, status, since: statusSince(agent, status, false) };
}

/**
 * A monitor message in its always-sent form: the fields the agent holds, or only `id`
 * (the clear) when it holds none, so a client that missed a clear keeps nothing stale.
 */
function monitorMessage(
  type: 'agentSession' | 'agentArtifacts' | 'agentLoop' | 'agentTests',
  id: number,
  view: object | undefined,
): Record<string, unknown> {
  return { type, id, ...view };
}

/**
 * Replay an agent's active state to a connecting client.
 *
 * Order matters:
 * 1. Team info first — webview needs team context before tool messages
 * 2. Regular tools
 * 3. Background tools with runInBackground + isTeammateSpawn flags, skipping promoted spawns
 * 4. Status (active, waiting or idle; one per agent)
 * 4b. Workflow agents watched for the agent (subagentPresent)
 * 5. Context usage
 * 6. Model look
 * 7. Session title
 * 7b. Session signals: cache clock, permission mode, background shells
 * 7c. Monitor: session meta, artifacts, loop, tests (always, the clear form when unknown)
 * 8. Tripwire alarm
 * 9. Health mark
 * 10. Roster member (only for agents that hold one; mood depends on the alarm, so it follows it)
 *
 * Tool starts carry permissionActive (and when the prompt went up) while a permission prompt
 * is pending: a client takes a start without it as the prompt answered and drops the bubble.
 * Every status, health mark and alarm carries the server's `since`, so a reconnecting client
 * keeps the minutes it showed.
 */
export function resendAgentActivity(
  send: (message: Record<string, unknown>) => void,
  store: AgentStateStore,
): void {
  for (const [id, agent] of store) {
    // 1. Team metadata first — webview uses this to route tool messages correctly.
    // Derived teams (named background spawns) have a name and a lead link but NO
    // teamName, so gate on any team field.
    if (agent.teamName || agent.agentName || agent.isTeamLead) {
      send({
        type: 'agentTeamInfo',
        id,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }

    // 2. Regular (non-background) tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      // Skip background tools here — they're sent separately below with proper flags
      if (agent.backgroundAgentToolIds.has(toolId)) continue;

      const toolName = agent.activeToolNames.get(toolId) ?? '';
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
        permissionActive: agent.permissionSent || undefined,
        permissionSince: permissionSince(agent),
      });
    }

    // 3. Background tools with runInBackground flag. Skip promoted spawns to prevent
    // ghost Subtask characters alongside the real teammate character.
    for (const toolId of agent.backgroundAgentToolIds) {
      if (hasPromotedBackgroundAgent(id, toolId, store)) continue;

      const status = agent.activeToolStatuses.get(toolId);
      if (!status) continue;

      const toolName = agent.activeToolNames.get(toolId);
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
        permissionActive: agent.permissionSent || undefined,
        permissionSince: permissionSince(agent),
        runInBackground: true,
        isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
      });
    }

    // 4. Status: exactly one per agent, never left to a client default.
    send(agentStatusMessage(id, agent));

    // 4b. Workflow agents being watched for this lead: their helpers come back now,
    // not on their next tool call (an agent that only thinks may never make one).
    for (const message of workflowPresenceMessages(id, agent)) send(message);

    // 5. Context usage
    if (agent.contextTokens > 0) {
      send({
        type: 'agentContextUsage',
        id,
        contextTokens: agent.contextTokens,
        maxContextTokens: agent.maxContextTokens,
      });
    }

    // 6. Model look. Sent for every agent, `model` omitted while unknown, so a client
    // that missed a change (or never knew) cannot keep a stale rarity.
    send({ type: 'agentModel', id, model: agent.model, tier: agent.modelTier });

    // 7. Session title. Sent for untitled agents too (title omitted): a client that
    // was offline when a title was cleared would otherwise keep showing the stale one.
    send({ type: 'agentSessionTitle', id, title: derivedTitle(agent) });

    // 7b. Session signals. Sent for every agent, unknown fields omitted and a zero
    // shell count included, so a client that missed a clear keeps nothing stale.
    send(cacheMessage(id, agent));
    send(modeMessage(id, agent));
    send(shellsMessage(id, agent));

    // 7c. Monitor. Sent for every agent, as the clear form when nothing is known: a client
    // that reconnects must not keep another session's branch or artifacts.
    send(monitorMessage('agentSession', id, agent.sessionMeta));
    send(monitorMessage('agentArtifacts', id, agent.artifacts));
    send(monitorMessage('agentLoop', id, agent.loop));
    send(monitorMessage('agentTests', id, agent.tests));

    // 8. Tripwire alarm, or a clear for agents without one: a client that was offline
    // during an ack would otherwise keep an alarm the user already dismissed.
    send(tripwireResendMessage(agent));

    // 9. Health mark, or a clear for a healthy agent: a client that was offline when a mark
    // cleared would otherwise keep showing it.
    send(healthResendMessage(agent));

    // 10. Roster member. Not resent as a clear: an agent without a member simply has none.
    const roster = rosterMessage(agent, store);
    if (roster) send(roster);
  }
}
