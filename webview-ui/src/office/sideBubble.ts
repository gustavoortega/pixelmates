/**
 * The side bubble: a gold "?" (the agent asked a question) or a sage check (its turn is done) to
 * the right of the head, echoed on the monitor screen at the agent's desk. Pure, so the canvas,
 * the furniture rebuild and the tests share one rule.
 */

import { ASK_BUBBLE_BOB_MS } from '../constants.js';
import { type Character, WorkStatus } from './types.js';

export type SideBubbleKind = 'ask' | 'done';

type SideBubbleFacts = Pick<
  Character,
  'id' | 'isSubagent' | 'isGreeter' | 'matrixEffect' | 'agentStatus' | 'bubbleType'
> & { waitingAwaitingInput?: boolean };

/**
 * What an agent shows beside its head. `reason` is why the wait awaits the user (the office's
 * awaitingReasons): 'idle' is a finished turn, anything else a question. A permission prompt has
 * its own bubble, and a sleeping loop (`loopSleeping`) is not waiting for the user at all.
 * Status truth only: the 2 s waiting bubble fading out changes nothing here.
 */
export function sideBubbleKind(
  ch: SideBubbleFacts,
  reason: 'question' | 'idle' | undefined,
  loopSleeping = false,
): SideBubbleKind | null {
  if (ch.id <= 0 || ch.isSubagent || ch.isGreeter || ch.matrixEffect === 'despawn') return null;
  if (ch.bubbleType === 'permission') return null;
  if (ch.agentStatus !== WorkStatus.WAITING || ch.waitingAwaitingInput !== true) return null;
  if (reason !== 'idle') return 'ask';
  return loopSleeping ? null : 'done';
}

/** World px the question bubble sits above its rest: 0 or 1, flipping every ASK_BUBBLE_BOB_MS. */
export function askBobOffset(nowMs: number): number {
  return Math.floor(nowMs / ASK_BUBBLE_BOB_MS) % 2;
}
