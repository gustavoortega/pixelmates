import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  processTranscriptLine,
  setHookProvider,
  setTeamSwitchCallback,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors hookEventHandler.test.ts). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'lead-session',
    terminalRef: undefined,
    isExternal: true,
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

function agentToolUseRecord(toolId: string, name: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResultRecord(toolId: string, text: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }],
    },
  });
}

describe('transcriptParser: teammate spawn results (new-harness implicit teams)', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
      setTeamSwitchCallback(() => {});
    };
  });

  it('marks the agent as team lead when an Agent spawn result carries agent_id@team', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', {
        name: 'wa-research',
        subagent_type: 'general-purpose',
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.activeToolNames.get('toolu_1')).toBe('Agent');

    processTranscriptLine(
      1,
      toolResultRecord(
        'toolu_1',
        'Spawned successfully. (internal metadata)\nagent_id: wa-research@session-abc12345\nname: wa-research',
      ),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.teamName).toBe('session-abc12345');
    expect(agent.isTeamLead).toBe(true);
    const teamInfo = messages.find((m) => m.type === 'agentTeamInfo');
    expect(teamInfo).toMatchObject({ id: 1, teamName: 'session-abc12345', isTeamLead: true });
  });

  it('completes the spawn tool normally (no lingering background tool or Subtask)', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'wa-research' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: wa-research@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    // The teammate character replaces the transient Subtask one: the spawn tool
    // must be cleared, not parked in backgroundAgentToolIds forever (the new
    // harness never writes the queue-operation completion record).
    expect(agent.backgroundAgentToolIds.size).toBe(0);
    expect(agent.activeToolIds.has('toolu_1')).toBe(false);
    expect(messages.some((m) => m.type === 'subagentClear' && m.parentToolId === 'toolu_1')).toBe(
      true,
    );
  });

  it('does not overwrite team identity already established from record tags', () => {
    // Tag-derived identity (tmux/inline leads) is authoritative over spawn results.
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'assistant', teamName: 'explicit-team', message: { content: [] } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('explicit-team');
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'helper' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: helper@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('explicit-team');
  });

  it('re-latches a resumed tag-less lead to the newest team and reports the switch', () => {
    const switches: Array<{ leadId: number; previousTeam: string }> = [];
    setTeamSwitchCallback((leadId, previousTeam) => switches.push({ leadId, previousTeam }));

    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: demo-15s@session-aaaa1111'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('session-aaaa1111');

    // Resume: a new CLI run of the same session mints a fresh implicit team.
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_2', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_2', 'Spawned successfully.\nagent_id: demo-15s@session-bbbb2222'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.teamName).toBe('session-bbbb2222');
    expect(agent.isTeamLead).toBe(true);
    expect(switches).toEqual([{ leadId: 1, previousTeam: 'session-aaaa1111' }]);
    const teamInfos = messages.filter((m) => m.type === 'agentTeamInfo');
    expect(teamInfos[teamInfos.length - 1]).toMatchObject({
      id: 1,
      teamName: 'session-bbbb2222',
      isTeamLead: true,
    });
  });

  it('does not re-latch a teammate that spawns its own named Agent', () => {
    // A teammate session runs through the same processTranscriptLine as its
    // lead. Claude 5 teammates can use the Agent tool, so the teammate's own
    // transcript carries a spawn tool_result naming a NESTED team. Without the
    // leadAgentId guard the teammate re-latches onto that nested team, sets
    // isTeamLead, and linkTeammates detaches it from its real lead.
    const switches: Array<{ leadId: number; previousTeam: string }> = [];
    setTeamSwitchCallback((leadId, previousTeam) => switches.push({ leadId, previousTeam }));

    const teammate = createTestAgent({
      id: 2,
      sessionId: 'teammate-session',
      jsonlFile: '/test/teammate.jsonl',
      // As adopted by fileWatcher: team + lead are pre-set, and
      // teamNameFromTags is NOT set (the tag branch short-circuits because
      // teamName already matches).
      teamName: 'session-aaaa1111',
      agentName: 'helper',
      leadAgentId: 1,
    });
    agents.set(2, teammate);

    processTranscriptLine(
      2,
      agentToolUseRecord('toolu_9', 'Agent', { name: 'nested-helper' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      2,
      toolResultRecord(
        'toolu_9',
        'Spawned successfully.\nagent_id: nested-helper@session-cccc3333',
      ),
      agents,
      waitingTimers,
      permissionTimers,
    );

    // Stays in its own team, stays a teammate, stays attached to its lead.
    expect(teammate.teamName).toBe('session-aaaa1111');
    expect(teammate.isTeamLead).toBeFalsy();
    expect(teammate.leadAgentId).toBe(1);
    expect(switches).toEqual([]);
  });

  it('does not badge an adopted teammate session as LEAD when its lead is not tracked', () => {
    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'user',
        teamName: 'session-abc12345',
        agentName: 'demo-15s',
        message: { content: 'hello' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.agentName).toBe('demo-15s');
    expect(agent.teamName).toBe('session-abc12345');
    expect(agent.isTeamLead).toBeFalsy();
  });

  it('links an earlier-adopted teammate once the lead latches onto the team', () => {
    const teammate = createTestAgent({ id: 2, sessionId: 'tm-session' });
    agents.set(2, teammate);
    processTranscriptLine(
      2,
      JSON.stringify({
        type: 'user',
        teamName: 'session-abc12345',
        agentName: 'demo-15s',
        message: { content: 'hello' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(teammate.leadAgentId).toBeUndefined();

    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: demo-15s@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.isTeamLead).toBe(true);
    expect(teammate.leadAgentId).toBe(1);
    expect(teammate.isTeamLead).toBe(false);
  });

  it('still parks old-style async agent launches as background tools', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { run_in_background: true }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Async agent launched successfully.'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.backgroundAgentToolIds.has('toolu_1')).toBe(true);
    expect(agent.activeToolIds.has('toolu_1')).toBe(true);
    expect(agent.teamName).toBeUndefined();
  });

  it('ignores results of non-spawn tools that happen to mention agent_id', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Read', { file_path: '/tmp/x' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'agent_id: someone@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBeUndefined();
    expect(agent.isTeamLead).toBeUndefined();
  });
});

describe('transcriptParser: status truth (live path)', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const feed = (record: unknown) =>
    processTranscriptLine(1, JSON.stringify(record), agents, waitingTimers, permissionTimers);
  const statuses = () => messages.filter((m) => m.type === 'agentStatus');

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent({ isWaiting: true });
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('T8: slash-command output and compaction records do not make an idle agent active', () => {
    feed({ type: 'user', isMeta: true, message: { content: 'Caveat: local commands' } });
    feed({ type: 'user', message: { content: '<command-name>/cost</command-name>' } });
    feed({ type: 'user', message: { content: '<local-command-stdout>$1</local-command-stdout>' } });
    feed({ type: 'user', isCompactSummary: true, message: { content: 'summary' } });
    expect(statuses()).toEqual([]);
    expect(agent.isWaiting).toBe(true);
  });

  it('T8: a real prompt still starts the turn as active', () => {
    feed({ type: 'user', message: { content: 'fix the bug' } });
    expect(statuses()).toEqual([{ type: 'agentStatus', id: 1, status: 'active' }]);
    expect(agent.isWaiting).toBe(false);
  });

  it('T8: an interrupt marks the agent waiting even when hooks are delivering', () => {
    agent.hookDelivered = true;
    agent.isWaiting = false;
    feed(agentToolUseRecord('t1', 'Bash', { command: 'sleep 99' }));
    messages.length = 0;
    feed({
      type: 'user',
      message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    });
    expect(statuses()).toEqual([
      { type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: false },
    ]);
    expect(agent.isWaiting).toBe(true);
    expect(agent.activeToolIds.size).toBe(0);
  });

  describe('a question tool', () => {
    const ASK = {
      questions: [{ question: 'Which database should the migration target?' }],
    };
    const feedLine = (line: string) =>
      processTranscriptLine(1, line, agents, waitingTimers, permissionTimers);
    const WIRE = {
      type: 'agentStatus',
      id: 1,
      status: 'waiting',
      awaitingInput: true,
      awaitingReason: 'question',
      question: 'Which database should the migration target?',
    };

    it('raises the question ticket from its tool_use and ends it with its result', () => {
      agent.isWaiting = false;
      feedLine(agentToolUseRecord('q1', 'AskUserQuestion', ASK));
      expect(statuses()).toEqual([WIRE]);

      messages.length = 0;
      feedLine(toolResultRecord('q1', 'Postgres'));
      expect(statuses()).toEqual([{ type: 'agentStatus', id: 1, status: 'active' }]);
      expect(agent.question).toBeUndefined();
    });

    // The hook raised the ticket first; the transcript record that follows ~0.5 s later must
    // neither flip it back to active nor date it again.
    it('keeps the ticket and its start when the transcript catches up with the hook', () => {
      // What the PreToolUse hook left behind: the ticket, dated by the server clock.
      Object.assign(agent, {
        isWaiting: false,
        hookDelivered: true,
        awaitingInput: true,
        awaitingReason: 'question',
        question: ASK.questions[0].question,
        statusKey: 'waiting:input',
        statusSince: 1_234,
      });
      feed({
        type: 'assistant',
        timestamp: '2026-10-20T10:00:00Z',
        message: {
          content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: ASK }],
        },
      });
      expect(statuses()).toEqual([{ ...WIRE, since: 1_234 }]);
      expect(agent.isWaiting).toBe(true);
    });

    // K2b: the user's next prompt (UserPromptSubmit is not an installed hook) ends the wait.
    it('ends when the user types a prompt instead of answering', () => {
      agent.isWaiting = false;
      feedLine(agentToolUseRecord('q1', 'AskUserQuestion', ASK));
      messages.length = 0;
      feed({ type: 'user', message: { content: 'never mind, use sqlite' } });
      expect(statuses()).toEqual([{ type: 'agentStatus', id: 1, status: 'active' }]);
      expect(agent.awaitingInput).toBeFalsy();
      expect(agent.question).toBeUndefined();
    });
  });
});

