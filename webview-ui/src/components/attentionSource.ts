import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import { type Attention, type AttentionAgent, attentionTickets } from './attention.js';

/** The top-level agents (sessions): no helper (negative ids, sub-agents) and no greeter. */
export function sessionIds(os: OfficeState): number[] {
  const ids: number[] = [];
  for (const ch of os.characters.values()) {
    if (ch.id > 0 && !ch.isSubagent && !ch.isGreeter) ids.push(ch.id);
  }
  return ids;
}

/** What the rail reads about each session, from OfficeState and the hook's React mirrors. */
export function attentionOf(
  os: OfficeState,
  agentTools: Record<number, ToolActivity[]>,
  agentStatuses: Record<number, string>,
): Attention {
  const agents: AttentionAgent[] = sessionIds(os).map((id) => {
    const ch = os.characters.get(id);
    return {
      id,
      tools: agentTools[id],
      status: agentStatuses[id],
      awaitingInput: ch?.waitingAwaitingInput === true,
      awaitingReason: os.awaitingReasons.get(id),
      question: os.questions.get(id),
      currentTool: ch?.currentTool,
      health: os.health.get(id),
      tripwire: os.tripwires.get(id),
      statusSince: os.statusSince.get(id),
      permissionSince: os.permissionSince.get(id),
      healthSince: os.healthSince.get(id),
      tripwireSince: os.tripwireSince.get(id),
    };
  });
  return attentionTickets(agents);
}
