/**
 * The inspector's view-model: what each section says for what the server sent, and that absent
 * is never shown as 0 (D3). Pure; the sheet only lays these rows out.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import {
  type AgentStateInput,
  type HelperInput,
  type InspectorInput,
  inspectorView,
  stateChip,
} from '../src/components/inspector/inspectorView.js';

/** 15:20 local, on a fixed day, so clock text is stable. */
const NOW = new Date(2026, 9, 12, 15, 20, 0).getTime();
const MIN = 60_000;

function input(over: Partial<InspectorInput> = {}): InspectorInput {
  return {
    id: 1,
    name: { text: 'Ada' },
    isActive: false,
    bubbleType: null,
    tools: [],
    contextTokens: 0,
    maxContextTokens: 0,
    helpers: [],
    mates: [],
    now: NOW,
    ...over,
  };
}

const chipText = (a: Partial<AgentStateInput>): string =>
  stateChip({ isActive: false, bubbleType: null, tools: [], ...a }, NOW)
    .parts.map((p) => p.text)
    .join('');

describe('state chip precedence: needs you, then health, command, verb, asleep, idle', () => {
  const running = [{ toolId: 't', status: 'Running: git push', done: false }];
  const cases: Array<[string, Partial<AgentStateInput>, string, string]> = [
    [
      'a permission prompt beats a stuck mark',
      {
        bubbleType: 'permission',
        tools: running,
        health: { state: 'stuck', reason: 'tests_failing_no_edits', count: 4 },
      },
      'allow git push?',
      'gold',
    ],
    [
      'a non-shell prompt names the tool',
      { tools: [{ toolId: 't', status: 'Reading a.ts', done: false, permissionWait: true }] },
      'allow Read?',
      'gold',
    ],
    ['a question', { bubbleType: 'waiting', waitingAwaitingInput: true }, 'has a question', 'gold'],
    [
      'a stuck mark beats the running command',
      { tools: running, health: { state: 'stuck', reason: 'tests_failing_no_edits', count: 4 } },
      '×4 stuck',
      'rust',
    ],
    ['a running command', { isActive: true, tools: running }, 'git push', 'paper'],
    [
      'a tool verb',
      { isActive: true, tools: [{ toolId: 't', status: 'Editing a.ts', done: false }] },
      'writing · Edit',
      'paper',
    ],
    ['active with no tool open', { isActive: true }, 'thinking', 'paper'],
    ['a loop asleep', { loop: { nextAt: NOW + 25 * MIN, wakes: 3 } }, 'asleep · 15:45', 'quiet'],
    ['idle since a known time', { statusSince: NOW - 68 * MIN }, 'idle 1h08m', 'quiet'],
    ['idle with no since: no age', {}, 'idle', 'quiet'],
  ];
  it.each(cases)('%s', (_name, a, text, tone) => {
    const chip = stateChip({ isActive: false, bubbleType: null, tools: [], ...a }, NOW);
    expect(chip.parts.map((p) => p.text).join('')).toBe(text);
    expect(chip.tone).toBe(tone);
  });

  it('the command in a chip is session text, the words around it are not', () => {
    const chip = stateChip({ isActive: true, bubbleType: 'permission', tools: running }, NOW);
    expect(chip.parts).toEqual([{ text: 'allow ' }, { text: 'git push', pv: true }, { text: '?' }]);
  });

  it('a done tool row is not the open one', () => {
    expect(chipText({ tools: [{ toolId: 't', status: 'Running: npm test', done: true }] })).toBe(
      'idle',
    );
  });
});

