/**
 * The monitor's plates (W2): what line 1 says by precedence, the medal, the reserved box against
 * the drawn one, the crew banner and the crew lines.
 *
 * Run with: npm run test:webview
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowRun } from '../../core/src/messages.js';
import { TAG_STATE_MAX_CHARS } from '../src/constants.js';
import { monitorMessages } from '../src/heroScene.js';
import { CrewBanner } from '../src/office/components/CrewBanner.js';
import { Medal } from '../src/office/components/Medal.js';
import { ToolOverlay } from '../src/office/components/ToolOverlay.js';
import { crewBannerSize, crewBannerView } from '../src/office/crewBanner.js';
import { crewLines } from '../src/office/crewLines.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { layoutLabels } from '../src/office/labelLayout.js';
import {
  plateBoxHeight,
  plateBoxWidth,
  plateFit,
  setMonitorFullPlates,
} from '../src/office/nameplate.js';
import {
  type PlateFacts,
  type PlateState,
  plateState,
  stateText,
  tagStateText,
} from '../src/office/plateState.js';
import { type NameplateContent, overlayContent } from '../src/office/toolUtils.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const MIN = 60_000;
const NOW = new Date(2026, 9, 15, 15, 20).getTime();

// Spec colors, spelled as channels (the lint rule keeps hex literals in constants.ts).
const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const CORAL = hex(0xec, 0x92, 0x77);
const RING_FILL = hex(0xf6, 0xe3, 0xbd);
const RING_TRACK = hex(0x5a, 0x3d, 0x27);

describe('C6.1 plate line 1: needs you > done > command > verb > asleep > idle', () => {
  const quiet: PlateFacts = {
    permission: false,
    question: false,
    stuck: false,
    done: false,
    finished: false,
    active: false,
    toolStatus: null,
    now: NOW,
  };
  const all: PlateFacts = {
    permission: true,
    permissionSince: NOW - 12 * MIN,
    question: true,
    statusSince: NOW - 4 * MIN,
    stuck: true,
    stuckSince: NOW - 9 * MIN,
    done: true,
    finished: true,
    active: true,
    toolStatus: 'Running: git commit',
    loopNextAt: NOW + 25 * MIN,
    now: NOW,
  };
  // Each row turns off the facts above it, so the next one wins: [name, facts, kind, words].
  const cases: Array<[string, PlateFacts, string, string | null]> = [
    ['a permission prompt beats everything', all, 'alert', null],
    ['then a question', { ...all, permission: false }, 'alert', null],
    ['then stuck', { ...all, permission: false, question: false }, 'alert', null],
    [
      'then a helper done',
      { ...all, permission: false, question: false, stuck: false },
      'done',
      'done',
    ],
    [
      'then the command it runs',
      { ...all, permission: false, question: false, stuck: false, done: false },
      'cmd',
      'git commit',
    ],
    [
      'then the verb of its tool',
      { ...quiet, active: true, toolStatus: 'Editing app.ts', loopNextAt: all.loopNextAt },
      'verb',
      'writing',
    ],
    ['active with no tool is thinking', { ...quiet, active: true }, 'verb', 'thinking'],
    [
      'then a loop asleep',
      { ...quiet, loopNextAt: all.loopNextAt },
      'asleep',
      'asleep until 15:45',
    ],
    ['a loop past its wake is idle', { ...quiet, loopNextAt: NOW - MIN }, 'idle', 'idle'],
    // The user's turn: after asleep (a sleeping loop is not waiting on you), before idle.
    [
      'a finished wait is done',
      { ...quiet, finished: true, statusSince: NOW - 3 * MIN },
      'finished',
      'done',
    ],
    [
      'a loop asleep outranks finished',
      { ...quiet, finished: true, loopNextAt: all.loopNextAt },
      'asleep',
      'asleep until 15:45',
    ],
    ['idle with its age', { ...quiet, statusSince: NOW - 68 * MIN }, 'idle', 'idle 1h08m'],
    // A status the server did not date (B7): idle, no age.
    ['idle with no since', quiet, 'idle', 'idle'],
  ];
  it.each(cases)('%s', (_name, facts, kind, words) => {
    const s = plateState(facts);
    expect(s.kind).toBe(kind);
    expect(stateText(s, NOW)).toBe(words);
  });

  it('a permission prompt over a finished wait still shows the alert', () => {
    expect(plateState({ ...quiet, finished: true, permission: true }).kind).toBe('alert');
    expect(plateState({ ...quiet, finished: true, question: true }).kind).toBe('alert');
    expect(plateState({ ...quiet, finished: true, stuck: true }).kind).toBe('alert');
  });

  it('the alert tab: gold `!` and `?` wait on you, rust `×` is stuck, each with its minutes', () => {
    expect(plateState(all)).toEqual({
      kind: 'alert',
      alert: { glyph: '!', tone: 'wait', since: NOW - 12 * MIN },
    });
    expect(plateState({ ...all, permission: false })).toEqual({
      kind: 'alert',
      alert: { glyph: '?', tone: 'wait', since: NOW - 4 * MIN },
    });
    expect(plateState({ ...quiet, stuck: true })).toEqual({
      kind: 'alert',
      alert: { glyph: '×', tone: 'stuck', since: null },
    });
  });
});

function medalHtml(tier: 1 | 2 | 3 | 4 | null, fraction: number | null): string {
  return renderToStaticMarkup(createElement(Medal, { spec: { tier, fraction }, px: 24 }));
}

describe('a monitor tag says its state whole or not at all', () => {
  const ago = (min: number) => NOW - min * MIN;
  it.each<[string, PlateState, string | null]>([
    ['asleep says when it wakes', { kind: 'asleep', until: NOW + 25 * MIN }, 'wake 15:45'],
    ['idle under an hour', { kind: 'idle', since: ago(12) }, 'idle 12m'],
    ['idle from an hour drops the m', { kind: 'idle', since: ago(68) }, 'idle 1h08'],
    ['idle with no start has no number', { kind: 'idle', since: null }, 'idle'],
    ['a short verb as it is', { kind: 'verb', verb: 'thinking' }, 'thinking'],
    ['a long verb is left out', { kind: 'verb', verb: 'compacting context' }, null],
    ['a short command as it is', { kind: 'cmd', cmd: 'git push' }, 'git push'],
    ['a long command gives its first word', { kind: 'cmd', cmd: 'npm run test:webview' }, 'npm'],
    ['a long first word is left out', { kind: 'cmd', cmd: 'kubectl-argo-rollouts get' }, null],
    ['done', { kind: 'done' }, 'done'],
    // The check is drawn as a pixel bitmap after the word: the text itself has no check mark.
    ['finished', { kind: 'finished' }, 'done'],
  ])('%s', (_name, state, words) => {
    expect(tagStateText(state, NOW)).toBe(words);
    expect([...(words ?? '')].length).toBeLessThanOrEqual(TAG_STATE_MAX_CHARS);
  });

  describe('plateFit', () => {
    const saved = globalThis.window;
    beforeEach(() => {
      (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
    });
    afterEach(() => {
      setMonitorFullPlates(false);
      (globalThis as { window?: unknown }).window = saved;
    });
    const plate: NameplateContent = {
      name: 'Dennis',
      namePv: false,
      medal: null,
      state: { kind: 'asleep', until: NOW + 25 * MIN },
      loop: false,
      sub: null,
      helper: false,
      rarity: null,
      pill: null,
    };

    it('beside the rail a state that does not fit is gone, where a panel plate cuts it', () => {
      // A few px short of the whole state: room for a stub of it, not for the words.
      setMonitorFullPlates(false);
      const width = plateBoxWidth(plate, false, NOW) - 6;
      expect(plateFit(plate, false, NOW, width).state).toBe('cut');
      setMonitorFullPlates(true);
      const tagWidth = plateBoxWidth(plate, false, NOW) - 6;
      expect(plateFit(plate, false, NOW, tagWidth).state).toBe('none');
      expect(plateFit(plate, false, NOW, tagWidth + 6).state).toBe('full');
    });
  });
});

describe('C6.2 the medal', () => {
  it('91% context turns the ring coral', () => {
    const html = medalHtml(3, 0.91);
    expect(html).toContain(CORAL);
    expect(html).not.toContain(RING_FILL);
    expect(html).toContain('91% context');
  });

  it('18% fills a little of the ring and leaves the rest as track', () => {
    const html = medalHtml(2, 0.18);
    expect(html).toContain(RING_FILL);
    expect(html).toContain(RING_TRACK);
    expect(html).not.toContain(CORAL);
    expect(html).toContain('18% context');
  });

  it('no context draws the track alone and says no percent', () => {
    const html = medalHtml(4, null);
    expect(html).toContain(RING_TRACK);
    expect(html).not.toContain(RING_FILL);
    expect(html).not.toContain('%');
    expect(html).not.toContain('data-context-pct');
  });

  it('on a plate, an agent with a model and no context yet shows its tier and no percent', () => {
    const saved = globalThis.window;
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
    try {
      const os = office();
      os.addAgent(1, 0, 0, undefined, true);
      os.setSessionTitle(1, 'Fix login');
      os.setAgentModel(1, 'some-model', 3);
      const html = overlayHtml(os, [1], 8);
      const plate = html.slice(html.indexOf('class="nameplate '));
      expect(plate).toContain('data-testid="plate-medal"');
      expect(plate).not.toContain('%');
      expect(plate).not.toContain('data-context-pct');
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
  });

  it('is square pixels: crisp edges on a 12 px grid', () => {
    const html = medalHtml(1, 0.5);
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain('viewBox="0 0 12 12"');
  });
});

function office(cols = 12, rows = 9): OfficeState {
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
  return new OfficeState(layout);
}

function overlayHtml(os: OfficeState, agents: number[], zoom: number): string {
  const container = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 900 }),
  } as unknown as HTMLDivElement;
  return renderToStaticMarkup(
    createElement(ToolOverlay, {
      officeState: os,
      agents,
      agentTools: {},
      subagentTools: {},
      subagentCharacters: [],
      containerRef: { current: container },
      zoom,
      panRef: { current: { x: 0, y: 0 } },
      onCloseAgent: () => {},
      onAckTripwire: () => {},
      onOpenInspector: () => {},
    }),
  );
}

describe('C6.3 the box the collision pass reserves is the box the plate draws', () => {
  const saved = globalThis.window;
  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved;
  });

  /** The plate's height as its markup declares it: line heights, padding, border, shadow. */
  function drawnPlateHeight(html: string): number {
    const plate = html.slice(html.indexOf('class="nameplate '));
    const pad = Number(/padding:(\d+)px 0/.exec(plate)?.[1]);
    const lines = [...plate.matchAll(/style="[^"]*?height:(\d+)px/g)]
      .map((m) => Number(m[1]))
      // Line 1, then line 2 when present; the alert tab and the medal sit inside line 1.
      .filter((_, i, all) => i === 0 || i === all.length - 1);
    const line2 = html.includes('data-testid="plate-line2"') ? lines[lines.length - 1] : 0;
    // `.nameplate`: 3 px border each side and a 3 px hard shadow (index.css).
    return lines[0] + line2 + 2 * pad + 2 * 3 + 3;
  }

  it('a full plate with line 2 reserves both lines', () => {
    const os = office();
    os.addAgent(1, 0, 0, undefined, true);
    os.setRoster(1, {
      memberId: 'ada',
      name: 'Ada',
      level: 7,
      xp: 1,
      xpToNext: 10,
      streak: 0,
      mood: 'happy',
    });
    os.setSessionMeta(1, { branch: 'fix/retry-backoff', startedAt: NOW - 154 * MIN });
    const html = overlayHtml(os, [1], 8);
    // The branch is session text: privacy mode masks it.
    expect(html).toMatch(/class="[^"]*\bpv\b[^"]*">fix\/retry-backoff</);
    const content = overlayContent({
      expanded: false,
      label: null,
      subCount: 0,
      name: 'Ada',
      maxWidth: 300,
      branch: 'fix/retry-backoff',
      ageMs: 154 * MIN,
    });
    const plate = content.mode === 'compact' ? content.plate! : null;
    expect(plateBoxHeight(plate!, false)).toBe(drawnPlateHeight(html));
    // Line 2 adds height: a plate without it reserves less.
    expect(plateBoxHeight({ ...plate!, sub: null }, false)).toBeLessThan(plateBoxHeight(plate!));
  });

  it('two plates one above the other keep apart at their full height', () => {
    const plate = {
      name: 'Ada',
      namePv: false,
      medal: null,
      state: null,
      loop: false,
      sub: [{ text: 'main', pv: true }],
      helper: false,
      rarity: null,
      pill: null,
    };
    const h = plateBoxHeight(plate, false);
    // The lower plate's top sits inside the upper one's second line.
    const upper = { id: 1, col: 4, row: 2, x: 200, y: 100, w: 150, h, grow: 'down' as const };
    const lower = {
      id: 2,
      col: 4,
      row: 3,
      x: 200,
      y: 100 + h - 10,
      w: 150,
      h,
      grow: 'down' as const,
    };
    const placed = layoutLabels([upper, lower], [], 30);
    const top = lower.y + (placed.get(2)?.dy ?? 0);
    expect(placed.get(2)?.dim).toBe(false);
    expect(top).toBeGreaterThanOrEqual(upper.y + h);
  });
});

