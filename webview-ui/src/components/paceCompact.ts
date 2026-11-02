/**
 * Whether the rail's Pace panel shows its one-row compact form because the ticket list ran out
 * of room. Pure: MonitorRail measures, this decides, and the hysteresis is a table test.
 *
 * Compact frees `fullH - compactH` px for the list, so going back to full needs that much spare
 * room (plus a little slack for rounding). Going back on any spare room would flip every render:
 * the full panel takes the room back and the list overflows again.
 */

/** Spare px beyond the freed height before the full panel comes back, so rounding cannot flip it. */
export const PACE_COMPACT_SLACK_PX = 2;

export interface PaceCompactMeasure {
  /** The list's content height. */
  scrollH: number;
  /** The list's visible height. */
  clientH: number;
  /** The panel's height when it last rendered full; null when it never has (not measured). */
  fullH: number | null;
  /** The panel's height as it renders compact, 0 when that renders nothing. */
  compactH: number;
}

export function nextPaceCompact(prev: boolean, m: PaceCompactMeasure): boolean {
  if (!prev) return m.scrollH > m.clientH;
  // Never measured full: leave on the first sign of room; at most one bounce teaches fullH.
  if (m.fullH === null) return m.scrollH > m.clientH;
  return !(m.scrollH <= m.clientH - (m.fullH - m.compactH) - PACE_COMPACT_SLACK_PX);
}