/** A Bash result. A background launch carries the task id on toolUseResult. */
function bashResult(toolId: string, backgroundTaskId: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: `Command running in background with ID: ${backgroundTaskId}`,
        },
      ],
    },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId },
  });
}

/** The result of a Bash call the user denied: an error, no task id. */
function deniedResult(toolId: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolId, is_error: true, content: 'Permission denied' },
      ],
    },
    toolUseResult: 'Error: Permission for this tool has been denied',
  });
}

/** The same record written by a sub-agent inlined in this transcript. */
function sidechain(line: string) {
  return JSON.stringify({ ...JSON.parse(line), isSidechain: true });
}

/** Claude Code's notification text for a background task that ended. */
function notificationText(toolId: string, taskId: string, status: string) {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`;
}

/** The notification as enqueued when the task ends. */
function taskNotification(toolId: string, taskId: string, status = 'completed') {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: notificationText(toolId, taskId, status),
  });
}

/** The notification delivered to the model as a prompt. */
function promptNotification(toolId: string, taskId: string) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: notificationText(toolId, taskId, 'completed') },
  });
}

/** The notification queued as an attachment while the agent was busy. */
function queuedNotification(toolId: string, taskId: string) {
  return JSON.stringify({
    type: 'attachment',
    attachment: { type: 'queued_command', prompt: notificationText(toolId, taskId, 'completed') },
  });
}

/** A TaskStop result: it names the task it stopped. */
function taskStopResult(toolId: string, taskId: string) {
  const result = {
    message: `Successfully stopped task: ${taskId} (npm run dev)`,
    task_id: taskId,
    task_type: 'local_bash',
    command: 'npm run dev',
  };
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolId, content: JSON.stringify(result) }],
    },
    toolUseResult: result,
  });
}

describe('transcriptParser: background shells', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let shells: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const feed = (line: string) =>
    processTranscriptLine(1, line, agents, waitingTimers, permissionTimers);
  const running = (n: number) => ({ type: 'agentShells', id: 1, running: n });
  /** A Bash sent to the background: its call, then its result with the task id. */
  const launch = (toolId: string, taskId: string) => {
    feed(agentToolUseRecord(toolId, 'Bash', { command: 'npm run dev', run_in_background: true }));
    feed(bashResult(toolId, taskId));
  };

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    shells = [];
    agents.on('broadcast', (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.type === 'agentShells') shells.push(m);
    });
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  /** Every record that can end a background shell, as the lines it takes. */
  const shellEnds: Array<[string, (toolId: string, taskId: string) => string[]]> = [
    ['its task notification is enqueued', (toolId, taskId) => [taskNotification(toolId, taskId)]],
    [
      'its notification is delivered as a prompt',
      (toolId, taskId) => [promptNotification(toolId, taskId)],
    ],
    [
      'its notification is queued as an attachment',
      (toolId, taskId) => [queuedNotification(toolId, taskId)],
    ],
    [
      'TaskStop stops its task, which no notification follows',
      (_toolId, taskId) => [
        agentToolUseRecord('toolu_stop', 'TaskStop', { task_id: taskId }),
        taskStopResult('toolu_stop', taskId),
      ],
    ],
  ];

  it.each(shellEnds)('C3 a background shell counts from its launch until %s', (_how, end) => {
    launch('toolu_1', 'b1');
    launch('toolu_2', 'b2');
    expect(shells).toEqual([running(1), running(2)]);
    // The launches returned: each Bash is done as a tool while its shell runs on.
    expect([...agent.activeToolIds]).toEqual([]);

    for (const line of end('toolu_2', 'b2')) feed(line);
    expect(shells).toEqual([running(1), running(2), running(1)]);

    // The other shell still counts until its own end.
    feed(taskNotification('toolu_1', 'b1'));
    expect(shells).toEqual([running(1), running(2), running(1), running(0)]);
  });

  it('C9 a denied or sidechain launch never counts; a result with a task id does, even without the flag', () => {
    feed(
      agentToolUseRecord('toolu_no', 'Bash', { command: 'npm run dev', run_in_background: true }),
    );
    feed(deniedResult('toolu_no'));
    // A sub-agent's launch: its notification lands in another transcript.
    feed(
      sidechain(
        agentToolUseRecord('toolu_sub', 'Bash', {
          command: 'npm run dev',
          run_in_background: true,
        }),
      ),
    );
    feed(sidechain(bashResult('toolu_sub', 'b9')));
    expect(shells).toEqual([]);

    // A command that runs too long goes to the background with no flag on its input.
    feed(agentToolUseRecord('toolu_auto', 'Bash', { command: 'npm test' }));
    feed(bashResult('toolu_auto', 'b2'));
    expect(shells).toEqual([running(1)]);
  });

  it('C10 a notification for a shell this agent never launched changes nothing; a repeat counts down once', () => {
    launch('toolu_1', 'b1');
    // A sub-agent's shell finishing on the lead's transcript.
    feed(taskNotification('toolu_sub', 'b9'));
    expect(shells).toEqual([running(1)]);

    feed(taskNotification('toolu_1', 'b1'));
    feed(taskNotification('toolu_1', 'b1', 'killed'));
    expect(shells).toEqual([running(1), running(0)]);
    expect(agent.runningShellIds?.size).toBe(0);
  });

  it('a notification written before its launch result leaves the shell uncounted', () => {
    feed(taskNotification('toolu_fast', 'b3'));
    launch('toolu_fast', 'b3');

    expect(shells).toEqual([]);
    expect(agent.runningShellIds?.size ?? 0).toBe(0);
  });
});

describe('transcriptParser: record types', () => {
  it('C14 mode and permission-mode records are known types, never logged as unrecognized', () => {
    setHookProvider(claudeProvider);
    const agents = new AgentStateStore();
    const agent = createTestAgent();
    agents.set(1, agent);
    const feed = (record: unknown) =>
      processTranscriptLine(1, JSON.stringify(record), agents, new Map(), new Map());

    feed({ type: 'mode', mode: 'normal', sessionId: 's' });
    feed({ type: 'permission-mode', permissionMode: 'auto', sessionId: 's' });

    expect([...agent.seenUnknownRecordTypes]).toEqual([]);
  });
});

describe('transcriptParser: Bash status privacy', () => {
  it('keeps a secret in any argument out of the broadcast status and the server log line', () => {
    const canary = 'CANARY-s3cr3t-9f8e7d';
    setHookProvider(claudeProvider);
    const agents = new AgentStateStore();
    agents.set(1, createTestAgent());
    const sent: Array<Record<string, unknown>> = [];
    agents.on('broadcast', (msg) => sent.push(msg as Record<string, unknown>));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const timers = new Map<number, ReturnType<typeof setTimeout>>();
      processTranscriptLine(
        1,
        agentToolUseRecord('toolu_1', 'Bash', {
          command: `FOO=${canary} ssh ${canary} --token "${canary}" https://h/${canary}`,
        }),
        agents,
        timers,
        timers,
      );
      const start = sent.find((m) => m.type === 'agentToolStart');
      expect(start).toMatchObject({ status: 'Running: ssh' });
      const logged = log.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(logged).toContain('tool start: toolu_1 Running: ssh');
      expect(logged).not.toContain(canary);
      expect(JSON.stringify(sent)).not.toContain(canary);
    } finally {
      log.mockRestore();
    }
  });
});
