/**
 * The monitor's stores on OfficeState, fed wire-shaped host messages through the same delegate
 * the message hook calls: keyed by agent id (a message can precede its character), cleared by
 * removeAgent, and versioned so the monitor panels re-render once per change.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import { applyMonitorMessage } from '../src/hooks/monitorMessages.js';
import { type MonitorSnapshot, nextRenderVersion } from '../src/hooks/monitorVersion.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

const T = 1_760_000_000_000;

/** One message per monitor store, all for agent `id`. */
function everyStore(id: number): Array<{ type: string; [key: string]: unknown }> {
  return [
    { type: 'agentSession', id, branch: 'fix/retry', startedAt: T, costUsd: 0 },
    { type: 'agentArtifacts', id, count: 2, complete: false, items: [{ title: 'Plan', at: T }] },
    { type: 'agentLoop', id, nextAt: T + 60_000, wakes: 3 },
    { type: 'agentTests', id, passed: 40, failed: 2, at: T },
    { type: 'workflowRun', id, runId: 'r1', status: 'running', name: 'review-pr', started: 4 },
    {
      type: 'agentStatus',
      id,
      status: 'waiting',
      awaitingInput: true,
      awaitingReason: 'question',
      question: 'Which database?',
      since: T - 1,
    },
    { type: 'agentToolPermission', id, permissionSince: T - 2 },
    {
      type: 'agentHealth',
      id,
      state: 'stuck',
      reason: 'tests_failing_no_edits',
      count: 4,
      since: T - 3,
    },
    {
      type: 'agentTripwire',
      id,
      ruleId: 'r',
      ruleName: 'R',
      severity: 'high',
      count: 1,
      since: T - 4,
    },
  ];
}

/** What the stores hold for `id`, in one comparable shape. */
function storedFor(os: OfficeState, id: number) {
  return {
    session: os.sessionMeta.get(id),
    artifacts: os.artifacts.get(id),
    loop: os.loops.get(id),
    tests: os.tests.get(id),
    runs: os.workflowRuns.get(id) && Object.fromEntries(os.workflowRuns.get(id)!),
    status: os.statusSince.get(id),
    reason: os.awaitingReasons.get(id),
    question: os.questions.get(id),
    permission: os.permissionSince.get(id),
    health: os.healthSince.get(id),
    tripwire: os.tripwireSince.get(id),
  };
}

const EVERY_STORE_HELD = {
  session: { branch: 'fix/retry', startedAt: T, costUsd: 0 },
  artifacts: { count: 2, complete: false, items: [{ title: 'Plan', at: T }] },
  loop: { nextAt: T + 60_000, wakes: 3 },
  tests: { passed: 40, failed: 2, at: T },
  runs: { r1: { status: 'running', name: 'review-pr', started: 4 } },
  status: T - 1,
  reason: 'question',
  question: 'Which database?',
  permission: T - 2,
  health: T - 3,
  tripwire: T - 4,
};

const NOTHING_HELD = {
  session: undefined,
  artifacts: undefined,
  loop: undefined,
  tests: undefined,
  runs: undefined,
  status: undefined,
  reason: undefined,
  question: undefined,
  permission: undefined,
  health: undefined,
  tripwire: undefined,
};

