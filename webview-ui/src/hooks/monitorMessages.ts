/**
 * The monitor's half of the host messages: the five monitor messages and the `since` fields on
 * status, permission, health and tripwire messages, stored on OfficeState by agent id. Store only:
 * the rail, plates and inspector read the stores. DOM-free: the hook calls it for every message,
 * tests call it with wire-shaped messages.
 */

import type { OfficeState } from '../office/engine/officeState.js';
import { resync } from '../office/engine/resync.js';

interface HostMessage {
  type: string;
  [key: string]: unknown;
}

/** The message minus its envelope and its absent fields, or undefined for the clear form. */
function viewOf<V>(msg: HostMessage, envelope: readonly string[]): V | undefined {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(msg)) {
    if (value !== undefined && !envelope.includes(key)) view[key] = value;
  }
  return Object.keys(view).length > 0 ? (view as V) : undefined;
}

const AGENT_ENVELOPE = ['type', 'id'] as const;
const RUN_ENVELOPE = ['type', 'id', 'runId'] as const;

function epochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Store what a host message tells the monitor; any other message changes nothing. */
export function applyMonitorMessage(os: OfficeState, msg: HostMessage): void {
  const id = msg.id as number;
  switch (msg.type) {
    case 'agentSession':
      os.setSessionMeta(id, viewOf(msg, AGENT_ENVELOPE));
      return;
    case 'agentArtifacts':
      os.setArtifacts(id, viewOf(msg, AGENT_ENVELOPE));
      return;
    case 'agentLoop':
      os.setLoop(id, viewOf(msg, AGENT_ENVELOPE));
      return;
    case 'agentTests':
      os.setTests(id, viewOf(msg, AGENT_ENVELOPE));
      return;
    case 'workflowRun':
      if (typeof msg.runId === 'string') {
        // A reconnect's catch-up restates every run the server still tracks; the rest go at
        // handshakeDone (resync.ts).
        resync.noteWorkflowRun(id, msg.runId);
        os.setWorkflowRun(id, msg.runId, viewOf(msg, RUN_ENVELOPE));
      }
      return;
    case 'agentStatus': {
      os.setStatusSince(id, epochMs(msg.since));
      // A wait with no reason is an older server's: a question. Anything else carries none.
      const waiting = msg.status === 'waiting' && msg.awaitingInput === true;
      os.setAwaiting(
        id,
        waiting ? (msg.awaitingReason === 'idle' ? 'idle' : 'question') : undefined,
        waiting && typeof msg.question === 'string' && msg.question ? msg.question : undefined,
      );
      return;
    }
    case 'agentToolStart':
      // A start without permissionActive means the prompt was answered (agentMessages.ts).
      os.setPermissionSince(
        id,
        msg.permissionActive === true ? epochMs(msg.permissionSince) : undefined,
      );
      return;
    case 'agentToolPermission':
      os.setPermissionSince(id, epochMs(msg.permissionSince));
      return;
    case 'agentToolPermissionClear':
    case 'agentToolsClear':
      os.setPermissionSince(id, undefined);
      return;
    case 'agentHealth':
      os.setHealthSince(id, epochMs(msg.since));
      return;
    case 'agentHealthClear':
      os.setHealthSince(id, undefined);
      return;
    case 'agentTripwire':
      os.setTripwireSince(id, epochMs(msg.since));
      return;
    case 'agentTripwireClear':
      os.setTripwireSince(id, undefined);
      return;
    default:
      return;
  }
}
