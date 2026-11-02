import { MONITOR_SEEN_STORAGE_KEY, SEEN_TURNS_MAX } from '../constants.js';

/** The two Storage methods the seen list needs, so tests pass a fake. */
export type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The page's localStorage, or undefined outside a browser or when the browser refuses access. */
export function browserStorage(): SeenStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Agent id -> the `since` of the Your turn the user opened (null: that turn had no `since`).
 * Anything unreadable, unparsable or shaped differently reads as nothing seen: a list that
 * cannot be trusted is not partly trusted.
 */
export function readSeenTurns(storage: SeenStorage | undefined): Map<number, number | null> {
  const seen = new Map<number, number | null>();
  try {
    const raw = storage?.getItem(MONITOR_SEEN_STORAGE_KEY);
    if (!raw) return seen;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seen;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) return new Map();
      const [id, since] = entry as [unknown, unknown];
      if (typeof id !== 'number' || !Number.isInteger(id)) return new Map();
      if (since !== null && (typeof since !== 'number' || !Number.isFinite(since))) {
        return new Map();
      }
      seen.set(id, since);
    }
  } catch {
    return new Map();
  }
  return seen;
}

/** Keeps the SEEN_TURNS_MAX most recent entries (the map's insertion order). Never throws. */
export function writeSeenTurns(
  storage: SeenStorage | undefined,
  seen: ReadonlyMap<number, number | null>,
): void {
  try {
    storage?.setItem(MONITOR_SEEN_STORAGE_KEY, JSON.stringify([...seen].slice(-SEEN_TURNS_MAX)));
  } catch {
    // A list that cannot be kept still applies to this page.
  }
}
