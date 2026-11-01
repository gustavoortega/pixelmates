/**
 * The side bubble beside a head and the glyph on its monitor screen: which agents show them, and
 * that a screen shows one only while its agent stands at its own seat.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { ASK_BUBBLE_BOB_MS } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { askBobOffset, sideBubbleKind } from '../src/office/sideBubble.js';
import type { Character, OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TileType, WorkStatus } from '../src/office/types.js';
import { loadRealAssets } from './realAssets.js';

beforeAll(loadRealAssets);

type Facts = Parameters<typeof sideBubbleKind>[0];

function facts(over: Partial<Facts> = {}): Facts {
  return {
    id: 1,
    isSubagent: false,
    matrixEffect: null,
    agentStatus: WorkStatus.WAITING,
    bubbleType: 'waiting',
    waitingAwaitingInput: true,
    ...over,
  };
}

describe('sideBubbleKind', () => {
  it('a question wait asks, an idle wait is done', () => {
    expect(sideBubbleKind(facts(), 'question')).toBe('ask');
    expect(sideBubbleKind(facts(), undefined)).toBe('ask');
    expect(sideBubbleKind(facts(), 'idle')).toBe('done');
  });

  it('shows nothing for a plain wait, an active agent or a permission prompt', () => {
    expect(sideBubbleKind(facts({ waitingAwaitingInput: false }), 'question')).toBeNull();
    expect(sideBubbleKind(facts({ agentStatus: WorkStatus.ACTIVE }), 'question')).toBeNull();
    expect(sideBubbleKind(facts({ agentStatus: WorkStatus.IDLE }), 'idle')).toBeNull();
    // A permission prompt over a status the wait left behind: its own bubble owns the head.
    expect(sideBubbleKind(facts({ bubbleType: 'permission' }), 'question')).toBeNull();
    // Status truth only: the 2 s waiting bubble fading out changes nothing.
    expect(sideBubbleKind(facts({ bubbleType: null }), 'question')).toBe('ask');
  });

  it('never for a sub-agent, the greeter, a despawning agent or an id <= 0', () => {
    expect(sideBubbleKind(facts({ isSubagent: true }), 'question')).toBeNull();
    expect(sideBubbleKind(facts({ isGreeter: true }), 'question')).toBeNull();
    expect(sideBubbleKind(facts({ matrixEffect: 'despawn' }), 'question')).toBeNull();
    expect(sideBubbleKind(facts({ id: 0 }), 'question')).toBeNull();
    expect(sideBubbleKind(facts({ id: -3 }), 'question')).toBeNull();
  });

  it('a sleeping loop is not waiting for you: no done, a question still asks', () => {
    expect(sideBubbleKind(facts(), 'idle', true)).toBeNull();
    expect(sideBubbleKind(facts(), 'question', true)).toBe('ask');
  });
});

describe('askBobOffset', () => {
  it('alternates 0 and 1 every step', () => {
    expect(askBobOffset(0)).toBe(0);
    expect(askBobOffset(ASK_BUBBLE_BOB_MS - 1)).toBe(0);
    expect(askBobOffset(ASK_BUBBLE_BOB_MS)).toBe(1);
    expect(askBobOffset(2 * ASK_BUBBLE_BOB_MS - 1)).toBe(1);
    expect(askBobOffset(2 * ASK_BUBBLE_BOB_MS)).toBe(0);
  });
});

const COLS = 14;
const ROWS = 12;

/** Layout v7 pod at c=1, r=3: the back-view seat `cb1` owns the front-facing PC `pb1`. */
const POD: PlacedFurniture[] = [
  { uid: 'da1', type: 'DESK_FRONT', col: 1, row: 4 },
  { uid: 'ca1', type: 'CUSHIONED_CHAIR_FRONT', col: 2, row: 4 },
  { uid: 'pa1', type: 'PC_BACK', col: 3, row: 4 },
  { uid: 'db1', type: 'DESK_FRONT', col: 1, row: 6 },
  { uid: 'pb1', type: 'PC_FRONT_OFF', col: 2, row: 6 },
  { uid: 'cb1', type: 'CUSHIONED_CHAIR_BACK', col: 2, row: 8 },
];

function office(): OfficeState {
  const os = new OfficeState({
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles: new Array(COLS * ROWS).fill(TileType.FLOOR_1),
    furniture: POD,
  } as OfficeLayout);
  os.addAgent(1, 0, 0, 'cb1', true, undefined, undefined, true);
  return os;
}

function ask(os: OfficeState, reason: 'question' | 'idle' = 'question'): void {
  os.showWaitingBubble(1, true);
  os.setAwaiting(1, reason, undefined);
}

function drawnGlyphs(os: OfficeState): Array<string | undefined> {
  return os.furniture.filter((f) => f.screenGlyph).map((f) => f.screenGlyph);
}

describe('screen glyphs', () => {
  it('an agent at its seat with a question wait gives its PC ask, drawn on the screen', () => {
    const os = office();
    ask(os);
    os.update(0.016);
    expect(drawnGlyphs(os)).toEqual(['ask']);
  });

  it('an idle wait gives done', () => {
    const os = office();
    ask(os, 'idle');
    os.update(0.016);
    expect(drawnGlyphs(os)).toEqual(['done']);
  });

  it('an active agent gives none', () => {
    const os = office();
    os.setAgentActive(1, true);
    os.update(0.016);
    expect(drawnGlyphs(os)).toEqual([]);
  });

  it('an agent off its seat gives none, and the glyph returns when it sits back down', () => {
    const os = office();
    ask(os);
    os.update(0.016);
    const ch = os.characters.get(1) as Character;
    const seat = os.seats.get('cb1')!;
    os.walkToTile(1, seat.seatCol + 3, seat.seatRow - 2);
    for (let i = 0; i < 40 && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow; i++) {
      os.update(0.1);
    }
    expect(ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow).toBe(false);
    expect(os.screenGlyphs().size).toBe(0);
    // The key is read at the top of an update, so the furniture follows one tick behind.
    os.update(0.016);
    expect(drawnGlyphs(os)).toEqual([]);

    // Back on the seat: the rebuild key notices, with no other trigger.
    ch.tileCol = seat.seatCol;
    ch.tileRow = seat.seatRow;
    os.update(0.016);
    os.update(0.016);
    expect(os.screenGlyphs().get('pb1')).toBe('ask');
    expect(drawnGlyphs(os)).toEqual(['ask']);
  });

  it('an idle wait with a loop sleeping gives no side bubble and no glyph', () => {
    const os = office();
    ask(os, 'idle');
    os.setLoop(1, { nextAt: Date.now() + 60_000 });
    os.update(0.016);
    expect(os.sideBubbleOf(os.characters.get(1)!)).toBeNull();
    expect(os.screenGlyphs().size).toBe(0);
    expect(drawnGlyphs(os)).toEqual([]);
  });

  it('a seat owning a PC_BACK draws no glyph (its screen faces away)', () => {
    const os = office();
    os.removeAgent(1);
    os.addAgent(2, 0, 0, 'ca1', true, undefined, undefined, true);
    os.showWaitingBubble(2, true);
    os.setAwaiting(2, 'question', undefined);
    os.update(0.016);
    expect(drawnGlyphs(os)).toEqual([]);
  });
});
