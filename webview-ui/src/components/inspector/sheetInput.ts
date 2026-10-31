/**
 * Gathers what the inspector shows for the selected agent from OfficeState and the App's tool
 * state. DOM-free; the sheet calls it on every render.
 */

import type { SubagentCharacter } from '../../hooks/subagentMessages.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import type { Character, ToolActivity } from '../../office/types.js';
import type { AgentStateInput, HelperInput, InspectorInput, Text } from './inspectorView.js';

/** The tool state the App holds in React (useExtensionMessages), not on OfficeState. */
export interface SheetToolState {
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: readonly SubagentCharacter[];
}

const NO_TOOLS: readonly ToolActivity[] = [];

/**
 * The agent the sheet shows for a selection: a selected sub-agent shows its lead, as a click on
 * one focuses the lead's terminal.
 */
export function inspectedAgentId(os: OfficeState, selected: number | null): number | null {
  if (selected === null) return null;
  const parent = os.subagentMeta.get(selected)?.parentAgentId;
  const id = parent ?? selected;
  return os.characters.has(id) ? id : null;
}

/** The agent's name; with no roster member or teammate name the folder stands in, masked. */
function nameOf(os: OfficeState, ch: Character): Text {
  const name = os.rosters.get(ch.id)?.name ?? ch.agentName;
  if (name) return { text: name };
  return ch.folderName ? { text: ch.folderName, pv: true } : { text: `Agent ${ch.id}` };
}

function stateOf(os: OfficeState, ch: Character, tools: SheetToolState): AgentStateInput {
  return {
    isActive: ch.isActive,
    bubbleType: ch.bubbleType,
    waitingAwaitingInput: ch.waitingAwaitingInput,
    question: os.questions.get(ch.id),
    tools: tools.agentTools[ch.id] ?? NO_TOOLS,
    health: os.health.get(ch.id),
    loop: os.loops.get(ch.id),
    statusSince: os.statusSince.get(ch.id),
  };
}

export function sheetInput(
  os: OfficeState,
  id: number,
  tools: SheetToolState,
  now: number,
): InspectorInput | null {
  const ch = os.characters.get(id);
  if (!ch || ch.isSubagent) return null;
  const leadRows = tools.agentTools[id] ?? NO_TOOLS;
  const helpers: HelperInput[] = tools.subagentCharacters
    .filter((s) => s.parentAgentId === id)
    .map((s) => ({
      id: s.id,
      parentToolId: s.parentToolId,
      label: s.plateLabel || s.label,
      group: s.group,
      tools: tools.subagentTools[id]?.[s.parentToolId] ?? NO_TOOLS,
      bubbleType: os.characters.get(s.id)?.bubbleType ?? null,
      // The plate's rule: a sub-agent's task is over once the lead's spawn row is done.
      done: leadRows.some((t) => t.toolId === s.parentToolId && t.done),
      startedAt: s.startedAt,
    }));
  const leadCh = ch.leadAgentId !== undefined ? os.characters.get(ch.leadAgentId) : undefined;
  const mates = [...os.characters.values()]
    .filter((m) => !m.isSubagent && m.leadAgentId === id)
    .map((m) => ({ id: m.id, name: nameOf(os, m), ...stateOf(os, m, tools) }));
  return {
    id,
    name: nameOf(os, ch),
    folder: ch.folderName,
    isTeamLead: ch.isTeamLead,
    contextTokens: ch.contextTokens,
    maxContextTokens: ch.maxContextTokens,
    title: os.sessionTitles.get(id),
    model: os.models.get(id),
    session: os.sessionMeta.get(id),
    artifacts: os.artifacts.get(id),
    tests: os.tests.get(id),
    runs: os.workflowRuns.get(id),
    permissionSince: os.permissionSince.get(id),
    healthSince: os.healthSince.get(id),
    tripwire: os.tripwires.get(id),
    cache: os.cacheByAgent.get(id),
    mode: os.modeByAgent.get(id),
    shells: os.shellsByAgent.get(id),
    helpers,
    lead: leadCh
      ? { id: leadCh.id, name: nameOf(os, leadCh), ...stateOf(os, leadCh, tools) }
      : undefined,
    mates,
    now,
    ...stateOf(os, ch, tools),
  };
}
