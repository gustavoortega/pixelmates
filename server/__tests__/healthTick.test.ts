import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { HEALTH_DEAD_REMOVE_MS, TEXT_IDLE_DELAY_MS } from '../src/constants.js';
import { scanExternalDir, scanForBackgroundAgentFiles } from '../src/fileWatcher.js';
import { runHealthTick } from '../src/healthTick.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-12T12:00:00Z');
type Rec = Record<string, unknown>;

let toolSeq = 0;
const prompt = (): Rec => ({ type: 'user', message: { content: 'go' } });
const toolUse = (name: string, id = `toolu_${++toolSeq}`): Rec => ({
  type: 'assistant',
  timestamp: new Date(Date.now()).toISOString(),
  message: { content: [{ type: 'tool_use', id, name, input: { n: toolSeq } }] },
});
const toolResult = (id: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const turnEnd = (): Rec => ({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
const textAnswer = (): Rec => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Done.' }] },
});
/** One assistant record carrying several calls, as a parallel batch is written. */
const batch = (...calls: Array<[name: string, id: string]>): Rec => ({
  type: 'assistant',
  message: { content: calls.map(([name, id]) => ({ type: 'tool_use', id, name, input: {} })) },
});

const stalled = (id: number, count: number) => ({
  type: 'agentHealth',
  id,
  state: 'stalled',
  reason: 'no_progress',
  count,
  // Server stamped when the state is entered.
  since: expect.any(Number),
});
const dead = (id: number) => ({
  type: 'agentHealth',
  id,
  state: 'dead',
  reason: 'process_gone',
  count: 0,
  // Server stamped when the state is entered.
  since: expect.any(Number),
});
const clear = (id: number) => ({ type: 'agentHealthClear', id });

function createTestAgent(overrides: Partial<AgentState>): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/none.jsonl',
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

describe('health tick', () => {
  let tmp: string;
  let sessionsDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let health: Rec[];
  let children: ChildProcess[];
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-health-tick-'));
    sessionsDir = path.join(tmp, 'config', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'project'));
    fs.mkdirSync(path.join(tmp, 'bin'));
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'config');
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    health = [];
    store.on('broadcast', (msg) => {
      if (String(msg.type).startsWith('agentHealth')) health.push(msg);
    });
    children = [];
    // Only the clock is faked: liveness waits on real processes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    runtime.dispose();
    for (const child of children) child.kill('SIGKILL');
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A transcript last written at `mtimeMs`. */
  function transcript(name: string, mtimeMs = T0, records: Rec[] = [prompt()]): string {
    const file = path.join(tmp, 'project', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }

  function addAgent(overrides: Partial<AgentState> = {}): AgentState {
    const agent = createTestAgent({
      jsonlFile: transcript(`${overrides.sessionId ?? 'sess-1'}.jsonl`),
      projectDir: path.join(tmp, 'project'),
      ...overrides,
    });
    store.set(agent.id, agent);
    runtime.registerAgent(agent.sessionId, agent.id);
    return agent;
  }

  function feed(agent: AgentState, ...records: Rec[]): void {
    for (const record of records) {
      processTranscriptLine(
        agent.id,
        JSON.stringify(record),
        store,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );
    }
  }

  function hook(agent: AgentState, event: Rec): void {
    runtime.handleHookEvent('claude', { session_id: agent.sessionId, ...event });
  }

  async function tickAt(now: number): Promise<void> {
    vi.setSystemTime(now);
    await runHealthTick(runtime.healthDeps, now);
  }

  /** A real process whose name is `name`: a link to sleep, so `ps` reports that name. */
  async function processNamed(name: string): Promise<number> {
    // The node binary under another name: the process name is the file name it runs from. A
    // symlink to sleep is not enough, since a multicall sleep (rust coreutils on newer Ubuntu)
    // reads its own name and exits at once on one it does not know.
    const link = path.join(tmp, 'bin', name);
    if (!fs.existsSync(link)) {
      try {
        fs.linkSync(process.execPath, link);
      } catch {
        fs.copyFileSync(process.execPath, link);
        fs.chmodSync(link, 0o755);
      }
    }
    const child = spawn(link, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    children.push(child);
    await new Promise((resolve) => child.once('spawn', resolve));
    return child.pid!;
  }

  /** A pid whose process has exited. */
  async function goneProcess(): Promise<number> {
    const pid = await processNamed('claude');
    const child = children[children.length - 1];
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    return pid;
  }

  function sessionFile(sessionId: string, pid: number, name = `${pid}.json`): void {
    fs.writeFileSync(
      path.join(sessionsDir, name),
      JSON.stringify({ pid, sessionId, cwd: tmp, startedAt: T0, kind: 'interactive' }),
    );
  }

  /** A server restart with one external agent, id 7, persisted on `file`. */
  function restore(file: string): void {
    const persisted: PersistedAgent = {
      id: 7,
      sessionId: 'restored',
      terminalName: '',
      isExternal: true,
      jsonlFile: file,
      projectDir: path.dirname(file),
    };
    store.setAdapter({
      loadAgents: () => [persisted],
      saveAgents: () => {},
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
      setSetting: () => {},
    } as StateAdapter);
    runtime.restoreExternalAgents();
  }

  describe('C2 stalled: an open turn with no progress', () => {
    it.each([
      ['a Read left open', ['Read'], 10, [stalled(1, 10)]],
      ['an open long-running tool at 10 min', ['Bash'], 10, []],
      ['an open long-running tool at 15 min', ['Bash'], 15, [stalled(1, 15)]],
      ['two open tools, one long-running, at 12 min', ['Bash', 'Read'], 12, []],
      ['an open AskUserQuestion', ['AskUserQuestion'], 11, []],
    ])('%s', async (_name, tools, minutes, expected) => {
      const agent = addAgent();
      feed(agent, prompt(), ...tools.map((name) => toolUse(name)));
      await tickAt(T0 + minutes * MIN);
      expect(health).toEqual(expected);
    });

    it('in hooks mode a result still closes its call: a finished Bash gets the 10 min window', async () => {
      const agent = addAgent({ hookDelivered: true });
      feed(agent, prompt(), toolUse('Bash', 'toolu_bash'), toolResult('toolu_bash'));
      await tickAt(T0 + 11 * MIN);
      expect(health).toEqual([stalled(1, 11)]);
    });

    it.each([
      [
        'a closed turn',
        [prompt(), toolUse('Read', 'toolu_closed'), toolResult('toolu_closed'), turnEnd()],
      ],
      // Idle, not waiting: adopted with nothing in flight, or launched and never prompted.
      ['an idle agent that has not opened a turn', []],
    ])('%s stays quiet however long the silence', async (_name, records) => {
      const agent = addAgent();
      feed(agent, ...records);
      await tickAt(T0 + 60 * MIN);
      expect(health).toEqual([]);
    });

    // A parallel batch: the Read ran and returned, then the Edit asked for permission. The
    // watcher reads the batch's record after those hooks, and each result as its own record.
    it.each([
      ['is the user silence, even after the late tool_use record', () => {}, []],
      [
        "is the user silence, even after the other call's result",
        (agent: AgentState) => feed(agent, toolResult('toolu_read')),
        [],
      ],
      [
        'answered by its own result no longer holds off a stall',
        (agent: AgentState) => feed(agent, toolResult('toolu_read'), toolResult('toolu_edit')),
        [stalled(1, 11)],
      ],
      [
        'answered, as a later hook says, no longer holds off a stall',
        (agent: AgentState) => hook(agent, { hook_event_name: 'PostToolUse', tool_name: 'Edit' }),
        [stalled(1, 11)],
      ],
      [
        'dropped for a new prompt no longer holds off a stall',
        (agent: AgentState) => feed(agent, prompt()),
        [stalled(1, 11)],
      ],
    ])('a permission prompt %s', async (_name, then, expected) => {
      const agent = addAgent({ hookDelivered: true });
      feed(agent, prompt());
      hook(agent, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
      hook(agent, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
      hook(agent, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} });
      hook(agent, { hook_event_name: 'PermissionRequest', tool_name: 'Edit' });
      feed(agent, batch(['Read', 'toolu_read'], ['Edit', 'toolu_edit']));
      then(agent);
      await tickAt(T0 + 11 * MIN);
      expect(health).toEqual(expected);
    });

    it('a lead whose sub-agent transcript moves is not stalled', async () => {
      const agent = addAgent({ sessionId: 'lead' });
      feed(agent, prompt(), toolUse('Agent'));
      const sub = path.join(tmp, 'project', 'lead', 'subagents', 'agent-a1.jsonl');
      fs.mkdirSync(path.dirname(sub), { recursive: true });
      fs.writeFileSync(sub, '{}\n');
      fs.utimesSync(sub, (T0 + 15 * MIN) / 1000, (T0 + 15 * MIN) / 1000);
      // Past the long-tool window on the lead's own clock.
      await tickAt(T0 + 16 * MIN);
      expect(health).toEqual([]);
    });

    // A restart replays nothing: the transcript tail says which calls were left open, and the
    // stall clock runs from its last write.
    it.each([
      ['a Read left open goes stalled after 10 min', 'Read', [[11, [stalled(7, 11)]]]],
      [
        'a Bash left open gets the long-tool window',
        'Bash',
        [
          [12, []],
          [15, [stalled(7, 15)]],
        ],
      ],
    ] as Array<[string, string, Array<[number, Rec[]]>]>)(
      'a restored mid-turn agent: %s',
      async (_name, tool, ticks) => {
        restore(transcript('restored.jsonl', T0, [prompt(), toolUse(tool, 'toolu_r')]));
        for (const [minutes, expected] of ticks) {
          await tickAt(T0 + minutes * MIN);
          expect(health).toEqual(expected);
        }
      },
    );

    it('a restored mid-turn agent is not stalled when its transcript cannot be read at the tick', async () => {
      const file = transcript('restored.jsonl', T0 - 30_000, [
        prompt(),
        toolUse('Read', 'toolu_r'),
      ]);
      restore(file);
      fs.rmSync(file);
      await tickAt(T0 + 60_000);
      expect(health).toEqual([]);
    });

    it('a turn the agent is waiting in (a text answer gone quiet) is not stalled', async () => {
      vi.useFakeTimers({ now: T0 });
      const agent = addAgent();
      feed(agent, prompt(), textAnswer());
      vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);
      expect(agent.isWaiting).toBe(true);
      await tickAt(T0 + 11 * MIN);
      expect(health).toEqual([]);
    });
  });

  // None of these ends the turn: only the progress itself can clear the mark.
  describe('C4 a stalled mark clears on any progress', () => {
    it.each([
      ['a transcript line', (agent: AgentState) => feed(agent, { type: 'progress' })],
      [
        'a hook',
        (agent: AgentState) => hook(agent, { hook_event_name: 'PostToolUse', tool_name: 'Read' }),
      ],
      [
        "a sub-agent's hook on the agent's session",
        (agent: AgentState) =>
          hook(agent, {
            hook_event_name: 'PreToolUse',
            agent_id: 'a1b2c3',
            tool_name: 'Read',
            tool_input: {},
          }),
      ],
    ])('%s', async (_name, progress) => {
      const agent = addAgent();
      feed(agent, prompt(), toolUse('Read'));
      await tickAt(T0 + 10 * MIN);
      expect(health).toEqual([stalled(1, 10)]);
      progress(agent);
      expect(health).toEqual([stalled(1, 10), clear(1)]);
    });

    it('a stalled count is re-sent as the minutes grow, once per minute, from one start', async () => {
      const agent = addAgent();
      feed(agent, prompt(), toolUse('Read'));
      await tickAt(T0 + 10 * MIN);
      await tickAt(T0 + 10 * MIN + 30_000);
      await tickAt(T0 + 11 * MIN);
      expect(health).toEqual([stalled(1, 10), stalled(1, 11)]);
      // A growing count is the same mark: the rail's minutes run from when it was entered.
      expect(health.map((m) => m.since)).toEqual([T0 + 10 * MIN, T0 + 10 * MIN]);
    });
  });

  describe.skipIf(process.platform === 'win32')('C6 dead: the session process is gone', () => {
    it('reads each session from its session files', async () => {
      const gone = await goneProcess();
      sessionFile('gone', gone);
      sessionFile('reused', await processNamed('bash'));
      sessionFile('node', await processNamed('node'));
      sessionFile('bun', await processNamed('bun'));
      sessionFile('native', await processNamed('claude'));
      // A resume runs the same session under a new pid; the old file stays behind.
      sessionFile('resumed', gone, 'old.json');
      sessionFile('resumed', await processNamed('claude'), 'new.json');
      fs.writeFileSync(path.join(sessionsDir, 'torn.json'), '{"pid": 12');

      const liveness = await claudeProvider.liveness!([
        'gone',
        'reused',
        'node',
        'bun',
        'native',
        'resumed',
        'missing',
      ]);
      expect(Object.fromEntries(liveness)).toEqual({
        gone: 'dead',
        reused: 'dead',
        node: 'alive',
        bun: 'alive',
        native: 'alive',
        resumed: 'alive',
        missing: 'unknown',
      });
    });

    it('marks a dead agent, removes it after 5 min if external, and keeps a terminal agent', async () => {
      const file = transcript('ext.jsonl', T0);
      scanExternalDir(
        path.join(tmp, 'project'),
        runtime.knownJsonlFiles,
        store.nextAgentId,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
        () => {},
      );
      const [ext] = [...store.values()];
      expect(ext).toMatchObject({ isExternal: true, sessionId: 'ext' });
      const terminal = addAgent({
        id: 50,
        sessionId: 'term',
        isExternal: false,
        jsonlFile: transcript('other/term.jsonl'),
        projectDir: path.join(tmp, 'project', 'other'),
      });
      sessionFile('ext', await goneProcess());
      sessionFile('term', await goneProcess());

      await tickAt(T0);
      expect(health).toEqual([dead(ext.id), dead(terminal.id)]);
      await tickAt(T0 + HEALTH_DEAD_REMOVE_MS - 1000);
      expect(store.has(ext.id)).toBe(true);
      await tickAt(T0 + HEALTH_DEAD_REMOVE_MS);
      expect(store.has(ext.id)).toBe(false);
      expect(store.has(terminal.id)).toBe(true);

      // A resume writes to the same transcript: the next scan adopts it again.
      fs.appendFileSync(file, JSON.stringify(prompt()) + '\n');
      fs.utimesSync(file, Date.now() / 1000, Date.now() / 1000);
      scanExternalDir(
        path.join(tmp, 'project'),
        runtime.knownJsonlFiles,
        store.nextAgentId,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
        () => {},
      );
      expect([...store.values()].filter((a) => a.jsonlFile === file)).toHaveLength(1);
    });

    it("a teammate in its lead's session stays beside its gray terminal lead, and is not minted again", async () => {
      const lead = addAgent({
        id: store.nextAgentId.current++,
        sessionId: 'lead',
        isExternal: false,
        backgroundAgentToolIds: new Set(['toolu_bg']),
      });
      // A named background spawn: its transcript and sidecar under the lead's session.
      const subagents = path.join(tmp, 'project', 'lead', 'subagents');
      fs.mkdirSync(subagents, { recursive: true });
      fs.writeFileSync(path.join(subagents, 'agent-a1.jsonl'), JSON.stringify(prompt()) + '\n');
      fs.writeFileSync(
        path.join(subagents, 'agent-a1.meta.json'),
        JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_bg', name: 'helper' }),
      );
      // The project scan that seats it, run every second while the spawn is live.
      const scan = () =>
        scanForBackgroundAgentFiles(
          lead.id,
          store,
          store.nextAgentId,
          runtime.fileWatchers,
          runtime.pollingTimers,
          runtime.waitingTimers,
          runtime.permissionTimers,
          () => {},
        );
      const teammates = () =>
        [...store.values()].filter((a) => a.leadAgentId === lead.id).map((a) => a.id);
      scan();
      const [helper] = teammates();
      expect(store.get(helper)).toMatchObject({ isExternal: true, sessionId: 'lead' });
      sessionFile('lead', await goneProcess());

      await tickAt(T0);
      await tickAt(T0 + HEALTH_DEAD_REMOVE_MS);
      scan();
      expect(teammates()).toEqual([helper]);
      expect(health).toEqual([dead(lead.id), dead(helper)]);
    });

    it.each([
      ['an idle agent', []],
      // The process died mid-call: the resumed one waits at its prompt with nothing in flight.
      ['an agent that died mid-turn', [prompt(), toolUse('Read')]],
    ])(
      '%s alive again (a resume under a new pid) is cleared, and is not stalled after',
      async (_name, records) => {
        const agent = addAgent({ sessionId: 'back' });
        feed(agent, ...records);
        sessionFile('back', await goneProcess());
        await tickAt(T0);
        expect(health).toEqual([dead(agent.id)]);
        sessionFile('back', await processNamed('claude'), 'resumed.json');
        await tickAt(T0 + 30_000);
        await tickAt(T0 + 12 * MIN);
        expect(health).toEqual([dead(agent.id), clear(agent.id)]);
      },
    );

    it('C9 dead outranks stalled on the same agent', async () => {
      // A terminal agent: it stays while dead, so the tick still compares after 10 min.
      const agent = addAgent({ sessionId: 'both', isExternal: false });
      sessionFile('both', await goneProcess());
      await tickAt(T0);
      // The transcript opens a turn the session files cannot account for: the process still
      // reads gone, and the turn then goes quiet.
      feed(agent, prompt(), toolUse('Read'));
      await tickAt(T0 + 11 * MIN);
      expect(health).toEqual([dead(agent.id)]);
    });
  });

  describe('the tick never throws', () => {
    it('a liveness check that fails is logged once, and the tick still resolves', async () => {
      // A session to ask about: with none, the provider is never called.
      addAgent();
      const failure = Object.assign(new Error('session files unreadable'), {
        code: 'ETICKTEST_LIVENESS',
      });
      const deps = {
        ...runtime.healthDeps,
        provider: { ...claudeProvider, liveness: () => Promise.reject(failure) },
      };
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(runHealthTick(deps, T0)).resolves.toBeUndefined();
      await expect(runHealthTick(deps, T0 + 30_000)).resolves.toBeUndefined();
      const lines = logged.mock.calls.filter(([line]) =>
        String(line).includes('ETICKTEST_LIVENESS'),
      );
      expect(lines).toHaveLength(1);
    });

    it('an agent whose tick throws does not stop the others', async () => {
      const first = addAgent({ id: 1, sessionId: 'first' });
      const second = addAgent({ id: 2, sessionId: 'second' });
      feed(first, prompt(), toolUse('Read'));
      feed(second, prompt(), toolUse('Read'));
      // A send that throws for the first agent's mark, as one on a closing socket can.
      store.on('broadcast', (msg) => {
        if (msg.id === first.id && String(msg.type).startsWith('agentHealth')) {
          throw Object.assign(new Error('send failed'), { code: 'ETICKTEST_SEND' });
        }
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(tickAt(T0 + 11 * MIN)).resolves.toBeUndefined();
      expect(health).toContainEqual(stalled(second.id, 11));
    });
  });
});
