/**
 * The README hero scene: what it stages in the real office, and that it stays a dev-only path.
 *
 * Run with: npm test
 */
import * as fs from 'fs';
import * as path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import type { ModelTier } from '../../core/src/provider.js';
import { FX_POP_MS, PLATE_SCALE_MAX } from '../src/constants.js';
import {
  freezeHeroOffice,
  HERO_AGENTS,
  HERO_SEATS,
  heroMessages,
  heroZoomFor,
  monitorMessages,
  parseHeroScene,
  parseMonitorScene,
  seatHeroAgents,
  startHeroStage,
} from '../src/heroScene.js';
import { officeNow } from '../src/office/clock.js';
import { FxText } from '../src/office/components/FxText.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { createPet } from '../src/office/engine/petEntity.js';
import { plateIsCompact, plateScale } from '../src/office/nameplate.js';
import { type PlateState, sceneTwoLinePlate } from '../src/office/plateState.js';
import { shaftRects } from '../src/office/shafts.js';
import { type NameplateContent, xpPopLabel } from '../src/office/toolUtils.js';
import type { OfficeLayout } from '../src/office/types.js';
import { Direction, IdlePose, TileType, WorkStatus } from '../src/office/types.js';
import { loadRealAssets } from './realAssets.js';

const SRC = path.resolve(__dirname, '..', 'src');
const LAYOUT_PATH = path.join(SRC, '..', 'public', 'assets', 'scenes', 'hero-layout.json');
const layoutOf = (): OfficeLayout =>
  JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8')) as OfficeLayout;

beforeAll(loadRealAssets);

/** What useExtensionMessages does with these messages, reduced to the office calls it makes. */
function apply(os: OfficeState, msg: ServerMessage): void {
  if (msg.type === 'agentModel')
    os.setAgentModel(msg.id, msg.model, msg.tier as ModelTier | undefined);
  else if (msg.type === 'agentSessionTitle') os.setSessionTitle(msg.id, msg.title);
  else if (msg.type === 'agentRoster') os.setRoster(msg.id, msg);
  else if (msg.type === 'rosterEvent') os.setRosterEvent(msg.id, msg, Date.now());
  else if (msg.type === 'agentToolStart') {
    os.setAgentTool(msg.id, msg.toolName ?? null);
    os.setAgentActive(msg.id, true);
  } else if (msg.type === 'agentStatus') os.setAgentActive(msg.id, msg.status === 'active');
}

