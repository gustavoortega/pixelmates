import { describe, expect, it } from 'vitest';

import { claudeProvider, turnSignal } from '../src/providers/hook/claude/claude.js';
import { type DerivedTurnState, deriveTurnState } from '../src/turnState.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const traits = claudeProvider.turnTraits!;

function derive(
  records: unknown[],
  clocks: { leadMtimeMs?: number; subagentMtimesMs?: number[] } = {},
): DerivedTurnState['kind'] {
  return deriveTurnState(
    records.map((r) => JSON.stringify(r)),
    NOW,
    { leadMtimeMs: NOW - 5_000, ...clocks },
    turnSignal,
    traits,
  ).kind;
}

const prompt = (text = 'do it', at = ago(MIN)) => ({
  type: 'user',
  timestamp: at,
  message: { content: text },
});
const toolUse = (calls: Array<[string, string]>, at = ago(MIN)) => ({
  type: 'assistant',
  timestamp: at,
  message: { content: calls.map(([id, name]) => ({ type: 'tool_use', id, name, input: {} })) },
});
const toolResult = (id: string, at = ago(MIN)) => ({
  type: 'user',
  timestamp: at,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const turnEnd = (at = ago(MIN)) => ({ type: 'system', subtype: 'turn_duration', timestamp: at });
const answer = (at = ago(MIN)) => ({
  type: 'assistant',
  timestamp: at,
  message: { content: [{ type: 'text', text: 'done' }] },
});
const thinking = (at = ago(1_000)) => ({
  type: 'assistant',
  timestamp: at,
  message: { content: [{ type: 'thinking', thinking: '...' }] },
});

describe('turnSignal (Claude record classifier)', () => {
  const kind = (r: unknown) => turnSignal(r).kind;

  it.each([
    ['user prompt (string)', { type: 'user', message: { content: 'fix it' } }, 'prompt'],
    [
      'user prompt (text block)',
      { type: 'user', message: { content: [{ type: 'text', text: 'fix it' }] } },
      'prompt',
    ],
    [
      'interrupt',
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      },
      'interrupted',
    ],
    [
      'interrupt for tool use',
      { type: 'user', message: { content: '[Request interrupted by user for tool use]' } },
      'interrupted',
    ],
    ['isMeta', { type: 'user', isMeta: true, message: { content: 'Caveat: ...' } }, 'meta'],
    [
      'command-name',
      { type: 'user', message: { content: '<command-name>/cost</command-name>' } },
      'meta',
    ],
    [
      'local-command-stdout',
      { type: 'user', message: { content: '<local-command-stdout>$1</local-command-stdout>' } },
      'meta',
    ],
    [
      'local-command-stderr',
      { type: 'user', message: { content: '<local-command-stderr>x</local-command-stderr>' } },
      'meta',
    ],
    [
      'compact summary',
      { type: 'user', isCompactSummary: true, message: { content: 'sum' } },
      'meta',
    ],
    [
      'tool_result even when flagged meta',
      {
        type: 'user',
        isMeta: true,
        message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] },
      },
      'toolResult',
    ],
    [
      'tool_use',
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'x' },
            { type: 'tool_use', id: 'a', name: 'Read' },
          ],
        },
      },
      'toolUse',
    ],
    [
      'thinking only',
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } },
      'thinking',
    ],
    [
      'text answer',
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      'textAnswer',
    ],
    ['turn_duration', { type: 'system', subtype: 'turn_duration' }, 'turnEnd'],
    ['other system', { type: 'system', subtype: 'informational' }, 'ignore'],
    ['file-history-snapshot', { type: 'file-history-snapshot' }, 'ignore'],
    ['queue-operation', { type: 'queue-operation', operation: 'enqueue' }, 'ignore'],
    ['ai-title', { type: 'ai-title', aiTitle: 'x' }, 'ignore'],
  ])('%s -> %s', (_name, record, expected) => {
    expect(kind(record)).toBe(expected);
  });

  it('carries tool ids and names, and the record timestamp', () => {
    const sig = turnSignal({
      type: 'assistant',
      timestamp: '2026-10-11T12:00:00Z',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(sig).toEqual({
      kind: 'toolUse',
      toolUseIds: ['a', 'b'],
      toolNames: ['Read', 'Bash'],
      toolInputs: [{ file_path: 'a.ts' }, { command: 'ls' }],
      timestampMs: NOW,
    });
  });
});

