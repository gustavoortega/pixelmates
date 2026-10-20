import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { ackTripwire } from '../src/tripwires.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing. */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
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
    ...overrides,
  } as AgentState;
}

function createMockWebview() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      messages.push(msg);
      return Promise.resolve(true);
    }),
    messages,
  };
}

/** The agent_id Claude stamps on hooks fired inside a sub-agent. */
const SUB_AGENT_ID = 'a0b1c2d3e4f5a6b7c';

describe('HookEventHandler', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let mockWebview: ReturnType<typeof createMockWebview>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    mockWebview = createMockWebview();
    // Wire broadcast subscriber so mockWebview captures store broadcasts
    agents.on('broadcast', (msg) => {
      mockWebview.postMessage(msg);
    });
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
    );
  });

  // ── PermissionRequest ───────────────────────────────────────

  it('PermissionRequest sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
  });

  it('PermissionRequest cancels permission timer', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const timer = setTimeout(() => {}, 10000);
    permissionTimers.set(1, timer);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    expect(permissionTimers.has(1)).toBe(false);
  });

  it('PermissionRequest notifies sub-agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeSubagentToolNames.set('tool-parent', new Map([['sub-1', 'Read']]));
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const subMsg = mockWebview.messages.find((m) => m.type === 'subagentToolPermission');
    expect(subMsg).toBeTruthy();
    expect(subMsg?.parentToolId).toBe('tool-parent');
  });

  // ── Notification ────────────────────────────────────────────

  it('Notification permission_prompt sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'permission_prompt',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(agent.permissionSent).toBe(true);
  });

  // ── Question and idle waits ─────────────────────────────────

  describe('question and idle waits', () => {
    const ASK_INPUT = {
      questions: [
        {
          question: 'Which database should the migration target?',
          header: 'DB',
          multiSelect: false,
        },
      ],
    };
    const hook = (name: string, extra: Record<string, unknown> = {}) =>
      handler.handleEvent('claude', { hook_event_name: name, session_id: 'sess-1', ...extra });
    const ask = () => hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ASK_INPUT });
    const lastStatus = () => mockWebview.messages.filter((m) => m.type === 'agentStatus').at(-1);
    let agent: AgentState;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-10-20T10:00:00Z'));
      agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
    });
    afterEach(() => vi.useRealTimers());

    // K1: a session that finished and sat idle is not asking anything, and the idle prompt
    // does not make it a newer wait.
    it('idle_prompt after Stop is an idle wait: no question, and the Stop start is kept', () => {
      hook('Stop');
      const stoppedAt = Date.now();
      vi.advanceTimersByTime(5 * 60_000);
      hook('Notification', { notification_type: 'idle_prompt' });

      expect(lastStatus()).toEqual({
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'idle',
        since: stoppedAt,
      });
    });

    // K2
    it('a question tool starts a question ticket at once, keeps its tool row, and its result ends it', () => {
      ask();
      const now = Date.now();
      expect(lastStatus()).toEqual({
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        awaitingInput: true,
        awaitingReason: 'question',
        question: 'Which database should the migration target?',
        since: now,
      });
      expect(mockWebview.messages.some((m) => m.type === 'agentToolStart')).toBe(true);
      expect(mockWebview.messages.some((m) => m.type === 'agentToolsClear')).toBe(false);

      vi.advanceTimersByTime(30_000);
      hook('PostToolUse', { tool_name: 'AskUserQuestion' });
      expect(lastStatus()).toMatchObject({ status: 'active' });
      expect(agent.awaitingInput).toBeFalsy();
      expect(agent.question).toBeUndefined();
    });

    it('the idle prompt that fires while a question is unanswered leaves the question alone', () => {
      ask();
      vi.advanceTimersByTime(60_000);
      hook('Notification', { notification_type: 'idle_prompt' });
      expect(lastStatus()).toMatchObject({
        awaitingReason: 'question',
        since: Date.now() - 60_000,
      });
    });

    it('a question the server cannot read still raises the ticket, without text', () => {
      hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} });
      const status = lastStatus()!;
      expect(status).toMatchObject({ awaitingInput: true, awaitingReason: 'question' });
      expect(status).not.toHaveProperty('question');
    });

    // K2b / K2c and the other ways a question ends. A user prompt reaches the server through
    // the transcript (UserPromptSubmit is not installed): see transcriptParser.test.ts.
    it("only the lead's own next call or the end of the turn clears the question", () => {
      ask();
      // A sub-agent's call, and a parallel tool finishing, are not the answer.
      hook('PreToolUse', { tool_name: 'Read', tool_input: {}, agent_id: SUB_AGENT_ID });
      hook('PostToolUse', { tool_name: 'Read' });
      expect(lastStatus()).toMatchObject({ awaitingReason: 'question' });
      expect(agent.question).toBeDefined();

      hook('PreToolUse', { tool_name: 'Read', tool_input: {} });
      expect(lastStatus()).toMatchObject({ status: 'active' });
      expect(agent.question).toBeUndefined();

      ask();
      hook('Stop');
      expect(lastStatus()).toMatchObject({ status: 'waiting', awaitingInput: false });
      expect(lastStatus()).not.toHaveProperty('question');
      expect(agent.awaitingReason).toBeUndefined();
    });

    it('SessionEnd clears a pending question', () => {
      ask();
      hook('SessionEnd', { reason: 'clear' });
      expect(agent.awaitingInput).toBeFalsy();
      expect(agent.question).toBeUndefined();
    });

    // K3, hook entry point: the text on the wire is the redacted, flattened, cut one.
    it('redacts, flattens and cuts the question it puts on the wire', () => {
      const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
      hook('PreToolUse', {
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: `Use ${token}‮ now? ${'y'.repeat(200)}` }] },
      });
      const text = lastStatus()!.question as string;
      expect(text).not.toContain('ghp_');
      expect(text).not.toMatch(/[‮\n]/);
      expect(Array.from(text).length).toBeLessThanOrEqual(80);
    });
  });

  // ── Stop ────────────────────────────────────────────────────

  it('Stop marks agent waiting without awaitingInput (Done)', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
    // Stop = finished its turn -> awaitingInput falsy ("Done")
    expect(waitMsg?.awaitingInput).toBeFalsy();
  });

  it('Stop clears foreground tools but preserves background agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('fg-tool');
    agent.activeToolStatuses.set('fg-tool', 'Running');
    agent.activeToolNames.set('fg-tool', 'Bash');
    agent.activeToolIds.add('bg-tool');
    agent.activeToolStatuses.set('bg-tool', 'Background task');
    agent.activeToolNames.set('bg-tool', 'Agent');
    agent.backgroundAgentToolIds.add('bg-tool');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.activeToolIds.has('fg-tool')).toBe(false);
    expect(agent.activeToolIds.has('bg-tool')).toBe(true);
    const clearMsg = mockWebview.messages.find((m) => m.type === 'agentToolsClear');
    expect(clearMsg).toBeTruthy();
    const reSent = mockWebview.messages.find(
      (m) => m.type === 'agentToolStart' && m.toolId === 'bg-tool',
    );
    expect(reSent).toBeTruthy();
  });

  // ── hookDelivered ───────────────────────────────────────────

  it('sets hookDelivered flag on agent', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  // ── Buffering ───────────────────────────────────────────────

  it('silently drops events for untracked sessions', () => {
    // No agents, no pending sessions, no prior buffered events
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'unknown-sess',
    });

    // No messages sent, no crash
    expect(mockWebview.messages).toHaveLength(0);
  });

  it('buffers events when unregistered agents exist (internal agent race)', () => {
    // Agent exists in map but not yet registered for hooks
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);
    // Don't call registerAgent yet (simulates race)

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Event should be buffered (auto-discovery finds agent by sessionId and delivers)
    expect(agent.isWaiting).toBe(true);
  });

  it('flushes buffered events on registerAgent', () => {
    // Agent exists with sessionId but not registered
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);

    // Send event (auto-discovery will find it immediately in this case)
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Auto-discovery handles it directly
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
  });

  it('prunes expired buffered events', async () => {
    // Create agent so events get buffered (unregistered agent exists)
    const agent = createTestAgent({ id: 1, sessionId: 'other-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'expired-sess',
    });

    // Wait well past HOOK_EVENT_BUFFER_MS (5000) + prune interval cycle
    await new Promise((r) => setTimeout(r, 7000));

    // Now register -- event should have been pruned
    const agent2 = createTestAgent({ id: 2 });
    agents.set(2, agent2);
    handler.registerAgent('expired-sess', 2);

    // No messages (event was pruned)
    expect(mockWebview.messages).toHaveLength(0);

    handler.dispose();
  });

  // ── Auto-discovery ──────────────────────────────────────────

  it('auto-discovers agent by sessionId field', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'auto-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'auto-sess',
    });

    expect(agent.isWaiting).toBe(true);
  });

  // ── Dispose ─────────────────────────────────────────────────

  it('dispose cleans up timers and maps', () => {
    handler.registerAgent('sess-1', 1);
    handler.dispose();
    expect(() => handler.dispose()).not.toThrow();
  });

  // ── SessionStart ────────────────────────────────────────────

  it('SessionStart for known agent sets hookDelivered', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart auto-discovers agent by sessionId', () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'auto-sess',
      hookDelivered: false,
    } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'auto-sess',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart(source=clear) reassigns agent with pendingClear', () => {
    const agent = createTestAgent({
      id: 1,
      projectDir: '/projects/test',
      pendingClear: true,
    } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-sess',
      source: 'clear',
      transcript_path: '/projects/test/new-sess.jsonl',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'new-sess', '/projects/test/new-sess.jsonl');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart for unknown session stores as pending', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    // No agent created (pending, awaiting confirmation)
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── SessionEnd ──────────────────────────────────────────────

  it('SessionEnd(reason=clear) sets pendingClear and marks waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'clear',
    });

    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
  });

  it('SessionEnd(reason=exit) calls onSessionEnd immediately', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'exit',
    });

    // Exit is immediate, no pendingClear delay
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'exit');
  });

  it('SessionEnd(reason=resume) delays onSessionEnd for SESSION_END_GRACE_MS', async () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'resume',
    });

    // pendingClear set, onSessionEnd delayed
    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).not.toHaveBeenCalled();

    // Wait for grace period (2000ms + margin)
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'resume');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionEnd discards pending external session (transient filtering)', () => {
    // Store pending session via SessionStart
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'transient-sess',
      source: 'startup',
      transcript_path: '/projects/test/transient.jsonl',
      cwd: '/projects/test',
    });

    // SessionEnd arrives before confirmation -> discard
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'transient-sess',
      reason: 'other',
    });

    // No agent created, no messages
    expect(mockWebview.messages).toHaveLength(0);
  });

  describe('SessionEnd on a terminal agent, which stays in the office', () => {
    const signals = () =>
      mockWebview.messages.filter((m) =>
        ['agentCache', 'agentMode', 'agentShells'].includes(String(m.type)),
      );

    function endSession(reason: string): AgentState {
      const agent = createTestAgent({
        id: 1,
        isExternal: false,
        cacheTtlSeconds: 3600,
        cacheExpiresAt: 1_760_000_000_000,
        permissionMode: 'auto',
        runningShellIds: new Map([['toolu_1', 'b1']]),
      });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      handler.handleEvent('claude', {
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        reason,
      });
      return agent;
    }

    it('C12 an exit clears its cache clock, its shells and its mode', () => {
      const agent = endSession('exit');

      expect(signals()).toEqual([
        { type: 'agentCache', id: 1 },
        { type: 'agentShells', id: 1, running: 0 },
        { type: 'agentMode', id: 1 },
      ]);
      expect(agent.permissionMode).toBeUndefined();
    });

    it('C12 a /clear clears the cache clock and the shells but keeps the mode', () => {
      const agent = endSession('clear');

      expect(signals()).toEqual([
        { type: 'agentCache', id: 1 },
        { type: 'agentShells', id: 1, running: 0 },
      ]);
      expect(agent.permissionMode).toBe('auto');
    });
  });

  // ── PreToolUse / PostToolUse ─────────────────────────────────

  it('PreToolUse sends agentToolStart with formatted status', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/src/server.ts' },
    });

    const toolMsg = mockWebview.messages.find((m) => m.type === 'agentToolStart');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.toolName).toBe('Read');
    expect(toolMsg?.status).toBe('Reading server.ts');
    expect(agent.currentHookToolId).toBeTruthy();
  });

  it('PreToolUse marks agent active and cancels waiting', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(agent.isWaiting).toBe(false);
    expect(agent.hadToolsInTurn).toBe(true);
    const activeMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'active',
    );
    expect(activeMsg).toBeTruthy();
  });

  it('PostToolUse sends agentToolDone and clears currentHookToolId', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-123';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-123');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  it('PostToolUseFailure sends agentToolDone', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-456';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-456');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  // ── Pending external session confirmation ────────────────────

  it('confirmation event creates pending external session and delivers event', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    // SessionStart stores as pending
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate the provider creating the agent (callback side effect)
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Stop confirms the session -> creates agent -> re-processes Stop
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'ext-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'ext-sess',
      '/projects/test/ext-sess.jsonl',
      '/projects/test',
    );
    // Stop was re-processed after agent creation
    const agent = agents.get(2);
    expect(agent?.isWaiting).toBe(true);
  });

  // ── Resume ──────────────────────────────────────────────────

  it('SessionStart(source=resume) calls onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionResume).toHaveBeenCalledWith('/projects/test/resume-sess.jsonl');
  });

  it('SessionEnd(resume) + SessionStart(resume) reassigns agent within grace period', async () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear, onSessionEnd });

    // SessionEnd(reason=resume) sets pendingClear, starts grace timer
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'old-sess',
      reason: 'resume',
    });
    expect(agent.pendingClear).toBe(true);

    // SessionStart(source=resume) arrives within grace period -> reassigns
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });
    expect(agent.pendingClear).toBe(false);
    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );

    // Grace timer fires but pendingClear is already false -> no-op
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it('SessionStart(source=resume) reassigns agent with pendingClear, not other agents in same projectDir', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    // Agent 1: the one that did /resume (has pendingClear from SessionEnd)
    const resumingAgent = createTestAgent({
      id: 1,
      sessionId: 'old-sess-1',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, resumingAgent);
    handler.registerAgent('old-sess-1', 1);

    // Agent 2: external agent in same projectDir (no pendingClear)
    const externalAgent = createTestAgent({
      id: 2,
      sessionId: 'ext-sess-2',
      projectDir: '/projects/test',
      pendingClear: false,
    });
    agents.set(2, externalAgent);
    handler.registerAgent('ext-sess-2', 2);

    // SessionStart(source=resume) should reassign Agent 1 (pendingClear), NOT Agent 2
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );
    expect(resumingAgent.pendingClear).toBe(false);
    // Agent 2 should be untouched
    expect(externalAgent.pendingClear).toBe(false);
    expect(externalAgent.sessionId).toBe('ext-sess-2');
  });

  // ── Provider-agnostic (optional transcript_path) ────────────

  it('SessionStart stores pending with cwd only (no transcript_path)', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'no-transcript-sess',
      source: 'startup',
      cwd: '/projects/test',
    });

    // Pending, no agent yet
    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate agent creation on confirmation
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Confirmation event creates agent
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'no-transcript-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'no-transcript-sess',
      undefined,
      '/projects/test',
    );
  });

  it('SessionStart(source=resume) uses cwd for matching when no transcript_path', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resumed-sess',
      source: 'resume',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'resumed-sess', undefined);
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart(source=resume) without transcript_path does not call onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-no-path',
      source: 'resume',
      cwd: '/projects/test',
    });

    // onSessionResume requires transcript_path to clear dismissals
    expect(onSessionResume).not.toHaveBeenCalled();
  });

  // ── Basic subagent regression (Agent Teams feature OFF) ─────────────
  // These tests pin down the behavior that must NOT change for basic subagents.
  // Basic subagents use Agent or Task tool WITHOUT run_in_background=true.

  // PreToolUse(Agent) sets currentHookIsTeammateSpawn iff run_in_background === true.
  describe.each([
    { label: 'run_in_background=true', toolInput: { run_in_background: true }, expected: true },
    { label: 'run_in_background=false', toolInput: { run_in_background: false }, expected: false },
  ])('PreToolUse(Agent, $label)', ({ toolInput, expected }) => {
    it(`sets currentHookIsTeammateSpawn=${expected}`, () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { description: 'Code review', ...toolInput },
      });

      expect(agent.currentHookIsTeammateSpawn).toBe(expected);
    });
  });

  // SubagentStart routes to teammate discovery ONLY when both conditions hold:
  // currentHookIsTeammateSpawn === true AND agent.teamName is set (JSONL-confirmed lead).
  // Basic subagents (no spawn flag) or the external-session false-positive case
  // (spawn flag set but no teamName) fall through to the basic subagent path.
  describe.each([
    {
      label: 'teammate (spawn flag + teamName)',
      spawn: true,
      teamName: 'research',
      seedActiveTool: false,
      expectTeammateDetected: true,
    },
    {
      label: 'false-positive guard (spawn flag, no teamName)',
      spawn: true,
      teamName: undefined,
      seedActiveTool: true,
      expectTeammateDetected: false,
    },
    {
      label: 'basic subagent from hook before JSONL (no activeToolNames parent)',
      spawn: false,
      teamName: undefined,
      seedActiveTool: false,
      expectTeammateDetected: false,
    },
  ])('SubagentStart: $label', ({ spawn, teamName, seedActiveTool, expectTeammateDetected }) => {
    it(`onTeammateDetected called=${expectTeammateDetected}`, () => {
      const agent = createTestAgent({
        id: 1,
        currentHookIsTeammateSpawn: spawn,
        ...(teamName ? { teamName } : {}),
      });
      if (seedActiveTool) {
        agent.activeToolNames.set('toolu_real', 'Agent');
      } else if (!spawn) {
        agent.currentHookToolId = 'hook-XXX';
        agent.currentHookToolName = 'Agent';
      }
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      const onTeammateDetected = vi.fn();
      handler.setLifecycleCallbacks({ onTeammateDetected });

      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: expectTeammateDetected ? 'web-researcher' : 'general-purpose',
      });

      if (expectTeammateDetected) {
        expect(onTeammateDetected).toHaveBeenCalledWith(1, 'sess-1', 'web-researcher');
        // Teammate path skips subagentToolStart (no ghost sub-agent character).
        expect(mockWebview.messages.find((m) => m.type === 'subagentToolStart')).toBeUndefined();
      } else {
        expect(onTeammateDetected).not.toHaveBeenCalled();
        const msg = mockWebview.messages.find((m) => m.type === 'subagentToolStart');
        if (seedActiveTool) {
          // Basic path with real tool id available.
          expect(msg).toBeTruthy();
          expect(msg?.parentToolId).toBe('toolu_real');
        } else {
          // No real tool id yet -- JSONL will create the sub-agent character.
          expect(msg).toBeUndefined();
        }
      }
    });
  });

  // ── Hooks fired inside a sub-agent (agent_id) ───────────────────────
  // A workflow agent or a Task/Agent sub-agent fires hooks on the lead's
  // session with its own agent_id. They are the sub-agent's events: the lead's
  // tools, status and adoption must not move.

  describe.each([
    { label: "the lead's own call", extra: {}, leadTool: true },
    { label: "a sub-agent's call", extra: { agent_id: SUB_AGENT_ID }, leadTool: false },
  ])('C7 PreToolUse, $label', ({ extra, leadTool }) => {
    it(`starts a lead tool: ${leadTool}`, () => {
      agents.set(1, createTestAgent({ id: 1 }));
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        ...extra,
      });

      expect(mockWebview.messages.some((m) => m.type === 'agentToolStart')).toBe(leadTool);
      expect(mockWebview.messages.some((m) => m.type === 'agentStatus')).toBe(leadTool);
    });
  });

  it("C7 a sub-agent's PostToolUse never ends the lead's open hook tool", () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 60' },
    });
    const leadToolId = agent.currentHookToolId;
    expect(leadToolId).toBeDefined();

    for (const name of ['PostToolUse', 'PostToolUseFailure']) {
      handler.handleEvent('claude', {
        hook_event_name: name,
        session_id: 'sess-1',
        agent_id: SUB_AGENT_ID,
      });
    }

    expect(agent.currentHookToolId).toBe(leadToolId);
    expect(mockWebview.messages.some((m) => m.type === 'agentToolDone')).toBe(false);
  });

  describe.each(['PostToolUse', 'PreToolUse'])(
    "C38 a sub-agent's %s after its permission prompt",
    (event) => {
      it("clears the lead's bubble and starts no lead tool", () => {
        agents.set(1, createTestAgent({ id: 1 }));
        handler.registerAgent('sess-1', 1);
        // Claude builds PermissionRequest from the tool call: a sub-agent's carries its agent_id.
        handler.handleEvent('claude', {
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-1',
          agent_id: SUB_AGENT_ID,
        });
        expect(mockWebview.messages.some((m) => m.type === 'agentToolPermission')).toBe(true);
        mockWebview.messages.length = 0;

        handler.handleEvent('claude', {
          hook_event_name: event,
          session_id: 'sess-1',
          agent_id: SUB_AGENT_ID,
          tool_name: 'Read',
          tool_input: { file_path: '/x.ts' },
        });

        expect(mockWebview.messages).toEqual([{ type: 'agentToolPermissionClear', id: 1 }]);
      });
    },
  );

  it('C17 a sub-agent hook for a pending session neither confirms nor adopts it', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'unknown-sess',
      source: 'startup',
      transcript_path: '/projects/test/unknown-sess.jsonl',
      cwd: '/projects/test',
    });

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'unknown-sess',
      agent_id: SUB_AGENT_ID,
      tool_name: 'Read',
      tool_input: { file_path: '/x.ts' },
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();
    expect(agents.size).toBe(0);
    expect(mockWebview.messages.some((m) => m.type === 'agentToolStart')).toBe(false);
  });

  describe.each([
    { event: 'Stop', extra: {} },
    { event: 'SessionEnd', extra: { reason: 'prompt_input_exit' } },
  ])('C26 a $event carrying agent_id', ({ event, extra }) => {
    it("leaves the lead's open tool, its status and its session alone", () => {
      const onSessionEnd = vi.fn();
      handler.setLifecycleCallbacks({ onSessionEnd });
      const agent = createTestAgent({ id: 1, hookDelivered: true });
      agent.activeToolIds.add('toolu_open');
      agent.activeToolNames.set('toolu_open', 'Bash');
      agent.activeToolStatuses.set('toolu_open', 'Running: sleep');
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: event,
        session_id: 'sess-1',
        agent_id: SUB_AGENT_ID,
        ...extra,
      });

      expect(agent.activeToolIds.has('toolu_open')).toBe(true);
      expect(agent.isWaiting).toBe(false);
      expect(onSessionEnd).not.toHaveBeenCalled();
      expect(mockWebview.messages).toEqual([]);
    });
  });

  it('C26 a SessionStart carrying agent_id leaves no pending session for a later event to adopt', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'unknown-sess',
      agent_id: SUB_AGENT_ID,
      source: 'startup',
      transcript_path: `/projects/test/unknown-sess/subagents/agent-${SUB_AGENT_ID}.jsonl`,
      cwd: '/projects/test',
    });

    // The session's own event confirms a pending session: there must be none to confirm.
    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'unknown-sess',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();
  });

  it("C36 a sub-agent's SubagentStop ends only the row it drew; the last one ends the Task's helper", () => {
    vi.useFakeTimers();
    try {
      const agent = createTestAgent({ id: 1 });
      agent.activeToolIds.add('toolu_task');
      agent.activeToolNames.set('toolu_task', 'Task');
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      const subagent = (hookEvent: string, agentId: string) =>
        handler.handleEvent('claude', {
          hook_event_name: hookEvent,
          session_id: 'sess-1',
          agent_id: agentId,
          agent_type: 'general-purpose',
        });
      const taskClears = () =>
        mockWebview.messages.filter(
          (m) => m.type === 'subagentClear' && m.parentToolId === 'toolu_task',
        );

      subagent('SubagentStart', 'y1');
      vi.advanceTimersByTime(1); // row ids carry Date.now(): two Starts in one ms share a row id
      subagent('SubagentStart', 'y2');

      const sent = mockWebview.messages.length;
      subagent('SubagentStop', 'z9'); // a sub-agent that drew no row
      expect(mockWebview.messages).toHaveLength(sent);

      subagent('SubagentStop', 'y1');
      expect(taskClears()).toHaveLength(0);

      subagent('SubagentStop', 'y2');
      expect(taskClears()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HookEventHandler: tripwires', () => {
  const HIGH_CMD = 'cat ~/.aws/credentials';
  const MEDIUM_CMD = 'source .env';
  let agents: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;
  let handler: HookEventHandler;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  const tripwires = (): Array<Record<string, unknown>> =>
    broadcasts.filter((m) => m.type === 'agentTripwire');

  function preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): void {
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: toolName,
      tool_input: toolInput,
      ...extra,
    });
  }

  beforeEach(() => {
    agents = new AgentStateStore();
    broadcasts = [];
    agents.on('broadcast', (msg) => broadcasts.push(msg));
    handler = new HookEventHandler(
      agents,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
    agents.set(1, createTestAgent({ id: 1 }));
    handler.registerAgent('sess-1', 1);
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  it('broadcasts one agentTripwire with only ids and labels, and logs neither input nor text', () => {
    preToolUse('Bash', { command: `${HIGH_CMD} #SENTINEL` });

    expect(tripwires()).toEqual([
      {
        type: 'agentTripwire',
        id: 1,
        ruleId: 'cloud-credentials',
        ruleName: 'Cloud credentials access',
        severity: 'high',
        count: 1,
        since: expect.any(Number),
      },
    ]);
    // Only the tripwire message and the logs are checked: the existing tool display
    // is a separate channel with its own status text.
    const leaked =
      JSON.stringify(tripwires()) +
      consoleSpies.map((spy) => JSON.stringify(spy.mock.calls)).join('');
    expect(leaked).not.toContain('.aws');
    expect(leaked).not.toContain('SENTINEL');
    expect(JSON.stringify(consoleSpies[0].mock.calls)).toContain(
      'Tripwire cloud-credentials agent 1',
    );
  });

  it('stays silent for a benign call', () => {
    preToolUse('Bash', { command: 'ls' });
    expect(tripwires()).toEqual([]);
    expect(agents.get(1)?.tripwire).toBeUndefined();
  });

  it('counts a second hit', () => {
    preToolUse('Bash', { command: HIGH_CMD });
    preToolUse('Bash', { command: HIGH_CMD });
    expect(tripwires().map((m) => m.count)).toEqual([1, 2]);
  });

  it('checks a Task call even though the office draws nothing for it', () => {
    preToolUse('Task', { subagent_type: 'general', command: HIGH_CMD });
    expect(tripwires()).toHaveLength(1);
    expect(broadcasts.some((m) => m.type === 'agentToolStart')).toBe(false);
  });

  it("C39 checks a sub-agent's call (agent_id), which starts no lead tool", () => {
    preToolUse('Bash', { command: HIGH_CMD }, { agent_id: SUB_AGENT_ID });
    expect(tripwires()).toHaveLength(1);
    expect(broadcasts.some((m) => m.type === 'agentToolStart')).toBe(false);
  });

  it('keeps the high rule on screen when a medium hit follows, but counts it', () => {
    preToolUse('Bash', { command: HIGH_CMD });
    preToolUse('Bash', { command: MEDIUM_CMD });
    expect(tripwires()[1]).toMatchObject({
      ruleId: 'cloud-credentials',
      severity: 'high',
      count: 2,
    });
  });

  it('switches to the high rule when it follows a medium one', () => {
    preToolUse('Bash', { command: MEDIUM_CMD });
    preToolUse('Bash', { command: HIGH_CMD });
    expect(tripwires()[1]).toMatchObject({
      ruleId: 'cloud-credentials',
      severity: 'high',
      count: 2,
    });
  });
});

describe('HookEventHandler: when each state began (the monitor minutes)', () => {
  const T0 = Date.parse('2026-10-14T10:00:00Z');
  const SEC = 1000;
  let agents: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;
  let handler: HookEventHandler;

  const event = (hook_event_name: string, extra: Record<string, unknown> = {}): void =>
    handler.handleEvent('claude', { hook_event_name, session_id: 'sess-1', ...extra });
  const at = (ms: number): void => {
    vi.setSystemTime(T0 + ms);
  };
  const last = (type: string): Record<string, unknown> | undefined =>
    broadcasts.filter((m) => m.type === type).at(-1);
  const resent = (): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => out.push(m), agents);
    return out;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    agents = new AgentStateStore();
    broadcasts = [];
    agents.on('broadcast', (msg) => broadcasts.push(msg));
    handler = new HookEventHandler(
      agents,
      new Map(),
      new Map(),
      claudeProvider,
      new SessionRouter(),
    );
    agents.set(1, createTestAgent({ id: 1 }));
    handler.registerAgent('sess-1', 1);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a status and a prompt keep their start through repeats, and a reconnect restates both', () => {
    at(0);
    event('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/test/a.ts' } });
    at(60 * SEC);
    event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    // The second call repeats `active`: the turn did not start again.
    expect(last('agentStatus')).toMatchObject({ status: 'active', since: T0 });

    // The transcript holds the call in flight; hooks never add rows of their own.
    const agent = agents.get(1)!;
    agent.activeToolStatuses.set('toolu_ls', 'Running: ls');
    agent.activeToolNames.set('toolu_ls', 'Bash');
    at(90 * SEC);
    event('PermissionRequest');
    at(120 * SEC);
    event('PermissionRequest');
    expect(last('agentToolPermission')).toEqual({
      type: 'agentToolPermission',
      id: 1,
      permissionSince: T0 + 90 * SEC,
    });

    const replay = resent();
    expect(replay.find((m) => m.type === 'agentStatus')).toMatchObject({ since: T0 });
    expect(replay.filter((m) => m.type === 'agentToolStart')).toEqual([
      expect.objectContaining({ permissionActive: true, permissionSince: T0 + 90 * SEC }),
    ]);

    at(180 * SEC);
    event('Stop');
    expect(last('agentStatus')).toMatchObject({ status: 'waiting', since: T0 + 180 * SEC });
  });

  it('a tripwire alarm is as old as its first hit since the last ack', () => {
    at(0);
    event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'source .env' } });
    at(30 * SEC);
    event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat ~/.aws/credentials' } });
    expect(last('agentTripwire')).toMatchObject({ severity: 'high', count: 2, since: T0 });

    ackTripwire(agents.get(1)!, 2);
    at(90 * SEC);
    event('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'source .env' } });
    expect(last('agentTripwire')).toMatchObject({ count: 1, since: T0 + 90 * SEC });
  });
});
