import type { LimitWindow, UsageLimits } from '../../../core/src/messages.js';
import type { AgentStateStore } from '../agentStateStore.js';
import type { LimitSample, UsageLimitsBody } from './usageLimitsBody.js';

export type LimitWindowKey = 'fiveHour' | 'sevenDay';

/** Told when a window's reset time moves (the first reading, or a new window): the token ledger anchors its 5-hour
 *  block or week on it, as it does on a transcript's quota record. `resetsAt` and `now` are epoch ms. */
export type LimitsAnchorCallback = (window: LimitWindowKey, resetsAt: number, now: number) => void;

const WINDOW_KEYS: readonly LimitWindowKey[] = ['fiveHour', 'sevenDay'];

/** A stored window that no post has carried for this long, while posts keep arriving, belongs to an account that no
 *  longer reports it (one without a 5 h window sends `five_hour` null on every post). Longer than a session's
 *  refresh so one that merely lacks the field cannot clear it, and short enough that the row does not linger. */
export const LIMIT_WINDOW_ABSENT_MS = 10 * 60_000;

/** Usage only grows inside a window and a new window always resets later, so a sample is "not older" when its reset
 *  is later, or the same with equal or higher usage. Equal counts: a session confirming the same numbers keeps the
 *  reading fresh. */
function isNotOlder(next: LimitWindow, stored: LimitWindow): boolean {
  return (
    next.resetsAt > stored.resetsAt ||
    (next.resetsAt === stored.resetsAt && next.usedPercentage >= stored.usedPercentage)
  );
}

function toWindow(sample: LimitSample): LimitWindow {
  // The wire carries epoch ms, as integers.
  return { usedPercentage: sample.usedPercentage, resetsAt: Math.round(sample.resetsAt * 1000) };
}

/**
 * The official limits the status line wrapper reports, account-wide and in memory. Several Claude Code sessions post
 * the same limits from different moments, and with `refreshInterval` an idle session re-posts its last snapshot
 * every refresh, so "the latest post wins" would flip the panel between a stale and a fresh value. Each window keeps
 * one sample and takes an incoming one only when it is not older; a post with nothing accepted changes nothing and
 * broadcasts nothing. A window no post has carried for LIMIT_WINDOW_ABSENT_MS drops back to null, but only inside
 * `set`: while every session is idle nothing arrives, and the last reading stays for the webview to age.
 */
export class UsageLimitsStore {
  private readonly samples: Record<LimitWindowKey, LimitWindow | null> = {
    fiveHour: null,
    sevenDay: null,
  };
  /** The last time any valid post carried a sample for the window, accepted or not: an older reading still proves the
   *  account has that window. */
  private readonly carriedAt: Record<LimitWindowKey, number | null> = {
    fiveHour: null,
    sevenDay: null,
  };
  private receivedAt = 0;

  constructor(
    private readonly store: Pick<AgentStateStore, 'broadcast'>,
    private readonly onLimits?: LimitsAnchorCallback,
  ) {}

  /** Merge one validated post received at `now` (epoch ms). */
  set(body: UsageLimitsBody, now: number): void {
    for (const key of WINDOW_KEYS) {
      if (body[key] !== null) this.carriedAt[key] = now;
    }
    let accepted = false;
    for (const key of WINDOW_KEYS) {
      const sample = body[key];
      if (sample === null) continue; // a post with one window keeps the other
      const next = toWindow(sample);
      const stored = this.samples[key];
      if (stored !== null && !isNotOlder(next, stored)) continue;
      this.samples[key] = next;
      accepted = true;
      // Anchor once per reset time, and only on a window still running.
      if ((stored === null || stored.resetsAt !== next.resetsAt) && next.resetsAt > now) {
        this.onLimits?.(key, next.resetsAt, now);
      }
    }
    let cleared = false;
    for (const key of WINDOW_KEYS) {
      const carried = this.carriedAt[key];
      if (
        this.samples[key] !== null &&
        carried !== null &&
        now - carried >= LIMIT_WINDOW_ABSENT_MS
      ) {
        this.samples[key] = null;
        cleared = true;
      }
    }
    if (!accepted && !cleared) return;
    // Advances even when the values are equal: the staleness label reads it. A clear alone leaves it.
    if (accepted) this.receivedAt = now;
    this.store.broadcast({ ...this.latest() });
  }

  /** What a connecting client is sent: the stored samples, or both windows null with `receivedAt` 0 before anything
   *  arrived. Always a message, so a client can tell "this process receives the limits, nothing yet" from a window
   *  that reuses another window's server and never will. */
  latest(): UsageLimits {
    return {
      type: 'usageLimits',
      receivedAt: this.receivedAt,
      fiveHour: this.samples.fiveHour,
      sevenDay: this.samples.sevenDay,
    };
  }
}