/** The scene's workflow run, as `?scene=monitor` sends it. */
function sceneRun(): WorkflowRun {
  const msg = monitorMessages(NOW).find((m) => m.type === 'workflowRun');
  if (!msg || msg.type !== 'workflowRun') throw new Error('the monitor scene sends no run');
  return msg;
}

function bannerHtml(run: Partial<WorkflowRun>): string {
  const view = crewBannerView(run, 'Linus', NOW);
  const { w, h } = crewBannerSize(view);
  return renderToStaticMarkup(
    createElement(CrewBanner, { view, rect: { x: 0, y: 0, w, h }, scale: 1, leadId: 4 }),
  );
}

describe('C6.4 the crew banner', () => {
  it("names the scene's run, its two phases and its counts", () => {
    const html = bannerHtml(sceneRun());
    expect(html).toContain('data-testid="crew-banner"');
    expect(html).toContain('review-pr');
    expect(html).toContain('Linus');
    expect(html.match(/data-testid="crew-phase"/g)).toHaveLength(2);
    expect(html).toContain('4 started · 1 done · 21m');
    // A pip per started agent (1 + 3), filled once done (1).
    expect(html.match(/data-testid="crew-pip"/g)).toHaveLength(4);
    expect(html.match(/data-done="true"/g)).toHaveLength(1);
  });

  it('a run the server lost the name of (a restart) says Workflow, and no age without since', () => {
    const run: Partial<WorkflowRun> = { ...sceneRun() };
    delete run.name;
    delete run.since;
    const html = bannerHtml(run);
    expect(html).toContain('>Workflow<');
    expect(html).toContain('4 started · 1 done<');
  });

  it('hangs over a running run with drawn helpers, and goes when the run is done', () => {
    const saved = globalThis.window;
    (globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };
    try {
      const os = office();
      os.addAgent(4, 0, 0, undefined, true);
      const parentToolId = 'wf:monitor-run:a2';
      const helper = os.addSubagent(4, parentToolId, true);
      const render = () => {
        const container = {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 900 }),
        } as unknown as HTMLDivElement;
        return renderToStaticMarkup(
          createElement(ToolOverlay, {
            officeState: os,
            agents: [4],
            agentTools: {},
            subagentTools: {},
            subagentCharacters: [{ id: helper, parentAgentId: 4, parentToolId, label: '' }],
            containerRef: { current: container },
            zoom: 8,
            panRef: { current: { x: 0, y: 0 } },
            onCloseAgent: () => {},
            onAckTripwire: () => {},
            onOpenInspector: () => {},
          }),
        );
      };
      const scene = sceneRun();
      const run = { status: scene.status, phases: scene.phases, started: 4, done: 1 };
      const runId = scene.runId;
      os.setWorkflowRun(4, runId, run);
      expect(render()).toContain('data-testid="crew-banner"');
      os.setWorkflowRun(4, runId, { ...run, status: 'done' });
      expect(render()).not.toContain('data-testid="crew-banner"');
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
  });
});