describe('hero scene staging', () => {
  let os: OfficeState;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 11, 9, 5, 7));
    const layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8')) as OfficeLayout;
    os = new OfficeState(layout);
    seatHeroAgents(os);
    for (const msg of heroMessages()) apply(os, msg);
    stop = startHeroStage(os, (msg) => apply(os, msg));
    os.selectedAgentId = 4; // what the last agentCreated does
    // One second of the loop at 20 fps: the nap and the cloud must be there at once, with the stage's own timers running.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(50);
      os.update(0.05);
    }
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('seats the four agents in their chairs, working, reading, storming and napping', () => {
    expect([...os.characters.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (const a of HERO_AGENTS) expect(os.characters.get(a.id)?.seatId).toBe(HERO_SEATS[a.id]);
    expect(os.characters.get(1)?.agentStatus).toBe(WorkStatus.ACTIVE);
    expect(os.characters.get(2)?.currentTool).toBe('Read');
    expect(os.characters.get(3)?.agentStatus).toBe(WorkStatus.ACTIVE);
    expect(os.characters.get(4)?.pose).toBe(IdlePose.NAPPING);
    expect(os.selectedAgentId).toBeNull();
  });

  it('seats Grace face-on on a top-row chair, so her plate stands under the storm cloud', () => {
    const grace = os.characters.get(3)!;
    expect(grace.dir).toBe(Direction.DOWN);
    const chair = layoutOf().furniture.find((f) => f.uid === HERO_SEATS[3])!;
    const firstPodRow = Math.min(
      ...layoutOf()
        .furniture.filter((f) => f.type === 'DESK_FRONT')
        .map((f) => f.row),
    );
    expect(chair.row).toBe(firstPodRow);
  });

  it('keeps two-line plates at full size while staged, and the normal rules back after', () => {
    expect([2, 4, 6, 8].map((z) => plateIsCompact(z))).toEqual([false, false, false, false]);
    // the scene frames one room as the whole map, so the fit ratio alone would pin the plates at 1
    expect(plateScale(8, 8)).toBe(PLATE_SCALE_MAX);
    stop();
    expect([2, 4, 6, 8].map((z) => plateIsCompact(z))).toEqual([true, true, true, false]);
    expect(plateScale(8, 8)).toBe(1);
    stop = () => {};
  });

  it('puts the owl on the busiest agent only and a storm cloud over the frustrated one only', () => {
    expect([...os.companions].map(([id, c]) => [id, c.kind])).toEqual([[1, 'owl']]);
    const now = Date.now();
    expect(os.weather.stormAlpha(3, now)).toBeGreaterThan(0);
    for (const id of [1, 2, 4]) expect(os.weather.stormAlpha(id, now)).toBeNull();
  });

  it('keeps the XP pop on screen most of the time and the storm going past its 20 s life', () => {
    let popFrames = 0;
    let stormFrames = 0;
    let mostPops = 0;
    const frames = 500;
    for (let i = 0; i < frames; i++) {
      vi.advanceTimersByTime(50);
      os.update(0.05);
      const pops = os.fx.active.filter((a) => a.kind === 'pop').length;
      mostPops = Math.max(mostPops, pops);
      if (pops > 0) popFrames++;
      if (os.weather.stormAlpha(3, Date.now()) !== null) stormFrames++;
    }
    expect(popFrames / frames).toBeGreaterThan(0.8);
    // Never a second pop stacked over one that is still rising.
    expect(mostPops).toBe(1);
    // A frame or two of calm is the restart; anything more is the cloud going away.
    expect(stormFrames / frames).toBeGreaterThan(0.95);
  });

  it('keeps a readable "+120 PR" over Ada in at least 90% of samples over 10 s', () => {
    // Readable = still at half opacity or more: FxText fades as min(1, (1 - age/FX_POP_MS) * 3).
    // Samples every 250 ms: the old 2.5 s cadence leaves ~20% of them in the fade or the gap.
    let readable = 0;
    const samples = 40;
    for (let i = 0; i < samples; i++) {
      for (let f = 0; f < 5; f++) {
        vi.advanceTimersByTime(50);
        os.update(0.05);
      }
      const pop = os.fx.active.find((a) => a.kind === 'pop' && a.agentId === 1);
      const opacity = pop ? Math.min(1, (1 - (Date.now() - pop.startedAt) / FX_POP_MS) * 3) : 0;
      if (opacity >= 0.5 && pop && xpPopLabel(pop) === '+120 PR') readable++;
    }
    expect(readable / samples).toBeGreaterThanOrEqual(0.9);
  });

  it('pins the clock to 09:30, the shafts near their .30 peak, while staged and gives the real one back after', () => {
    expect([officeNow().getHours(), officeNow().getMinutes()]).toEqual([9, 30]);
    const shaft = shaftRects(os.getLayout(), officeNow().getHours(), officeNow().getMinutes())[0];
    // The curve holds .30 to 09:00 and is at ~.294 by 09:30; at 16:30 it read ~.24.
    expect(shaft.color.alpha).toBeGreaterThan(0.29);
    stop();
    expect([officeNow().getHours(), officeNow().getMinutes()]).toEqual([9, 5]);
    stop = () => {};
  });
});

describe('hero zoom', () => {
  const room = { cols: 17, rows: 9 };
  it('is the largest zoom level at which the whole room fits the viewport', () => {
    // 1550x784 CSS px at dpr 2: 3100x1568 device px against a 272x144 world px room.
    expect(heroZoomFor(room, { width: 1550, height: 784 }, 2)).toBe(10);
    expect(heroZoomFor(room, { width: 1280, height: 800 }, 1)).toBe(4);
  });
});

describe('hero scene request', () => {
  it('turns on for ?scene=hero only, and &hud=0 hides the HUD', () => {
    expect(parseHeroScene('?scene=hero')?.hud).toBe(true);
    expect(parseHeroScene('?scene=hero&hud=0')?.hud).toBe(false);
    expect(parseHeroScene('?scene=other')).toBeNull();
    expect(parseHeroScene('')).toBeNull();
  });

  it('reads the recording options and ignores values out of range', () => {
    expect(
      parseHeroScene('?scene=hero&pops=0&freeze=1&text=1.25&zoom=4&clock=21:10&hud=office'),
    ).toEqual({
      hud: false,
      hudOffice: true,
      pops: false,
      freeze: true,
      text: 1.25,
      zoom: 4,
      agents: null,
      workflow: true,
      clock: { hour: 21, minute: 10 },
    });
    expect(parseHeroScene('?scene=hero&text=9&zoom=2.5&clock=25:00')).toMatchObject({
      pops: true,
      freeze: false,
      text: 1,
      zoom: null,
      clock: null,
    });
  });
});

