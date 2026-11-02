/**
 * The seen list's storage: what survives a reload, what a broken browser store does to it, and
 * the cap that keeps it small. Reads and writes go through a fake Storage, never a real one.
 */

import { describe, expect, it } from 'vitest';

import { SEEN_TURNS_MAX } from '../src/constants.js';
import { applyMonitorMessage } from '../src/hooks/monitorMessages.js';
import { readSeenTurns, type SeenStorage, writeSeenTurns } from '../src/hooks/seenTurns.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function fakeStorage(initial?: string): SeenStorage & { value: string | null } {
  const store = {
    value: initial ?? null,
    getItem: () => store.value,
    setItem: (_key: string, value: string) => {
      store.value = value;
    },
  };
  return store;
}

const throwing: SeenStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

function stored(storage: { value: string | null }): Array<[number, number | null]> {
  return JSON.parse(storage.value ?? '[]') as Array<[number, number | null]>;
}

describe('seen turns storage', () => {
  it('round-trips ids with and without a since, in order', () => {
    const storage = fakeStorage();
    writeSeenTurns(
      storage,
      new Map<number, number | null>([
        [7, 1_760_000_000_000],
        [3, null],
      ]),
    );
    expect([...readSeenTurns(storage)]).toEqual([
      [7, 1_760_000_000_000],
      [3, null],
    ]);
  });

  it('reads nothing and never throws when the browser store refuses access', () => {
    expect(readSeenTurns(throwing).size).toBe(0);
    expect(() => writeSeenTurns(throwing, new Map([[1, 5]]))).not.toThrow();
    expect(readSeenTurns(undefined).size).toBe(0);
  });

  it.each(['not json', '{"7":1}', '[[7]]', '[["7",1]]', '[[7,"x"]]', '[[7,1],[8]]'])(
    'treats %s as an empty list',
    (raw) => {
      expect(readSeenTurns(fakeStorage(raw)).size).toBe(0);
    },
  );

  it('keeps the 200 most recent of 201 ids, dropping the oldest', () => {
    const storage = fakeStorage();
    const all = new Map<number, number | null>();
    for (let id = 1; id <= SEEN_TURNS_MAX + 1; id++) all.set(id, id);
    writeSeenTurns(storage, all);
    const ids = stored(storage).map(([id]) => id);
    expect(ids).toHaveLength(SEEN_TURNS_MAX);
    expect(ids[0]).toBe(2);
    expect(ids).not.toContain(1);
  });
});

describe('re-marking a seen turn', () => {
  const layout: OfficeLayout = {
    version: 1,
    cols: 4,
    rows: 4,
    tiles: new Array<TileType>(16).fill(TileType.FLOOR_1),
    furniture: [],
  };

  // The oldest id seen again is the freshest, so the cap must drop someone else.
  it('moves the id to the end, so the cap keeps it', () => {
    const storage = fakeStorage();
    const os = new OfficeState(layout, storage);
    const finish = (id: number, since: number) => {
      applyMonitorMessage(os, {
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'idle',
        since,
      });
      os.markSeenIfYourTurn(id);
    };
    for (let id = 1; id <= SEEN_TURNS_MAX; id++) finish(id, 1000 + id);
    finish(1, 5000);
    finish(SEEN_TURNS_MAX + 1, 5001);
    const ids = stored(storage).map(([id]) => id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).toHaveLength(SEEN_TURNS_MAX);
  });
});