describe('vitals', () => {
  const kinds = (i: InspectorInput) => inspectorView(i).vitals.map((c) => c.kind);

  it('nothing known: no cells at all', () => {
    expect(kinds(input())).toEqual([]);
  });

  it('cost: a present 0 is $0.00, an absent cost has no cell (A10)', () => {
    const zero = inspectorView(input({ session: { costUsd: 0, costAt: NOW - 2 * MIN } }));
    expect(zero.vitals).toContainEqual({ kind: 'cost', text: '$0.00', caption: 'as of 15:18' });
    expect(kinds(input({ session: { branch: 'main' } }))).not.toContain('cost');
  });

  it('session reads as this transcript, not the session (A21)', () => {
    const v = inspectorView(input({ session: { startedAt: NOW - 154 * MIN } }));
    expect(v.vitals).toContainEqual({
      kind: 'session',
      parts: [
        { n: '2', unit: 'h' },
        { n: '34', unit: 'm' },
      ],
      caption: 'transcript since 12:46',
    });
  });

  it('context shows its share and tokens against the window', () => {
    const at = (tokens: number) =>
      inspectorView(input({ contextTokens: tokens, maxContextTokens: 200_000 })).vitals[0];
    expect(at(168_000)).toMatchObject({ pct: 84, caption: '168k of 200k' });
    expect(
      inspectorView(input({ contextTokens: 910_000, maxContextTokens: 1_000_000 })).vitals[0],
    ).toMatchObject({ caption: '910k of 1M' });
  });

  it('a cold cache gets the cold cell and the note; under 20k of context, no cache cell', () => {
    const cold = inspectorView(
      input({
        contextTokens: 54_000,
        maxContextTokens: 200_000,
        cache: { ttlSeconds: 3600, expiresAt: NOW - 8 * MIN },
      }),
    );
    expect(cold.vitals).toContainEqual({
      kind: 'cache',
      cold: true,
      parts: [],
      caption: 'since 15:12 · 1h TTL',
    });
    expect(cold.coldNote).toBe('Cold since 15:12: the next turn re-reads 54k.');
    const small = input({
      contextTokens: 9_000,
      maxContextTokens: 200_000,
      cache: { ttlSeconds: 300, expiresAt: NOW + MIN },
    });
    expect(kinds(small)).not.toContain('cache');
  });
});

describe('artifacts (B11)', () => {
  it('an incomplete scan shows N+, a publish count only when sent', () => {
    const v = inspectorView(
      input({
        artifacts: {
          count: 3,
          complete: false,
          items: [
            { title: 'Plan', url: 'https://claude.ai/a/123', publishes: 2, at: NOW - 6 * MIN },
            { title: 'Notes', url: 'https://claude.ai/a/456' },
            { title: 'Once', url: 'https://claude.ai/a/789', publishes: 1 },
          ],
        },
      }),
    ).artifacts;
    expect(v?.count).toBe('3+');
    expect(v?.rows[0]).toMatchObject({
      title: { text: 'Plan', pv: true },
      publishes: '×2 publishes',
      time: '15:14',
      href: 'https://claude.ai/a/123',
      urlText: { text: 'claude.ai/a/123', pv: true },
    });
    expect(v?.rows[1].publishes).toBeUndefined();
    expect(v?.rows[1].time).toBeUndefined();
    expect(v?.rows[2].publishes).toBe('1 publish');
  });

  it('only an http(s) url becomes a link; the text still shows', () => {
    const rows = inspectorView(
      input({
        artifacts: {
          count: 2,
          complete: true,
          items: [
            { title: 'x', url: 'javascript:alert(1)' },
            { title: 'y', url: 'not a url' },
          ],
        },
      }),
    ).artifacts?.rows;
    expect(rows?.map((r) => r.href)).toEqual([undefined, undefined]);
    expect(rows?.[0].urlText?.text).toBe('javascript:alert(1)');
  });
});

describe('workflow, loop, tests', () => {
  it('a run with no name or since after a restart: "Workflow", counts with no age (A18)', () => {
    const v = inspectorView(
      input({
        runs: new Map([
          [
            'r1',
            {
              status: 'running',
              phases: [
                { name: 'scan', started: 1, done: 1 },
                { name: 'review', started: 3, done: 0 },
              ],
              started: 4,
              done: 1,
            },
          ],
        ]),
      }),
    ).workflows[0];
    expect(v.name).toEqual({ text: 'Workflow' });
    expect(v.age).toBeUndefined();
    expect(v.counts).toBe('4 started · 1 done');
    expect(v.phases.map((p) => p.current)).toEqual([false, true]);
  });

  it('a named run masks its name and shows its age', () => {
    const v = inspectorView(
      input({
        runs: new Map([['r1', { status: 'running', name: 'review-pr', since: NOW - 21 * MIN }]]),
      }),
    ).workflows[0];
    expect(v.name).toEqual({ text: 'review-pr', pv: true });
    expect(v.age).toBe('since 14:59 · 21m');
  });

  it('a loop shows its wakes only once one fired (A8)', () => {
    expect(inspectorView(input({ loop: { nextAt: NOW + 25 * MIN } })).loop).toEqual({
      next: 'next 15:45 · in 25m',
      wakes: undefined,
    });
    expect(inspectorView(input({ loop: { wakes: 1 } })).loop).toEqual({
      next: 'awake',
      wakes: '1 wake',
    });
  });

  it('tests: a present 0 shows, an absent count does not', () => {
    expect(inspectorView(input({ tests: { passed: 41, failed: 0, at: NOW } })).tests).toEqual({
      passed: 41,
      failed: 0,
      at: '15:20',
    });
    expect(inspectorView(input({ tests: { at: NOW } })).tests).toBeUndefined();
  });
});

