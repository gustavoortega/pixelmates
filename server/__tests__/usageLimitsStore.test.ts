import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageLimits } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type LimitWindowKey, UsageLimitsStore } from '../src/usage/usageLimitsStore.js';

const NOW = 1_760_000_000_000; // epoch ms
const RESET_5H = 1_760_003_600; // epoch s, an hour after NOW
const RESET_7D = 1_760_300_000;

const sample = (usedPercentage: number, resetsAt: number) => ({ usedPercentage, resetsAt });

/**
 * Several Claude Code sessions post the same account-wide limits, and an idle one re-posts its last snapshot on every
 * refresh. The store must keep the newest reading per window, whoever posted it, and say nothing when a post adds
 * nothing.
 */
describe('UsageLimitsStore', () => {
  let agents: AgentStateStore;
  let broadcasts: UsageLimits[];
  let anchors: Array<[LimitWindowKey, number]>;
  let limits: UsageLimitsStore;

  beforeEach(() => {
    agents = new AgentStateStore();
    broadcasts = [];
    agents.on('broadcast', (message) => broadcasts.push(message as unknown as UsageLimits));
    anchors = [];
    limits = new UsageLimitsStore(agents, (window, resetsAt) => anchors.push([window, resetsAt]));
  });

  afterEach(() => {
    agents.dispose();
  });

  it('ignores an older snapshot from an idle session: no change, no broadcast', () => {
    limits.set({ fiveHour: sample(45, RESET_5H), sevenDay: sample(20, RESET_7D) }, NOW);

    limits.set({ fiveHour: sample(30, RESET_5H), sevenDay: sample(15, RESET_7D) }, NOW + 30_000);

    expect(broadcasts).toHaveLength(1);
    expect(limits.latest()).toEqual({
      type: 'usageLimits',
      receivedAt: NOW,
      fiveHour: { usedPercentage: 45, resetsAt: RESET_5H * 1000 },
      sevenDay: { usedPercentage: 20, resetsAt: RESET_7D * 1000 },
    });
  });

  it('takes a new window even with lower usage', () => {
    limits.set({ fiveHour: sample(95, RESET_5H), sevenDay: null }, NOW);

    limits.set({ fiveHour: sample(2, RESET_5H + 18_000), sevenDay: null }, NOW + 60_000);

    expect(limits.latest().fiveHour).toEqual({
      usedPercentage: 2,
      resetsAt: (RESET_5H + 18_000) * 1000,
    });
  });

  // receivedAt drives the "official" vs "23m ago" label: a session confirming the same numbers keeps it fresh.
  it('advances receivedAt and broadcasts when a post repeats the stored values', () => {
    limits.set({ fiveHour: sample(45, RESET_5H), sevenDay: sample(20, RESET_7D) }, NOW);

    limits.set({ fiveHour: sample(45, RESET_5H), sevenDay: sample(20, RESET_7D) }, NOW + 30_000);

    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1].receivedAt).toBe(NOW + 30_000);
  });

  it('keeps the other window when a post carries only one', () => {
    limits.set({ fiveHour: sample(45, RESET_5H), sevenDay: sample(20, RESET_7D) }, NOW);

    limits.set({ fiveHour: sample(50, RESET_5H), sevenDay: null }, NOW + 30_000);

    expect(limits.latest()).toMatchObject({
      fiveHour: { usedPercentage: 50 },
      sevenDay: { usedPercentage: 20, resetsAt: RESET_7D * 1000 },
    });
  });

  // An idle session's snapshot can name a reset that already passed. It is still a reading, but the ledger keeps the
  // newest anchor per window, so anchoring it (stamped now) would outrank the transcripts' own quota records.
  it('stores and broadcasts a window already past its reset without anchoring it', () => {
    limits.set({ fiveHour: sample(80, NOW / 1000 - 60), sevenDay: null }, NOW);

    expect(broadcasts).toHaveLength(1);
    expect(limits.latest().fiveHour).toEqual({ usedPercentage: 80, resetsAt: NOW - 60_000 });
    expect(anchors).toEqual([]);
  });

  // The ledger anchors its windows on a reset time; re-anchoring on every refresh would be noise.
  it('anchors once per reset time, not once per post', () => {
    limits.set({ fiveHour: sample(10, RESET_5H), sevenDay: sample(5, RESET_7D) }, NOW);
    limits.set({ fiveHour: sample(12, RESET_5H), sevenDay: sample(5, RESET_7D) }, NOW + 30_000);
    limits.set(
      { fiveHour: sample(1, RESET_5H + 18_000), sevenDay: sample(6, RESET_7D) },
      NOW + 60_000,
    );

    expect(anchors).toEqual([
      ['fiveHour', RESET_5H * 1000],
      ['sevenDay', RESET_7D * 1000],
      ['fiveHour', (RESET_5H + 18_000) * 1000],
    ]);
  });

  // An account without a 5 h window posts five_hour null on every post. The stored reading must go once no post
  // has carried it for a while, but only while posts keep arriving, and never because one session lacks the field.
  describe('a window that stops being carried', () => {
    const EVERY = 30_000;
    const MIN = 60_000;
    const full = { fiveHour: sample(45, RESET_5H), sevenDay: sample(20, RESET_7D) };
    const without = { fiveHour: null, sevenDay: sample(20, RESET_7D) };

    it('keeps the window while any source still carries it', () => {
      for (let t = 0; t <= 20 * MIN; t += EVERY) {
        limits.set(t % (2 * EVERY) === 0 ? full : without, NOW + t);
        expect(limits.latest().fiveHour).not.toBeNull();
      }
    });

    it('drops it at the first post 10 minutes after the last one that carried it', () => {
      limits.set(full, NOW);
      let clearedAt: number | null = null;
      for (let t = EVERY; t <= 11 * MIN; t += EVERY) {
        const before = broadcasts.length;
        limits.set(without, NOW + t);
        if (limits.latest().fiveHour === null && clearedAt === null) {
          clearedAt = t;
          expect(broadcasts).toHaveLength(before + 1);
          // The 7 d reading was accepted by that same post, so it dates the broadcast.
          expect(limits.latest().receivedAt).toBe(NOW + t);
        }
      }
      expect(clearedAt).toBe(10 * MIN);
      expect(limits.latest().sevenDay).not.toBeNull();
    });

    it('drops it even when every post since is an older reading that is not accepted', () => {
      limits.set(full, NOW);
      const older = { fiveHour: null, sevenDay: sample(10, RESET_7D) };
      for (let t = EVERY; t <= 11 * MIN; t += EVERY) limits.set(older, NOW + t);
      expect(limits.latest().fiveHour).toBeNull();
      // Only a clear happened since the first post: receivedAt did not move.
      expect(limits.latest().receivedAt).toBe(NOW);
    });

    // With every session idle no post arrives, and the webview ages the reading itself.
    it('keeps the last reading while no post arrives, whatever the clock does', () => {
      vi.useFakeTimers();
      try {
        limits.set(full, NOW);
        vi.advanceTimersByTime(30 * MIN);
        expect(limits.latest().fiveHour).not.toBeNull();
        expect(broadcasts).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('counts an older reading of the window as carried', () => {
      limits.set(full, NOW);
      const olderBoth = { fiveHour: sample(30, RESET_5H), sevenDay: sample(20, RESET_7D) };
      for (let t = EVERY; t <= 20 * MIN; t += EVERY) {
        limits.set(t % (2 * EVERY) === 0 ? without : olderBoth, NOW + t);
      }
      expect(limits.latest().fiveHour).toMatchObject({ usedPercentage: 45 });
    });
  });
});
