/**
 * The tab badge: the title the count makes, and who is counted.
 */

import { describe, expect, it } from 'vitest';

import type { Attention, Ticket } from '../src/components/attention.js';
import { badgeCount, tabTitle } from '../src/tabBadge.js';

const ticket = (id: number, kind: Ticket['kind']): Ticket => ({
  id,
  kind,
  glyph: '?',
  reason: 'x',
});

describe('tabTitle', () => {
  it.each([
    [0, 'pixelmates'],
    [1, '(1) pixelmates'],
    [2, '(2) pixelmates'],
  ])('%s needing you reads %s', (count, title) => {
    expect(tabTitle(count)).toBe(title);
  });
});

describe('badgeCount', () => {
  it('counts the agents blocked on you, not stuck or finished ones', () => {
    const attention: Attention = {
      needs: [ticket(1, 'question')],
      stuck: [ticket(2, 'stuck')],
      yours: [ticket(3, 'idle')],
    };
    expect(badgeCount(attention)).toBe(1);
  });
});
