import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { RosterStore } from '../src/roster.js';
import { claimRosterMember } from '../src/rosterAgent.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 0,
    sessionId: 'test-session',
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/** Messages every agent gets on a resend, known or not. */
const SENT_FOR_EVERY_AGENT = new Set([
  'agentModel',
  'agentSessionTitle',
  'agentCache',
  'agentMode',
  'agentShells',
  'agentSession',
  'agentArtifacts',
  'agentLoop',
  'agentTests',
]);

/** Resend minus the model, title, session-signal, monitor, tripwire and health messages, which every
 *  agent gets, so the tests below can assert the other messages without restating them each time. */
function resendActivityWithoutTitlesOrAlarms(
  sent: Array<Record<string, unknown>>,
  store: AgentStateStore,
): void {
  resendAgentActivity((msg) => {
    if (
      !SENT_FOR_EVERY_AGENT.has(String(msg.type)) &&
      !String(msg.type).startsWith('agentTripwire') &&
      !String(msg.type).startsWith('agentHealth')
    ) {
      sent.push(msg);
    }
  }, store);
}

describe('resendAgentActivity roster', () => {
  it('replays agentRoster for rostered agents only, after the tripwire and health messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resend-roster-'));
    const store = new AgentStateStore();
    const roster = new RosterStore({ filePath: path.join(dir, 'roster.json') });
    roster.attach(store);
    const rostered = createTestAgent({ id: 1, sessionId: 's1' });
    claimRosterMember(rostered, store);
    store.set(1, rostered);
    store.set(2, createTestAgent({ id: 2, sessionId: 's2' }));

    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    roster.dispose();
    fs.rmSync(dir, { recursive: true, force: true });

    const forAgent = (id: number) => sent.filter((m) => m.id === id).map((m) => m.type);
    expect(forAgent(1)).toEqual([
      'agentStatus',
      'agentModel',
      'agentSessionTitle',
      'agentCache',
      'agentMode',
      'agentShells',
      'agentSession',
      'agentArtifacts',
      'agentLoop',
      'agentTests',
      'agentTripwireClear',
      'agentHealthClear',
      'agentRoster',
    ]);
    expect(forAgent(2)).toEqual([
      'agentStatus',
      'agentModel',
      'agentSessionTitle',
      'agentCache',
      'agentMode',
      'agentShells',
      'agentSession',
      'agentArtifacts',
      'agentLoop',
      'agentTests',
      'agentTripwireClear',
      'agentHealthClear',
    ]);
    expect(sent.find((m) => m.type === 'agentRoster')).toMatchObject({
      id: 1,
      level: 1,
      xp: 0,
      xpToNext: 100,
      mood: 'neutral',
    });
  });
});