describe('crew lines', () => {
  it('run solid to a crew helper and dashed to a sub-agent, through the aisle around a wall', () => {
    // A wall across column 5 with one gap at row 7: the only way between the halves.
    const cols = 11;
    const rows = 9;
    const tiles = new Array<TileType>(cols * rows).fill(TileType.FLOOR_1);
    for (let r = 0; r < rows; r++) if (r !== 7) tiles[r * cols + 5] = TileType.WALL;
    const os = new OfficeState({ version: 1, cols, rows, tiles, furniture: [] } as OfficeLayout);
    os.addAgent(1, 0, 0, undefined, true);
    const crew = os.addSubagent(1, 'wf:run-1:a1', true);
    const sub = os.addSubagent(1, 'toolu_spawn', true);
    const place = (id: number, col: number, row: number) => {
      const ch = os.characters.get(id)!;
      ch.tileCol = col;
      ch.tileRow = row;
    };
    place(1, 2, 2);
    place(crew, 8, 2);
    place(sub, 3, 4);

    const lines = crewLines(os);
    expect(lines.map((l) => [l.helperId, l.kind]).sort()).toEqual(
      [
        [crew, 'crew'],
        [sub, 'sub'],
      ].sort(),
    );
    // Across the wall the line takes the gap: some corner sits on row 7 in column 5.
    const across = lines.find((l) => l.helperId === crew)!;
    const tilesOf = across.points.map((p) => [Math.floor(p.x / 16), Math.floor(p.y / 16)]);
    expect(tilesOf[0]).toEqual([2, 2]);
    expect(tilesOf[tilesOf.length - 1]).toEqual([8, 2]);
    for (let i = 1; i < tilesOf.length; i++) {
      const [c0, r0] = tilesOf[i - 1];
      const [c1, r1] = tilesOf[i];
      // Every segment is straight and never crosses a wall tile.
      expect(c0 === c1 || r0 === r1).toBe(true);
      for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++)
        for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
          expect(tiles[r * cols + c]).not.toBe(TileType.WALL);
    }
  });
});
