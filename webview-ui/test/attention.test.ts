/**
 * The attention rail's rules, on plain inputs: which agent gets a ticket and of what kind, what
 * its reason may say, the order the tickets and the arrow keys walk, and how the minutes read.
 */

import { describe, expect, it } from 'vitest';

import {
  type AttentionAgent,
  attentionTickets,
  cycleOrder,
  healthReason,
  minutesBlock,
  modelLabel,
  stepSession,
} from '../src/components/attention.js';

const M = 60_000;
const NOW = Date.parse('2026-10-12T15:20:00Z');

const pushRow = { toolId: 't1', status: 'Running: git push', done: false, permissionWait: true };

function tickets(agents: AttentionAgent[]) {
  const { needs, stuck, yours } = attentionTickets(agents, NOW);
  const rows = (list: typeof needs) => list.map((t) => [t.id, t.kind, t.glyph, t.reason, t.since]);
  return { needs: rows(needs), stuck: rows(stuck), yours: rows(yours) };
}

describe('attentionTickets', () => {
  it('puts a prompt and a question under Needs you, a tripwire and a spinning agent under Stuck', () => {
    expect(
      tickets([
        { id: 1, tools: [pushRow], permissionSince: NOW - 12 * M },
        { id: 2, status: 'waiting', awaitingInput: true, statusSince: NOW - 4 * M },
        {
          id: 3,
          health: { state: 'stuck', reason: 'tests_failing_no_edits', count: 4 },
          healthSince: NOW - 9 * M,
        },
        { id: 4, tripwire: { ruleName: 'Force push', count: 2 }, tripwireSince: NOW - 3 * M },
      ]),
    ).toEqual({
      needs: [
        [1, 'permission', '!', 'Allow git push?', NOW - 12 * M],
        [2, 'question', '?', 'Has a question', NOW - 4 * M],
      ],
      stuck: [
        [3, 'stuck', '×', 'tests failing ×4 · no edits', NOW - 9 * M],
        [4, 'stuck', '×', 'Force push', NOW - 3 * M],
      ],
      yours: [],
    });
  });

  // The ticket follows the open row: a prompt answered (its tool ran) or a finished turn is no ticket.
  it.each<[string, AttentionAgent]>([
    ['a prompt whose tool already ran', { id: 1, tools: [{ ...pushRow, done: true }] }],
    ['an open tool with no prompt', { id: 1, tools: [{ ...pushRow, permissionWait: false }] }],
    ['a finished turn (waiting, no question)', { id: 1, status: 'waiting', awaitingInput: false }],
    ['a question flag left from an earlier wait', { id: 1, status: 'idle', awaitingInput: true }],
    ['a dead process', { id: 1, health: { state: 'dead', reason: 'process_gone', count: 0 } }],
  ])('gives no ticket for %s', (_case, agent) => {
    expect(tickets([agent])).toEqual({ needs: [], stuck: [], yours: [] });
  });

  it('gives an agent one ticket, in its most urgent kind', () => {
    const health = { state: 'looping' as const, reason: 'same_call_repeated' as const, count: 6 };
    const tripwire = { ruleName: 'Secrets read', count: 1 };
    expect(
      tickets([
        { id: 1, tools: [pushRow], status: 'waiting', awaitingInput: true, tripwire, health },
        { id: 2, status: 'waiting', awaitingInput: true, tripwire },
        { id: 3, tripwire, health },
      ]),
    ).toEqual({
      needs: [
        [1, 'permission', '!', 'Allow git push?', undefined],
        [2, 'question', '?', 'Has a question', undefined],
      ],
      stuck: [[3, 'stuck', '×', 'Secrets read', undefined]],
      yours: [],
    });
  });

  // Only the program the server already reduced a shell command to may show; any other tool is
  // named, never described (a status carries file names).
  it.each([
    ['Running: npm test', 'Bash', 'Allow npm test?'],
    ['Running: ', 'Bash', 'Allow Bash?'],
    ['Reading secrets.env', 'Read', 'Allow Read?'],
    ['Using Workflow', 'Workflow', 'Allow Workflow?'],
    ['Subtask: deploy the thing', null, 'Allow this tool?'],
  ])('a prompt on "%s" (tool %s) reads %s', (status, currentTool, reason) => {
    const [ticket] = attentionTickets(
      [{ id: 1, currentTool, tools: [{ ...pushRow, status }] }],
      NOW,
    ).needs;
    expect(ticket.reason).toBe(reason);
  });

  // K1 / K6: a finished session that sat idle is told apart from one that asked something, and
  // lands in Your turn, not Needs you.
  it('reads a question with its own words, an idle wait as finished in Your turn, and falls back without text', () => {
    expect(
      tickets([
        {
          id: 1,
          status: 'waiting',
          awaitingInput: true,
          awaitingReason: 'question',
          question: 'Which database?',
          statusSince: NOW - 2 * M,
        },
        { id: 2, status: 'waiting', awaitingInput: true, awaitingReason: 'question' },
        {
          id: 3,
          status: 'waiting',
          awaitingInput: true,
          awaitingReason: 'idle',
          question: 'stale text',
          statusSince: NOW - 3 * M,
        },
      ]),
    ).toMatchObject({
      needs: [
        [1, 'question', '?', 'Which database?', NOW - 2 * M],
        [2, 'question', '?', 'Has a question', undefined],
      ],
      yours: [[3, 'idle', '–', 'Finished', NOW - 3 * M]],
    });
  });

  // K1b: idle waits never mix into Needs you; each list is oldest first.
  it('keeps idle waits out of Needs you, and lists each list oldest first', () => {
    const { needs, yours } = attentionTickets(
      [
        {
          id: 1,
          status: 'waiting',
          awaitingInput: true,
          awaitingReason: 'idle',
          statusSince: NOW - 60 * M,
        },
        {
          id: 2,
          status: 'waiting',
          awaitingInput: true,
          awaitingReason: 'question',
          statusSince: NOW - M,
        },
        { id: 3, tools: [pushRow], permissionSince: NOW - 2 * M },
        {
          id: 4,
          status: 'waiting',
          awaitingInput: true,
          awaitingReason: 'idle',
          statusSince: NOW - 90 * M,
        },
      ],
      NOW,
    );
    expect(needs.map((t) => t.id)).toEqual([3, 2]);
    expect(yours.map((t) => t.id)).toEqual([4, 1]);
  });

  // A loop asleep until a future wake is not waiting on you.
  it('gives a sleeping loop no Your turn ticket, and one past its wake a ticket', () => {
    const idle = { status: 'waiting', awaitingInput: true, awaitingReason: 'idle' } as const;
    expect(tickets([{ id: 1, ...idle, loopNextAt: NOW + 25 * M }]).yours).toEqual([]);
    expect(tickets([{ id: 1, ...idle, loopNextAt: NOW - M }]).yours).toHaveLength(1);
    expect(tickets([{ id: 1, ...idle }]).yours).toHaveLength(1);
  });

  it('lists the longest wait first, and tickets with no known start after the dated ones', () => {
    const order = attentionTickets(
      [
        { id: 5, status: 'waiting', awaitingInput: true },
        { id: 4, status: 'waiting', awaitingInput: true, statusSince: NOW - 2 * M },
        { id: 3, tools: [pushRow], permissionSince: NOW - 20 * M },
        { id: 2, status: 'waiting', awaitingInput: true },
      ],
      NOW,
    ).needs.map((t) => t.id);
    expect(order).toEqual([3, 4, 2, 5]);
  });
});