describe('monitor scene recording options', () => {
  it('&workflow=0 and &agents=... leave a quiet office: no run, only the kept agents', () => {
    const opts = parseMonitorScene('?scene=monitor&agents=1,2,3,4&workflow=0')!;
    expect(opts).toMatchObject({ agents: [1, 2, 3, 4], workflow: false });
    const msgs = monitorMessages(1_000_000_000, opts);
    expect(msgs.some((m) => m.type === 'workflowRun' || m.type === 'subagentPresent')).toBe(false);
    const ids = new Set(msgs.flatMap((m) => ('id' in m && typeof m.id === 'number' ? [m.id] : [])));
    expect([...ids].sort()).toEqual([1, 2, 3, 4]);
    expect(monitorMessages(1_000_000_000).some((m) => m.type === 'workflowRun')).toBe(true);
  });
});

describe('hero scene recording options', () => {
  it('&pops=0 fires no pop of its own, so only a posted award pops', () => {
    vi.useFakeTimers();
    const os = new OfficeState(layoutOf());
    seatHeroAgents(os);
    const stop = startHeroStage(os, () => {}, Date.now, { pops: false, text: 1, clock: null });
    vi.advanceTimersByTime(3 * FX_POP_MS);
    expect(os.fx.active.filter((a) => a.kind === 'pop')).toHaveLength(0);
    stop();
    vi.useRealTimers();
  });

  it('&freeze=1 keeps the pet on its tile however long the office runs', () => {
    const os = new OfficeState(layoutOf());
    os.pets.push(createPet('test-cat', 1, 2, 2));
    freezeHeroOffice(os);
    const before = os.pets.map((p) => [p.tileCol, p.tileRow, p.x, p.y]);
    expect(before.length).toBeGreaterThan(0);
    for (let i = 0; i < 20 * 60; i++) os.update(0.05);
    expect(os.pets.map((p) => [p.tileCol, p.tileRow, p.x, p.y])).toEqual(before);
  });
});

describe('the scene plate: level and name over what the agent is doing', () => {
  const plate = (state: PlateState | null): NameplateContent => ({
    name: 'Ada',
    namePv: false,
    medal: null,
    state,
    loop: false,
    sub: [{ text: 'Ship the checkout fix', pv: true }],
    helper: false,
    rarity: null,
    pill: null,
  });
  const NOW = 1_000_000_000;
  const line2 = (p: NameplateContent): string | undefined => p.sub?.[0].text;

  it('words an edit, a command and a wait the way the README does', () => {
    const edit = sceneTwoLinePlate(
      plate({ kind: 'verb', verb: 'writing' }),
      12,
      'Editing a.ts',
      NOW,
    );
    expect(edit.name).toBe('Lv12 Ada');
    expect(line2(edit)).toBe('editing');
    expect(edit.state).toBeNull();
    expect(line2(sceneTwoLinePlate(plate({ kind: 'cmd', cmd: 'git commit' }), 12, null, NOW))).toBe(
      '\u203A git commit',
    );
    const wait = plate({
      kind: 'alert',
      alert: { glyph: '?', tone: 'wait', since: NOW - (3 * 60 + 10) * 1000 },
    });
    expect(line2(sceneTwoLinePlate(wait, 9, null, NOW))).toBe('? 3m needs you');
    const idle = plate({ kind: 'idle', since: NOW - 68 * 60_000 });
    expect(line2(sceneTwoLinePlate(idle, 4, null, NOW))).toBe('idle 1h08');
  });
});

describe('hero layout', () => {
  it('holds furniture and tiles of the one room and nothing else', () => {
    const raw = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      [
        'areaTiles',
        'areas',
        'carpetTiles',
        'cols',
        'furniture',
        'layoutRevision',
        'pets',
        'rows',
        'tileColors',
        'tiles',
        'version',
      ].sort(),
    );
    expect((raw.areas as { label: string }[]).map((a) => a.label)).toEqual(['Studio']);
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/tiendanube|\/Users\/|@/i);
    const furniture = raw.furniture as Record<string, unknown>[];
    // The crop ends on the rug's last row: no floor, wall or furniture below it.
    const carpet = raw.carpetTiles as unknown[];
    const cols = raw.cols as number;
    const lastRugRow = Math.max(...carpet.map((t, i) => (t ? Math.floor(i / cols) : -1)));
    expect(raw.rows).toBe(lastRugRow + 1);
    expect((raw.tiles as number[]).length).toBe(cols * (raw.rows as number));
    expect(furniture.every((f) => (f.row as number) <= lastRugRow)).toBe(true);
    for (const f of furniture) {
      expect(Object.keys(f).every((k) => ['uid', 'type', 'col', 'row', 'color'].includes(k))).toBe(
        true,
      );
    }
  });
});

