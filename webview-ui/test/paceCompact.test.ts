/**
 * When the Pace panel goes compact because the ticket list ran out of room, and when it comes
 * back: the full panel must need the room it takes, or the two forms would flip every render.
 */

import { describe, expect, it } from 'vitest';

import { nextPaceCompact, PACE_COMPACT_SLACK_PX } from '../src/components/paceCompact.js';

// The full panel is 120 px tall, the compact one 30: compact frees 90 px.
const FULL = 120;
const COMPACT = 30;
const FREED = FULL - COMPACT;
const measure = (scrollH: number, clientH: number, fullH: number | null = FULL) => ({
  scrollH,
  clientH,
  fullH,
  compactH: COMPACT,
});

describe('nextPaceCompact', () => {
  it('goes compact when the list overflows', () => {
    expect(nextPaceCompact(false, measure(401, 400))).toBe(true);
    expect(nextPaceCompact(false, measure(400, 400))).toBe(false);
  });

  it('comes back full once the list would fit with the full panel and a little slack', () => {
    expect(nextPaceCompact(true, measure(200, 200 + FREED + PACE_COMPACT_SLACK_PX))).toBe(false);
  });

  it('stays compact with room for exactly the freed height and no slack', () => {
    expect(nextPaceCompact(true, measure(200, 200 + FREED))).toBe(true);
  });

  it('leaves compact on any spare room while the full height was never measured', () => {
    expect(nextPaceCompact(true, measure(300, 300, null))).toBe(false);
    expect(nextPaceCompact(true, measure(301, 300, null))).toBe(true);
  });
});
