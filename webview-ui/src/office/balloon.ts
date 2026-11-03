/**
 * The speech balloon over a hovered character in the monitor: which kind of ask it shows and the
 * text under its title. Pure, so the overlay and the tests share one rule. The text is session
 * text (a question, a command's program), so the overlay masks it under privacy mode.
 */

import type { Ticket } from '../components/attention.js';
import { formatSpan } from './plateState.js';
import type { SideBubbleKind } from './sideBubble.js';

export type BalloonKind = 'permission' | 'question' | 'finished';

export interface Balloon {
  kind: BalloonKind;
  title: string | null;
  detail: string;
  /** The detail is session text: privacy mode masks it. */
  detailPv: boolean;
}

export interface BalloonFacts {
  /** The browser monitor; the VS Code panel keeps its hover card. */
  monitor: boolean;
  /** This agent's ticket from the rail's rules, any list, or null. */
  ticket: Ticket | null;
  /** The side bubble beside the head. */
  bubble: SideBubbleKind | null;
  /** When the current status began, epoch ms. */
  since: number | null;
  /** The session title, else the folder. */
  title: string | null;
}

/**
 * Permission and question read from the ticket (the rail's own words); a finished turn says how
 * long ago. Stuck agents and agents with nothing to ask keep the full card (null).
 */
export function balloonOf(f: BalloonFacts, now: number): Balloon | null {
  if (!f.monitor) return null;
  const { title } = f;
  if (f.ticket?.kind === 'permission') {
    return { kind: 'permission', title, detail: f.ticket.reason, detailPv: true };
  }
  if (f.ticket?.kind === 'question') {
    return { kind: 'question', title, detail: f.ticket.reason, detailPv: true };
  }
  if (f.bubble === 'ask') {
    return { kind: 'question', title, detail: 'Has a question', detailPv: true };
  }
  if (f.bubble === 'done' || f.bubble === 'seen') {
    // formatSpan clamps at 0m, so a server clock ahead of ours never reads negative.
    const detail = f.since === null ? 'Finished' : `Finished ${formatSpan(now - f.since)} ago`;
    return { kind: 'finished', title, detail, detailPv: false };
  }
  return null;
}