describe('hero light', () => {
  it('lands the window shafts on the floor between the wall and the first pod row', () => {
    const layout = layoutOf();
    const firstPodRow = Math.min(
      ...layout.furniture.filter((f) => f.type === 'DESK_FRONT').map((f) => f.row),
    );
    const firstFloorRow = layout.tiles.findIndex((t) => t !== TileType.WALL && t !== TileType.VOID);
    const shafts = shaftRects(layout, 9, 30);
    expect(shafts).toHaveLength(2);
    for (const shaft of shafts) {
      const rows = shaft.cells.map((c) => c.row);
      expect(Math.min(...rows)).toBe(Math.floor(firstFloorRow / layout.cols));
      expect(rows.some((r) => r < firstPodRow)).toBe(true);
    }
  });
});

describe('hero FX look', () => {
  it('draws one "+120 PR" per pop in FS Pixel Sans gold with the dark outline, rising 70 px over 2.4 s', () => {
    vi.useFakeTimers();
    try {
      const os = new OfficeState(layoutOf());
      seatHeroAgents(os);
      const startedAt = 1_000_000;
      os.fx.active.push({
        kind: 'pop',
        agentId: 1,
        startedAt,
        amount: 120,
        signal: 'pr',
        level: 0,
      });
      os.fx.now = startedAt + 1200;
      const html = renderToStaticMarkup(
        createElement(FxText, {
          officeState: os,
          scale: 1,
          toScreenX: (x) => x,
          toScreenY: (y) => y,
        }),
      );
      expect(html.match(/data-testid="fx-xp-pop"/g)).toHaveLength(1);
      expect(html).toContain('+120 PR');
      expect(html).toContain('font-size:22px');
      // The look is the spec, pinned on purpose: a constant edit must turn this red.
      /* eslint-disable pixel-agents/no-inline-colors */
      expect(html).toContain('color:#ffe066');
      for (const d of ['2px 2px', '-2px 2px', '2px -2px', '-2px -2px'])
        expect(html).toContain(`${d} 0 #3b2412`);
      /* eslint-enable pixel-agents/no-inline-colors */
      // Halfway through its 2.4 s life it has risen half of 70 px.
      expect(html).toContain('- 35px');
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the napper's Zz cream with a dark brown outline", () => {
    const zz = JSON.parse(
      fs.readFileSync(path.join(SRC, 'office', 'sprites', 'flair', 'zz.json'), 'utf-8'),
    ) as { palette: Record<string, string> };
    /* eslint-disable-next-line pixel-agents/no-inline-colors -- the generated art colors are the spec */
    expect(zz.palette).toEqual({ '.': '', W: '#fff4dc', o: '#3b2412' });
  });
});

describe('dev-only isolation', () => {
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  }
  const importers = (pattern: RegExp): string[] =>
    sources(SRC)
      .filter((f) => pattern.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(SRC, f))
      .sort();

  it('only the dev browser mock imports the scene, and only the scene overrides the clock', () => {
    expect(importers(/['"](\.\.?\/)+heroScene(\.[jt]s)?['"]/)).toEqual(['browserMock.ts']);
    expect(importers(/overrideOfficeClock/)).toEqual(['heroScene.ts', 'office/clock.ts']);
    expect(importers(/forceFullPlates/)).toEqual(['heroScene.ts', 'office/nameplate.ts']);
  });

  it('loads the browser mock behind import.meta.env.DEV', () => {
    for (const f of importers(/import\(['"]\.\/browserMock/)) {
      const lines = fs.readFileSync(path.join(SRC, f), 'utf-8').split('\n');
      const at = lines.findIndex((l) => /import\(['"]\.\/browserMock/.test(l));
      expect(lines.slice(Math.max(0, at - 6), at).join('\n')).toContain('import.meta.env.DEV');
    }
  });
});