describe('resendAgentActivity', () => {
  it('sends messages in order: team info, tools, waiting, context, model, title, session signals, tripwire, health', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        teamName: 'test-team',
        activeToolStatuses: new Map([['tool-1', 'Running']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
        isWaiting: true,
        contextTokens: 50_000,
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);

    expect(sent.map((m) => m.type)).toEqual([
      'agentTeamInfo',
      'agentToolStart',
      'agentStatus',
      'agentContextUsage',
      'agentModel',
      'agentSessionTitle',
      'agentCache',
      'agentMode',
      'agentShells',
      'agentSession',
      'agentArtifacts',
      'agentLoop',
      'agentTests',
      'agentTripwireClear',
      'agentHealthClear',
    ]);
  });

  it('includes basic fields for regular tools', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        activeToolStatuses: new Map([['tool-1', 'Running']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);

    // The agent has a tool in flight, so it is also explicitly active.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      type: 'agentToolStart',
      id: 1,
      toolId: 'tool-1',
      status: 'Running',
      toolName: 'Bash',
    });
    expect(sent[1]).toEqual({ type: 'agentStatus', id: 1, status: 'active' });
  });

  it('restates a pending permission prompt on every tool start, regular and background', () => {
    // A client takes a start without the flag as the prompt answered and drops its bubble.
    const withTools = (id: number, permissionSent: boolean) =>
      createTestAgent({
        id,
        permissionSent,
        activeToolStatuses: new Map([
          ['run', 'Running: build'],
          ['spawn', 'Subtask: scan'],
        ]),
        activeToolNames: new Map([
          ['run', 'Bash'],
          ['spawn', 'Agent'],
        ]),
        backgroundAgentToolIds: new Set(['spawn']),
      });
    const store = new AgentStateStore();
    store.set(1, withTools(1, true));
    store.set(2, withTools(2, false));
    const sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);

    const starts = sent
      .filter((m) => m.type === 'agentToolStart')
      .map((m) => [m.id, m.toolId, m.permissionActive]);
    expect(starts).toEqual([
      [1, 'run', true],
      [1, 'spawn', true],
      [2, 'run', undefined],
      [2, 'spawn', undefined],
    ]);
  });

  it('handles background tools with flags and promoted skip logic', () => {
    const store = new AgentStateStore();
    // Lead with three background tools: unnamed, named spawn, and promoted
    store.set(
      1,
      createTestAgent({
        id: 1,
        // A teamed lead: the webview routes agentToolStart by the parent's
        // teamName, so the team message has to land before the tool replays or
        // a background spawn is routed as if the lead had no team.
        teamName: 'test-team',
        activeToolStatuses: new Map([
          ['bg-unnamed', 'Subtask: Unnamed'],
          ['bg-named', 'Subtask: Named'],
          ['bg-promoted', 'Subtask: Promoted'],
        ]),
        activeToolNames: new Map([
          ['bg-unnamed', 'Agent'],
          ['bg-named', 'Agent'],
          ['bg-promoted', 'Agent'],
        ]),
        backgroundAgentToolIds: new Set(['bg-unnamed', 'bg-named', 'bg-promoted']),
        teammateSpawnToolIds: new Set(['bg-named']),
      }),
    );
    // Promoted teammate (should cause bg-promoted to be skipped)
    store.set(
      2,
      createTestAgent({
        id: 2,
        leadAgentId: 1,
        spawnToolUseId: 'bg-promoted',
        agentName: 'promoted-agent',
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);

    const toolStarts = sent.filter((m) => m.type === 'agentToolStart');
    expect(toolStarts).toHaveLength(2); // unnamed + named, NOT promoted

    // Team info first: the webview reads the parent's teamName to decide whether
    // a background agentToolStart becomes a Subtask sub-character, so a replay
    // that arrives before it is routed against stale team state.
    const teamIdx = sent.findIndex((m) => m.type === 'agentTeamInfo' && m.id === 1);
    const firstBgToolIdx = sent.findIndex((m) => m.type === 'agentToolStart' && m.id === 1);
    expect(teamIdx).toBeGreaterThanOrEqual(0);
    expect(teamIdx).toBeLessThan(firstBgToolIdx);

    // Unnamed: runInBackground=true, no isTeammateSpawn. toolName is required —
    // without it the webview cannot recreate the Subtask after agentToolsClear.
    const unnamed = toolStarts.find((t) => t.toolId === 'bg-unnamed');
    expect(unnamed).toMatchObject({ runInBackground: true, toolName: 'Agent' });
    expect(unnamed?.isTeammateSpawn).toBeUndefined();

    // Named: runInBackground=true, isTeammateSpawn=true, toolName present.
    const named = toolStarts.find((t) => t.toolId === 'bg-named');
    expect(named).toMatchObject({
      runInBackground: true,
      isTeammateSpawn: true,
      toolName: 'Agent',
    });
  });

  it('sends team info for any team field trigger, omits when none present', () => {
    // teamName trigger
    let store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, teamName: 'my-team' }));
    let sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent.filter((m) => m.type === 'agentTeamInfo')).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentTeamInfo', id: 1, teamName: 'my-team' });

    // agentName trigger (derived team)
    store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2, agentName: 'worker-1', leadAgentId: 1 }));
    sent = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent.filter((m) => m.type === 'agentTeamInfo')).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentTeamInfo', id: 2, agentName: 'worker-1' });

    // isTeamLead trigger
    store = new AgentStateStore();
    store.set(3, createTestAgent({ id: 3, isTeamLead: true }));
    sent = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent.filter((m) => m.type === 'agentTeamInfo')).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentTeamInfo', id: 3, isTeamLead: true });

    // No team fields: no message
    store = new AgentStateStore();
    store.set(4, createTestAgent({ id: 4 }));
    sent = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent.filter((m) => m.type === 'agentTeamInfo')).toHaveLength(0);
  });

  it('sends waiting for a waiting agent and idle for a quiet one, never nothing', () => {
    let store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, isWaiting: true }));
    let sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: false }]);

    store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2, isWaiting: false }));
    sent = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent).toEqual([{ type: 'agentStatus', id: 2, status: 'idle' }]);
  });

  // K5: a reconnecting client is told why each waiting agent waits, and the question's text.
  it('carries the wait reason and the question text on a reconnect', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        isWaiting: true,
        awaitingInput: true,
        awaitingReason: 'question',
        question: 'Which database?',
        statusKey: 'waiting:input',
        statusSince: 5_000,
      }),
    );
    store.set(
      2,
      createTestAgent({
        id: 2,
        isWaiting: true,
        awaitingInput: true,
        awaitingReason: 'idle',
        question: 'left over',
        statusKey: 'waiting:done',
        statusSince: 4_000,
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => {
      if (m.type === 'agentStatus') sent.push(m);
    }, store);
    expect(sent).toEqual([
      {
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'question',
        question: 'Which database?',
        since: 5_000,
      },
      {
        type: 'agentStatus',
        id: 2,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'idle',
        since: 4_000,
      },
    ]);
  });

  it('sends exactly one status per agent, with the value its state implies', () => {
    const store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, hadToolsInTurn: true }));
    store.set(2, createTestAgent({ id: 2, derivedActive: true }));
    store.set(3, createTestAgent({ id: 3, isWaiting: true, awaitingInput: true }));
    store.set(4, createTestAgent({ id: 4, isWaiting: true, hadToolsInTurn: true }));
    store.set(5, createTestAgent({ id: 5 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => {
      if (m.type === 'agentStatus') sent.push(m);
    }, store);
    expect(sent).toEqual([
      { type: 'agentStatus', id: 1, status: 'active' },
      { type: 'agentStatus', id: 2, status: 'active' },
      { type: 'agentStatus', id: 3, status: 'waiting', awaitingInput: true },
      { type: 'agentStatus', id: 4, status: 'waiting', awaitingInput: false },
      { type: 'agentStatus', id: 5, status: 'idle' },
    ]);
  });

  it('sends context usage only when agent has tokens', () => {
    let store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, contextTokens: 50_000, maxContextTokens: 200_000 }));
    let sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent.filter((m) => m.type === 'agentContextUsage')).toEqual([
      { type: 'agentContextUsage', id: 1, contextTokens: 50_000, maxContextTokens: 200_000 },
    ]);

    store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2, contextTokens: 0, maxContextTokens: 200_000 }));
    sent = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent.filter((m) => m.type === 'agentContextUsage')).toHaveLength(0);
  });

  it('sends the model look for every agent, omitting what is unknown', () => {
    const store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, model: 'claude-opus-5-5', modelTier: 3 }));
    store.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => {
      if (msg.type === 'agentModel') sent.push(JSON.parse(JSON.stringify(msg)));
    }, store);
    expect(sent).toEqual([
      { type: 'agentModel', id: 1, model: 'claude-opus-5-5', tier: 3 },
      { type: 'agentModel', id: 2 },
    ]);
  });

  it('sends the session signals for every agent, omitting what is unknown and counting zero shells', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        cacheTtlSeconds: 3600,
        cacheExpiresAt: 1_760_000_000_000,
        permissionMode: 'auto',
        runningShellIds: new Map([
          ['toolu_a', 'ba'],
          ['toolu_b', 'bb'],
        ]),
      }),
    );
    store.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => {
      if (['agentCache', 'agentMode', 'agentShells'].includes(String(msg.type))) sent.push(msg);
    }, store);
    // Strict: an unknown field is absent from the message, not present as undefined.
    expect(sent).toStrictEqual([
      { type: 'agentCache', id: 1, ttlSeconds: 3600, expiresAt: 1_760_000_000_000 },
      { type: 'agentMode', id: 1, mode: 'auto' },
      { type: 'agentShells', id: 1, running: 2 },
      { type: 'agentCache', id: 2 },
      { type: 'agentMode', id: 2 },
      { type: 'agentShells', id: 2, running: 0 },
    ]);
  });

  it('C0.2 sends the monitor messages for every agent: what it holds, or the id alone as a clear', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        sessionMeta: { branch: 'fix/retry', startedAt: 1_000, costUsd: 0 },
        artifacts: { count: 1, complete: true, items: [{ title: 'Plan', url: 'u', at: 2_000 }] },
        loop: { nextAt: 3_000 },
        tests: { passed: 4, failed: 1, at: 4_000 },
      }),
    );
    // Nothing known: a client that showed another session's branch under this id must drop it.
    store.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => {
      if (/^agent(Session|Artifacts|Loop|Tests)$/.test(String(m.type))) sent.push(m);
    }, store);
    expect(sent).toEqual([
      { type: 'agentSession', id: 1, branch: 'fix/retry', startedAt: 1_000, costUsd: 0 },
      {
        type: 'agentArtifacts',
        id: 1,
        count: 1,
        complete: true,
        items: [{ title: 'Plan', url: 'u', at: 2_000 }],
      },
      { type: 'agentLoop', id: 1, nextAt: 3_000 },
      { type: 'agentTests', id: 1, passed: 4, failed: 1, at: 4_000 },
      { type: 'agentSession', id: 2 },
      { type: 'agentArtifacts', id: 2 },
      { type: 'agentLoop', id: 2 },
      { type: 'agentTests', id: 2 },
    ]);
  });

  it('handles edge cases: empty store and multiple agents', () => {
    // Empty store
    let store = new AgentStateStore();
    let sent: Array<Record<string, unknown>> = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent).toHaveLength(0);

    // Multiple agents with different activity
    store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        activeToolStatuses: new Map([['tool-1', 'Running']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
      }),
    );
    store.set(2, createTestAgent({ id: 2, isWaiting: true }));
    sent = [];
    resendActivityWithoutTitlesOrAlarms(sent, store);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ type: 'agentToolStart', id: 1 });
    expect(sent[1]).toMatchObject({ type: 'agentStatus', id: 1, status: 'active' });
    expect(sent[2]).toMatchObject({ type: 'agentStatus', id: 2, status: 'waiting' });
  });

  it('sends the title of a titled agent and an omitted title for an untitled one', () => {
    const store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, customTitle: 'Fix login bug', aiTitle: 'Generated' }));
    store.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);

    const titles = sent.filter((m) => m.type === 'agentSessionTitle');
    expect(titles).toHaveLength(2);
    expect(titles[0]).toEqual({ type: 'agentSessionTitle', id: 1, title: 'Fix login bug' });
    expect(titles[1]).toEqual({ type: 'agentSessionTitle', id: 2, title: undefined });
  });

  it('sends the alarm and health mark of a flagged agent, and clears for one without, alarm first', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        tripwire: {
          ruleId: 'dotenv',
          ruleName: 'Dotenv file access',
          severity: 'medium',
          count: 3,
          since: 1,
        },
        health: {
          redRuns: 0,
          lastCall: null,
          turnOpenAt: 1,
          progressAt: 1,
          permissionPendingAt: null,
          deadAt: null,
          lastSent: { state: 'stalled', reason: 'no_progress', count: 12 },
        },
      }),
    );
    store.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);

    const alarmsAndHealth = sent.filter((m) => /^agent(Tripwire|Health)/.test(String(m.type)));
    expect(alarmsAndHealth).toEqual([
      {
        type: 'agentTripwire',
        id: 1,
        ruleId: 'dotenv',
        ruleName: 'Dotenv file access',
        severity: 'medium',
        count: 3,
        since: 1,
      },
      { type: 'agentHealth', id: 1, state: 'stalled', reason: 'no_progress', count: 12 },
      { type: 'agentTripwireClear', id: 2 },
      { type: 'agentHealthClear', id: 2 },
    ]);
  });
});
