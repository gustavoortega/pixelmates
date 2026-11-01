/**
 * How busy each office scene reads to the render loop: 'active' draws every frame, 'ambient' ten
 * times a second, 'idle' once a second. A scene that moves but reads quieter animates in steps; one
 * that reads busier than it is burns the CPU the loop exists to save.
 *
 * Run with: npm test
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ActivityLevel } from '../src/office/engine/gameLoop.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { createPet } from '../src/office/engine/petEntity.js';
import { setCozyLighting } from '../src/office/engine/renderer.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { PetState, TILE_SIZE, TileType } from '../src/office/types.js';
import { loadRealAssets } from './realAssets.js';

const COLS = 12;
const ROWS = 10;
const DESK: PlacedFurniture[] = [
  { uid: 'desk', type: 'DESK_FRONT', col: 7, row: 2 },
  { uid: 'chair', type: 'CUSHIONED_CHAIR_FRONT', col: 8, row: 2 },
];
const FAIRY: PlacedFurniture[] = [{ uid: 'fairy', type: 'FAIRY_LIGHTS', col: 2, row: 0 }];
/** A chair alone in the room: its sitter's companion has the floor around it to land on. */
const LONE_CHAIR: PlacedFurniture[] = [
  { uid: 'chair', type: 'CUSHIONED_CHAIR_FRONT', col: 5, row: 5 },
];

/** Agent 1, idle unless `working`, seated at the desk's chair with no spawn effect. */
function seat(os: OfficeState, working = false): void {
  os.addAgent(1, 0, 0, 'chair', true, undefined, undefined, working);
}

interface Scene {
  name: string;
  level: ActivityLevel;
  furniture?: PlacedFurniture[];
  /** Local hour of the office clock; noon by default. */
  hour?: number;
  cozyOff?: boolean;
  setup?: (os: OfficeState) => void;
  /** What the scene must be after its update, so it reads its level for the reason it names. */
  check?: (os: OfficeState) => void;
}

/** An idle agent of the given mood at its desk. */
function moody(os: OfficeState, mood: 'happy' | 'frustrated'): void {
  seat(os);
  os.setRoster(1, { memberId: 'm', name: 'Ada', level: 1, xp: 0, xpToNext: 100, streak: 0, mood });
}

