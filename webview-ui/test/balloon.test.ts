/**
 * The hover balloon's rules: what a hovered character asks, in the rail's own words, and which
 * agents get no balloon. Tickets come from the real attentionTickets, never hand-built.
 */

import { describe, expect, it } from 'vitest';

import { type AttentionAgent, attentionTickets } from '../src/components/attention.js';
import { type BalloonFacts, balloonOf } from '../src/office/balloon.js';

const M = 60_000;
const NOW = Date.parse('2026-11-03T15:20:00Z');

const pushRow = { toolId: 't1', status: 'Running: git push', done: false, permissionWait: true };

function ticketOf(agent: AttentionAgent) {
  const { needs, stuck, yours } = attentionTickets([agent], NOW);
  return [...needs, ...stuck, ...yours][0] ?? null;
}

function facts(over: Partial<BalloonFacts> = {}): BalloonFacts {
  return { monitor: true, ticket: null, bubble: null, since: null, title: null, ...over };
}

describe('balloonOf', () => {
  it('a permission prompt reads the rail reason, masked', () => {
    const ticket = ticketOf({ id: 1, tools: [pushRow], permissionSince: NOW - 2 * M });
    expect(balloonOf(facts({ ticket }), NOW)).toEqual({
      kind: 'permission',
      title: null,
      detail: 'Allow git push?',
      detailPv: true,
    });
  });

  it.each([
    ['with its text', 'Monday or Sunday?', 'Monday or Sunday?'],
    ['without text', undefined, 'Has a question'],
  ])('a question %s is masked', (_case, question, detail) => {
    const ticket = ticketOf({
      id: 1,
      status: 'waiting',
      awaitingInput: true,
      awaitingReason: 'question',
      question,
    });
    expect(balloonOf(facts({ ticket }), NOW)).toMatchObject({
      kind: 'question',
      detail,
      detailPv: true,
    });
  });

  it('an ask bubble with no ticket still says it has a question', () => {
    expect(balloonOf(facts({ bubble: 'ask' }), NOW)).toMatchObject({
      kind: 'question',
      detail: 'Has a question',
    });
  });

  it.each<['done' | 'seen']>([['done'], ['seen']])(
    'a %s bubble says how long ago it finished, unmasked',
    (bubble) => {
      expect(balloonOf(facts({ bubble, since: NOW - 4 * M }), NOW)).toEqual({
        kind: 'finished',
        title: null,
        detail: 'Finished 4m ago',
        detailPv: false,
      });
    },
  );

  it('a finish with no known start says only Finished', () => {
    expect(balloonOf(facts({ bubble: 'done' }), NOW)?.detail).toBe('Finished');
  });

  it('a start ahead of our clock never reads negative', () => {
    expect(balloonOf(facts({ bubble: 'done', since: NOW + M }), NOW)?.detail).toBe(
      'Finished 0m ago',
    );
  });

  it('a stuck agent keeps its full card', () => {
    const ticket = ticketOf({
      id: 1,
      health: { state: 'stuck', reason: 'tests_failing_no_edits', count: 4 },
    });
    expect(ticket?.kind).toBe('stuck');
    expect(balloonOf(facts({ ticket }), NOW)).toBeNull();
  });

  it('passes the title through, and has none when there is none', () => {
    expect(balloonOf(facts({ bubble: 'ask', title: 'Ship the fix' }), NOW)?.title).toBe(
      'Ship the fix',
    );
    expect(balloonOf(facts({ bubble: 'ask', title: null }), NOW)?.title).toBeNull();
  });

  // Contract: ToolOverlay also skips the ticket lookup outside the monitor, so the VS Code panel
  // never reaches this rule.
  it('outside the monitor there is no balloon', () => {
    expect(
      balloonOf(facts({ monitor: false, bubble: 'done', since: NOW - 4 * M }), NOW),
    ).toBeNull();
  });
});