describe('monitor stores', () => {
  it('C0.4 keep what arrives before the character, each in its own store, and still hold it once the character is added', () => {
    const os = new OfficeState(floorLayout());
    for (const msg of everyStore(7)) applyMonitorMessage(os, msg);
    expect(os.characters.has(7)).toBe(false);
    expect(storedFor(os, 7)).toEqual(EVERY_STORE_HELD);

    os.addAgent(7);
    expect(storedFor(os, 7)).toEqual(EVERY_STORE_HELD);
  });

  it('C0.3 removeAgent clears every monitor store for that agent and leaves the others', () => {
    const os = new OfficeState(floorLayout());
    os.addAgent(7);
    os.addAgent(8);
    for (const msg of [...everyStore(7), ...everyStore(8)]) applyMonitorMessage(os, msg);

    os.removeAgent(7);
    expect(storedFor(os, 7)).toEqual(NOTHING_HELD);
    expect(storedFor(os, 8)).toEqual(EVERY_STORE_HELD);
  });

  it('the clear forms and the answered prompt empty their store', () => {
    const os = new OfficeState(floorLayout());
    for (const msg of everyStore(7)) applyMonitorMessage(os, msg);
    for (const msg of [
      { type: 'agentSession', id: 7 },
      { type: 'agentArtifacts', id: 7 },
      { type: 'agentLoop', id: 7 },
      { type: 'agentTests', id: 7 },
      { type: 'workflowRun', id: 7, runId: 'r1' },
      // A status the server cannot date clears the old start rather than keeping it.
      { type: 'agentStatus', id: 7, status: 'idle' },
      // A live start without permissionActive is the prompt answered.
      { type: 'agentToolStart', id: 7, toolId: 't', status: 'Reading a.ts' },
      { type: 'agentHealthClear', id: 7 },
      { type: 'agentTripwireClear', id: 7 },
    ]) {
      applyMonitorMessage(os, msg);
    }
    expect(storedFor(os, 7)).toEqual(NOTHING_HELD);
  });

  it('a status keeps the wait reason and question only while it is a wait for the user', () => {
    const os = new OfficeState(floorLayout());
    const status = (extra: Record<string, unknown>) =>
      applyMonitorMessage(os, { type: 'agentStatus', id: 7, ...extra });
    status({ status: 'waiting', awaitingInput: true, awaitingReason: 'idle' });
    expect([os.awaitingReasons.get(7), os.questions.get(7)]).toEqual(['idle', undefined]);
    // An older server sends no reason: that wait is a question.
    status({ status: 'waiting', awaitingInput: true });
    expect(os.awaitingReasons.get(7)).toBe('question');
    status({
      status: 'waiting',
      awaitingInput: true,
      awaitingReason: 'question',
      question: 'Ship?',
    });
    expect(os.questions.get(7)).toBe('Ship?');
    // A finished turn, or work resuming, drops both.
    status({ status: 'waiting', awaitingInput: false });
    expect([os.awaitingReasons.get(7), os.questions.get(7)]).toEqual([undefined, undefined]);
    status({
      status: 'waiting',
      awaitingInput: true,
      awaitingReason: 'question',
      question: 'Ship?',
    });
    status({ status: 'active' });
    expect([os.awaitingReasons.get(7), os.questions.get(7)]).toEqual([undefined, undefined]);
  });

  it('B8 a monitor message replaces its store entry: a field it leaves out is gone, not kept', () => {
    // The server sends a fire as `{wakes}` with no `nextAt`: the wake that was pending has
    // happened, and a store that merged would go on counting down to it.
    const os = new OfficeState(floorLayout());
    const store = (msg: { type: string; [key: string]: unknown }) => {
      applyMonitorMessage(os, msg);
      return {
        agentLoop: os.loops,
        agentArtifacts: os.artifacts,
        agentTests: os.tests,
        agentSession: os.sessionMeta,
      }[msg.type]?.get(7);
    };
    for (const [first, second] of [
      [
        { type: 'agentLoop', id: 7, nextAt: T + 60_000 },
        { type: 'agentLoop', id: 7, wakes: 1 },
      ],
      [
        { type: 'agentArtifacts', id: 7, count: 2, complete: true, items: [{ url: 'a' }] },
        { type: 'agentArtifacts', id: 7, count: 1, complete: false },
      ],
      [
        { type: 'agentTests', id: 7, passed: 3, failed: 1, at: T },
        { type: 'agentTests', id: 7, passed: 4 },
      ],
      [
        { type: 'agentSession', id: 7, branch: 'main', costUsd: 1, costAt: T },
        { type: 'agentSession', id: 7, branch: 'dev' },
      ],
    ] as const) {
      store(first);
      const { type, id, ...expected } = second as Record<string, unknown>;
      expect([type, id]).toEqual([second.type, 7]);
      expect(store(second)).toEqual(expected);
    }
  });

  it('a restated start keeps the pending prompt with its start; a turn end drops it', () => {
    const os = new OfficeState(floorLayout());
    applyMonitorMessage(os, {
      type: 'agentToolStart',
      id: 7,
      toolId: 't',
      status: 'Running: git push',
      permissionActive: true,
      permissionSince: T,
    });
    expect(os.permissionSince.get(7)).toBe(T);
    applyMonitorMessage(os, { type: 'agentToolsClear', id: 7 });
    expect(os.permissionSince.has(7)).toBe(false);
  });

  it('a monitor field moves the version once per change, not on a repeat or a clear of nothing', () => {
    const os = new OfficeState(floorLayout());
    const bumps = (msg: { type: string; [key: string]: unknown }): number => {
      const before = os.monitorVersion;
      applyMonitorMessage(os, msg);
      return os.monitorVersion - before;
    };
    expect(bumps({ type: 'agentStatus', id: 7, status: 'active', since: T })).toBe(1);
    // The parser repeats `active` on every tool call, with the same start.
    expect(bumps({ type: 'agentStatus', id: 7, status: 'active', since: T })).toBe(0);
    expect(bumps({ type: 'agentLoop', id: 7, nextAt: T })).toBe(1);
    expect(bumps({ type: 'agentTripwireClear', id: 7 })).toBe(0);
  });

  it('a stalled count that grows moves the version though its start does not', () => {
    // The panels read the existing health store too: 10 -> 11 minutes must re-render them.
    const os = new OfficeState(floorLayout());
    os.addAgent(7);
    os.setHealth(7, { state: 'stalled', reason: 'no_progress', count: 10 });
    const before = os.monitorVersion;
    os.setHealth(7, { state: 'stalled', reason: 'no_progress', count: 11 });
    expect(os.monitorVersion).toBe(before + 1);
  });
});

describe('C0.5 nextRenderVersion: re-render only when the stores or the selection moved', () => {
  const prev: MonitorSnapshot = { version: 4, selectedAgentId: 2 };
  it.each([
    ['a quiet frame', { monitorVersion: 4, selectedAgentId: 2 }, false],
    ['a store write', { monitorVersion: 5, selectedAgentId: 2 }, true],
    ['a canvas click on another agent', { monitorVersion: 4, selectedAgentId: 3 }, true],
    ['a deselect', { monitorVersion: 4, selectedAgentId: null }, true],
    ['both at once', { monitorVersion: 6, selectedAgentId: 3 }, true],
  ] as const)('%s', (_name, office, renders) => {
    const next = nextRenderVersion(prev, office);
    // Same object = React bails out; a new one carries what the frame read.
    expect(next !== prev).toBe(renders);
    expect(next).toEqual({
      version: office.monitorVersion,
      selectedAgentId: office.selectedAgentId,
    });
  });
});