const SCENES: Scene[] = [
  { name: 'an empty office by day', level: 'idle' },
  { name: 'an idle agent at its desk', level: 'ambient', furniture: DESK, setup: (os) => seat(os) },
  { name: 'a working agent', level: 'active', furniture: DESK, setup: (os) => seat(os, true) },
  {
    name: 'an idle agent walking',
    level: 'active',
    furniture: DESK,
    setup: (os) => {
      seat(os);
      os.walkToTile(1, 2, 7);
    },
  },
  {
    name: 'an idle agent materializing',
    level: 'active',
    furniture: DESK,
    setup: (os) => os.addAgent(1, 0, 0, 'chair', false, undefined, undefined, false),
  },
  {
    name: 'an idle agent under a tripwire alarm',
    level: 'active',
    furniture: DESK,
    setup: (os) => {
      seat(os);
      os.setTripwire(1, { ruleName: 'rule', severity: 'high', count: 1 });
    },
  },
  {
    name: 'smoke over a stuck agent',
    level: 'active',
    furniture: DESK,
    setup: (os) => {
      seat(os);
      os.setHealth(1, { state: 'stuck', reason: 'tests_failing_no_edits', count: 3 });
    },
  },
  {
    // The pause mark is still: a health mark alone does not mean a frame of its own.
    name: 'a pause mark over a stalled agent',
    level: 'ambient',
    furniture: DESK,
    setup: (os) => {
      seat(os);
      os.setHealth(1, { state: 'stalled', reason: 'no_progress', count: 10 });
    },
  },
  {
    name: 'an XP pop playing',
    level: 'active',
    furniture: DESK,
    setup: (os) => {
      seat(os);
      os.setRosterEvent(1, { kind: 'xp', amount: 120 }, Date.now());
    },
  },
  {
    name: 'a storm over a frustrated agent',
    level: 'active',
    furniture: DESK,
    setup: (os) => moody(os, 'frustrated'),
  },
  {
    name: 'a heart rising over a happy agent',
    level: 'active',
    furniture: DESK,
    setup: (os) => moody(os, 'happy'),
    check: (os) => expect(os.weather.hearts).toHaveLength(1),
  },
  {
    name: 'a companion gliding back to its agent',
    level: 'active',
    furniture: LONE_CHAIR,
    setup: (os) => {
      seat(os);
      os.setAgentModel(1, 'model', 1);
      os.update(0.1);
      // Its agent stays put: only the companion, four tiles off its spot, is on the move.
      os.companions.get(1)!.x += 4 * TILE_SIZE;
    },
    check: (os) => expect(os.characters.get(1)!.path).toHaveLength(0),
  },
  { name: 'the greeter', level: 'active', setup: (os) => os.spawnGreeter() },
  {
    name: 'an awake pet',
    level: 'ambient',
    setup: (os) => {
      os.pets.push(createPet('cat', 0, 3, 3));
    },
  },
  {
    name: 'a walking pet',
    level: 'active',
    setup: (os) => {
      const pet = createPet('cat', 0, 3, 3);
      pet.state = PetState.WALK;
      pet.path = [
        { col: 4, row: 3 },
        { col: 5, row: 3 },
      ];
      os.pets.push(pet);
    },
  },
  {
    // At night with nobody working a pet with no sofa to go to sleeps where it stands.
    name: 'a pet asleep at night',
    level: 'idle',
    hour: 22,
    setup: (os) => {
      os.pets.push(createPet('cat', 0, 3, 3));
    },
  },
  {
    name: 'a heart bubble over a pet asleep at night',
    level: 'ambient',
    hour: 22,
    setup: (os) => {
      os.pets.push(createPet('cat', 0, 3, 3));
      os.showPetBubble('cat');
    },
    check: (os) => expect(os.pets[0]!.state).toBe(PetState.SLEEP),
  },
  { name: 'fairy lights at night', level: 'ambient', hour: 22, furniture: FAIRY },
  { name: 'fairy lights by day', level: 'idle', furniture: FAIRY },
  {
    name: 'fairy lights at night with the cozy lighting off',
    level: 'idle',
    hour: 22,
    furniture: FAIRY,
    cozyOff: true,
  },
  {
    // The side bubble bobs in 600 ms steps, which the 100 ms ambient redraw already shows.
    name: 'a question wait at its desk',
    level: 'ambient',
    furniture: DESK,
    setup: (os) => {
      seat(os);
      os.showWaitingBubble(1, true);
      os.setAwaiting(1, 'question', undefined);
    },
    check: (os) => expect(os.sideBubbleOf(os.characters.get(1)!)).toBe('ask'),
  },
  {
    name: 'a monitor left on in the layout',
    level: 'ambient',
    furniture: [{ uid: 'pc', type: 'PC_FRONT_ON_1', col: 3, row: 3 }],
  },
];

beforeAll(loadRealAssets);

afterEach(() => {
  setCozyLighting(true);
  vi.useRealTimers();
});

describe('office activity level', () => {
  it.each(SCENES)(
    '$name reads $level',
    ({ level, furniture = [], hour = 12, cozyOff, setup, check }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 0, 1, hour, 0));
      setCozyLighting(!cozyOff);
      const os = new OfficeState({
        version: 1,
        cols: COLS,
        rows: ROWS,
        tiles: new Array(COLS * ROWS).fill(TileType.FLOOR_1),
        furniture,
      } as OfficeLayout);
      setup?.(os);
      os.update(0.1);
      check?.(os);
      expect(os.activityLevel()).toBe(level);
    },
  );
});