describe('healthReason', () => {
  it.each([
    ['tests_failing_no_edits', 'stuck', 4, 'tests failing ×4 · no edits'],
    ['same_call_repeated', 'looping', 6, 'same call ×6'],
    ['no_progress', 'stalled', 12, 'no progress 12m'],
    ['no_progress', 'stalled', 68, 'no progress 1h08m'],
  ] as const)('%s (%s, count %s) reads %s', (reason, state, count, text) => {
    expect(healthReason({ state, reason, count })).toBe(text);
  });
});

describe('minutesBlock', () => {
  it.each([
    [undefined, '–', null],
    [NOW, '0', 'MIN'],
    [NOW + 5 * M, '0', 'MIN'],
    [NOW - 12 * M - 59_000, '12', 'MIN'],
    [NOW - 99 * M, '99', 'MIN'],
    [NOW - 100 * M, '1h40', null],
    [NOW - (23 * 60 + 59) * M, '23h59', null],
    [NOW - 26 * 60 * M, '1d2h', null],
  ])('since %s -> %s %s', (since, value, unit) => {
    expect(minutesBlock(since, NOW)).toEqual({ value, unit });
  });
});

describe('the arrow keys', () => {
  const attention = attentionTickets(
    [
      { id: 7, status: 'waiting', awaitingInput: true, statusSince: NOW - M },
      { id: 3, tools: [pushRow], permissionSince: NOW - 9 * M },
      { id: 9, tripwire: { ruleName: 'x', count: 1 }, tripwireSince: NOW - 30 * M },
      {
        id: 5,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'idle',
        statusSince: NOW - 50 * M,
      },
    ],
    NOW,
  );

  it('walk the rail top to bottom (Needs you, Stuck, Your turn), then everyone else by id', () => {
    expect(cycleOrder(attention, [1, 9, 3, 12, 7, 2, 5])).toEqual([3, 7, 9, 5, 1, 2, 12]);
  });

  it.each([
    [null, 1, 3],
    [null, -1, 12],
    [3, 1, 7],
    [12, 1, 3],
    [3, -1, 12],
    [42, 1, 3],
  ] as const)('from %s, step %s lands on %s', (current, step, next) => {
    expect(stepSession([3, 7, 9, 1, 2, 12], current, step)).toBe(next);
  });

  it('select nothing in an empty office', () => {
    expect(stepSession([], null, 1)).toBeNull();
  });
});

describe('modelLabel', () => {
  it.each([
    ['claude-opus-5-5', 3, 'Opus 5.5'],
    ['claude-sonnet-4-5-20250929', 2, 'Sonnet 4.5'],
    ['claude-haiku-4', 1, 'Haiku 4'],
    ['monitor-tier-4', 4, 'Fable'],
    [undefined, 2, 'Sonnet'],
    ['some-model', undefined, null],
    [undefined, undefined, null],
  ])('%s (tier %s) reads %s', (model, tier, label) => {
    expect(modelLabel(model, tier)).toBe(label);
  });
});