describe('depends on whom', () => {
  it('crew helpers group under their run, sub-agents apart, a teammate under its lead', () => {
    const v = inspectorView(
      input({
        runs: new Map([['run-1', { name: 'review-pr' }]]),
        helpers: [
          {
            id: -1,
            parentToolId: 'wf:run-1:a2',
            label: 'security pass',
            group: 'review',
            tools: [],
            bubbleType: null,
            done: false,
          },
          {
            id: -2,
            parentToolId: 'toolu_1',
            label: 'Map the call sites',
            tools: [{ toolId: 's', status: 'Reading events.ts', done: false }],
            bubbleType: null,
            done: false,
          },
        ],
        lead: { id: 9, name: { text: 'Linus' }, isActive: true, bubbleType: null, tools: [] },
      }),
    );
    expect(v.tree.map((g) => [g.kind, g.name?.text, g.rows.map((r) => r.name.text)])).toEqual([
      ['lead', undefined, ['Linus']],
      ['workflow', 'review-pr', ['security pass']],
      ['sub', undefined, ['Map the call sites']],
    ]);
    expect(v.tree[1].rows[0]).toMatchObject({ sub: 'review', name: { pv: true } });
    // Announced, no tool call yet: thinking (as its plate says), not idle.
    expect(v.tree[1].rows[0].chip.parts[0].text).toBe('thinking');
    expect(v.tree[2].rows[0].chip.parts[0].text).toBe('reading · Read');
  });

  it('Q4.3 a working helper shows its minutes from its start; with no known start or once done, none', () => {
    const helper = (id: number, over: Partial<HelperInput>): HelperInput => ({
      id,
      parentToolId: `toolu_${-id}`,
      label: `task ${-id}`,
      tools: [],
      bubbleType: null,
      done: false,
      ...over,
    });
    const rows = inspectorView(
      input({
        helpers: [
          helper(-1, { startedAt: NOW - 12 * MIN }),
          helper(-2, {}),
          helper(-3, { startedAt: NOW - 30 * MIN, done: true }),
        ],
      }),
    ).tree[0].rows;
    expect(rows.map((r) => [r.minutes, r.chip.tone, r.chip.parts[0].text])).toEqual([
      ['12m', 'paper', 'thinking'],
      [undefined, 'paper', 'thinking'],
      [undefined, 'sage', 'done'],
    ]);
  });

  it('a lone agent has no tree', () => {
    expect(inspectorView(input()).tree).toEqual([]);
  });
});

describe('inspectorView hero.question', () => {
  const QUESTION = 'Which database should the migration target?';
  const chip = (i: InspectorInput) =>
    inspectorView(i)
      .hero.chip.parts.map((p) => p.text)
      .join('');

  it('carries the pending question in full, masked, with the chip still saying so', () => {
    const v = inspectorView(
      input({ bubbleType: 'waiting', waitingAwaitingInput: true, question: QUESTION }),
    );
    expect(v.hero.question).toEqual({ text: QUESTION, pv: true });
    expect(
      chip(input({ bubbleType: 'waiting', waitingAwaitingInput: true, question: QUESTION })),
    ).toBe('has a question');
  });

  it('keeps the question after the bubble faded, and shows none for an idle wait', () => {
    const faded = input({ bubbleType: null, question: QUESTION });
    expect(inspectorView(faded).hero.question).toEqual({ text: QUESTION, pv: true });
    expect(chip(faded)).toBe('has a question');
    const idle = input({ bubbleType: 'waiting', waitingAwaitingInput: true });
    expect(inspectorView(idle).hero.question).toBeUndefined();
  });
});