describe('deriveTurnState', () => {
  it('a finished turn, a text answer and an interrupt all read waiting', () => {
    expect(derive([prompt(), toolUse([['a', 'Read']]), toolResult('a'), turnEnd()])).toBe(
      'waiting',
    );
    expect(derive([prompt(), answer()])).toBe('waiting');
    expect(
      derive([
        prompt(),
        toolUse([['a', 'Read']]),
        {
          type: 'user',
          timestamp: ago(MIN),
          message: { content: '[Request interrupted by user]' },
        },
      ]),
    ).toBe('waiting');
  });

  it('CLI-injected /cost records after a finished turn do not make it active', () => {
    expect(
      derive([
        prompt(),
        turnEnd(),
        { type: 'user', isMeta: true, message: { content: 'Caveat' } },
        { type: 'user', message: { content: '<command-name>/cost</command-name>' } },
        { type: 'user', message: { content: '<local-command-stdout>$1</local-command-stdout>' } },
        { type: 'file-history-snapshot' },
      ]),
    ).toBe('waiting');
  });

  it('a prompt or fresh reasoning as the newest record reads active', () => {
    expect(derive([turnEnd(), prompt('next', ago(2_000))])).toBe('active');
    expect(derive([prompt(), thinking()])).toBe('active');
  });

  it('dates the state by the record that decided it: not a later attachment, not the mtime', () => {
    const sinceOf = (records: unknown[]) => {
      const state = deriveTurnState(
        records.map((r) => JSON.stringify(r)),
        NOW,
        { leadMtimeMs: NOW - 5_000 },
        turnSignal,
        traits,
      );
      return state.kind === 'idle' ? 'idle' : state.sinceMs;
    };
    const attachment = { type: 'attachment', timestamp: ago(10_000), attachment: {} };
    expect(sinceOf([prompt(), toolUse([['q', 'AskUserQuestion']], ago(4 * MIN)), attachment])).toBe(
      NOW - 4 * MIN,
    );
    expect(sinceOf([prompt(), turnEnd(ago(2 * MIN)), attachment])).toBe(NOW - 2 * MIN);
    // A deciding record without a timestamp leaves the start unknown, never the mtime.
    const undated = { type: 'user', message: { content: 'go' } };
    expect(sinceOf([undated])).toBeUndefined();
  });

  it('a pending AskUserQuestion reads awaitingInput, an answered one does not', () => {
    expect(derive([prompt(), toolUse([['q', 'AskUserQuestion']])])).toBe('awaitingInput');
    expect(
      derive([prompt(), toolUse([['q', 'AskUserQuestion']]), toolResult('q', ago(1_000))]),
    ).toBe('active');
  });

  // B7 / K3, adoption entry point: a restarted server shows the question a session is stopped on.
  describe('the question of an adopted session', () => {
    const asking = (question: unknown, extra: unknown[] = []) => ({
      type: 'assistant',
      timestamp: ago(MIN),
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'q',
            name: 'AskUserQuestion',
            input: { questions: [{ question }] },
          },
          ...extra,
        ],
      },
    });
    const stateOf = (records: unknown[]) =>
      deriveTurnState(
        records.map((r) => JSON.stringify(r)),
        NOW,
        { leadMtimeMs: NOW - 5_000 },
        turnSignal,
        traits,
      );

    it('reads the text of the pending question tool, and no other tool call', () => {
      const state = stateOf([prompt(), asking('Which database?')]);
      expect(state).toMatchObject({ kind: 'awaitingInput', question: 'Which database?' });
      // Only ids and names reach the health seed, never an input.
      expect(JSON.stringify(state)).not.toContain('questions');
    });

    it('redacts and cuts the text like the hook path does', () => {
      const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
      const state = stateOf([prompt(), asking(`Use ${token}\u202e ${'y'.repeat(700)}`)]);
      const text = (state as { question: string }).question;
      expect(text).not.toContain('ghp_');
      expect(text).not.toContain('\u202e');
      expect(Array.from(text).length).toBe(300);
    });

    it('is still awaiting input, without text, when the question cannot be read', () => {
      const state = stateOf([prompt(), asking(undefined)]);
      expect(state.kind).toBe('awaitingInput');
      expect(state).not.toHaveProperty('question');
    });
  });

  it('pairs parallel tool calls by id: one result back, one still running', () => {
    // Bash is a long-runner that is 5 min quiet: believed active only while it is
    // known to be pending. If any result closed every call, this would read idle.
    const records = [
      prompt(),
      toolUse(
        [
          ['r', 'Read'],
          ['b', 'Bash'],
        ],
        ago(5 * MIN),
      ),
      toolResult('r', ago(5 * MIN)),
    ];
    expect(derive(records, { leadMtimeMs: NOW - 5 * MIN })).toBe('active');
  });

  it('a quiet agent is active only inside the staleness window of its pending tool', () => {
    const quiet = { leadMtimeMs: NOW - 5 * MIN };
    expect(derive([prompt(), toolUse([['b', 'Bash']], ago(5 * MIN))], quiet)).toBe('active');
    expect(derive([prompt(), toolUse([['r', 'Read']], ago(5 * MIN))], quiet)).toBe('idle');
    expect(
      derive([prompt(), toolUse([['b', 'Bash']], ago(20 * MIN))], { leadMtimeMs: NOW - 20 * MIN }),
    ).toBe('idle');
  });

  it('a quiet lead is active while a sub-agent transcript is still moving', () => {
    const records = [prompt(), toolUse([['a', 'Read']], ago(5 * MIN))];
    expect(derive(records, { leadMtimeMs: NOW - 5 * MIN })).toBe('idle');
    expect(derive(records, { leadMtimeMs: NOW - 5 * MIN, subagentMtimesMs: [NOW - 10_000] })).toBe(
      'active',
    );
  });

  it('a turn finished hours ago reads idle, not Done', () => {
    const old = ago(3 * 60 * MIN);
    expect(derive([prompt('x', old), turnEnd(old)], { leadMtimeMs: NOW - 3 * 60 * MIN })).toBe(
      'idle',
    );
    expect(derive([prompt('x', old), turnEnd(ago(MIN))])).toBe('waiting');
  });

  it('a transcript of only bookkeeping reads idle', () => {
    expect(derive([{ type: 'file-history-snapshot' }, { type: 'ai-title', aiTitle: 't' }])).toBe(
      'idle',
    );
    expect(derive([])).toBe('idle');
  });
});
